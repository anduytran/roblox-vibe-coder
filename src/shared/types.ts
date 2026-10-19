// Types shared by the main process, preload bridge and renderer.
// Nothing in here may import Node or Electron modules.

export type AgentStatus = 'idle' | 'queued' | 'working' | 'awaiting_approval' | 'error' | 'stopped'

/** A subagent role, stored as .claude/agents/<id>.md in the project (Claude Code compatible). */
export interface Role {
  id: string
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
}

export interface ProjectSettings {
  /** Attach Roblox Studio's built-in MCP server to this project's agents. */
  robloxStudioMcp: boolean
  /** Let agents edit/write files inside the project folder without asking. */
  autoApproveEdits: boolean
  /** Shell commands starting with one of these run without asking (e.g. "rojo build", "git status"). */
  allowedBashPrefixes: string[]
  /** Tools the user chose "Always allow" for (exact tool names, e.g. an MCP tool). */
  alwaysAllowTools: string[]
  /** Daily spend limit for this project in USD; null = no project limit. */
  dailyBudgetUsd: number | null
  /** Model override for this project; null = app default. */
  model: string | null
}

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
  settings: ProjectSettings
}

export interface AppSettings {
  defaultModel: string
  maxConcurrentRuns: number
  /** Hard stop for a single run (passed to the SDK as maxBudgetUsd). */
  perRunBudgetUsd: number
  /** Daily spend limit across all projects; null = none. */
  globalDailyBudgetUsd: number | null
  /** Command used to launch Roblox Studio's MCP server. Empty = platform default. */
  studioMcpCommand: string
  studioMcpArgs: string[]
}

export type LogKind = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'result'

export interface LogEntry {
  id: string
  ts: number
  kind: LogKind
  text: string
  tool?: string
}

export interface QueuedTask {
  id: string
  prompt: string
  createdAt: number
}

export interface AgentState {
  projectId: string
  agentId: string
  status: AgentStatus
  sessionId: string | null
  queue: QueuedTask[]
  log: LogEntry[]
  lastError: string | null
  costUsd: number
  /** Short description of what the agent is doing right now. */
  activity: string | null
}

export type ApprovalDecision = 'allow' | 'deny' | 'always'

export interface ApprovalRequest {
  id: string
  projectId: string
  agentId: string
  toolName: string
  summary: string
  inputJson: string
  reason: string
  outsideProject: boolean
  ts: number
}

export interface CostSummary {
  todayUsd: number
  projectTodayUsd: Record<string, number>
  projectTotalUsd: Record<string, number>
}

export interface GitFile {
  path: string
  /** Two-letter porcelain status, e.g. " M", "??", "A ". */
  status: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  files: GitFile[]
}

export type AgentEvent =
  | { type: 'state'; state: AgentState }
  | { type: 'log'; projectId: string; agentId: string; entry: LogEntry }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval_resolved'; id: string }
  | { type: 'cost'; summary: CostSummary }
  | { type: 'reset'; projectId: string; agentId: string }

export interface Result<T> {
  ok: boolean
  value?: T
  error?: string
}
