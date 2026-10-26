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
  /** Extra connected tools this role gets: "blender" adds the Blender connection set up in Settings. */
  mcp?: 'blender'[]
  /** Folder (inside the project) of this role's Obsidian vault, e.g. "ui-vault". */
  vault?: string
  /** Which templates the vault starts from: UI (screens, components, style guide) or game design. */
  vaultKind?: VaultKind
  /**
   * "research": a web researcher. It can only search and read the web — no project files, commands,
   * Studio or subagents — and its findings wait in Reviews until you approve them into research/.
   */
  mode?: 'research'
}

export type VaultKind = 'ui' | 'design'

/** A command Hangar runs on every finished task before you merge it (lint, build, tests). */
export interface CheckCommand {
  name: string
  command: string
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
  /** Run on each finished autonomous task, in a separate checkout of its branch. */
  checks: CheckCommand[]
  /** A read-only reviewer agent reads each finished task's change and reports problems. */
  reviewer: boolean
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
  /** Which credential agents use. 'max' (a Claude subscription token) works only in development builds. */
  authMode: 'apiKey' | 'max'
  /** Blender connection (an MCP server such as blender-mcp) for the Blender 3D modeler. Empty = not set up. */
  blenderMcpCommand?: string
  blenderMcpArgs?: string[]
  /** Desktop notifications when something needs you and Hangar isn't the focused window (default on). */
  notifications?: boolean
  /** Claude Max mode: no new work starts once plan usage reaches these percentages. */
  planLimits: { fiveHourPct: number; weeklyPct: number }
}

export type LogKind = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'result'

export interface LogEntry {
  id: string
  ts: number
  kind: LogKind
  text: string
  tool?: string
  /** Pairs a tool call with its result in the feed (absent on entries saved before it was recorded). */
  toolUseId?: string
  /** A tool result's full size in bytes; its text may be clipped. */
  bytes?: number
}

export interface QueuedTask {
  id: string
  prompt: string
  createdAt: number
  /** Record a short clip of the agent's playtest for the review. */
  record?: boolean
  /** Queued by autopilot (a build step, or the end-of-sprint check-in report). */
  origin?: 'autopilot' | 'autopilot-report'
}

export type ReviewStatus = 'pending' | 'merged' | 'discarded'

export interface CheckResult {
  name: string
  command: string
  status: 'passed' | 'failed' | 'error'
  /** Last part of the command's output. */
  output: string
  ms: number
}

export interface ReviewChecks {
  status: 'running' | 'done' | 'skipped'
  /** Why the checks were skipped or could not run. */
  reason: string | null
  results: CheckResult[]
  /** Ran inside the OS sandbox (macOS/Linux); false on Windows or with the project's sandbox off. */
  sandboxed?: boolean
}

export interface AiFinding {
  severity: 'high' | 'medium' | 'low'
  file: string
  line: number | null
  title: string
  detail: string
}

/** The reviewer agent's report. Advisory: it read agent-written code and can be fooled by it. */
export interface AiReview {
  status: 'running' | 'done' | 'error'
  verdict: 'approve' | 'concerns' | 'block' | null
  summary: string
  findings: AiFinding[]
  costUsd: number
  error: string | null
}

/** Findings from the web researcher, held back from every agent until you approve them. */
export interface ResearchFindings {
  markdown: string
  /** Pages the researcher actually fetched, recorded by Hangar (not taken from the report). */
  fetched: string[]
  /** Searches it ran. */
  queries: string[]
  /** Links the report cites. */
  cited: string[]
  /** Hidden or direction-changing characters were found and removed. */
  hiddenChars: boolean
  /** Where it was saved once approved (inside the project). */
  savedAs: string | null
}

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
  /** "research" reviews hold web findings instead of a branch (branch and shas are empty). */
  kind?: 'code' | 'research'
  checks?: ReviewChecks | null
  aiReview?: AiReview | null
  research?: ResearchFindings | null
  /** When it was merged or discarded (absent while pending, and on reviews from before this was recorded). */
  decidedAt?: number
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
  /** Claude plan usage (Claude Max mode), from what the engine last reported; null until it reports any. */
  plan: PlanUsage | null
  /** Estimated spend over the last 7 days, all projects. */
  weekUsd: number
}

