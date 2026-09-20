// FileSystemProvider backed by the VM's IDE agent over the authenticated
// socket. Confined to /home/coder by the agent; here we marshal calls and
// translate the agent's fsChange events into VS Code file-change events.
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import type { IDisposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'
import { FileSystemError } from 'vscode'
import {
  FileSystemProviderCapabilities,
  FileChangeType,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IStat,
  type IFileWriteOptions,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IWatchOptions,
  type IFileChange,
} from '@codingame/monaco-vscode-files-service-override'
import type { WsClient } from './wsclient'

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}
function toBytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  return new Uint8Array(0)
}

function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

// The agent reports raw Node errors. Map the common ones to FileSystemError so
// the workbench treats them as expected conditions (a missing settings.json is
// probed on every folder open) instead of logging them at error level.
function toFsError(e: unknown, resource: URI): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/\bENOENT\b|no such file/i.test(msg)) return FileSystemError.FileNotFound(resource)
  if (/\bEEXIST\b|already exists/i.test(msg)) return FileSystemError.FileExists(resource)
  if (/\b(EACCES|EPERM)\b|permission denied/i.test(msg)) return FileSystemError.NoPermissions(resource)
  return e instanceof Error ? e : new Error(msg)
}

export class WsFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  capabilities =
    FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive

  private _onDidChangeCapabilities = new Emitter<void>()
  onDidChangeCapabilities = this._onDidChangeCapabilities.event
  private _onDidChangeFile = new Emitter<readonly IFileChange[]>()
  onDidChangeFile = this._onDidChangeFile.event

  constructor(private readonly client: WsClient) {
    client.on('fsChange', (m) => {
      const path = m.path as string
      const exists = m.exists as boolean
      const kind = m.kind as string
      let type: FileChangeType
      if (!exists) type = FileChangeType.DELETED
      else if (kind === 'rename') type = FileChangeType.ADDED
      else type = FileChangeType.UPDATED
      this._onDidChangeFile.fire([{ type, resource: URI.file(path) }])
    })
  }

  async stat(resource: URI): Promise<IStat> {
    try {
      return (await this.client.call('stat', { path: resource.path })) as IStat
    } catch (e) {
      throw toFsError(e, resource)
    }
  }
  async readdir(resource: URI): Promise<[string, number][]> {
    try {
      return (await this.client.call('readDirectory', {
        path: resource.path,
      })) as [string, number][]
    } catch (e) {
      throw toFsError(e, resource)
    }
  }
  async readFile(resource: URI): Promise<Uint8Array> {
    try {
      const b64 = (await this.client.call('readFile', { path: resource.path })) as string
      return b64ToBytes(b64)
    } catch (e) {
      throw toFsError(e, resource)
    }
  }
  async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    try {
      await this.client.call('writeFile', {
        path: resource.path,
        content: bytesToB64(toBytes(content)),
        options: opts,
      })
    } catch (e) {
      throw toFsError(e, resource)
    }
    this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }])
  }
  async mkdir(resource: URI): Promise<void> {
    try {
      await this.client.call('createDirectory', { path: resource.path })
    } catch (e) {
      throw toFsError(e, resource)
    }
    this._onDidChangeFile.fire([{ type: FileChangeType.ADDED, resource }])
  }
  async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
    try {
      await this.client.call('delete', { path: resource.path, options: opts })
    } catch (e) {
      throw toFsError(e, resource)
    }
    this._onDidChangeFile.fire([{ type: FileChangeType.DELETED, resource }])
  }
  async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
    try {
      await this.client.call('rename', { path: from.path, newPath: to.path, options: opts })
    } catch (e) {
      throw toFsError(e, from)
    }
    this._onDidChangeFile.fire([
      { type: FileChangeType.DELETED, resource: from },
      { type: FileChangeType.ADDED, resource: to },
    ])
  }
  watch(_resource: URI, _opts: IWatchOptions): IDisposable {
    // One recursive watcher in the agent covers the whole workspace.
    void this.client.call('watch', {})
    return { dispose() {} }
  }
}
