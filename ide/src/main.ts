// Bivack IDE - the real VS Code workbench, backed by the VM over the
// authenticated WebSocket. File operations go to the in-VM agent on port 8082.
import '@codingame/monaco-vscode-theme-defaults-default-extension'

import * as monaco from 'monaco-editor'
import 'vscode/localExtensionHost'
import { StatusBarAlignment, window as vscodeWindow } from 'vscode'
import {
  initialize,
  type IWorkbenchConstructionOptions,
  LogLevel,
  IEditorOverrideServices,
} from '@codingame/monaco-vscode-api'
import { Action2, MenuId, registerAction2 } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
import type { EnvironmentOverride } from '@codingame/monaco-vscode-api/workbench'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getConfigurationServiceOverride, {
  configurationRegistry,
  getUserConfiguration,
  initUserConfiguration,
  updateUserConfiguration,
} from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getAuthenticationServiceOverride from '@codingame/monaco-vscode-authentication-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getWorkspaceTrustOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getSnippetServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override'
import getLanguageDetectionWorkerServiceOverride from '@codingame/monaco-vscode-language-detection-worker-service-override'
import getBannerServiceOverride from '@codingame/monaco-vscode-view-banner-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getTitleBarServiceOverride from '@codingame/monaco-vscode-view-title-bar-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import { registerFileSystemOverlay } from '@codingame/monaco-vscode-files-service-override'
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
import { WsFileSystemProvider } from './wsfs'
import { WsClient } from './wsclient'
import { BivackTerminalBackend } from './terminal'
import { loadConfig, getIdToken, fetchToken, type AppConfig } from './auth'
import { registerBivackAuth } from './authprovider'

const WORKSPACE = '/home/coder'

// Vite builds each worker and hands back its URL; Monaco creates them on
// demand. getWorkerUrl is required in addition to getWorker because the
// extension host worker is created from a URL, not an instance.
import editorWorkerUrl from 'monaco-editor/esm/vs/editor/editor.worker.js?worker&url'
import extensionHostWorkerUrl from '@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url'
import textMateWorkerUrl from '@codingame/monaco-vscode-textmate-service-override/worker?worker&url'
import outputLinkWorkerUrl from '@codingame/monaco-vscode-output-service-override/worker?worker&url'
import languageDetectionWorkerUrl from '@codingame/monaco-vscode-language-detection-worker-service-override/worker?worker&url'
import localFileSearchWorkerUrl from '@codingame/monaco-vscode-search-service-override/worker?worker&url'

const workerUrls: Record<string, string> = {
  editorWorkerService: editorWorkerUrl,
  extensionHostWorkerMain: extensionHostWorkerUrl,
  TextMateWorker: textMateWorkerUrl,
  OutputLinkDetectionWorker: outputLinkWorkerUrl,
  LanguageDetectionWorker: languageDetectionWorkerUrl,
  LocalFileSearchWorker: localFileSearchWorkerUrl,
}
window.MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string) {
    return workerUrls[label] ?? editorWorkerUrl
  },
  getWorkerOptions() {
    return { type: 'module' }
  },
}

const container = document.getElementById('workbench')!

function showMessage(html: string): void {
  container.innerHTML = `<div style="font:14px -apple-system,sans-serif;color:#c9d1d9;background:#0d1117;
    height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px">
    <div>${html}</div></div>`
}

function boot(text: string): void {
  const el = document.getElementById('boot-msg')
  if (el) el.textContent = text
}

// Open a fresh authenticated socket to the VM agent. Reused across reconnects;
// re-running the token flow also resumes the VM if it had suspended.
async function openWorkspaceSocket(): Promise<WebSocket> {
  if (!config) config = await loadConfig()
  boot('Signing in…')
  const jwt = await getIdToken(config)
  boot('Starting your workspace…')
  const { authToken, endpoint } = await fetchToken(config, jwt)
  const ws = new WebSocket(endpoint.replace(/^https?:\/\//, 'wss://') + '/', [
    'lambda-microvms',
    `lambda-microvms.authentication.${authToken}`,
    'lambda-microvms.port.8082',
  ])
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket to the workspace failed')), { once: true })
  })
  return ws
}

// Connect to the VM and register the WebSocket-backed file system BEFORE the
// workbench initializes (the workspace folder is read during init).
let client!: WsClient
let config: AppConfig | undefined
try {
  const ws = await openWorkspaceSocket()
  client = new WsClient(openWorkspaceSocket, ws)
  registerFileSystemOverlay(1, new WsFileSystemProvider(client))
} catch (e) {
  // Not signed in (or no session yet): use the shared login page.
  window.location.replace('../login/?next=' + encodeURIComponent('/ide/'))
  throw e
}

