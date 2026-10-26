// IPC channel names and the API surface exposed to the renderer as window.hangar.
import type {
  AgentEvent,
  AgentState,
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  CostSummary,
  GitStatus,
  Project,
  ProjectSettings,
  Review,
  Role,
  AutopilotConfig,
  AutopilotState,
  NewGameInput,
  TrendsSnapshot,
  IdeaChatMessage,
  IdeaCategory,
  ModelFile,
  ModelRequest
} from './types'

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  keyStatus: 'key:status',
  keySet: 'key:set',
  keyClear: 'key:clear',
  maxTokenSet: 'maxToken:set',
  maxTokenClear: 'maxToken:clear',
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsRemove: 'projects:remove',
  projectsUpdate: 'projects:update',
  projectsReveal: 'projects:reveal',
  rolesList: 'roles:list',
  rolesInstallTemplates: 'roles:installTemplates',
  rolesSave: 'roles:save',
  rolesDelete: 'roles:delete',
  agentsSnapshot: 'agents:snapshot',
  agentsSend: 'agents:send',
  modelsList: 'models:list',
  modelsMake: 'models:make',
  modelsReveal: 'models:reveal',
  agentsStop: 'agents:stop',
  agentsStopAll: 'agents:stopAll',
  agentsClearQueue: 'agents:clearQueue',
  agentsResetSession: 'agents:resetSession',
  approvalsPending: 'approvals:pending',
  approvalsRespond: 'approvals:respond',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitCommit: 'git:commit',
  gitRevertFile: 'git:revertFile',
  gitInit: 'git:init',
  costsSummary: 'costs:summary',
  planUsageRefresh: 'planUsage:refresh',
  reviewsList: 'reviews:list',
  reviewsDiff: 'reviews:diff',
  reviewsMerge: 'reviews:merge',
  reviewsDiscard: 'reviews:discard',
  reviewsCheckout: 'reviews:checkout',
  reviewsCheckoutBase: 'reviews:checkoutBase',
  reviewsClipFile: 'reviews:clipFile',
  reviewsPublish: 'reviews:publish',
  reviewsRecheck: 'reviews:recheck',
  testPlaceKeyStatus: 'testPlaceKey:status',
  testPlaceKeySet: 'testPlaceKey:set',
  testPlaceKeyClear: 'testPlaceKey:clear',
  vaultStatus: 'vault:status',
  vaultCreate: 'vault:create',
  vaultOpen: 'vault:open',
  vaultNotes: 'vault:notes',
  vaultRead: 'vault:read',
  remoteStatus: 'remote:status',
  remoteSet: 'remote:set',
  remotePair: 'remote:pair',
  remoteUnpair: 'remote:unpair',
  projectsCreate: 'projects:create',
  projectsPickFolder: 'projects:pickFolder',
  projectsReadDocument: 'projects:readDocument',
  systemTools: 'system:tools',
  systemOpenUrl: 'system:openUrl',
  autopilotList: 'autopilot:list',
  autopilotStart: 'autopilot:start',
  autopilotPause: 'autopilot:pause',
  autopilotResume: 'autopilot:resume',
  autopilotStop: 'autopilot:stop',
  autopilotConfigure: 'autopilot:configure',
  autopilotFeedback: 'autopilot:feedback',
  trendsGet: 'trends:get',
  trendsRefresh: 'trends:refresh',
  trendsIdeas: 'trends:ideas',
  trendsRefineIdea: 'trends:refineIdea',
  trendsUndoRefine: 'trends:undoRefine',
  trendsSaveIdea: 'trends:saveIdea',
  trendsUnsaveIdea: 'trends:unsaveIdea',
  ideaChatGet: 'ideaChat:get',
  ideaChatSend: 'ideaChat:send',
  ideaChatClear: 'ideaChat:clear',
  agentEvent: 'agent:event'
} as const

export interface KeyStatus {
  hasKey: boolean
  /** False when the OS cannot encrypt secrets; the key is then not saved to disk. */
  encryptionAvailable: boolean
  /** Claude Max mode (personal use) can be turned on: development builds only. */
  maxAvailable: boolean
  /** A Claude subscription token is saved. */
  hasMaxToken: boolean
  /** The credential for the active mode is saved, so agents can run. */
  ready: boolean
}

export interface RemoteStatus {
  enabled: boolean
  port: number
  /** URL to open on the phone once `tailscale serve` is set up, if Hangar could detect it. */
  url: string | null
  /** The command that exposes Hangar to your own Tailscale devices (HTTPS, tailnet only). */
  serveCommand: string
  devices: { id: string; name: string; pairedAt: number; lastSeen: number | null }[]
  pushReady: boolean
}

