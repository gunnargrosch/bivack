// Bivack IDE agent.
//
// One WebSocket server on port 8082 serving the IDE: file operations scoped to
// /home/coder, a PTY per requested terminal, and push-based filesystem change
// events. Reachable only through the MicroVM ingress, which authenticates the
// connection before any traffic arrives, so the agent does no auth. Runs as the
// `coder` user; file paths are confined to the workspace root.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const WebSocket = require('/opt/app/node_modules/ws');

let ptyLib = null;
try { ptyLib = require('/opt/app/node_modules/node-pty'); } catch (e) { console.warn('node-pty unavailable:', e.message); }

const PORT = 8082;
const ROOT = '/home/coder';
const SHELL = '/usr/bin/zsh';
// vscode FileType: File = 1, Directory = 2, SymbolicLink = 64
const FT_FILE = 1, FT_DIR = 2, FT_LINK = 64;

function safe(p) {
  const raw0 = typeof p === 'string' && p.length ? p : '/';
  // Normalize any Windows-style path a client might send.
  const raw = raw0.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const abs = path.resolve(raw.startsWith('/') ? raw : path.join(ROOT, raw));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('path outside workspace');
  return abs;
}
function fileType(s) {
  return s.isDirectory() ? FT_DIR : s.isFile() ? FT_FILE : FT_LINK;
}

async function stat(p) {
  const s = await fsp.lstat(safe(p));
  return { type: fileType(s), ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
}
async function readDirectory(p) {
  const entries = await fsp.readdir(safe(p), { withFileTypes: true });
  return entries.map((e) => [e.name, e.isDirectory() ? FT_DIR : e.isFile() ? FT_FILE : FT_LINK]);
}
async function readFile(p) {
  return (await fsp.readFile(safe(p))).toString('base64');
}
async function writeFile(p, base64, opts = {}) {
  const abs = safe(p);
  const exists = fs.existsSync(abs);
  if (opts.create === false && !exists) throw new Error('file does not exist');
  if (opts.overwrite === false && exists) throw new Error('file exists');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, Buffer.from(base64 || '', 'base64'));
}
async function createDirectory(p) {
  await fsp.mkdir(safe(p), { recursive: true });
}
async function remove(p, opts = {}) {
  await fsp.rm(safe(p), { recursive: !!opts.recursive, force: false });
}
async function rename(oldP, newP, opts = {}) {
  const a = safe(oldP), b = safe(newP);
  if (!opts.overwrite && fs.existsSync(b)) throw new Error('target exists');
  await fsp.mkdir(path.dirname(b), { recursive: true });
  await fsp.rename(a, b);
}

// Recursive watch of the workspace; events are broadcast to every connected
// client. The client maps `exists` to added/updated/deleted.
let watcher = null;
function ensureWatcher() {
  if (watcher) return;
  try {
    watcher = fs.watch(ROOT, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const abs = path.join(ROOT, filename);
      const exists = fs.existsSync(abs);
      for (const c of wss.clients) {
        if (c.readyState === 1) {
          try { c.send(JSON.stringify({ event: 'fsChange', path: abs, kind: eventType, exists })); } catch {}
        }
      }
    });
    console.log('watching', ROOT);
  } catch (e) {
    console.warn('watch failed:', e.message);
  }
}

const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocket.Server({ server });

// PTYs outlive a client connection. The ingress drops an idle socket (a
// backgrounded tab stops the keepalive), and the workbench reconnects expecting
// its terminals to still be there. Keeping them per-connection killed every
// shell on the drop, so a reconnected terminal was dead. Output is broadcast to
// whichever clients are connected; each filters by ptyId.
const ptys = new Map();
const clients = new Set();
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) { if (c.readyState === 1) { try { c.send(s); } catch {} } }
}
function createPty(id, cols, rows, cwd) {
  if (!ptyLib) throw new Error('node-pty unavailable');
  const existing = ptys.get(id);
  if (existing) {
    // Re-attach after a reconnect: same shell, just re-report the size.
    try { existing.resize(cols || 80, rows || 24); } catch {}
    return { pid: existing.pid };
  }
  const workdir = cwd ? safe(cwd) : ROOT;
  console.log(`createPty id=${id} cols=${cols} rows=${rows} cwd=${workdir}`);
  const p = ptyLib.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: workdir,
    env: { ...process.env, HOME: ROOT, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
  });
  p.onData((d) => broadcast({ event: 'ptyData', ptyId: id, data: d }));
  p.onExit(({ exitCode }) => { console.log(`ptyExit id=${id} code=${exitCode}`); ptys.delete(id); broadcast({ event: 'ptyExit', ptyId: id, code: exitCode }); });
  ptys.set(id, p);
  return { pid: p.pid };
}

wss.on('connection', (ws) => {
  clients.add(ws);
  const send = (obj) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } };
  console.log(`${new Date().toISOString()} ws connect`);

  ws.on('close', () => {
    console.log(`${new Date().toISOString()} ws close`);
    clients.delete(ws);
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const { id, op } = msg;
    try {
      let result;
      switch (op) {
        case 'stat': result = await stat(msg.path); break;
        case 'readDirectory': result = await readDirectory(msg.path); break;
        case 'readFile': result = await readFile(msg.path); break;
        case 'writeFile': result = await writeFile(msg.path, msg.content, msg.options); break;
        case 'createDirectory': result = await createDirectory(msg.path); break;
        case 'delete': result = await remove(msg.path, msg.options); break;
        case 'rename': result = await rename(msg.path, msg.newPath, msg.options); break;
        case 'watch': ensureWatcher(); result = {}; break;
        case 'createPty': result = createPty(msg.ptyId, msg.cols, msg.rows, msg.cwd); break;
        case 'ptyInput': { const p = ptys.get(msg.ptyId); if (p) p.write(msg.data); result = {}; break; }
        case 'ptyResize': { const p = ptys.get(msg.ptyId); if (p) p.resize(msg.cols, msg.rows); result = {}; break; }
        case 'ptyKill': { const p = ptys.get(msg.ptyId); if (p) { try { p.kill(); } catch {} ptys.delete(msg.ptyId); } result = {}; break; }
        default: throw new Error(`unknown op: ${op}`);
      }
      send({ id, ok: true, result });
    } catch (e) {
      send({ id, ok: false, error: e.message });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`ide-agent on :${PORT}`));
