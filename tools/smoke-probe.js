#!/usr/bin/env node
// Smoke probe for deploy.sh.
//
// Connects to a freshly launched MicroVM over SHELL_INGRESS and checks the two
// things that have silently broken before and that the HTTP-only smoke test
// cannot see:
//   1. the S3 Files home actually mounted at /home/coder (nfs)
//   2. outbound internet works (the NAT path)
// Exits non-zero if either is wrong, so deploy.sh fails loudly instead of
// reporting success on a VM that can't do useful work.
//
// Usage: node smoke-probe.js <endpoint> <shell-auth-token>
// Uses Node's built-in WebSocket (Node 22+), so there is no dependency to install.

const endpoint = process.argv[2];
const token = process.argv[3];
if (!endpoint || !token) {
  console.error('usage: smoke-probe.js <endpoint> <shell-auth-token>');
  process.exit(2);
}

const url = endpoint.replace(/^https?:\/\//, 'wss://') + '/';
const protocols = ['lambda-microvms', `lambda-microvms.authentication.${token}`, 'shell'];

const START = '__RUN_BEGIN__';
const END = '__RUN_END__';
// Wait up to ~40s for the async S3 Files mount, then report mount + internet.
const cmd = [
  `for i in $(seq 1 20); do grep -q ' /home/coder ' /proc/mounts && break; sleep 2; done`,
  `grep -q ' /home/coder ' /proc/mounts && echo __MOUNT_OK__ || echo __MOUNT_FAIL__`,
  `code=$(curl -sS -o /dev/null -w '%{http_code}' -m 20 https://api.anthropic.com)`,
  `[ -n "$code" ] && [ "$code" != "000" ] && echo __NET_OK__ || echo "__NET_FAIL__:$code"`,
].join('\n');

const ws = new WebSocket(url, protocols);
ws.binaryType = 'arraybuffer';

let out = '';
let started = false;
const killer = setTimeout(() => {
  console.error('smoke-probe: TIMEOUT waiting for the VM');
  process.exit(1);
}, 120000);

function finish(ok, body) {
  clearTimeout(killer);
  const mountOk = body.includes('__MOUNT_OK__');
  const netOk = body.includes('__NET_OK__');
  console.log(`  s3 files mount: ${mountOk ? 'OK' : 'FAIL'}`);
  console.log(`  outbound internet: ${netOk ? 'OK' : 'FAIL'}`);
  if (!mountOk || !netOk) console.error(body.trim());
  try { ws.close(); } catch {}
  process.exit(ok && mountOk && netOk ? 0 : 1);
}

ws.addEventListener('message', (ev) => {
  const s = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
  if (!started && s.trimStart().startsWith('{"type":"session_init"')) {
    started = true;
    const b64 = Buffer.from(cmd).toString('base64');
    setTimeout(() => {
      ws.send(`echo ${START}; echo ${b64} | base64 -d | bash 2>&1; echo ${END}\n`);
    }, 300);
    return;
  }
  started = true;
  out += s;
  const lines = out.split('\n')
    .map((l) => l.replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  const b = lines.findIndex((l) => l.trim() === START);
  const e = lines.findIndex((l) => l.trim() === END);
  if (b !== -1 && e !== -1 && e > b) {
    finish(true, lines.slice(b + 1, e).join('\n'));
  }
});

ws.addEventListener('error', () => {
  console.error('smoke-probe: WebSocket error');
  process.exit(1);
});

ws.addEventListener('close', () => {
  if (!out) {
    console.error('smoke-probe: connection closed before the probe ran');
    process.exit(1);
  }
});
