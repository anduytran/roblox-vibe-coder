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
    clear: () => invoke(IPC.keyClear),
    setMaxToken: (token) => invoke(IPC.maxTokenSet, token),
    clearMaxToken: () => invoke(IPC.maxTokenClear)
  },
  projects: {
    list: () => invoke(IPC.projectsList),
    add: () => invoke(IPC.projectsAdd),
    remove: (id) => invoke(IPC.projectsRemove, id),
    update: (id, patch) => invoke(IPC.projectsUpdate, id, patch),
    reveal: (id) => invoke(IPC.projectsReveal, id),
    create: (input) => invoke(IPC.projectsCreate, input),
    pickFolder: () => invoke(IPC.projectsPickFolder),
    readDocument: () => invoke(IPC.projectsReadDocument)
  },
  system: {
    tools: () => invoke(IPC.systemTools),
    openUrl: (url) => invoke(IPC.systemOpenUrl, url)
  },
  autopilot: {
    list: () => invoke(IPC.autopilotList),
    start: (id, opts) => invoke(IPC.autopilotStart, id, opts),
    pause: (id) => invoke(IPC.autopilotPause, id),
    resume: (id) => invoke(IPC.autopilotResume, id),
    stop: (id) => invoke(IPC.autopilotStop, id),
    configure: (id, config) => invoke(IPC.autopilotConfigure, id, config),
    feedback: (id, text) => invoke(IPC.autopilotFeedback, id, text)
  },
  trends: {
    get: () => invoke(IPC.trendsGet),
    refresh: () => invoke(IPC.trendsRefresh),
    ideas: (category) => invoke(IPC.trendsIdeas, category),
    refineIdea: (id, request) => invoke(IPC.trendsRefineIdea, id, request),
    undoRefine: (id) => invoke(IPC.trendsUndoRefine, id),
    saveIdea: (id) => invoke(IPC.trendsSaveIdea, id),
    unsaveIdea: (id) => invoke(IPC.trendsUnsaveIdea, id)
  },
  ideaChat: {
    get: () => invoke(IPC.ideaChatGet),
    send: (text, category) => invoke(IPC.ideaChatSend, text, category),
    clear: () => invoke(IPC.ideaChatClear)
  },
  roles: {
    list: (id) => invoke(IPC.rolesList, id),
    installTemplates: (id) => invoke(IPC.rolesInstallTemplates, id),
    save: (id, role) => invoke(IPC.rolesSave, id, role),
    delete: (id, roleId) => invoke(IPC.rolesDelete, id, roleId)
  },
  models: {
    list: (projectId) => invoke(IPC.modelsList, projectId),
    make: (projectId, request) => invoke(IPC.modelsMake, projectId, request),
    reveal: (projectId, file) => invoke(IPC.modelsReveal, projectId, file)
  },
  agents: {
    snapshot: (id) => invoke(IPC.agentsSnapshot, id),
    send: (id, agentId, prompt, opts) => invoke(IPC.agentsSend, id, agentId, prompt, opts),
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
    summary: () => invoke(IPC.costsSummary),
    refreshPlan: () => invoke(IPC.planUsageRefresh)
  },
  reviews: {
    list: (id) => invoke(IPC.reviewsList, id),
    diff: (id) => invoke(IPC.reviewsDiff, id),
    merge: (id, opts) => invoke(IPC.reviewsMerge, id, opts),
    discard: (id) => invoke(IPC.reviewsDiscard, id),
    checkout: (id) => invoke(IPC.reviewsCheckout, id),
    checkoutBase: (id) => invoke(IPC.reviewsCheckoutBase, id),
    clipFile: (id, index) => invoke(IPC.reviewsClipFile, id, index),
    publish: (id) => invoke(IPC.reviewsPublish, id),
    recheck: (id, opts) => invoke(IPC.reviewsRecheck, id, opts)
  },
  vault: {
    status: (id, folder) => invoke(IPC.vaultStatus, id, folder),
    create: (id, folder) => invoke(IPC.vaultCreate, id, folder),
    open: (id, folder) => invoke(IPC.vaultOpen, id, folder)
  },
  testPlaceKey: {
    status: (id) => invoke(IPC.testPlaceKeyStatus, id),
    set: (id, key) => invoke(IPC.testPlaceKeySet, id, key),
    clear: (id) => invoke(IPC.testPlaceKeyClear, id)
  },
  remote: {
    status: () => invoke(IPC.remoteStatus),
    set: (patch) => invoke(IPC.remoteSet, patch),
    pair: () => invoke(IPC.remotePair),
    unpair: (id) => invoke(IPC.remoteUnpair, id)
  },
  onAgentEvent(listener) {
    const wrapped = (_e: IpcRendererEvent, event: AgentEvent): void => listener(event)
    ipcRenderer.on(IPC.agentEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.agentEvent, wrapped)
  }
}

contextBridge.exposeInMainWorld('hangar', api)
