import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { AgentEvent, AppSettings, ApprovalDecision, ProjectSettings, Role } from '@shared/types'
import { AgentRunner, type QueryFn } from './agentRunner'
import { CostTracker } from './costs'
import { gitCommit, gitDiff, gitInit, gitRevertFile, gitStatus } from './git'
import { JsonStore } from './jsonStore'
import { KeyProxy } from './keyProxy'
import { ProjectRegistry } from './projects'
import { deleteRole, installTemplates, listRoles, saveRole } from './roles'
import { SecretStore } from './secrets'

const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: 'claude-sonnet-5-5',
  maxConcurrentRuns: 3,
  perRunBudgetUsd: 2,
  globalDailyBudgetUsd: 20,
  studioMcpCommand: '',
  studioMcpArgs: [],
  hideKeyFromAgents: true
}

let mainWindow: BrowserWindow | null = null

// Single instance: a second launch focuses the existing window instead of running twice.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const dataDir = (): string => app.getPath('userData')

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'Hangar',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win.show())

  // Never open new windows inside the app; send real web links to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Block navigation and redirects away from the app UI, and never allow embedded webviews.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  win.webContents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

const APP_FILE_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href

/** True only for the app's own page: the exact bundled index.html (or the dev server in development). */
function isAppUrl(url: string): boolean {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && dev) {
    try {
      return new URL(url).origin === new URL(dev).origin
    } catch {
      return false
    }
  }
  return url.split('#')[0]!.split('?')[0] === APP_FILE_URL
}

/** Only accept IPC from our own UI, never from any other frame or page. */
function guard<A extends unknown[], R>(handler: (...args: A) => R | Promise<R>) {
  return async (event: IpcMainInvokeEvent, ...args: A): Promise<R> => {
    const url = event.senderFrame?.url ?? ''
    if (!isAppUrl(url)) throw new Error('Blocked IPC from an untrusted frame.')
    return handler(...args)
  }
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length > 50000) throw new Error(`Invalid ${name}.`)
  return v
}

