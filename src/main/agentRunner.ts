import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentState,
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  LogEntry,
  Project,
  Role
} from '@shared/types'
import type { CostTracker } from './costs'
import { JsonStore } from './jsonStore'
import { bashPrefixFor, evaluateToolUse, summarizeToolUse } from './permissions'
import { mcpServersFor } from './projects'
import type { ProjectRegistry } from './projects'
import { listRoles } from './roles'
import { convertMessage, type StreamMessage } from './sdkMessages'

/** The always-present general agent for each project. Role agents come from .claude/agents/. */
export const MAIN_AGENT_ID = 'main'

const MAX_LOG = 400
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
  loadQuery: () => Promise<QueryFn>
  emit: (event: AgentEvent) => void
  persistFile: string
}

const keyOf = (projectId: string, agentId: string): string => `${projectId}:${agentId}`

export class AgentRunner {
  private states = new Map<string, AgentState>()
  private controllers = new Map<string, AbortController>()
  private pending = new Map<string, PendingApproval>()
  /** Global arrival order of queued tasks, so the oldest task anywhere runs next (timestamps can tie). */
  private order = new WeakMap<object, number>()
  private seq = 0
  private persisted: JsonStore<Persisted>

  constructor(private readonly deps: RunnerDeps) {
    this.persisted = new JsonStore<Persisted>(deps.persistFile, { agents: {} })
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

  send(projectId: string, agentId: string, prompt: string): void {
    const text = prompt.trim()
    if (!text) return
    const project = this.deps.registry.get(projectId)
    if (!this.agentIds(project).includes(agentId)) throw new Error('Unknown agent.')
    const s = this.state(projectId, agentId)
    const task = { id: randomUUID(), prompt: text.slice(0, 20000), createdAt: Date.now() }
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
    if (decision === 'always' && !request.outsideProject) {
      const project = this.deps.registry.get(request.projectId)
      const settings = project.settings
      if (request.toolName === 'Bash') {
        const cmd = typeof p.input.command === 'string' ? p.input.command : ''
        const prefix = bashPrefixFor(cmd)
        if (prefix) this.deps.registry.update(project.id, { settings: { allowedBashPrefixes: [...settings.allowedBashPrefixes, prefix] } })
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
        .sort((a, b) => (this.order.get(a.queue[0]!) ?? 0) - (this.order.get(b.queue[0]!) ?? 0))[0]
      if (!next) return
      const task = next.queue.shift()!
      next.status = 'working'
      this.publish(next)
      void this.run(next, task.prompt).finally(() => this.schedule())
    }
  }

  private async run(s: AgentState, prompt: string): Promise<void> {
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
    const blocked = this.deps.costs.budgetBlock(project.id, project.settings.dailyBudgetUsd, settings.globalDailyBudgetUsd)
    if (blocked) return this.fail(s, blocked)

    const role: Role | undefined = s.agentId === MAIN_AGENT_ID ? undefined : listRoles(project.path).find((r) => r.id === s.agentId)
    if (s.agentId !== MAIN_AGENT_ID && !role) return this.fail(s, 'This role no longer exists.')

    const controller = new AbortController()
    this.controllers.set(key, controller)
    let finished = false

    try {
      const query = await this.deps.loadQuery()
      const options: Record<string, unknown> = {
        cwd: project.path,
        model: role?.model ?? project.settings.model ?? settings.defaultModel,
        abortController: controller,
        // Only the project's own settings, CLAUDE.md and .claude/agents are loaded — never the
        // user's global Claude settings, so their allow-rules can't widen what this app permits.
        settingSources: ['project'],
        permissionMode: 'default',
        mcpServers: mcpServersFor(project, settings),
        maxBudgetUsd: settings.perRunBudgetUsd,
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
        canUseTool: this.makeCanUseTool(s, project, role)
      }
      if (role) {
        options.systemPrompt = { type: 'preset', preset: 'claude_code', append: `\n\n# Your role: ${role.name}\n${role.prompt}` }
        if (role.tools?.length) options.disallowedTools = [...EDIT_TOOLS, 'Bash'].filter((t) => !role.tools!.includes(t))
      }
      if (s.sessionId) options.resume = s.sessionId

      for await (const raw of query({ prompt, options })) {
        const c = convertMessage(raw as StreamMessage)
        if (c.sessionId) s.sessionId = c.sessionId
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
      this.controllers.delete(key)
      this.denyPendingFor(s.projectId, s.agentId, 'Run ended')
      s.activity = null
      this.save(s)
      this.publish(s)
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

      const request: ApprovalRequest = {
        id: randomUUID(),
        projectId: project.id,
        agentId: s.agentId,
        toolName,
        summary: summarizeToolUse(toolName, input),
        inputJson: JSON.stringify(input, null, 2).slice(0, 8000),
        reason: decision.reason,
        outsideProject: decision.outsideProject,
        ts: Date.now()
      }
      return new Promise<PermissionResult>((resolve) => {
        this.pending.set(request.id, { request, resolve, input })
        signal.addEventListener('abort', () => {
          if (this.pending.delete(request.id)) {
            resolve({ behavior: 'deny', message: 'Run was stopped.', interrupt: true })
            this.deps.emit({ type: 'approval_resolved', id: request.id })
          }
        })
        s.status = 'awaiting_approval'
        s.activity = `Waiting for approval: ${request.summary}`
        this.publish(s)
        this.deps.emit({ type: 'approval', request })
      })
    }
  }
}

function friendlyError(message: string): string {
  if (/invalid x-api-key|authentication_error|401/i.test(message)) return 'Your API key was rejected. Check it in Settings.'
  if (/credit balance|billing/i.test(message)) return 'Your Anthropic account is out of credits.'
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message)) return 'The Claude Agent SDK is not installed. Run "npm install" in the Hangar folder.'
  if (/ENOENT/i.test(message) && /claude/i.test(message)) return `Could not start the Claude Code engine: ${message}`
  return message
}
