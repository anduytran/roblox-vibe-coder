import { useSyncExternalStore } from 'react'
import type { KeyStatus } from '@shared/ipc'
import type { AgentEvent, AgentState, AppSettings, ApprovalRequest, AutopilotState, CostSummary, IdeaCategory, StudioSyncState, Project, Review, Role, TrendsSnapshot } from '@shared/types'

export type ProjectTab = 'overview' | 'design' | 'agents' | 'models' | 'reviews' | 'changes' | 'files' | 'settings'
/** The project tabs in order (Cmd/Ctrl+1…8). */
export const PROJECT_TABS: ProjectTab[] = ['overview', 'design', 'agents', 'models', 'reviews', 'changes', 'files', 'settings']
export type SettingsTab = 'general' | 'account' | 'agents' | 'limits' | 'roblox' | 'phone' | 'privacy'
export type Page = 'home' | 'ideas'

export interface StoreState {
  ready: boolean
  projects: Project[]
  selectedProjectId: string | null
  /** Which app page shows when no project is selected. */
  page: Page
  /** The open tab of the selected project. */
  projectTab: ProjectTab
  /** Something to bring into view on the project's tab (from Home or the Inbox). `seq` makes repeats count. */
  focus: { agentId?: string; reviewId?: string; seq: number } | null
  /** The Inbox side panel (everything waiting for you, across games). */
  inboxOpen: boolean
  /** The App Settings dialog, open at this category (null: closed). */
  settingsTab: SettingsTab | null
  /** The trending charts are being fetched. */
  trendsLoading: boolean
  /** A branch switch blocked by uncommitted changes: the dialog to commit or discard them, then retry. */
  uncommitted: { projectId: string; retry?: () => Promise<unknown> } | null
  /** Live sync into Roblox Studio (one game at a time). */
  studioSync: StudioSyncState
  /** projectId -> agentId -> state */
  agents: Record<string, Record<string, AgentState>>
  roles: Record<string, Role[]>
  /** projectId -> reviews (newest first) */
  reviews: Record<string, Review[]>
  approvals: ApprovalRequest[]
  costs: CostSummary
  settings: AppSettings | null
  key: KeyStatus
  toast: { id: number; text: string; tone: 'info' | 'error' } | null
  /** projectId -> autopilot state */
  autopilot: Record<string, AutopilotState>
  trends: TrendsSnapshot | null
  /** The "New game" wizard, optionally prefilled (from a trending suggestion). */
  wizard: { idea?: string; name?: string; genre?: string } | null
  /** The idea brainstorm chat, if open, with text to start the message box with. */
  ideaChat: { draft: string; category: IdeaCategory } | null
  /** The dashboard idea open on the refine screen. */
  refineIdeaId: string | null
  /** The in-app confirmation dialog, if one is open. */
  confirm: ConfirmRequest | null
}

export interface ConfirmRequest {
  id: number
  title: string
  /** One short paragraph. */
  body?: string
  /** Warnings shown as a list (for example why a merge needs a second look). */
  lines?: string[]
  confirmLabel: string
  tone: 'primary' | 'danger'
}

let state: StoreState = {
  ready: false,
  projects: [],
  selectedProjectId: null,
  page: 'home',
  projectTab: 'overview',
  focus: null,
  inboxOpen: false,
  settingsTab: null,
  trendsLoading: false,
  uncommitted: null,
  studioSync: { projectId: null, status: 'off', port: 34872, message: null },
  agents: {},
  roles: {},
  reviews: {},
  approvals: [],
  costs: { todayUsd: 0, projectTodayUsd: {}, projectTotalUsd: {}, plan: null, weekUsd: 0 },
  settings: null,
  key: { hasKey: false, encryptionAvailable: true, maxAvailable: false, hasMaxToken: false, ready: false },
  toast: null,
  autopilot: {},
  trends: null,
  wizard: null,
  ideaChat: null,
  refineIdeaId: null,
  confirm: null
}

