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
  agentEvent: 'agent:event'
} as const

export interface KeyStatus {
  hasKey: boolean
  /** False when the OS cannot encrypt secrets; the key is then not saved to disk. */
  encryptionAvailable: boolean
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
    send(projectId: string, agentId: string, prompt: string): Promise<void>
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
  onAgentEvent(listener: (event: AgentEvent) => void): () => void
}
