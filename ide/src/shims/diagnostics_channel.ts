// Browser shim for `node:diagnostics_channel`, which @xterm/addon-ligatures
// (pulled in by the VS Code terminal service) imports transitively. Node
// diagnostics channels are meaningless in the browser, so these are no-ops.
type Channel = {
  hasSubscribers: boolean
  subscribe: (fn: (msg: unknown) => void) => void
  unsubscribe: (fn: (msg: unknown) => void) => void
  publish: (msg: unknown) => void
}

function makeChannel(): Channel {
  return { hasSubscribers: false, subscribe() {}, unsubscribe() {}, publish() {} }
}

export function channel(_name?: string): Channel {
  return makeChannel()
}

export function tracingChannel(_name?: string): Record<string, Channel> {
  return {
    start: makeChannel(),
    end: makeChannel(),
    asyncStart: makeChannel(),
    asyncEnd: makeChannel(),
    error: makeChannel(),
  }
}

export function hasSubscribers(_name?: string): boolean {
  return false
}

export default { channel, tracingChannel, hasSubscribers }
