// Thin wrapper over the authenticated WebSocket to the VM agent: request and
// response by id, server-pushed events (ptyData, ptyExit, fsChange), and
// reconnection. The VM can suspend when idle, which drops the socket; the
// workbench keeps using the same client across reconnects, and calls made while
// disconnected are queued and flushed once the socket is back.
export type OpenSocket = () => Promise<WebSocket>

export class WsClient {
  private ws: WebSocket | null = null
  private seq = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<(m: { [k: string]: unknown }) => void>>()
  private queue: string[] = []
  private reconnectDelay = 1000
  private reconnecting = false
  private keepalive = 0
  private reconnected = new Set<() => void>()

  constructor(
    private readonly open: OpenSocket,
    initial: WebSocket,
  ) {
    this.adopt(initial)
  }

  private adopt(ws: WebSocket): void {
    this.ws = ws
    this.reconnectDelay = 1000
    ws.addEventListener('message', (ev) => this.onMessage(ev))
    ws.addEventListener('close', () => this.onClose(ws))
    for (const msg of this.queue) ws.send(msg)
    this.queue = []
    // Keepalive: the ingress drops an idle socket, and the agent kills its
    // PTYs when the socket closes. A NUL byte every 15s (ignored by the agent,
    // which only parses JSON) keeps it open, same as the terminal tab.
    clearInterval(this.keepalive)
    this.keepalive = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send('\0') } catch { /* closed between checks */ }
      }
    }, 15000)
  }

  private onMessage(ev: MessageEvent): void {
    let m: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string }
    try {
      m = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    } catch {
      return
    }
    // Events are checked first: PTY events also carry an id (the pty id),
    // which must not be mistaken for a response id.
    if (typeof m.event === 'string') {
      this.listeners.get(m.event)?.forEach((fn) => fn(m as { [k: string]: unknown }))
    } else if (typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.resolve(m.result)
      else p.reject(new Error(m.error || 'error'))
    }
  }

  private onClose(ws: WebSocket): void {
    if (ws !== this.ws) return
    this.ws = null
    clearInterval(this.keepalive)
    for (const [, p] of this.pending) p.reject(new Error('The workspace connection dropped'))
    this.pending.clear()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.ws) return
    this.reconnecting = true
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000)
    setTimeout(() => {
      this.open()
        .then((ws) => {
          this.reconnecting = false
          if (!this.ws) {
            this.adopt(ws)
            for (const fn of this.reconnected) { try { fn() } catch { /* listener error */ } }
          }
        })
        .catch(() => {
          this.reconnecting = false
          this.scheduleReconnect()
        })
    }, delay)
  }

  call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.seq++
    const msg = JSON.stringify({ id, op, ...args })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg)
      else this.queue.push(msg)
    })
  }

  on(event: string, fn: (m: { [k: string]: unknown }) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)?.add(fn)
    return () => {
      this.listeners.get(event)?.delete(fn)
    }
  }

  // Fires after the socket is re-established (not on the first connect), so
  // stateful consumers like terminals can re-attach to the server.
  onReconnected(fn: () => void): () => void {
    this.reconnected.add(fn)
    return () => {
      this.reconnected.delete(fn)
    }
  }
}
