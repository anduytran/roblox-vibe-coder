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
  Role
} from './types'

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  keyStatus: 'key:status',
  keySet: 'key:set',
  keyClear: 'key:clear',
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
  remoteStatus: 'remote:status',
  remoteSet: 'remote:set',
  remotePair: 'remote:pair',
  remoteUnpair: 'remote:unpair',
  agentEvent: 'agent:event'
} as const

export interface KeyStatus {
  hasKey: boolean
  /** False when the OS cannot encrypt secrets; the key is then not saved to disk. */
  encryptionAvailable: boolean
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
  }
  projects: {
    list(): Promise<Project[]>
    /** Opens a folder picker. Resolves null if cancelled. */
    add(): Promise<Project | null>
    remove(projectId: string): Promise<void>
    update(projectId: string, patch: { name?: string; settings?: Partial<ProjectSettings> }): Promise<Project>
    reveal(projectId: string): Promise<void>
  }
  roles: {
    list(projectId: string): Promise<Role[]>
    installTemplates(projectId: string): Promise<Role[]>
    save(projectId: string, role: Role): Promise<Role[]>
    delete(projectId: string, roleId: string): Promise<Role[]>
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