/** Stable empty values so selectors never return a fresh object (which would re-render forever). */
export const EMPTY_ROLES: Role[] = []
export const EMPTY_AGENTS: Record<string, AgentState> = {}
export const EMPTY_REVIEWS: Review[] = []

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
    // Blocked by uncommitted changes in the open game: show them, to commit or discard, then try again.
    const projectId = getState().selectedProjectId
    if (/There are uncommitted changes/i.test(message) && projectId && !getState().uncommitted) {
      openUncommitted(projectId, fn)
      return undefined
    }
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
    case 'autopilot':
      set((s) => ({ autopilot: { ...s.autopilot, [e.state.projectId]: e.state } }))
      break
    case 'studioSync':
      set({ studioSync: e.state })
      break
    case 'trends':
      set({ trends: normalizeTrends(e.snapshot) })
      break
    case 'openInbox':
      // Never over a dialog that's waiting for an answer.
      if (document.querySelector('.modal-backdrop')) break
      set({ inboxOpen: true })
      break
    case 'review':
      set((s) => {
        const list = (s.reviews[e.review.projectId] ?? []).filter((r) => r.id !== e.review.id)
        return { reviews: { ...s.reviews, [e.review.projectId]: [e.review, ...list].sort((a, b) => b.createdAt - a.createdAt) } }
      })
      break
  }
}

export function initStore(): void {
  api().onAgentEvent(applyEvent)
  void (async () => {
    const [projects, settings, key, costs, approvals, autopilots, trends] = await Promise.all([
      api().projects.list(),
      api().settings.get(),
      api().key.status(),
      api().costs.summary(),
      api().approvals.pending(),
      api().autopilot.list(),
      api().trends.get()
    ])
    void api().studio.syncStatus().then((studioSync) => set({ studioSync }), () => undefined)
    // Hangar opens on Home: what needs you, your games, and what's trending.
    set({
      ready: true,
      projects,
      settings,
      key,
      costs,
      approvals,
      selectedProjectId: null,
      autopilot: Object.fromEntries(autopilots.map((a) => [a.projectId, a])),
      trends: normalizeTrends(trends)
    })
    for (const p of projects) void loadProject(p.id)
  })()
}

export async function loadProject(projectId: string): Promise<void> {
  const [agents, roles, reviews] = await Promise.all([api().agents.snapshot(projectId), api().roles.list(projectId), api().reviews.list(projectId)])
  const map: Record<string, AgentState> = {}
  for (const a of agents) map[a.agentId] = a
  set((s) => ({ agents: { ...s.agents, [projectId]: map }, roles: { ...s.roles, [projectId]: roles }, reviews: { ...s.reviews, [projectId]: reviews } }))
}

let focusSeq = 0

/** Open a project (on a tab, Overview by default), or Home with null. */
export function selectProject(id: string | null, tab: ProjectTab = 'overview'): void {
  set(id ? { selectedProjectId: id, projectTab: tab, focus: null } : { selectedProjectId: null, page: 'home', focus: null })
  try {
    if (id) localStorage.setItem('hangar.selectedProject', id)
  } catch {
    // Storage unavailable: selection just isn't remembered.
  }
}

/** Open a project's tab with an agent or a review brought into view (links from Home and the Inbox). */
export function openProjectAt(id: string, tab: ProjectTab, focus: { agentId?: string; reviewId?: string } = {}): void {
  selectProject(id, tab)
  set({ focus: { ...focus, seq: ++focusSeq }, inboxOpen: false })
}

export function setProjectTab(tab: ProjectTab): void {
  set({ projectTab: tab, focus: null })
}

/** Show an app page (Home, Ideas). */
export function openPage(page: Page): void {
  set({ selectedProjectId: null, page, focus: null })
}

export function setInboxOpen(open: boolean): void {
  set({ inboxOpen: open })
}

const SETTINGS_TABS: SettingsTab[] = ['general', 'account', 'agents', 'limits', 'roblox', 'phone', 'privacy']

export function openUncommitted(projectId: string, retry?: () => Promise<unknown>): void {
  set({ uncommitted: { projectId, retry } })
}

export function closeUncommitted(): void {
  set({ uncommitted: null })
}

export function openSettings(tab: SettingsTab = 'general'): void {
  set({ settingsTab: SETTINGS_TABS.includes(tab) ? tab : 'general', inboxOpen: false })
}

export function closeSettings(): void {
  set({ settingsTab: null })
}

export function openWizard(prefill: StoreState['wizard'] = {}): void {
  set({ wizard: prefill ?? {}, ideaChat: null, refineIdeaId: null })
}

/** Brainstorm opens beside the ideas, on the Ideas page. */
export function openIdeaChat(draft = '', category: IdeaCategory = 'trend'): void {
  set({ ideaChat: { draft, category }, refineIdeaId: null, selectedProjectId: null, page: 'ideas', inboxOpen: false })
}