function sanitizeAppSettings(patch: Partial<AppSettings>, current: AppSettings): AppSettings {
  const num = (v: unknown, min: number, max: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
  const next = { ...current }
  if (typeof patch.defaultModel === 'string' && patch.defaultModel.trim()) next.defaultModel = patch.defaultModel.trim()
  if (patch.maxConcurrentRuns !== undefined) next.maxConcurrentRuns = Math.round(num(patch.maxConcurrentRuns, 1, 6, current.maxConcurrentRuns))
  if (patch.perRunBudgetUsd !== undefined) next.perRunBudgetUsd = num(patch.perRunBudgetUsd, 0.05, 25, current.perRunBudgetUsd)
  if (patch.globalDailyBudgetUsd !== undefined) {
    next.globalDailyBudgetUsd = patch.globalDailyBudgetUsd === null ? null : num(patch.globalDailyBudgetUsd, 0.1, 10000, 20)
  }
  if (typeof patch.studioMcpCommand === 'string') next.studioMcpCommand = patch.studioMcpCommand.trim()
  if (Array.isArray(patch.studioMcpArgs)) next.studioMcpArgs = patch.studioMcpArgs.filter((a): a is string => typeof a === 'string')
  if (typeof patch.hideKeyFromAgents === 'boolean') next.hideKeyFromAgents = patch.hideKeyFromAgents
  return next
}

app.whenReady().then(() => {
  const settings = new JsonStore<AppSettings>(join(dataDir(), 'settings.json'), DEFAULT_SETTINGS)
  const secrets = new SecretStore(join(dataDir(), 'anthropic-key.bin'))
  const registry = new ProjectRegistry(join(dataDir(), 'projects.json'))
  const costs = new CostTracker(join(dataDir(), 'costs.json'))
  const keyProxy = new KeyProxy(() => secrets.getKey())

  const emit = (event: AgentEvent): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.agentEvent, event)
  }

  const runner = new AgentRunner({
    registry,
    costs,
    emit,
    getSettings: () => settings.get(),
    getApiKey: () => secrets.getKey(),
    engineAuth: async (apiKey): Promise<{ env: Record<string, string>; release: () => void }> => {
      if (!settings.get().hideKeyFromAgents) return { env: { ANTHROPIC_API_KEY: apiKey }, release: () => {} }
      await keyProxy.start()
      const token = keyProxy.issueToken()
      return {
        env: { ANTHROPIC_BASE_URL: keyProxy.baseUrl(), ANTHROPIC_API_KEY: token },
        release: () => keyProxy.revokeToken(token)
      }
    },
    persistFile: join(dataDir(), 'agents.json'),
    trustFile: join(dataDir(), 'trusted-project-config.json'),
    loadQuery: async () => {
      const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as { query: QueryFn }
      return sdk.query
    }
  })

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void => {
    ipcMain.handle(channel, guard(fn))
  }

  // Settings and key
  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsSet, (patch: Partial<AppSettings>) => settings.set(sanitizeAppSettings(patch ?? {}, settings.get())))
  handle(IPC.keyStatus, () => secrets.status())
  handle(IPC.keySet, (key: unknown) => secrets.setKey(str(key, 'key')))
  handle(IPC.keyClear, () => secrets.clear())

  // Projects
  handle(IPC.projectsList, () => registry.list())
  handle(IPC.projectsAdd, async () => {
    const opts = { title: 'Choose a project folder', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    return registry.add(res.filePaths[0])
  })
  handle(IPC.projectsRemove, (id: unknown) => {
    const projectId = str(id, 'project')
    for (const s of runner.snapshot(projectId)) runner.stop(projectId, s.agentId)
    registry.remove(projectId)
  })
  handle(IPC.projectsUpdate, (id: unknown, patch: { name?: string; settings?: Partial<ProjectSettings> }) =>
    registry.update(str(id, 'project'), patch ?? {})
  )
  handle(IPC.projectsReveal, async (id: unknown) => {
    await shell.openPath(registry.get(str(id, 'project')).path)
  })

  // Roles
  const root = (id: unknown): string => registry.get(str(id, 'project')).path
  handle(IPC.rolesList, (id: unknown) => listRoles(root(id)))
  handle(IPC.rolesInstallTemplates, (id: unknown) => {
    installTemplates(root(id))
    return listRoles(root(id))
  })
  handle(IPC.rolesSave, (id: unknown, role: Role) => {
    if (!role || typeof role !== 'object') throw new Error('Invalid role.')
    if (role.id === 'main') throw new Error('"main" is reserved.')
    saveRole(root(id), {
      id: typeof role.id === 'string' ? role.id : '',
      name: str(role.name, 'name').slice(0, 60),
      description: str(role.description ?? '', 'description').slice(0, 500),
      prompt: str(role.prompt, 'instructions'),
      ...(Array.isArray(role.tools) && role.tools.length ? { tools: role.tools.filter((t) => typeof t === 'string') } : {}),
      ...(typeof role.model === 'string' && role.model.trim() ? { model: role.model.trim() } : {})
    })
    return listRoles(root(id))
  })
  handle(IPC.rolesDelete, (id: unknown, roleId: unknown) => {
    runner.stop(str(id, 'project'), str(roleId, 'role'))
    deleteRole(root(id), str(roleId, 'role'))
    return listRoles(root(id))
  })

  // Agents
  handle(IPC.agentsSnapshot, (id: unknown) => runner.snapshot(str(id, 'project')))
  handle(IPC.agentsSend, (id: unknown, agentId: unknown, prompt: unknown) =>
    runner.send(str(id, 'project'), str(agentId, 'agent'), str(prompt, 'prompt'))
  )
  handle(IPC.agentsStop, (id: unknown, agentId: unknown) => runner.stop(str(id, 'project'), str(agentId, 'agent')))
  handle(IPC.agentsStopAll, () => runner.stopAll())
  handle(IPC.agentsClearQueue, (id: unknown, agentId: unknown) => runner.clearQueue(str(id, 'project'), str(agentId, 'agent')))
  handle(IPC.agentsResetSession, (id: unknown, agentId: unknown) => runner.resetSession(str(id, 'project'), str(agentId, 'agent')))

  // Approvals
  handle(IPC.approvalsPending, () => runner.pendingApprovals())
  handle(IPC.approvalsRespond, (id: unknown, decision: unknown) => {
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'always') throw new Error('Invalid decision.')
    runner.respond(str(id, 'approval'), decision as ApprovalDecision)
  })

  // Git
  handle(IPC.gitStatus, (id: unknown) => gitStatus(root(id)))
  handle(IPC.gitDiff, (id: unknown, file?: unknown) => gitDiff(root(id), file === undefined ? undefined : str(file, 'file')))
  handle(IPC.gitCommit, (id: unknown, message: unknown) => gitCommit(root(id), str(message, 'message')))
  handle(IPC.gitRevertFile, async (id: unknown, file: unknown) => {
    const projectRoot = root(id)
    const f = str(file, 'file')
    const outcome = await gitRevertFile(projectRoot, f)
    // New files go to the OS trash rather than being deleted, so a revert is always recoverable.
    if (outcome === 'untracked') await shell.trashItem(join(projectRoot, f))
  })
  handle(IPC.gitInit, (id: unknown) => gitInit(root(id)))

  // Costs
  handle(IPC.costsSummary, () => costs.summary())

  mainWindow = createWindow()

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('before-quit', () => {
    runner.stopAll()
    keyProxy.stop()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
