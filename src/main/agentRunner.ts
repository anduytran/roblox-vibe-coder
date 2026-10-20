import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentState,
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  LogEntry,
  Project,
  QueuedTask,
  Review,
  Role
} from '@shared/types'
import type { CostTracker } from './costs'
import { JsonStore } from './jsonStore'
import { finishTaskBranch, gitSafetyEnv, prepareTaskBase, startTaskBranch, taskBranchName, type TaskBase } from './git'
import type { ReviewStore } from './reviews'
import { StudioClipRecorder } from './clips'
import { alwaysRuleFor, DECEPTIVE_CHARS, evaluateToolUse, summarizeToolUse } from './permissions'
import { readClaudeMd, reviewProject, TrustStore } from './projectTrust'
import { planSandbox } from './sandbox'
import { mcpServersFor } from './projects'
import type { ProjectRegistry } from './projects'
import { listRoles } from './roles'
import { convertMessage, type StreamMessage } from './sdkMessages'

/** The always-present general agent for each project. Role agents come from .claude/agents/. */
export const MAIN_AGENT_ID = 'main'

const MAX_LOG = 400
const MAX_TURNS = 80
const MAX_DETAILS = 20_000

/**
 * Only these environment variables reach the Claude engine (and so every command and tool
 * server it starts). Everything else in your environment, like cloud or GitHub tokens, stays out.
 */
const ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'SystemRoot',
  'SYSTEMROOT', 'SystemDrive', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'LOGNAME',
  'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'
]

/**
 * `auth` is either { ANTHROPIC_API_KEY: <real key> } or, with key hiding on, the proxy's
 * { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: <session token> }.
 */
export function buildAgentEnv(auth: Record<string, string>, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ENV_ALLOWLIST) {
    const v = source[k]
    if (typeof v === 'string') env[k] = v
  }
  // No telemetry, error reporting or auto-update traffic from the engine.
  return { ...env, ...gitSafetyEnv(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...auth }
}

/** Make hidden characters visible so an approval card shows what will really run. */
function reveal(text: string): string {
  return text.replace(new RegExp(DECEPTIVE_CHARS.source, 'gu'), (c) => `⟦U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`)
}
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

type PermissionResult = { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: boolean }

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal }
) => Promise<PermissionResult>

/** The subset of the Agent SDK's `query()` this app calls. Injected so tests can use a fake. */
export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>

interface Persisted {
  agents: Record<string, { sessionId: string | null; log: LogEntry[] }>
}

interface PendingApproval {
  request: ApprovalRequest
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
}

export interface RunnerDeps {
  registry: ProjectRegistry
  costs: CostTracker
  getSettings: () => AppSettings
  getApiKey: () => string | null
  /**
   * Credentials for one run's engine environment (the real key, or a per-run proxy token and URL).
   * `release` is called when the run ends, revoking the token.
   */
  engineAuth: (apiKey: string, opts: { forceHideKey: boolean }) => Promise<{ env: Record<string, string>; release: () => void }>
  loadQuery: () => Promise<QueryFn>
  emit: (event: AgentEvent) => void
  persistFile: string
  trustFile: string
  /** Hangar's own data folder; sandboxed commands may not read it. */
  appDataDir: string
  platform?: NodeJS.Platform
  reviews: ReviewStore
  /** Records playtest clips for tasks queued with "Record playtest". Optional (tests, unsupported OS). */
  clips?: ClipRecorder
}

export interface ClipSession {
  onToolUse(name: string, input: Record<string, unknown>): void
  onImages(images: { mediaType: string; data: string }[]): void
  finish(): Promise<Review['clip']>
  abort(): void
}
export interface ClipRecorder {
  begin(opts: { taskId: string; projectPath: string }): ClipSession
}

/** Added to every agent's instructions in autonomous mode. */
const AUTONOMOUS_INSTRUCTIONS = `
# Autonomous mode
You are working unattended. The user reviews your finished work later as one change on a git branch.
- Don't ask the user questions; make sensible decisions and note any important assumptions in your final message.
- Work only inside this project folder. Don't install packages or tools; if you need one, say so in your final message.
- Don't run git commands that change branches, history or config (checkout, switch, reset, commit, rebase, config). Hangar commits your work for you.
- Test your work: build, lint, and playtest in Roblox Studio when its tools are available. Fix problems you find.
- Finish with a short report: what you changed, how you tested it, and anything the user should check.`

const keyOf = (projectId: string, agentId: string): string => `${projectId}:${agentId}`