const services: IEditorOverrideServices = {
  ...getConfigurationServiceOverride(),
  ...getKeybindingsServiceOverride(),
  ...getModelServiceOverride(),
  ...getNotificationServiceOverride(),
  ...getDialogsServiceOverride(),
  ...getTextmateServiceOverride(),
  ...getThemeServiceOverride(),
  ...getLanguagesServiceOverride(),
  ...getStorageServiceOverride(),
  ...getSecretStorageServiceOverride(),
  ...getLogServiceOverride(),
  ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
  ...getExtensionGalleryServiceOverride({
    webOnly: true,
    // Open VSX has no per-extension "latest version" resource endpoint, so the
    // workbench's resource-API lookups 404 for every built-in extension. Drop
    // that resource from the manifest and let the gallery use its query API.
    transformExtensionGalleryManifest: (manifest) =>
      manifest && {
        ...manifest,
        resources: (manifest.resources ?? []).filter(
          (resource) => !resource.type.startsWith('ExtensionLatestVersionUriTemplate'),
        ),
      },
  }),
  ...getAuthenticationServiceOverride(),
  ...getEnvironmentServiceOverride(),
  ...getLifecycleServiceOverride(),
  ...getWorkspaceTrustOverride(),
  ...getSnippetServiceOverride(),
  ...getOutputServiceOverride(),
  ...getSearchServiceOverride(),
  ...getMarkersServiceOverride(),
  ...getAccessibilityServiceOverride(),
  ...getLanguageDetectionWorkerServiceOverride(),
  ...getBannerServiceOverride(),
  ...getStatusBarServiceOverride(),
  ...getTitleBarServiceOverride(),
  ...getExplorerServiceOverride(),
  ...getTerminalServiceOverride(new BivackTerminalBackend(client)),
  ...getWorkbenchServiceOverride(),
  ...getQuickAccessServiceOverride({
    isKeybindingConfigurationVisible: () => true,
    shouldUseGlobalPicker: () => true,
  }),
}

const options: IWorkbenchConstructionOptions = {
  enableWorkspaceTrust: false,
  workspaceProvider: {
    trusted: true,
    async open() {
      window.open(window.location.href)
      return true
    },
    workspace: { folderUri: monaco.Uri.file(WORKSPACE) },
  },
  developmentOptions: { logLevel: LogLevel.Info },
  productConfiguration: {
    nameShort: 'Bivack',
    nameLong: 'Bivack',
    // Extensions come from Open VSX (the public VS Code marketplace does not
    // permit third-party clients). Web extensions run in the worker host.
    extensionsGallery: {
      serviceUrl: 'https://open-vsx.org/vscode/gallery',
      resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
      extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
      controlUrl: '',
      nlsBaseUrl: '',
    },
  },
}

const envOptions: EnvironmentOverride = { userHome: monaco.Uri.file('/') }

// Default to a dark theme (the workspace is the user's own VM; trust is moot).
// The workbench infers the OS from the browser, so pin our remote zsh profile
// for every OS — otherwise a Windows/Mac browser offers pwsh/zsh and there is
// no local shell to launch.
const zshProfile = { path: '/usr/bin/zsh', args: [] }
// On touch devices the classic menu bar collapses and takes the hamburger with
// it, so those get the compact menu; pointer devices get the real File/Edit bar.
// The same split applies to the renderer: the GPU path's devicePixelRatio math
// desyncs the glyph grid on touch, while it is smoother on a desktop.
const touchDevice =
  window.matchMedia('(pointer: coarse)').matches ||
  window.matchMedia('(hover: none)').matches
