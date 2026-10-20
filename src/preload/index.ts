import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type HangarApi } from '@shared/ipc'
import type { AgentEvent } from '@shared/types'

// The only bridge between the UI and the main process. It exposes named functions,
// never ipcRenderer itself, so the page can't call arbitrary channels.
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: HangarApi = {
  platform: process.platform,
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch)
  },
  key: {
    status: () => invoke(IPC.keyStatus),
    set: (key) => invoke(IPC.keySet, key),
    clear: () => invoke(IPC.keyClear)
  },
  projects: {
    list: () => invoke(IPC.projectsList),
    add: () => invoke(IPC.projectsAdd),
    remove: (id) => invoke(IPC.projectsRemove, id),
    update: (id, patch) => invoke(IPC.projectsUpdate, id, patch),
    reveal: (id) => invoke(IPC.projectsReveal, id)
  },
  roles: {
    list: (id) => invoke(IPC.rolesList, id),
    installTemplates: (id) => invoke(IPC.rolesInstallTemplates, id),
    save: (id, role) => invoke(IPC.rolesSave, id, role),
    delete: (id, roleId) => invoke(IPC.rolesDelete, id, roleId)
  },
  agents: {
    snapshot: (id) => invoke(IPC.agentsSnapshot, id),
    send: (id, agentId, prompt) => invoke(IPC.agentsSend, id, agentId, prompt),
    stop: (id, agentId) => invoke(IPC.agentsStop, id, agentId),
    stopAll: () => invoke(IPC.agentsStopAll),
    clearQueue: (id, agentId) => invoke(IPC.agentsClearQueue, id, agentId),
    resetSession: (id, agentId) => invoke(IPC.agentsResetSession, id, agentId)
  },
  approvals: {
    pending: () => invoke(IPC.approvalsPending),
    respond: (id, decision) => invoke(IPC.approvalsRespond, id, decision)
  },
  git: {
    status: (id) => invoke(IPC.gitStatus, id),
    diff: (id, file) => invoke(IPC.gitDiff, id, file),
    commit: (id, message) => invoke(IPC.gitCommit, id, message),
    revertFile: (id, file) => invoke(IPC.gitRevertFile, id, file),
    init: (id) => invoke(IPC.gitInit, id)
  },
  costs: {
    summary: () => invoke(IPC.costsSummary)
  },
  onAgentEvent(listener) {
    const wrapped = (_e: IpcRendererEvent, event: AgentEvent): void => listener(event)
    ipcRenderer.on(IPC.agentEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.agentEvent, wrapped)
  }
}

contextBridge.exposeInMainWorld('hangar', api)