export class AgentRunner {
  private states = new Map<string, AgentState>()
  private controllers = new Map<string, AbortController>()
  private pending = new Map<string, PendingApproval>()
  /** Global arrival order of queued tasks, so the oldest task anywhere runs next (timestamps can tie). */
  private order = new WeakMap<object, number>()
  private seq = 0
  /** Projects whose finished task is still being committed and switched back to the base branch. */
  private wrapping = new Set<string>()
  private persisted: JsonStore<Persisted>
  private trust: TrustStore

  constructor(private readonly deps: RunnerDeps) {
    this.persisted = new JsonStore<Persisted>(deps.persistFile, { agents: {} })
    this.trust = new TrustStore(deps.trustFile)
  }

  // ---------- state ----------

  private state(projectId: string, agentId: string): AgentState {
    const key = keyOf(projectId, agentId)
    let s = this.states.get(key)
    if (!s) {
      const saved = this.persisted.get().agents[key]
      s = {
        projectId,
        agentId,
        status: 'idle',
        sessionId: saved?.sessionId ?? null,
        queue: [],
        log: saved?.log ?? [],
        lastError: null,
        costUsd: 0,
        activity: null
      }
      this.states.set(key, s)
    }
    return s
  }

  private publish(s: AgentState): void {
    this.deps.emit({ type: 'state', state: { ...s, queue: [...s.queue], log: [] } })
  }

  private save(s: AgentState): void {
    const key = keyOf(s.projectId, s.agentId)
    this.persisted.update((p) => ({
      agents: { ...p.agents, [key]: { sessionId: s.sessionId, log: s.log.slice(-MAX_LOG) } }
    }))
  }