const defaults: Record<string, unknown> = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.preferredDarkColorTheme': 'Default Dark Modern',
    // `compact` (a hamburger) is the web default; `classic` gives the File/Edit
    // menu bar. It collapses on touch, so keep compact there.
    'window.menuBarVisibility': touchDevice ? 'compact' : 'classic',
  // Auto-save did not persist edits reliably, so require a deliberate save; VS
  // Code prompts when closing a dirty file.
  'files.autoSave': 'off',
  // The home is the workspace, so the Explorer is otherwise full of tooling
  // dot-directories and files. Hidden by default; a user who wants them can edit
  // files.exclude. The VS Code built-ins are repeated so replacing the default
  // does not drop them.
  'files.exclude': {
    '**/.git': true,
    '**/.svn': true,
    '**/.hg': true,
    '**/CVS': true,
    '**/.DS_Store': true,
    '**/Thumbs.db': true,
    '**/.aws': true,
    '**/.cache': true,
    '**/.claude': true,
    '**/.claude.json': true,
    '**/.codex': true,
    '**/.config': true,
    '**/.kiro': true,
    '**/.local': true,
    '**/.npm': true,
    '**/.agents': true,
    '**/.zsh_history': true,
    '**/.zshrc': true,
    '**/.bashrc': true,
    '**/.gitconfig': true,
  },
  // The background (worker) tokenizer's state-sync dynamic import resolves to
  // undefined in this build and throws for every grammar. Tokenize on the main
  // thread instead; highlighting still works.
  'editor.experimental.asyncTokenization': false,
  // The GPU renderer computes cell width from devicePixelRatio, which desyncs
  // the glyph grid on touch; the DOM renderer avoids that. Elsewhere the GPU
  // renderer is much smoother for a redraw-heavy TUI.
  'terminal.integrated.gpuAcceleration': touchDevice ? 'off' : 'auto',
  'terminal.integrated.fontFamily': 'Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  'terminal.integrated.fontSize': 13,
  'terminal.integrated.defaultProfile.linux': 'zsh',
  'terminal.integrated.defaultProfile.osx': 'zsh',
  'terminal.integrated.defaultProfile.windows': 'zsh',
  'terminal.integrated.profiles.linux': { zsh: zshProfile },
  'terminal.integrated.profiles.osx': { zsh: zshProfile },
  'terminal.integrated.profiles.windows': { zsh: zshProfile },
}
// Register these as defaults, not user settings: everyone gets them, and a user
// can override any of them (files.exclude, files.autoSave, ...) and have it
// stick. The user settings file only needs to hold the user's own changes.
configurationRegistry.registerDefaultConfigurations([{ overrides: defaults }])
await initUserConfiguration('{}')

boot('Starting the editor…')
await initialize(services, container, options, envOptions)

// A way back to the chooser. The workbench has no route home, so register a
// command that navigates there and surface it in the File menu and the palette.
registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: 'bivack.home',
        title: 'Go to Bivack Home',
        f1: false,
        menu: [
          { id: MenuId.CommandPalette },
          { id: MenuId.MenubarFileMenu, group: '0_bivack', order: 0 },
        ],
      })
    }
    run(): void {
      window.location.href = '/'
    }
  },
)

// A status bar entry back to the chooser, so the action is reachable on touch
// devices too, where the File menu sits behind the compact menu.
const homeItem = vscodeWindow.createStatusBarItem(StatusBarAlignment.Left, 100)
homeItem.text = '$(home) Bivack'
homeItem.tooltip = 'Back to the Bivack chooser'
homeItem.command = 'bivack.home'
homeItem.show()

// The workbench is up; drop the boot overlay.
document.getElementById('boot')?.remove()

// One-time: early builds seeded files.autoSave into user settings, where it now
// overrides the default. Remove it (once) so the default off applies; afterwards
// the user is free to change it. Runs after initialize because it needs live
// services.
try {
  if (!localStorage.getItem('bivack.settings-migrated-v1')) {
    const stored = JSON.parse(await getUserConfiguration()) as Record<string, unknown>
    if ('files.autoSave' in stored || 'files.autoSaveDelay' in stored) {
      delete stored['files.autoSave']
      delete stored['files.autoSaveDelay']
      await updateUserConfiguration(JSON.stringify(stored))
    }
    localStorage.setItem('bivack.settings-migrated-v1', '1')
  }
} catch {
  // No stored settings yet, or storage unavailable.
}

// Some viewports (device emulation, mobile URL-bar changes) leave the workbench
// with a stale layout, and the terminal panel then draws its content offscreen
// until enough lines are written to fill the measured area. Nudge a relayout
// now, and again whenever the visual viewport changes.
const relayout = () => window.dispatchEvent(new Event('resize'))
requestAnimationFrame(relayout)
setTimeout(relayout, 500)
window.visualViewport?.addEventListener('resize', relayout)

// Language features load after the first paint so the workbench is not blocked
// on parsing them. Each is its own chunk, and they activate on the matching
// file type.
await Promise.all([
  import('@codingame/monaco-vscode-javascript-default-extension'),
  import('@codingame/monaco-vscode-typescript-basics-default-extension'),
  import('@codingame/monaco-vscode-typescript-language-features-default-extension'),
  import('@codingame/monaco-vscode-json-default-extension'),
  import('@codingame/monaco-vscode-json-language-features-default-extension'),
  import('@codingame/monaco-vscode-css-default-extension'),
  import('@codingame/monaco-vscode-html-default-extension'),
  import('@codingame/monaco-vscode-markdown-basics-default-extension'),
])

// Surface the signed-in Cognito user in the Accounts menu and to extensions.
if (config) registerBivackAuth(config)
