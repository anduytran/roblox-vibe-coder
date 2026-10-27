/**
 * What each agent may use, as groups people understand (checkboxes in the role editor), and the per-agent settings
 * shared by roles and the Main agent. Reading and searching files is always allowed: an agent can't work without it.
 */
import type { AgentEffort, AgentSettings, MainAgentSettings } from './types'

export const TOOL_GROUPS = [
  { id: 'edit', label: 'Edit files', hint: 'Create and change files in the game', tools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] },
  { id: 'run', label: 'Run commands', hint: 'Shell commands (sandboxed on Mac)', tools: ['Bash'] },
  { id: 'web', label: 'Search and read the web', hint: 'Still asks you before each page', tools: ['WebSearch', 'WebFetch'] },
  { id: 'delegate', label: 'Hand work to other agents', hint: 'Call the other roles as helpers', tools: ['Task', 'Agent'] }
] as const

export type ToolGroup = (typeof TOOL_GROUPS)[number]['id']

/** Every tool a group controls (anything else, like reading files, is always allowed). */
const GROUPED = TOOL_GROUPS.flatMap((g) => g.tools as readonly string[])

/** The groups a saved tool list allows. No list means everything (how roles started out). */
export function groupsFromTools(tools: readonly string[] | undefined): Set<ToolGroup> {
  if (!tools?.length) return new Set(TOOL_GROUPS.map((g) => g.id))
  return new Set(TOOL_GROUPS.filter((g) => g.tools.some((t) => tools.includes(t))).map((g) => g.id))
}

/** The tool list to save for the ticked groups: undefined when all are ticked (no limit). */
export function toolsFromGroups(groups: ReadonlySet<ToolGroup>): string[] | undefined {
  if (TOOL_GROUPS.every((g) => groups.has(g.id))) return undefined
  return ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', ...TOOL_GROUPS.filter((g) => groups.has(g.id)).flatMap((g) => g.tools)]
}

/** Tools the engine must refuse for an agent with this tool list (none when it has no list). */
export function disallowedFor(tools: readonly string[] | undefined): string[] {
  if (!tools?.length) return []
  return GROUPED.filter((t) => !tools.includes(t))
}

export const EFFORTS: { id: AgentEffort; label: string }[] = [
  { id: 'low', label: 'Low (quick and cheap)' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max (thinks hardest, costs most)' }
]

export const isEffort = (v: unknown): v is AgentEffort => v === 'low' || v === 'medium' || v === 'high' || v === 'max'

/** A per-task spending limit for one agent: 0.1–20 USD, or undefined (use the app's per-task limit). */
export function cleanBudget(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(20, Math.max(0.1, n)) * 100) / 100 : undefined
}

const FOLDER = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}(\/[A-Za-z0-9][A-Za-z0-9 _-]{0,40}){0,2}$/

/** The shared settings, cleaned of anything unexpected (they arrive from the UI and from saved files). */
export function cleanAgentSettings(v: unknown): AgentSettings {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const out: AgentSettings = {}
  if (Array.isArray(o.tools)) {
    const tools = [...new Set(o.tools.filter((t): t is string => typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(t)))].slice(0, 40)
    if (tools.length) out.tools = tools
  }
  if (isEffort(o.effort)) out.effort = o.effort
  const budget = cleanBudget(o.budgetUsd)
  if (budget) out.budgetUsd = budget
  if (o.studio === false) out.studio = false
  if (typeof o.knowledge === 'string' && FOLDER.test(o.knowledge.trim())) out.knowledge = o.knowledge.trim()
  const ctx = cleanContextTokens(o.contextTokens)
  if (ctx) out.contextTokens = ctx
  const turns = cleanMaxTurns(o.maxTurns)
  if (turns) out.maxTurns = turns
  return out
}

export function cleanMainAgent(v: unknown): MainAgentSettings | undefined {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const out: MainAgentSettings = { ...cleanAgentSettings(o) }
  if (typeof o.prompt === 'string' && o.prompt.trim()) out.prompt = o.prompt.trim().slice(0, 20000)
  return Object.keys(out).length ? out : undefined
}

/** Context sizes the engine accepts (it summarizes the conversation once it reaches one). */
export const CONTEXT_MIN = 100_000
export const CONTEXT_MAX = 1_000_000

/**
 * The context size for an agent's job, unless it has its own: the Lead plans from notes (helpers read the code),
 * builders need several code files open, QA and research read output and pages that needn't stay around.
 */
export function autoContextTokens(agentId: string): number {
  if (agentId === 'lead') return 120_000
  if (agentId === 'qa-tester' || agentId === 'researcher') return 100_000
  if (agentId === 'scripter' || agentId === 'ui-builder' || agentId === 'studio-modeler' || agentId === 'blender-modeler') return 200_000
  return 150_000
}

export function contextTokensFor(agentId: string, own?: number): number {
  return cleanContextTokens(own) ?? autoContextTokens(agentId)
}

/** A context size within what the engine accepts, or undefined. Accepts 200000, "200k" or "200000". */
export function cleanContextTokens(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? (/^\s*(\d+(?:\.\d+)?)\s*k\s*$/i.test(v) ? parseFloat(v) * 1000 : parseFloat(v)) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, n))) : undefined
}

/** Steps (model turns) per run: the QA Tester's playtests ran to hundreds of short turns, so it gets fewer. */
export const DEFAULT_MAX_TURNS = 80
export function maxTurnsFor(agentId: string, own?: number): number {
  return cleanMaxTurns(own) ?? (agentId === 'qa-tester' ? 60 : DEFAULT_MAX_TURNS)
}
export function cleanMaxTurns(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(300, Math.max(5, n))) : undefined
}

/** Roles that coordinate (hand building to the others) unless their role file says otherwise. */
export const COORDINATORS = ['lead', 'planner']
export const coordinatesByDefault = (roleId: string): boolean => COORDINATORS.includes(roleId)

/**
 * The effort an agent thinks at unless it has its own: medium. The models' thinking counts as output, the most
 * expensive kind of token, and medium is plenty for building from a clear brief. Haiku keeps its usual (it's the
 * cheap tier already).
 */
export function autoEffort(model: string | null | undefined): AgentEffort | undefined {
  return model && /haiku/i.test(model) ? undefined : 'medium'
}

/**
 * Tools no Hangar agent needs (notebooks, plan mode, questions to a user who isn't in the conversation, skills,
 * schedules, other sessions). Leaving them out keeps every agent's starting prompt smaller, and that prompt is written
 * again for each fresh task and each helper.
 */
export const LEAN_DISALLOWED = [
  'NotebookEdit',
  'NotebookRead',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'SlashCommand',
  'TodoWrite',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
  'EnterWorktree',
  'ExitWorktree',
  'ListAgents'
]
