import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC, type KeyStatus } from '@shared/ipc'
import type { AgentEvent, AppSettings, ApprovalDecision, ProjectSettings, Role } from '@shared/types'
import { AgentRunner, buildAgentEnv, type QueryFn } from './agentRunner'
import { probePlanUsage } from './planUsageProbe'
import { CostTracker, DEFAULT_PLAN_LIMITS } from './costs'
import { gitCommit, gitDiff, gitInit, gitRevertFile, gitStatus, setNoHooksBase } from './git'
import { scrubProcessEnv } from './env'
import { JsonStore } from './jsonStore'
import { KeyProxy } from './keyProxy'
import { StudioClipRecorder } from './clips'
import { RemoteServer } from './remote'
import { ReviewActions } from './reviewActions'
import { ReviewPipeline } from './reviewPipeline'
import { runChecks } from './checks'
import { TaskReviewer } from './taskReviewer'
import { WebEgressProxy } from './webEgress'
import { Autopilot } from './autopilot'
import { createGameProject, sanitizeNewGame, MAX_DOCUMENT } from './scaffold'
import { Trends } from './trending'
import { SUGGESTED_CHECKS } from './checks'
import { resolveCommand } from './testPlace'
import { readFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { ReviewStore } from './reviews'
import { TestPlacePublisher } from './testPlace'
import { TestPlaceKeys } from './testPlaceKeys'
import { createVault, vaultStatus } from './vault'
import { ProjectRegistry } from './projects'
import { deleteRole, installTemplates, listRoles, saveRole } from './roles'
import { SecretStore } from './secrets'
import { EngineCredentials, validateMaxToken, type EngineAuth } from './engineCredentials'

const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: 'claude-sonnet-5-5',
  maxConcurrentRuns: 3,
  perRunBudgetUsd: 2,
  globalDailyBudgetUsd: 20,
  studioMcpCommand: '',
  studioMcpArgs: [],
  hideKeyFromAgents: true,
  rojoCommand: 'rojo',
  authMode: 'apiKey',
  planLimits: DEFAULT_PLAN_LIMITS
}

let mainWindow: BrowserWindow | null = null

// Credentials in Hangar's own environment (cloud, GitHub, npm tokens…) are removed before anything
// starts, so no child process can inherit them however it builds its environment.
scrubProcessEnv()

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
  // Links can come from agent or web content (research sources), so say where it goes before opening.
  win.webContents.setWindowOpenHandler(({ url }) => {
    let host = ''
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' && !u.username && !u.password) host = u.host
    } catch {
      // not a URL
    }
    if (host) {
      void dialog
        .showMessageBox(win, { type: 'question', buttons: ['Open in browser', 'Cancel'], defaultId: 1, cancelId: 1, message: `Open ${host} in your browser?`, detail: url.slice(0, 500) })
        .then((r) => {
          if (r.response === 0) void shell.openExternal(url)
        })
    }
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
  if (patch.planLimits && typeof patch.planLimits === 'object') {
    const cur = current.planLimits ?? DEFAULT_PLAN_LIMITS
    next.planLimits = {
      fiveHourPct: Math.round(num(patch.planLimits.fiveHourPct, 5, 100, cur.fiveHourPct)),
      weeklyPct: Math.round(num(patch.planLimits.weeklyPct, 5, 100, cur.weeklyPct))
    }
  }
  // Claude Max mode is for the owner's own use while developing; packaged builds never turn it on.
  if (patch.authMode === 'apiKey' || (patch.authMode === 'max' && !app.isPackaged)) next.authMode = patch.authMode
  if (typeof patch.rojoCommand === 'string' && patch.rojoCommand.trim()) next.rojoCommand = patch.rojoCommand.trim().slice(0, 500)
  return next
}