  private log(s: AgentState, entry: Omit<LogEntry, 'id' | 'ts'>): void {
    const full: LogEntry = { ...entry, id: randomUUID(), ts: Date.now() }
    s.log.push(full)
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG)
    this.deps.emit({ type: 'log', projectId: s.projectId, agentId: s.agentId, entry: full })
  }

  /** Agent ids for a project: the main agent plus one per role file. */
  agentIds(project: Project): string[] {
    return [MAIN_AGENT_ID, ...listRoles(project.path).map((r) => r.id)]
  }

  snapshot(projectId: string): AgentState[] {
    const project = this.deps.registry.get(projectId)
    return this.agentIds(project).map((id) => {
      const s = this.state(projectId, id)
      return { ...s, queue: [...s.queue], log: [...s.log] }
    })
  }

  pendingApprovals(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  runningCount(): number {
    return [...this.states.values()].filter((s) => s.status === 'working' || s.status === 'awaiting_approval').length
  }

  // ---------- commands ----------

  /** True while any agent in the project is running (the working tree may be changing). */
  projectBusy(projectId: string): boolean {
    if (this.wrapping.has(projectId)) return true
    return [...this.states.values()].some((s) => s.projectId === projectId && (s.status === 'working' || s.status === 'awaiting_approval'))
  }

  send(projectId: string, agentId: string, prompt: string, opts: { record?: boolean } = {}): void {
    const text = prompt.trim()
    if (!text) return
    const project = this.deps.registry.get(projectId)
    if (!this.agentIds(project).includes(agentId)) throw new Error('Unknown agent.')
    const s = this.state(projectId, agentId)
    const task: QueuedTask = { id: randomUUID(), prompt: text.slice(0, 20000), createdAt: Date.now(), ...(opts.record ? { record: true } : {}) }
    this.order.set(task, ++this.seq)
    s.queue.push(task)
    if (s.status === 'error' || s.status === 'stopped' || s.status === 'idle') {
      s.status = 'queued'
      s.lastError = null
    }
    this.publish(s)
    this.schedule()
  }

  stop(projectId: string, agentId: string): void {
    const s = this.state(projectId, agentId)
    const key = keyOf(projectId, agentId)
    this.controllers.get(key)?.abort()
    this.denyPendingFor(projectId, agentId, 'Stopped by user')
    if (s.status === 'queued' || s.status === 'working' || s.status === 'awaiting_approval') {
      s.status = 'stopped'
      s.activity = null
      this.publish(s)
    }
  }

  stopAll(): void {
    for (const s of this.states.values()) {
      s.queue = []
      this.stop(s.projectId, s.agentId)
      this.publish(s)
    }
  }

  clearQueue(projectId: string, agentId: string): void {
    const s = this.state(projectId, agentId)
    s.queue = []
    if (s.status === 'queued') s.status = 'idle'
    this.publish(s)
  }

  resetSession(projectId: string, agentId: string): void {
    const s = this.state(projectId, agentId)
    if (s.status === 'working' || s.status === 'awaiting_approval') throw new Error('Stop the agent first.')
    s.sessionId = null
    s.log = []
    s.lastError = null
    s.status = s.queue.length ? 'queued' : 'idle'
    this.save(s)
    this.publish(s)
    this.deps.emit({ type: 'reset', projectId, agentId })
  }

  respond(id: string, decision: ApprovalDecision): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    const { request } = p
    // "Always" is only honoured when the request offered it; otherwise it counts as a single allow.
    if (decision === 'always' && request.canAlwaysAllow && !request.dangerous) {
      const project = this.deps.registry.get(request.projectId)
      const settings = project.settings
      if (request.toolName === 'Bash') {
        const rule = alwaysRuleFor(typeof p.input.command === 'string' ? p.input.command : '')
        if (rule) this.deps.registry.update(project.id, { settings: { allowedBashPrefixes: [...settings.allowedBashPrefixes, rule] } })
      } else {
        this.deps.registry.update(project.id, { settings: { alwaysAllowTools: [...settings.alwaysAllowTools, request.toolName] } })
      }
    }
    const allowed = decision === 'allow' || decision === 'always'
    p.resolve(allowed ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: 'The user declined this action.' })
    this.deps.emit({ type: 'approval_resolved', id })
    const s = this.state(request.projectId, request.agentId)
    if (s.status === 'awaiting_approval' && ![...this.pending.values()].some((x) => x.request.agentId === s.agentId && x.request.projectId === s.projectId)) {
      s.status = 'working'
      this.publish(s)
    }
    this.log(s, { kind: 'system', text: `${allowed ? 'Approved' : 'Declined'}: ${request.summary}` })
  }

  private denyPendingFor(projectId: string, agentId: string, message: string): void {
    for (const [id, p] of this.pending) {
      if (p.request.projectId === projectId && p.request.agentId === agentId) {
        this.pending.delete(id)
        p.resolve({ behavior: 'deny', message, interrupt: true })
        this.deps.emit({ type: 'approval_resolved', id })
      }
    }
  }

  // ---------- scheduling ----------

  private schedule(): void {
    const max = Math.max(1, this.deps.getSettings().maxConcurrentRuns)
    while (this.runningCount() < max) {
      const next = [...this.states.values()]
        .filter((s) => s.status === 'queued' && s.queue.length > 0)
        // In autonomous mode a project works on one branch at a time, so its tasks run one after another.
        .filter((s) => !(this.isAutonomous(s.projectId) && this.projectBusy(s.projectId)))
        .sort((a, b) => (this.order.get(a.queue[0]!) ?? 0) - (this.order.get(b.queue[0]!) ?? 0))[0]
      if (!next) return
      const task = next.queue.shift()!
      next.status = 'working'
      this.publish(next)
      void this.run(next, task).finally(() => this.schedule())
    }
  }

  private isAutonomous(projectId: string): boolean {
    try {
      return this.deps.registry.get(projectId).settings.autonomous
    } catch {
      return false
    }
  }

  private async run(s: AgentState, task: QueuedTask): Promise<void> {
    const prompt = task.prompt
    const key = keyOf(s.projectId, s.agentId)
    this.log(s, { kind: 'user', text: prompt })
    let project: Project
    try {
      project = this.deps.registry.get(s.projectId)
    } catch {
      return this.fail(s, 'Project was removed.')
    }
    const settings = this.deps.getSettings()
    const apiKey = this.deps.getApiKey()
    if (!apiKey) return this.fail(s, 'Add your Anthropic API key in Settings first.')
    // Reserve the worst case for runs already in progress, so parallel runs can't overshoot the daily limit.
    const others = [...this.states.values()].filter((x) => x !== s && (x.status === 'working' || x.status === 'awaiting_approval'))
    const reserved = others.length * settings.perRunBudgetUsd
    const reservedHere = others.filter((x) => x.projectId === project.id).length * settings.perRunBudgetUsd
    const blocked = this.deps.costs.budgetBlock(project.id, project.settings.dailyBudgetUsd, settings.globalDailyBudgetUsd, Date.now(), reserved, reservedHere)
    if (blocked) return this.fail(s, blocked)

    const role: Role | undefined = s.agentId === MAIN_AGENT_ID ? undefined : listRoles(project.path).find((r) => r.id === s.agentId)
    if (s.agentId !== MAIN_AGENT_ID && !role) return this.fail(s, 'This role no longer exists.')

    const controller = new AbortController()
    this.controllers.set(key, controller)
    let finished = false
    let started = false
    let releaseAuth: (() => void) | null = null
    let taskBranch: { name: string; from: TaskBase } | null = null
    let lastText = ''
    let clip: ClipSession | null = null
    const screenshotCalls = new Set<string>()

    try {
      // Anything in the folder that would launch programs (MCP servers, git config) needs approval first.
      const review = await reviewProject(project)
      const firstTime = !this.trust.hasAny(project.id)
      if ((review.items.length > 0 || (firstTime && review.notes.length > 0)) && !this.trust.isApproved(project.id, review.hash)) {
        const lines = [...review.items, ...(firstTime ? review.notes : [])]
        const ok = await this.requestApproval(s, project, {
          toolName: 'Project setup',
          summary: lines.join('\n'),
          details: lines.join('\n'),
          reason: review.items.length
            ? 'This project will start these programs on your computer when agents run. Only approve if you recognise every one.'
            : 'This folder gives agents instructions. Check them if you did not write this project yourself.',
          dangerous: true,
          canAlwaysAllow: false,
          signal: controller.signal
        })
        if (!ok) throw new Error('Project setup was not approved, so no agent was started.')
        this.trust.approve(project.id, review.hash)
      }

      if (project.settings.autonomous) {
        const from = await prepareTaskBase(project.path)
        const name = taskBranchName(s.agentId, prompt, task.id)
        await startTaskBranch(project.path, name, from)
        taskBranch = { name, from }
        this.log(s, { kind: 'system', text: `Autonomous: working on branch ${name} (from ${from.base}). You'll review it when it's done.` })
      }
      if (task.record && this.deps.clips) clip = this.deps.clips.begin({ taskId: task.id, projectPath: project.path })

      const query = await this.deps.loadQuery()
      const sandbox = planSandbox(project, { platform: this.deps.platform, appDataDir: this.deps.appDataDir })
      this.log(s, {
        kind: 'system',
        text: sandbox.active
          ? `Sandbox on: shell commands can only change files in this project${project.settings.sandboxAllowedDomains.length ? ` and reach ${project.settings.sandboxAllowedDomains.join(', ')}` : ' and have no network access'}.`
          : `Not sandboxed: ${sandbox.reason}`
      })
      // Unattended agents never hold the real API key.
      const auth = await this.deps.engineAuth(apiKey, { forceHideKey: project.settings.autonomous })
      releaseAuth = auth.release
      const allRoles = listRoles(project.path)
      const claudeMd = readClaudeMd(project.path)
      let append = ''
      if (claudeMd) append += `\n\n# Project instructions (CLAUDE.md)\n${claudeMd}`
      if (role) append += `\n\n# Your role: ${role.name}\n${role.prompt}`
      if (project.settings.autonomous) append += `\n${AUTONOMOUS_INSTRUCTIONS}`
      if (task.record) {
        append += `\n\nThis task asks for a recorded playtest. When you playtest the feature, demonstrate it clearly within about 30 seconds, and take a screenshot (screen_capture) at each key moment.`
      }
      const options: Record<string, unknown> = {
        cwd: project.path,
        model: role?.model ?? project.settings.model ?? settings.defaultModel,
        abortController: controller,
        // No settings files are loaded at all: not the user's global ones, and not the project's
        // .claude/settings.json, whose hooks and allow-rules a repository could use to run commands
        // or skip approvals. Hangar supplies CLAUDE.md and the roles itself.
        settingSources: [],
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
        agents: Object.fromEntries(
          allRoles
            .filter((r) => r.id !== role?.id)
            .map((r) => [r.id, { description: r.description || r.name, prompt: r.prompt, ...(r.tools?.length ? { tools: r.tools } : {}), ...(r.model ? { model: r.model } : {}) }])
        ),
        mcpServers: mcpServersFor(project, settings, review.servers),
        maxBudgetUsd: settings.perRunBudgetUsd,
        maxTurns: MAX_TURNS,
        env: buildAgentEnv(auth.env),
        canUseTool: this.makeCanUseTool(s, project, role)
      }
      if (sandbox.settings) options.settings = sandbox.settings
      if (role?.tools?.length) options.disallowedTools = [...EDIT_TOOLS, 'Bash'].filter((t) => !role.tools!.includes(t))
      if (s.sessionId) options.resume = s.sessionId

      started = true
      for await (const raw of query({ prompt, options })) {
        const c = convertMessage(raw as StreamMessage)
        if (c.sessionId) s.sessionId = c.sessionId
        if (c.text) lastText = c.text
        if (clip) {
          for (const t of c.toolUses ?? []) {
            clip.onToolUse(t.name, t.input)
            if (/__screen_capture$/.test(t.name) && t.id) screenshotCalls.add(t.id)
          }
          // Only Studio screenshots become clip frames, never other tools' images.
          const shots = (c.images ?? []).filter((img) => screenshotCalls.has(img.toolUseId))
          if (shots.length) clip.onImages(shots)
        }
        for (const e of c.entries) this.log(s, e)
        if (c.activity !== undefined) {
          s.activity = c.activity
          this.publish(s)
        }
        if (c.costUsd !== undefined) {
          s.costUsd += c.costUsd
          this.deps.costs.record(project.id, s.agentId, c.costUsd)
          this.deps.emit({ type: 'cost', summary: this.deps.costs.summary() })
        }
        if (c.finished) {
          finished = true
          if (!c.finished.ok) s.lastError = c.finished.error ?? 'Run failed'
        }
      }
      if (controller.signal.aborted) {
        s.status = 'stopped'
        this.log(s, { kind: 'system', text: 'Stopped.' })
      } else if (s.lastError && finished) {
        s.status = 'error'
      } else {
        s.status = s.queue.length ? 'queued' : 'idle'
      }
    } catch (err) {
      if (controller.signal.aborted) {
        s.status = 'stopped'
        this.log(s, { kind: 'system', text: 'Stopped.' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        s.status = 'error'
        s.lastError = friendlyError(message)
        this.log(s, { kind: 'error', text: s.lastError })
      }
    } finally {
      if (started && !finished) {
        // A stopped or crashed run never reports its cost. Count the per-task limit as a worst case so
        // daily limits still hold (the real cost is usually lower; the Claude Console has exact billing).
        const estimate = settings.perRunBudgetUsd
        this.deps.costs.record(project.id, s.agentId, estimate)
        s.costUsd += estimate
        this.log(s, { kind: 'system', text: `Cost of this run is unknown, so up to $${estimate.toFixed(2)} (the per-task limit) is counted toward today's limits.` })
        this.deps.emit({ type: 'cost', summary: this.deps.costs.summary() })
      }
      releaseAuth?.()
      this.controllers.delete(key)
      this.denyPendingFor(s.projectId, s.agentId, 'Run ended')
      if (taskBranch) {
        this.wrapping.add(project.id)
        try {
          await this.finishTask(s, project, task, taskBranch, lastText, clip, finished && !s.lastError && !controller.signal.aborted)
        } finally {
          this.wrapping.delete(project.id)
        }
      } else clip?.abort()
      s.activity = null
      this.save(s)
      this.publish(s)
    }
  }

  /** Commit the task's work to its branch, switch back, and turn it into a review (or note there was nothing). */
  private async finishTask(
    s: AgentState,
    project: Project,
    task: QueuedTask,
    branch: { name: string; from: TaskBase },
    lastText: string,
    clip: ClipSession | null,
    completed: boolean
  ): Promise<void> {
    const roleName = s.agentId === MAIN_AGENT_ID ? 'Main' : (listRoles(project.path).find((r) => r.id === s.agentId)?.name ?? s.agentId)
    const title = task.prompt.split('\n')[0]!.slice(0, 120)
    try {
      const { files, headSha, note } = await finishTaskBranch(project.path, branch.name, branch.from, roleName, `${roleName}: ${title}`)
      const clipResult = clip ? await clip.finish().catch(() => null) : null
      if (files.length === 0 || !headSha) {
        if (clipResult) StudioClipRecorder.remove(clipResult.files)
        this.log(s, { kind: 'system', text: `No files changed, so there's nothing to review. Back on ${branch.from.base}.${note ? ` ${note}` : ''}` })
        return
      }
      const review = this.deps.reviews.add({
        projectId: project.id,
        agentId: s.agentId,
        title,
        branch: branch.name,
        base: branch.from.base,
        baseSha: branch.from.baseSha,
        headSha,
        summary: lastText.slice(0, 8000),
        files,
        incomplete: completed ? null : (s.lastError ?? 'The run was stopped before it finished.'),
        note,
        clip: clipResult
      })
      this.deps.emit({ type: 'review', review })
      this.log(s, { kind: 'system', text: `Ready for review: ${files.length} file${files.length === 1 ? '' : 's'} changed on ${branch.name}. Back on ${branch.from.base}.` })
      if (note) this.log(s, { kind: 'error', text: note })
    } catch (err) {
      clip?.abort()
      const message = err instanceof Error ? err.message : String(err)
      this.log(s, { kind: 'error', text: `Couldn't wrap up the task branch ${branch.name}: ${message}. Your work is still on that branch; check the Changes tab.` })
    }
  }

  private fail(s: AgentState, message: string): void {
    s.status = 'error'
    s.lastError = message
    s.activity = null
    this.log(s, { kind: 'error', text: message })
    this.save(s)
    this.publish(s)
  }

  private makeCanUseTool(s: AgentState, project: Project, role: Role | undefined): CanUseTool {
    return async (toolName, input, { signal }) => {
      // Re-read settings each time so "Always allow" applies immediately.
      const current = this.deps.registry.get(project.id)
      if (role?.tools?.length && !toolName.startsWith('mcp__') && !role.tools.includes(toolName)) {
        return { behavior: 'deny', message: `The ${role.name} role is not allowed to use ${toolName}.` }
      }
      const decision = evaluateToolUse({ toolName, input, projectRoot: current.path, settings: current.settings })
      if (decision.action === 'allow') return { behavior: 'allow', updatedInput: input }
      if (decision.action === 'deny') return { behavior: 'deny', message: decision.reason }
      if (signal.aborted) return { behavior: 'deny', message: 'Run was stopped.', interrupt: true }
      const ok = await this.requestApproval(s, project, {
        toolName,
        summary: summarizeToolUse(toolName, input),
        details: JSON.stringify(input, null, 2),
        reason: decision.reason,
        dangerous: decision.dangerous,
        canAlwaysAllow: decision.canAlwaysAllow,
        signal,
        input
      })
      return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this action.' }
    }
  }

  /** Show an approval card and wait for the user. Resolves false if denied or the run stops. */
  private requestApproval(
    s: AgentState,
    project: Project,
    a: { toolName: string; summary: string; details: string; reason: string; dangerous: boolean; canAlwaysAllow: boolean; signal: AbortSignal; input?: Record<string, unknown> }
  ): Promise<boolean> {
    const truncated = a.details.length > MAX_DETAILS
    const request: ApprovalRequest = {
      id: randomUUID(),
      projectId: project.id,
      agentId: s.agentId,
      toolName: a.toolName,
      summary: reveal(a.summary),
      inputJson: reveal(truncated ? a.details.slice(0, MAX_DETAILS) : a.details),
      reason: a.reason,
      dangerous: a.dangerous,
      canAlwaysAllow: a.canAlwaysAllow && !a.dangerous,
      truncated,
      ts: Date.now()
    }
    return new Promise<boolean>((resolve) => {
      if (a.signal.aborted) return resolve(false)
      this.pending.set(request.id, {
        request,
        input: a.input ?? {},
        resolve: (r) => resolve(r.behavior === 'allow')
      })
      a.signal.addEventListener('abort', () => {
        if (this.pending.delete(request.id)) {
          resolve(false)
          this.deps.emit({ type: 'approval_resolved', id: request.id })
        }
      })
      s.status = 'awaiting_approval'
      s.activity = `Waiting for approval: ${request.summary.split('\n')[0]}`
      this.publish(s)
      this.deps.emit({ type: 'approval', request })
    })
  }
}

function friendlyError(message: string): string {
  if (/hangar_proxy_error|Invalid session token/i.test(message)) return `Hangar's key-hiding proxy refused the request: ${message}. If this keeps happening, turn off "Hide API key from agents" in Settings.`
  if (/invalid x-api-key|authentication_error|401/i.test(message)) return 'Your API key was rejected. Check it in Settings (or try turning off "Hide API key from agents").'
  if (/credit balance|billing/i.test(message)) return 'Your Anthropic account is out of credits.'
  if (/sandbox/i.test(message) && /(unavailable|bubblewrap|bwrap|socat|not supported|failed to start)/i.test(message)) {
    return `The sandbox could not start, so nothing ran: ${message}. On Linux install bubblewrap and socat; or turn off the sandbox for this project in Project settings.`
  }
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message)) return 'The Claude Agent SDK is not installed. Run "npm install" in the Hangar folder.'
  if (/ENOENT/i.test(message) && /claude/i.test(message)) return `Could not start the Claude Code engine: ${message}`
  return message
}
