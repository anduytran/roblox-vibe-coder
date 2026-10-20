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
  /** Folder (inside the project) of this role's Obsidian vault, e.g. "ui-vault". */
  vault?: string
}

export interface ProjectSettings {
  /** Attach Roblox Studio's built-in MCP server to this project's agents. */
  robloxStudioMcp: boolean
  /** Let agents edit/write files inside the project folder without asking. */
  autoApproveEdits: boolean
  /**
   * Shell command rules that run without asking. A command matches when its first words equal the
   * rule and any extra words are plain relative paths (no flags, quotes, variables or chaining).
   */
  allowedBashPrefixes: string[]
  /** Tools the user chose "Always allow" for (exact tool names, e.g. an MCP tool). */
  alwaysAllowTools: string[]
  /** Daily spend limit for this project in USD; null = no project limit. */
  dailyBudgetUsd: number | null
  /** Model override for this project; null = app default. */
  model: string | null
  /** Run agents' shell commands in the OS sandbox (macOS/Linux only): writes only inside the project, no network. */
  sandbox: boolean
  /** Network domains sandboxed commands may reach (e.g. "api.github.com"). Empty = no network. */
  sandboxAllowedDomains: string[]
  /**
   * Agents work without asking inside the fence: edits in the project, sandboxed commands and Studio
   * playtest tools run freely. Each task runs on its own git branch and ends as a review.
   */
  autonomous: boolean
  /** Private test place for "Publish to test place" (never the live game). */
  testPlace: { universeId: string; placeId: string } | null
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
  /** Give agents a session token through a local proxy instead of the real API key. */
  hideKeyFromAgents: boolean
  /** Command used to run Rojo when publishing to a test place. */
  rojoCommand: string
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
  /** Record a short clip of the agent's playtest for the review. */
  record?: boolean
}

export type ReviewStatus = 'pending' | 'merged' | 'discarded'

/** A finished autonomous task: its work lives on its own branch until you merge or discard it. */
export interface Review {
  id: string
  projectId: string
  agentId: string
  title: string
  branch: string
  base: string
  /** Commit the task started from, and the task's final commit: the review is exactly this range. */
  baseSha: string
  headSha: string
  /** The agent's final message (what it did, how it tested). */
  summary: string
  files: string[]
  status: ReviewStatus
  /** Set when the run stopped or failed before finishing. */
  incomplete: string | null
  note: string | null
  createdAt: number
  /** Playtest clip: a video file, or screenshot frames when recording wasn't possible. */
  clip: { kind: 'video' | 'frames'; files: string[] } | null
  published: { versionNumber: number; at: number } | null
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
  /** Shown in red (outside the project, protected file, secrets, project setup). */
  dangerous: boolean
  /** Whether "Always allow" may be offered. */
  canAlwaysAllow: boolean
  /** True if the details were cut for display. */
  truncated: boolean
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
  | { type: 'review'; review: Review }

export interface Result<T> {
  ok: boolean
  value?: T
  error?: string
}