app.whenReady().then(() => {
  // Never run with a project folder as the working directory: on Windows, programs started by name are
  // looked up there first.
  try {
    process.chdir(dataDir())
  } catch {
    // keep the default
  }
  setNoHooksBase(dataDir())
  // The UI never needs the camera, microphone, notifications, location or similar; refuse them all.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  const settings = new JsonStore<AppSettings>(join(dataDir(), 'settings.json'), DEFAULT_SETTINGS)
  // A settings file can't switch a shipped build into Claude Max mode (it would also swap the dollar limits out).
  if (app.isPackaged && settings.get().authMode === 'max') settings.set({ ...settings.get(), authMode: 'apiKey' })
  const secrets = new SecretStore(join(dataDir(), 'anthropic-key.bin'))
  const registry = new ProjectRegistry(join(dataDir(), 'projects.json'))
  const costs = new CostTracker(join(dataDir(), 'costs.json'))
  const maxToken = new SecretStore(join(dataDir(), 'claude-max-token.bin'), validateMaxToken)
  const keyProxy = new KeyProxy(() => secrets.getKey())
  const credentials = new EngineCredentials({
    personalModeAllowed: !app.isPackaged,
    getSettings: () => settings.get(),
    getApiKey: () => secrets.getKey(),
    getMaxToken: () => maxToken.getKey(),
    keyProxy
  })
  const keyStatus = (): KeyStatus => {
    const api = secrets.status()
    const hasMaxToken = !app.isPackaged && maxToken.status().hasKey
    return { ...api, maxAvailable: !app.isPackaged, hasMaxToken, ready: credentials.usingMax() ? hasMaxToken : api.hasKey }
  }
  const webEgress = new WebEgressProxy()

  const reviews = new ReviewStore(join(dataDir(), 'reviews.json'), (r) => r.clip && StudioClipRecorder.remove(r.clip.files))
  const testPlaceKeys = new TestPlaceKeys(dataDir())
  let remote: RemoteServer | null = null
  let pipeline: ReviewPipeline | null = null
  let autopilot: Autopilot | null = null
  const emit = (event: AgentEvent): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.agentEvent, event)
    remote?.onEvent(event)
    if (event.type === 'review') autopilot?.onReview(event.review)
  }

  const engineAuth = (credential: string, opts: { forceHideKey: boolean }): Promise<EngineAuth> => credentials.auth(credential, opts)
  const getCredential = (): string | null => credentials.get()
  let loggedPlanUsage = false
  const loadQuery = async (): Promise<QueryFn> => {
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as { query: QueryFn }
    // Every engine run reports Claude plan usage (Claude Max mode) as it changes; keep it for limits and the UI.
    return (args) =>
      (async function* () {
        try {
          yield* costs.watch(sdk.query(args), (info) => {
            if (!loggedPlanUsage) {
              loggedPlanUsage = true
              console.log(`[plan usage] first report from a run: ${info.rateLimitType} utilization=${info.utilization} resetsAt=${info.resetsAt} status=${info.status}`)
            }
            emit({ type: 'cost', summary: costs.summary() })
          })
        } finally {
          schedulePlanRefresh()
        }
      })()
  }

  // Claude Max mode: ask the plan for its exact 5-hour and weekly usage (what /usage shows). Sends no prompt.
  let planRefreshing: Promise<void> | null = null
  let planRefreshTimer: NodeJS.Timeout | null = null
  const refreshPlanUsage = (): Promise<void> => {
    planRefreshing ??= (async () => {
      const token = credentials.usingMax() ? credentials.get() : null
      if (!token) return
      const auth = await credentials.auth(token, { forceHideKey: false })
      try {
        const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as { query: Parameters<typeof probePlanUsage>[0] }
        // A `claude setup-token` token can only run models, not read usage. The owner's own Claude Code
        // login (`claude auth login`) can; the engine reads that login itself, so Hangar never sees it.
        const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _quiet, CLAUDE_CODE_OAUTH_TOKEN: _token, ...ownLogin } = buildAgentEnv(auth.env)
        const attempts: [string, Record<string, string>][] = [
          ['your Claude Code login', ownLogin],
          ['the Max token', buildAgentEnv(auth.env)]
        ]
        const failures: string[] = []
        for (const [label, env] of attempts) {
          const { answer, reason } = await probePlanUsage(sdk.query, env)
          if (!answer?.rate_limits) {
            failures.push(`${label}: ${reason}`)
            continue
          }
          if (costs.recordPlanAnswer(answer.rate_limits)) emit({ type: 'cost', summary: costs.summary() })
          return
        }
        console.log(`[plan usage] couldn't read plan usage. Sign in with \`claude auth login\` to show it. (${failures.join('; ')})`)
      } finally {
        auth.release()
      }
    })().finally(() => (planRefreshing = null))
    return planRefreshing
  }
  // After a run ends, check again shortly (several runs ending together share one check).
  const schedulePlanRefresh = (): void => {
    if (planRefreshTimer || !credentials.usingMax()) return
    planRefreshTimer = setTimeout(() => {
      planRefreshTimer = null
      void refreshPlanUsage()
    }, 15_000)
  }
  void refreshPlanUsage()
  setInterval(() => void refreshPlanUsage(), 10 * 60 * 1000).unref()

  const runner = new AgentRunner({
    registry,
    costs,
    emit,
    onReview: (r) => void pipeline?.start(r),
    onTaskDone: (o) => autopilot?.onTaskDone(o),
    researchProxy: () => webEgress.issue(),
    getSettings: () => settings.get(),
    getApiKey: getCredential,
    engineAuth,
    persistFile: join(dataDir(), 'agents.json'),
    trustFile: join(dataDir(), 'trusted-project-config.json'),
    appDataDir: dataDir(),
    reviews,
    clips: new StudioClipRecorder(join(dataDir(), 'clips')),
    loadQuery
  })

  pipeline = new ReviewPipeline({
    registry,
    reviews,
    emit,
    runChecks: (project, review) => runChecks(project, review, { workDir: join(dataDir(), 'builds'), appDataDir: dataDir() }),
    reviewer: new TaskReviewer({ loadQuery, engineAuth, getApiKey: getCredential, getSettings: () => settings.get(), costs, workDir: join(dataDir(), 'builds') })
  })

  const reviewActions = new ReviewActions({
    registry,
    reviews,
    runner,
    emit,
    publisher: new TestPlacePublisher({ registry, keys: testPlaceKeys, rojoCommand: () => settings.get().rojoCommand, workDir: join(dataDir(), 'builds') }),
    pipeline
  })
  autopilot = new Autopilot({
    file: join(dataDir(), 'autopilot.json'),
    registry,
    reviews,
    costs,
    emit,
    send: (projectId, agentId, prompt, opts) => runner.send(projectId, agentId, prompt, opts),
    merge: (id) => reviewActions.merge(id)
  })
  const trends = new Trends(join(dataDir(), 'trends.json'), { loadQuery, getApiKey: getCredential, getSettings: () => settings.get(), engineAuth, costs })
  remote = new RemoteServer(join(dataDir(), 'remote.json'), { registry, runner, reviews: reviewActions, costs, autopilot })
  void remote.start().catch(() => undefined)

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void => {
    ipcMain.handle(channel, guard(fn))
  }

  // Settings and key
  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsSet, (patch: Partial<AppSettings>) => {
    const next = settings.set(sanitizeAppSettings(patch ?? {}, settings.get()))
    if (patch?.authMode === 'max') void refreshPlanUsage()
    return next
  })
  handle(IPC.keyStatus, () => keyStatus())
  handle(IPC.keySet, (key: unknown) => {
    secrets.setKey(str(key, 'key'))
    return keyStatus()
  })
  handle(IPC.keyClear, () => {
    secrets.clear()
    return keyStatus()
  })
  handle(IPC.maxTokenSet, (token: unknown) => {
    if (app.isPackaged) throw new Error('Claude Max mode is only available in development builds.')
    maxToken.setKey(str(token, 'token'))
    return keyStatus()
  })
  handle(IPC.maxTokenClear, () => {
    maxToken.clear()
    return keyStatus()
  })

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
    autopilot?.stop(projectId)
    for (const s of runner.snapshot(projectId)) runner.stop(projectId, s.agentId)
    registry.remove(projectId)
    autopilot?.remove(projectId)
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
      ...(typeof role.model === 'string' && role.model.trim() ? { model: role.model.trim() } : {}),
      ...(typeof role.vault === 'string' && role.vault.trim() ? { vault: role.vault.trim() } : {}),
      ...(role.vaultKind === 'design' ? { vaultKind: 'design' as const } : {}),
      ...(role.mode === 'research' ? { mode: 'research' as const } : {})
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
  handle(IPC.agentsSend, (id: unknown, agentId: unknown, prompt: unknown, opts?: { record?: unknown }) =>
    runner.send(str(id, 'project'), str(agentId, 'agent'), str(prompt, 'prompt'), { record: opts?.record === true })
  )
  handle(IPC.agentsStop, (id: unknown, agentId: unknown) => runner.stop(str(id, 'project'), str(agentId, 'agent')))
  handle(IPC.agentsStopAll, () => {
    autopilot!.pauseAll('You stopped all agents.')
    runner.stopAll()
  })
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
  handle(IPC.planUsageRefresh, async () => {
    await refreshPlanUsage()
    return costs.summary()
  })

  // Reviews (autonomous task branches)
  handle(IPC.reviewsList, (id: unknown) => reviewActions.list(str(id, 'project')))
  handle(IPC.reviewsDiff, (id: unknown) => reviewActions.diff(str(id, 'review')))
  handle(IPC.reviewsMerge, (id: unknown, opts?: { force?: unknown; acknowledged?: unknown }) =>
    reviewActions.merge(str(id, 'review'), {
      force: opts?.force === true,
      acknowledged: Array.isArray(opts?.acknowledged) ? opts.acknowledged.filter((w): w is string => typeof w === 'string').slice(0, 20) : []
    })
  )
  handle(IPC.reviewsRecheck, (id: unknown, opts?: { reviewer?: unknown }) => reviewActions.recheck(str(id, 'review'), { reviewer: opts?.reviewer === true }))
  handle(IPC.reviewsDiscard, (id: unknown) => reviewActions.discard(str(id, 'review')))
  handle(IPC.reviewsCheckout, (id: unknown) => reviewActions.checkout(str(id, 'review')))
  handle(IPC.reviewsCheckoutBase, (id: unknown) => reviewActions.checkoutBase(str(id, 'project')))
  handle(IPC.reviewsClipFile, (id: unknown, index: unknown) => reviewActions.clipFile(str(id, 'review'), Number(index)))
  handle(IPC.reviewsPublish, (id: unknown) => reviewActions.publish(str(id, 'review')))
  handle(IPC.testPlaceKeyStatus, (id: unknown) => testPlaceKeys.status(str(id, 'project')))
  handle(IPC.testPlaceKeySet, (id: unknown, key: unknown) => testPlaceKeys.set(str(id, 'project'), str(key, 'key')))
  handle(IPC.testPlaceKeyClear, (id: unknown) => testPlaceKeys.clear(str(id, 'project')))

  // Obsidian vaults
  handle(IPC.vaultStatus, (id: unknown, folder: unknown) => vaultStatus(root(id), str(folder, 'folder')))
  handle(IPC.vaultCreate, (id: unknown, folder: unknown) => {
    const f = str(folder, 'folder')
    createVault(root(id), f, listRoles(root(id)).find((r) => r.vault === f)?.vaultKind ?? 'ui')
    return vaultStatus(root(id), str(folder, 'folder'))
  })
  handle(IPC.vaultOpen, async (id: unknown, folder: unknown) => {
    const f = str(folder, 'folder')
    const st = vaultStatus(root(id), f)
    if (!st.exists) throw new Error('Create the vault first.')
    const home = join(root(id), f, 'Home.md')
    // obsidian:// is the only non-https scheme Hangar ever opens, and only for a vault inside a project.
    await shell.openExternal(`obsidian://open?path=${encodeURIComponent(home)}`).catch(() => shell.openPath(join(root(id), f)))
  })

  // New game flow
  const tools = (): { rojo: boolean; selene: boolean; stylua: boolean; git: boolean } => ({
    rojo: resolveCommand(settings.get().rojoCommand) !== null,
    selene: resolveCommand('selene') !== null,
    stylua: resolveCommand('stylua') !== null,
    git: resolveCommand('git') !== null
  })
  const defaultParent = (): string => join(app.getPath('documents'), 'Hangar Games')
  handle(IPC.systemTools, () => ({ ...tools(), defaultParent: defaultParent() }))
  handle(IPC.projectsPickFolder, async () => {
    const opts = { title: 'Where should new games go?', defaultPath: defaultParent(), properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
  handle(IPC.projectsReadDocument, async () => {
    const opts = { title: 'Attach a design document', properties: ['openFile'] as Array<'openFile'>, filters: [{ name: 'Text documents', extensions: ['md', 'markdown', 'txt'] }] }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    const file = res.canceled ? undefined : res.filePaths[0]
    if (!file) return null
    if (statSync(file).size > MAX_DOCUMENT) throw new Error('That document is too large (300 KB max). Paste the important parts instead.')
    const text = readFileSync(file, 'utf8')
    if (text.includes('\0')) throw new Error('That file isn\'t a text document. Save it as Markdown or plain text first.')
    return { name: basename(file), text }
  })
  handle(IPC.projectsCreate, async (raw: unknown) => {
    const input = sanitizeNewGame(raw)
    if (input.parentDir === defaultParent() && !existsSync(input.parentDir)) mkdirSync(input.parentDir, { recursive: true })
    const path = await createGameProject(input)
    const added = registry.add(path)
    const t = tools()
    const checks = SUGGESTED_CHECKS.filter((c) => (c.name === 'Format' ? t.stylua : c.name === 'Lint' ? t.selene : t.rojo))
    const project = registry.update(added.id, {
      name: input.name.trim(),
      settings: { autonomous: true, reviewer: true, checks, robloxStudioMcp: input.studioTools, model: input.model, dailyBudgetUsd: input.dailyBudgetUsd }
    })
    autopilot!.configure(project.id, input.autopilot)
    let started = false
    let note: string | null = null
    if (input.startNow) {
      if (!getCredential()) note = 'Add your Anthropic API key (or Claude Max token) in Settings, then start autopilot from the project Overview.'
      else {
        autopilot!.start(project.id)
        started = true
      }
    }
    const missing = (['rojo', 'selene', 'stylua'] as const).filter((k) => !t[k])
    if (missing.length) note = [note, `Not installed, so not used as checks: ${missing.join(', ')}.`].filter(Boolean).join(' ')
    return { project, started, note }
  })

  // Autopilot
  const pid = (id: unknown): string => registry.get(str(id, 'project')).id
  handle(IPC.autopilotList, () => autopilot!.list())
  handle(IPC.autopilotStart, (id: unknown, opts?: { feedback?: unknown; config?: Record<string, unknown> }) =>
    autopilot!.start(pid(id), {
      feedback: typeof opts?.feedback === 'string' ? opts.feedback.slice(0, 8000) : undefined,
      config: opts?.config && typeof opts.config === 'object' ? (opts.config as never) : undefined
    })
  )
  handle(IPC.autopilotPause, (id: unknown) => autopilot!.pause(pid(id)))
  handle(IPC.autopilotResume, (id: unknown) => autopilot!.resume(pid(id)))
  handle(IPC.autopilotStop, (id: unknown) => autopilot!.stop(pid(id)))
  handle(IPC.autopilotConfigure, (id: unknown, config: unknown) => autopilot!.configure(pid(id), config && typeof config === 'object' ? (config as never) : {}))
  handle(IPC.autopilotFeedback, (id: unknown, text: unknown) => autopilot!.addFeedback(pid(id), str(text, 'feedback').slice(0, 8000)))

  // Trends and ideas
  handle(IPC.trendsGet, () => trends.current())
  handle(IPC.trendsRefresh, () => trends.refresh())
  handle(IPC.trendsIdeas, () => trends.generateIdeas())
  handle(IPC.ideaChatGet, () => trends.chat())
  handle(IPC.ideaChatSend, (text: unknown) => trends.sendChat(str(text, 'message')))
  handle(IPC.ideaChatClear, () => trends.clearChat())

  // Phone remote
  handle(IPC.remoteStatus, () => remote!.status())
  handle(IPC.remoteSet, (patch: { enabled?: unknown }) => remote!.setEnabled(patch?.enabled === true))
  handle(IPC.remotePair, () => remote!.startPairing())
  handle(IPC.remoteUnpair, (id: unknown) => remote!.unpair(str(id, 'device')))

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
    webEgress.stop()
    remote?.stop()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
