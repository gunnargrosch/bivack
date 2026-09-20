// VS Code terminal backend backed by a PTY in the VM over the same
// authenticated socket. The terminal panel is rendered by the
// terminal-service-override; we only create and feed the process.
import * as vscode from 'vscode'
import {
  SimpleTerminalBackend,
  SimpleTerminalProcess,
  type ITerminalChildProcess,
} from '@codingame/monaco-vscode-terminal-service-override'
import type { ITerminalProfile } from '@codingame/monaco-vscode-api/vscode/vs/platform/terminal/common/terminal'
import { ProcessPropertyType } from '@codingame/monaco-vscode-api/vscode/vs/platform/terminal/common/terminal'
import type { WsClient } from './wsclient'

let nextId = 1
// PTY ids are global in the agent (they outlive a socket), so namespace them per
// page to keep two open tabs from colliding.
const sessionId = Math.random().toString(36).slice(2, 8)

class BivackTerminalProcess extends SimpleTerminalProcess {
  private readonly _out: vscode.EventEmitter<string>
  private readonly _exit: vscode.EventEmitter<number>
  private disposers: Array<() => void> = []
  private cols: number
  private rows: number
  private readonly ptyId: string

  constructor(
    private readonly client: WsClient,
    id: number,
    cols: number,
    rows: number,
    cwd: string,
  ) {
    const out = new vscode.EventEmitter<string>()
    super(id, id, cwd, out.event)
    this._out = out
    this._exit = new vscode.EventEmitter<number>()
    this.onProcessExit = this._exit.event
    this.cols = cols
    this.rows = rows
    this.ptyId = `${sessionId}-${id}`
    // The workbench refreshes the process Cwd on Enter, and the base returns
    // undefined, which it rejects as "cwd is not a string". Report the real cwd.
    this.refreshProperty = ((type?: string) =>
      Promise.resolve(
        type === ProcessPropertyType.Cwd || type === ProcessPropertyType.InitialCwd
          ? this.cwd
          : undefined,
      )) as unknown as typeof this.refreshProperty
  }

  async start(): Promise<undefined> {
    this.disposers.push(
      this.client.on('ptyData', (m) => {
        if (m.ptyId === this.ptyId) this._out.fire(m.data as string)
      }),
    )
    this.disposers.push(
      this.client.on('ptyExit', (m) => {
        if (m.ptyId === this.ptyId) this._exit.fire(m.code as number)
      }),
    )
    // After a reconnect the agent still holds the shell, so re-attach to it
    // (createPty is idempotent). Ctrl-L makes the shell redraw the prompt that
    // was printed while the socket was down.
    this.disposers.push(
      this.client.onReconnected(() => {
        void this.client
          .call('createPty', { ptyId: this.ptyId, cols: this.cols, rows: this.rows, cwd: this.cwd })
          .then(() => this.client.call('ptyInput', { ptyId: this.ptyId, data: '\u000c' }))
          .catch(() => { /* dropped again; the next reconnect retries */ })
      }),
    )
    await this.client.call('createPty', {
      ptyId: this.ptyId,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
    })
    return undefined
  }

  input(data: string): void {
    void this.client.call('ptyInput', { ptyId: this.ptyId, data })
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    void this.client.call('ptyResize', { ptyId: this.ptyId, cols, rows })
  }
  shutdown(): void {
    for (const d of this.disposers) d()
    this.disposers = []
    void this.client.call('ptyKill', { ptyId: this.ptyId })
  }
  clearBuffer(): void {}
  sendSignal(): void {}
}

export class BivackTerminalBackend extends SimpleTerminalBackend {
  constructor(private readonly client: WsClient) {
    super()
  }
  // The base returns no profiles, so VS Code has nothing to launch.
  getProfiles = async (): Promise<ITerminalProfile[]> => [
    {
      profileName: 'zsh',
      path: '/usr/bin/zsh',
      isDefault: true,
      isAutoDetected: false,
      args: [],
    },
  ]
  getDefaultSystemShell = async (): Promise<string> => '/usr/bin/zsh'
  createProcess = async (...args: unknown[]): Promise<ITerminalChildProcess> => {
    const [, , cols, rows] = args as [unknown, unknown, number, number]
    // Ignore VS Code's cwd: on a Windows/Mac browser it resolves a non-POSIX
    // path against the local OS, which is wrong for the remote VM.
    return new BivackTerminalProcess(this.client, nextId++, cols, rows, '/home/coder')
  }
}
