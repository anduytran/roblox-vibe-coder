import { useSyncExternalStore } from 'react'
import type { KeyStatus } from '@shared/ipc'
import type { AgentEvent, AgentState, AppSettings, ApprovalRequest, CostSummary, Project, Role } from '@shared/types'

export interface StoreState {
  ready: boolean
  projects: Project[]
  selectedProjectId: string | null
  /** projectId -> agentId -> state */
  agents: Record<string, Record<string, AgentState>>
  roles: Record<string, Role[]>
  approvals: ApprovalRequest[]
  costs: CostSummary
  settings: AppSettings | null
  key: KeyStatus
  toast: { id: number; text: string; tone: 'info' | 'error' } | null
}

let state: StoreState = {
  ready: false,
  projects: [],
  selectedProjectId: null,
  agents: {},
  roles: {},
  approvals: [],
  costs: { todayUsd: 0, projectTodayUsd: {}, projectTotalUsd: {} },
  settings: null,
  key: { hasKey: false, encryptionAvailable: true },
  toast: null
}

/** Stable empty values so selectors never return a fresh object (which would re-render forever). */
export const EMPTY_ROLES: Role[] = []
export const EMPTY_AGENTS: Record<string, AgentState> = {}

const listeners = new Set<() => void>()

function set(patch: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export function getState(): StoreState {
  return state
}

export function useStore<T>(selector: (s: StoreState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => selector(state)
  )
}

const api = (): typeof window.hangar => window.hangar

let toastSeq = 0
export function toast(text: string, tone: 'info' | 'error' = 'info'): void {
  const id = ++toastSeq
  set({ toast: { id, text, tone } })
  setTimeout(() => {
    if (state.toast?.id === id) set({ toast: null })
  }, tone === 'error' ? 7000 : 3500)
}

/** Run an API call, showing a toast instead of throwing on failure. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
    toast(message, 'error')
    return undefined
  }
}

function applyEvent(e: AgentEvent): void {
  switch (e.type) {
    case 'state':
      set((s) => {
        const proj = { ...(s.agents[e.state.projectId] ?? {}) }
        const prev = proj[e.state.agentId]
        proj[e.state.agentId] = { ...e.state, log: prev?.log ?? [] }
        return { agents: { ...s.agents, [e.state.projectId]: proj } }
      })
      break
    case 'log':
      set((s) => {
        const proj = { ...(s.agents[e.projectId] ?? {}) }
        const prev = proj[e.agentId]
        if (!prev) return {}
        const log = [...prev.log, e.entry]
        proj[e.agentId] = { ...prev, log: log.length > 600 ? log.slice(-600) : log }
        return { agents: { ...s.agents, [e.projectId]: proj } }
      })
      break
    case 'reset':
      set((s) => {
        const proj = { ...(s.agents[e.projectId] ?? {}) }
        const prev = proj[e.agentId]
        if (prev) proj[e.agentId] = { ...prev, log: [] }
        return { agents: { ...s.agents, [e.projectId]: proj } }
      })
      break
    case 'approval':
      set((s) => ({ approvals: [...s.approvals.filter((a) => a.id !== e.request.id), e.request] }))
      break
    case 'approval_resolved':
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.id) }))
      break
    case 'cost':
      set({ costs: e.summary })
      break
  }
}

export function initStore(): void {
  api().onAgentEvent(applyEvent)
  void (async () => {
    const [projects, settings, key, costs, approvals] = await Promise.all([
      api().projects.list(),
      api().settings.get(),
      api().key.status(),
      api().costs.summary(),
      api().approvals.pending()
    ])
    let selected: string | null = null
    try {
      selected = localStorage.getItem('hangar.selectedProject')
    } catch {
      selected = null
    }
    if (!projects.some((p) => p.id === selected)) selected = projects[0]?.id ?? null
    set({ ready: true, projects, settings, key, costs, approvals, selectedProjectId: selected })
    for (const p of projects) void loadProject(p.id)
  })()
}

export async function loadProject(projectId: string): Promise<void> {
  const [agents, roles] = await Promise.all([api().agents.snapshot(projectId), api().roles.list(projectId)])
  const map: Record<string, AgentState> = {}
  for (const a of agents) map[a.agentId] = a
  set((s) => ({ agents: { ...s.agents, [projectId]: map }, roles: { ...s.roles, [projectId]: roles } }))
}

export function selectProject(id: string | null): void {
  set({ selectedProjectId: id })
  try {
    if (id) localStorage.setItem('hangar.selectedProject', id)
  } catch {
    // Storage unavailable: selection just isn't remembered.
  }
}

export async function addProject(): Promise<void> {
  const p = await attempt(() => api().projects.add())
  if (!p) return
  set((s) => ({ projects: s.projects.some((x) => x.id === p.id) ? s.projects : [...s.projects, p] }))
  selectProject(p.id)
  await loadProject(p.id)
}

export async function removeProject(id: string): Promise<void> {
  await attempt(() => api().projects.remove(id))
  set((s) => {
    const projects = s.projects.filter((p) => p.id !== id)
    return { projects, selectedProjectId: s.selectedProjectId === id ? (projects[0]?.id ?? null) : s.selectedProjectId }
  })
}

export function replaceProject(p: Project): void {
  set((s) => ({ projects: s.projects.map((x) => (x.id === p.id ? p : x)) }))
}

export async function refreshProjects(): Promise<void> {
  const projects = await api().projects.list()
  set({ projects })
}

export function setRoles(projectId: string, roles: Role[]): void {
  set((s) => ({ roles: { ...s.roles, [projectId]: roles } }))
  void loadProject(projectId)
}

export function setSettings(settings: AppSettings): void {
  set({ settings })
}

export function setKey(key: KeyStatus): void {
  set({ key })
}