export interface HangarApi {
  /** The OS Hangar runs on ("win32", "darwin", "linux"). */
  platform: string
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  key: {
    status(): Promise<KeyStatus>
    set(key: string): Promise<KeyStatus>
    clear(): Promise<KeyStatus>
    setMaxToken(token: string): Promise<KeyStatus>
    clearMaxToken(): Promise<KeyStatus>
  }
  projects: {
    list(): Promise<Project[]>
    /** Opens a folder picker. Resolves null if cancelled. */
    add(): Promise<Project | null>
    remove(projectId: string): Promise<void>
    update(projectId: string, patch: { name?: string; settings?: Partial<ProjectSettings> }): Promise<Project>
    reveal(projectId: string): Promise<void>
    /** Create a new game project from the wizard; starts autopilot if asked (and an API key is saved). */
    create(input: NewGameInput): Promise<{ project: Project; started: boolean; note: string | null }>
    /** Folder picker for where new projects go. */
    pickFolder(): Promise<string | null>
    /** Pick a design document (Markdown or text) to attach to the brief. */
    readDocument(): Promise<{ name: string; text: string } | null>
  }
  system: {
    /** Which build tools are installed (used to pick the checks for new projects). */
    tools(): Promise<{ rojo: boolean; selene: boolean; stylua: boolean; git: boolean; defaultParent: string }>
    /** Offer to open an https link in the browser (Hangar asks first, showing the full address). */
    openUrl(url: string): Promise<void>
  }
  autopilot: {
    list(): Promise<AutopilotState[]>
    start(projectId: string, opts?: { feedback?: string; config?: Partial<AutopilotConfig>; answers?: { question: string; answer: string }[] }): Promise<AutopilotState>
    pause(projectId: string): Promise<AutopilotState>
    resume(projectId: string): Promise<AutopilotState>
    stop(projectId: string): Promise<AutopilotState>
    configure(projectId: string, config: Partial<AutopilotConfig>): Promise<AutopilotState>
    feedback(projectId: string, text: string): Promise<AutopilotState>
  }
  trends: {
    get(): Promise<TrendsSnapshot>
    refresh(): Promise<TrendsSnapshot>
    ideas(category?: IdeaCategory): Promise<TrendsSnapshot>
    /** Rewrite one idea as asked; the previous version is kept for undoRefine. */
    refineIdea(id: string, request: string): Promise<TrendsSnapshot>
    undoRefine(id: string): Promise<TrendsSnapshot>
    /** Star a dashboard idea or chat brief; saved ideas survive New ideas. */
    saveIdea(id: string): Promise<TrendsSnapshot>
    unsaveIdea(id: string): Promise<TrendsSnapshot>
  }
  ideaChat: {
    get(): Promise<IdeaChatMessage[]>
    /** Resolves with the whole conversation, including Claude's reply. */
    send(text: string, category?: IdeaCategory): Promise<IdeaChatMessage[]>
    clear(): Promise<IdeaChatMessage[]>
  }
  roles: {
    list(projectId: string): Promise<Role[]>
    installTemplates(projectId: string): Promise<Role[]>
    save(projectId: string, role: Role): Promise<Role[]>
    delete(projectId: string, roleId: string): Promise<Role[]>
  }
  models: {
    list(projectId: string): Promise<ModelFile[]>
    /** Starts the Studio or Blender modeler on the request; resolves with the agent id that runs it. */
    make(projectId: string, request: ModelRequest): Promise<string>
    /** Shows a model file (or the models folder) in Finder / Explorer. */
    reveal(projectId: string, file?: string): Promise<void>
  }
  agents: {
    snapshot(projectId: string): Promise<AgentState[]>
    send(projectId: string, agentId: string, prompt: string, opts?: { record?: boolean }): Promise<void>
    stop(projectId: string, agentId: string): Promise<void>
    stopAll(): Promise<void>
    clearQueue(projectId: string, agentId: string): Promise<void>
    resetSession(projectId: string, agentId: string): Promise<void>
  }
  approvals: {
    pending(): Promise<ApprovalRequest[]>
    respond(id: string, decision: ApprovalDecision): Promise<void>
  }
  git: {
    status(projectId: string): Promise<GitStatus>
    diff(projectId: string, file?: string): Promise<string>
    commit(projectId: string, message: string): Promise<void>
    revertFile(projectId: string, file: string): Promise<void>
    init(projectId: string): Promise<void>
  }
  costs: {
    summary(): Promise<CostSummary>
    /** Claude Max mode: ask the plan for its current 5-hour and weekly usage. */
    refreshPlan(): Promise<CostSummary>
  }
  reviews: {
    list(projectId: string): Promise<Review[]>
    diff(reviewId: string): Promise<string>
    /** For research reviews: approve and save to research/. `force` merges despite failing checks or a reviewer block. */
    merge(reviewId: string, opts?: { force?: boolean; acknowledged?: string[] }): Promise<Review>
    discard(reviewId: string): Promise<Review>
    /** Switch the project folder to the review's branch so you can try it in Studio. */
    checkout(reviewId: string): Promise<void>
    checkoutBase(projectId: string): Promise<void>
    /** A clip file as a data: URL for display. */
    clipFile(reviewId: string, index: number): Promise<string>
    publish(reviewId: string): Promise<Review>
    /** Run the checks again (and the reviewer agent if `reviewer`). */
    recheck(reviewId: string, opts?: { reviewer?: boolean }): Promise<Review>
  }
  vault: {
    status(projectId: string, folder: string): Promise<{ folder: string; exists: boolean; notes: number }>
    create(projectId: string, folder: string): Promise<{ folder: string; exists: boolean; notes: number }>
    /** Open the vault in Obsidian (or the folder, if Obsidian isn't installed). */
    open(projectId: string, folder: string): Promise<void>
    /** Every role vault in the project with its notes (design vaults first), for the Design tab. */
    notes(projectId: string): Promise<{ folder: string; kind: 'design' | 'ui'; role: string; notes: { path: string; title: string }[] }[]>
    read(projectId: string, folder: string, path: string): Promise<string>
  }
  testPlaceKey: {
    status(projectId: string): Promise<{ hasKey: boolean }>
    set(projectId: string, key: string): Promise<{ hasKey: boolean }>
    clear(projectId: string): Promise<{ hasKey: boolean }>
  }
  remote: {
    status(): Promise<RemoteStatus>
    set(patch: { enabled?: boolean }): Promise<RemoteStatus>
    /** Start pairing: returns a 6-digit code valid for 5 minutes. */
    pair(): Promise<{ code: string; expiresAt: number }>
    unpair(deviceId: string): Promise<RemoteStatus>
  }
  onAgentEvent(listener: (event: AgentEvent) => void): () => void
}