/** The starting draft has been sent: forget it, so coming back to Ideas doesn't put it in the box again. */
/** Once a prefilled message is sent, keep the chip the user has on now (the panel re-reads the request). */
export function clearIdeaChatDraft(category: IdeaCategory): void {
  set((s) => (s.ideaChat?.draft ? { ideaChat: { draft: '', category } } : {}))
}

export function openIdeaRefine(id: string): void {
  set({ refineIdeaId: id })
}

export function closeIdeaRefine(): void {
  set({ refineIdeaId: null })
}

export function closeIdeaChat(): void {
  set({ ideaChat: null })
}

export function closeWizard(): void {
  set({ wizard: null })
}

export function setCosts(costs: CostSummary): void {
  set({ costs })
}

/** Trend data from older app versions or files may lack newer lists; fill them in so nothing reads undefined. */
function normalizeTrends(t: TrendsSnapshot): TrendsSnapshot {
  return { ...t, ideas: t.ideas ?? [], saved: t.saved ?? [], games: t.games ?? [], genres: t.genres ?? [] }
}

export function setTrends(trends: TrendsSnapshot): void {
  set({ trends: normalizeTrends(trends) })
}

export function setAutopilot(st: AutopilotState): void {
  set((s) => ({ autopilot: { ...s.autopilot, [st.projectId]: st } }))
}

/** A project the wizard just created. */
export async function addCreatedProject(p: Project): Promise<void> {
  set((s) => ({ projects: s.projects.some((x) => x.id === p.id) ? s.projects.map((x) => (x.id === p.id ? p : x)) : [...s.projects, p] }))
  selectProject(p.id)
  await loadProject(p.id)
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
  const wasSelected = state.selectedProjectId === id
  set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
  // The next game opens on its Overview (not next to its own Remove button); none left → Home.
  if (wasSelected) selectProject(state.projects[0]?.id ?? null)
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

export function replaceReview(r: Review): void {
  set((s) => ({ reviews: { ...s.reviews, [r.projectId]: (s.reviews[r.projectId] ?? []).map((x) => (x.id === r.id ? r : x)) } }))
}

// ---------- confirmation dialog ----------

let confirmSeq = 0
let confirmResolve: ((ok: boolean) => void) | null = null
/** What had keyboard focus before the dialog opened; it gets focus back afterwards. */
let confirmOpener: HTMLElement | null = null

/**
 * Ask the user to confirm, in Hangar's own dialog (not the system one). Resolves true on confirm,
 * false on cancel, Esc or clicking outside. Opening a second one cancels the first.
 */
export function confirmDialog(opts: { title: string; body?: string; lines?: string[]; confirmLabel?: string; tone?: 'primary' | 'danger' }): Promise<boolean> {
  // Remember the opener before the dialog's own button takes focus (and keep the first one if a dialog is already up).
  if (!confirmResolve) confirmOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  confirmResolve?.(false)
  return new Promise((resolve) => {
    confirmResolve = resolve
    set({ confirm: { id: ++confirmSeq, title: opts.title, body: opts.body, lines: opts.lines, confirmLabel: opts.confirmLabel ?? 'OK', tone: opts.tone ?? 'primary' } })
  })
}

export function answerConfirm(ok: boolean): void {
  const resolve = confirmResolve
  confirmResolve = null
  set({ confirm: null })
  const opener = confirmOpener
  confirmOpener = null
  // Back to where you were, if that control is still on screen.
  if (opener?.isConnected) requestAnimationFrame(() => opener.focus())
  resolve?.(ok)
}

// ---------- trending charts ----------

const TRENDS_STALE_MS = 6 * 3600 * 1000
let trendsInFlight: Promise<void> | null = null

/** Fetch Roblox's charts again (one fetch at a time, shared by every page). */
export function refreshTrends(announce = false): Promise<void> {
  trendsInFlight ??= (async () => {
    set({ trendsLoading: true })
    const t = await attempt(() => api().trends.refresh())
    if (t) {
      setTrends(t)
      if (announce && !t.error) toast('Trending games updated.')
    }
  })().finally(() => {
    trendsInFlight = null
    set({ trendsLoading: false })
  })
  return trendsInFlight
}

/** Refresh the charts if they're missing or older than six hours. */
export function ensureTrendsFresh(): void {
  const t = state.trends
  if (!t?.fetchedAt || Date.now() - t.fetchedAt > TRENDS_STALE_MS) void refreshTrends()
}