/** One folder of the project, for the Files tab (read-only). */
export interface FileListing {
  path: string
  entries: { name: string; path: string; kind: 'dir' | 'file'; size: number; mtime: number }[]
  /** Entries past the limit that aren't listed. */
  more: number
  /** The folder was too big to read to the end, so there are more than `more`. */
  capped: boolean
  /** Links, `.git` and other non-files left out. */
  skipped: number
}

/** One project file as the Files tab shows it: text up to 512 KB, or why it isn't shown. */
export interface FileView {
  path: string
  size: number
  mtime: number
  kind: 'text' | 'binary'
  text: string | null
  truncated: boolean
}

/** One day of spend, for the bars on Home and the Project tab. */
export interface CostDay {
  /** Local midnight the day starts at. */
  start: number
  usd: number
  /** Split by agent id (one project's history) or by project id (all games). */
  by: Record<string, number>
}

export interface PlanUsageWindow {
  /** Percent of the window used, 0–100. */
  usedPct: number
  /** When the window resets (ms since epoch), if known. */
  resetsAt: number | null
  /** When Hangar last heard about it. */
  at: number
}

export interface PlanUsage {
  fiveHour: PlanUsageWindow | null
  weekly: PlanUsageWindow | null
  /** Set while the plan refuses requests (a limit was hit): which window and when it lifts. */
  blocked: { window: string; until: number | null } | null
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

/** The project's GitHub repository (git's `origin` remote), for the GitHub settings card. */
export interface GitHubLink {
  isRepo: boolean
  /** "owner/name" when origin is a GitHub repository. */
  repo: string | null
  /** The repository's page, to open in the browser. */
  webUrl: string | null
  /** origin's address when it is set but isn't a GitHub repository (Hangar won't push there). */
  otherRemote: string | null
  /** The branch Push and Pull use (the current one). */
  branch: string | null
}

// ---------- new game flow, autopilot, trends ----------

/** Everything the "New game" wizard collects. */
export interface NewGameInput {
  name: string
  /** Folder the new project folder is created in. */
  parentDir: string
  /** The game idea, in the user's words. */
  idea: string
  /** Text of an attached design document (optional). */
  document: { name: string; text: string } | null
  platforms: ('phone' | 'pc' | 'console' | 'vr')[]
  genre: string
  notes: string
  model: string | null
  dailyBudgetUsd: number | null
  studioTools: boolean
  autopilot: AutopilotConfig
  /** Start autopilot right after creating the project. */
  startNow: boolean
}

export interface AutopilotConfig {
  /** Build tasks per sprint before the check-in. */
  sprintTasks: number
  /** Spending limit per sprint (USD); the sprint ends early when it's reached. */
  sprintBudgetUsd: number
  /** Merge finished work automatically when checks pass and the reviewer approves. */
  autoMerge: boolean
}

export type AutopilotStatus = 'off' | 'running' | 'waiting' | 'checkin' | 'paused'

export interface SprintReport {
  sprint: number
  at: number
  text: string
  /** Tasks finished in this sprint and what happened to them. */
  tasks: { title: string; outcome: 'merged' | 'waiting' | 'discarded' | 'no-changes' | 'failed' }[]
  spentUsd: number
  /** The product owner's answers to this check-in's questions (the decisions trail). */
  answers?: { question: string; answer: string }[]
}

export interface AutopilotState {
  projectId: string
  status: AutopilotStatus
  config: AutopilotConfig
  sprint: number
  tasksDone: number
  /** Project spend when the sprint started (sprint spend = total now − this). */
  spentAtSprintStart: number
  /** Why autopilot is waiting or paused. */
  reason: string | null
  /** The review autopilot is waiting on (checks, reviewer, or you). */
  awaitingReviewId: string | null
  /** Product-owner feedback to give the Lead at the start of the next task. */
  feedback: string[]
  /** Feedback already put into the Lead's queued task; given back if that task never finishes. */
  handedFeedback?: string[]
  sprintTasks: SprintReport['tasks']
  reports: SprintReport[]
  consecutiveFailures: number
  updatedAt: number
}

/** A Roblox experience from the discovery lists, with Hangar's trending score. */
export interface TrendingGame {
  universeId: number
  placeId: number
  name: string
  genre: string
  description: string
  players: number
  visits: number
  favorites: number
  likeRatio: number
  createdAt: number | null
  updatedAt: number | null
  /** Discovery lists it appears in, with its position (1 = top). */
  lists: { list: 'top-trending' | 'up-and-coming' | 'top-playing-now'; rank: number }[]
  /** 0–100: demand, reduced for how saturated its space is (see trending.ts). */
  score: number
  /** 0–100 before the saturation adjustment. */
  demand: number
  parts: { momentum: number; placement: number; freshness: number; approval: number; scale: number; saturation: number }
  /** Player-count change since the snapshot about a day ago (null until there's history). */
  growth: number | null
}

/** An original game idea generated from what's trending. */
export type IdeaCategory = 'trend' | 'original' | 'niche' | 'mashup' | 'experimental'

export interface GameIdea {
  id: string
  title: string
  pitch: string
  /** Empty until the details are generated (ideas start short to save tokens). */
  coreLoop: string
  whyNow: string
  /** What kind of idea was asked for (absent on ideas from before categories). */
  category?: IdeaCategory
  /** True once the full details (loop, why now, features, first version) have been generated. */
  detailed?: boolean
  features?: string[]
  /** What to build first: the smallest playable version. */
  firstVersion?: string
  genre: string
  scope: 'small' | 'medium' | 'large'
  inspiredBy: string[]
  score: number
  /** The version before the last refine, for Undo. */
  previous?: Omit<GameIdea, 'previous'>
}

/** A 3D model in a project: a Blender mesh export, or a Studio builder script (the model as Luau). */
export interface ModelFile {
  name: string
  kind: 'mesh' | 'builder'
  /** Path inside the project, forward slashes. */
  file: string
  /** Preview image as a data: URL (Blender renders one next to the mesh), if there is one. */
  preview: string | null
  updatedAt: number
}

/** A request to make a 3D model, from the project's 3D tab. */
export interface ModelRequest {
  method: 'studio' | 'blender'
  name: string
  description: string
  style: 'low-poly' | 'blocky' | 'stylized' | 'detailed'
  size: 'prop' | 'character' | 'vehicle' | 'building'
}

/** One message in the idea brainstorm chat on Home. */
export interface IdeaChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  /** A game brief Claude proposed in this reply, ready for the New game wizard. */
  idea?: GameIdea
}

export interface TrendsSnapshot {
  fetchedAt: number | null
  games: TrendingGame[]
  /** Game spaces (Roblox sub-genres): demand, how saturated they are (0–100, higher = more crowded), and the resulting score. */
  genres: { genre: string; score: number; demand: number; saturation: number; games: number; leader: string }[]
  ideas: GameIdea[]
  ideasAt: number | null
  error: string | null
  /** Ideas the user starred; they survive "New ideas". */
  saved: GameIdea[]
}

export type AgentEvent =
  | { type: 'state'; state: AgentState }
  | { type: 'log'; projectId: string; agentId: string; entry: LogEntry }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval_resolved'; id: string }
  | { type: 'cost'; summary: CostSummary }
  | { type: 'reset'; projectId: string; agentId: string }
  | { type: 'review'; review: Review }
  | { type: 'autopilot'; state: AutopilotState }
  /** Sent to the window only (from a clicked desktop notification): open the Inbox. */
  | { type: 'openInbox' }
  /** Ideas changed somewhere other than the window (an idea saved on the phone). */
  | { type: 'trends'; snapshot: TrendsSnapshot }

export interface Result<T> {
  ok: boolean
  value?: T
  error?: string
}
