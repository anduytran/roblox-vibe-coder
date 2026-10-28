import { coordinatesByDefault } from '@shared/agentConfig'
import { normalizeModel } from '@shared/models'
import type { AgentEvent, ApprovalExplanation, ApprovalRequest, AutopilotConfig, AutopilotState, AwaySummary, QueuedTask, Review, SprintItem, SprintReport } from '@shared/types'
import { stripHidden } from '@shared/text'
import { mergeWarnings } from '@shared/reviewRules'
import { laneId, MAX_LANES } from '@shared/lanes'
import type { CostTracker } from './costs'
import { JsonStore } from './jsonStore'
import type { ProjectRegistry } from './projects'
import type { ReviewStore } from './reviews'
import { listRoles } from './roles'
import { isProtectedPath } from './pathScope'
import { runsAsCode } from './checks'

/**
 * Autopilot: the agents keep building and you act as product owner.
 *
 * Work happens in sprints. In each sprint the Lead runs a series of tasks (one feature or fix each, on
 * its own branch, through the usual checks and reviewer agent):
 *   - work that passes the checks and gets the reviewer's approval merges automatically (if allowed);
 *   - anything else waits for you — autopilot pauses on it until you merge or discard it;
 *   - two failed tasks in a row pause autopilot.
 * When the sprint's task count or budget is reached, the Lead writes a check-in report (what was built,
 * how to try it, the plan for the next sprint, questions for you). You read it, add feedback, and start
 * the next sprint. Repeat until it's the game you want.
 */
export const DEFAULT_AUTOPILOT: AutopilotConfig = { sprintTasks: 0, sprintBudgetUsd: 10, autoMerge: true }

/** When the Lead decides a sprint's length, it still checks in after this many tasks at most. */
export const LEAD_SPRINT_MAX = 12

/** The line the Lead ends a task's report with when the sprint's plan is done. */
const SPRINT_DONE = /^[\s*_>#-]*sprint complete[.!]?[\s*_]*$/im

export interface TaskOutcome {
  projectId: string
  agentId: string
  task: QueuedTask
  ok: boolean
  stopped: boolean
  text: string
  error: string | null
  reviewId: string | null
  /** Held because the plan's usage ran out: it isn't over and continues by itself, so nothing happens yet. */
  paused?: boolean
}

export interface AutopilotDeps {
  file: string
  registry: ProjectRegistry
  reviews: ReviewStore
  costs: CostTracker
  emit: (e: AgentEvent) => void
  send: (projectId: string, agentId: string, prompt: string, opts: { origin: QueuedTask['origin']; fresh?: boolean; model?: string }) => void
  merge: (reviewId: string) => Promise<unknown>
  /**
   * True on a Claude Max plan: dollar budgets don't apply (the plan's usage limits do, through the runner, which
   * pauses work at them and autopilot picks up again when they reset).
   */
  usesPlan?: () => boolean
  /** Hand a merge clash to the agent that made the change (used while you're away). */
  fixClash?: (reviewId: string) => unknown
}

/**
 * Blocked items never stop the build: the Lead writes down what each one waits for and builds the next thing that
 * isn't blocked. (Twenty sprints once stalled on "playtest first" and "needs the product owner".)
 */
export const KEEP_BUILDING = `If an item is blocked (it needs the product owner, a playtest that can't run right now, or work that isn't merged yet), don't stop or wait for it: add it under a "## Blocked" heading in Roadmap.md with what it's waiting for, then build the next item that isn't blocked: this sprint's plan first, then the rest of the current milestone, then the next milestone. Never spend a task only re-checking blockers. If a playtest can't run, still build the item, check it with Luau tests (*.spec.luau files, which Hangar runs without Studio) and the build and lint checks, and list it under "## Needs a playtest" in Roadmap.md.`

/** Planning replies are kept short: every word a planner writes is output, the costliest kind of token. */
export const KEEP_SHORT = `Be brief: no restating the brief or the notes, no long rationale. Read only what the plan needs (ask "bookworm" for a summary instead of reading many files).`

/** While the game hasn't shipped, its ship checklist comes first. */
export const SHIP_FIRST = `If design-vault/Ship Checklist.md has unticked items, the next step comes from it first (skip the ones marked "(you)": they need the product owner, so list them under "Needs you" in Roadmap.md). Tick items in it as they're done.`

/** How the planner marks each piece, so simple ones are built on a cheaper model. */
export const SIZE_RULE = `Mark each piece's "size": "simple" for a small, well-understood change (a value, a small UI tweak, a fix in one place), built on Sonnet, which is faster and much cheaper; "hard" for a new system or tricky logic, built on the builder's own model.`
/** The model a "simple" piece is built on. */
export const SIMPLE_MODEL = 'claude-sonnet-5-5'

/** Tries at resolving one change's clash on its own before it waits for you. */
export const MAX_CLASH_FIXES = 2

/** Sprints in a row that built nothing before an unattended run stops instead of starting another. */
export const STUCK_SPRINTS = 2

/** Why a finished task can't be merged without you (null = it can). */
export function autoMergeBlocker(review: Review): string | null {
  if (review.kind === 'research') return 'Research always needs your approval.'
  if (review.incomplete) return 'The task stopped before it finished.'
  if (review.clash) return review.clash.fixing ? 'An agent is resolving its clash with the main branch.' : `It clashes with newer work on ${review.base}. Use Fix with AI, or discard it.`
  if (review.note) return review.note
  // Never merge changes to files that decide how code, tools or agents run without a person looking.
  const sensitive = review.files.filter((f) => isProtectedPath(f) || runsAsCode(f))
  if (sensitive.length) return `It changes ${sensitive.slice(0, 3).join(', ')}${sensitive.length > 3 ? '…' : ''}, which control how code or tools run.`
  const warnings = mergeWarnings(review)
  if (warnings.length) return warnings.join(' ')
  const checks = review.checks
  const checksOk = !!checks && checks.status === 'done' && checks.results.length > 0 && !checks.reason && checks.results.every((r) => r.status === 'passed')
  if (checks && !checksOk) return "Checks didn't all pass."
  const ai = review.aiReview
  if (ai) {
    if (ai.status === 'done' && ai.verdict === 'approve') return null
    // Low and medium concerns don't hold the work up: it merges once the checks pass, and the concerns become a
    // follow-up for the next sprint. A high one, or "don't merge", waits for you.
    if (ai.status === 'done' && ai.verdict === 'concerns') {
      if (ai.findings.some((f) => f.severity === 'high')) return 'The reviewer agent found a serious problem.'
      return checksOk ? null : 'The reviewer agent has concerns, and no checks passed to back it up.'
    }
    return "The reviewer agent didn't approve it."
  }
  return checksOk ? null : 'No checks or reviewer agent ran, so there is nothing to approve it automatically.'
}

const clampConfig = (c: Partial<AutopilotConfig>, base: AutopilotConfig): AutopilotConfig => ({
  // 0 = the Lead decides; otherwise 1–20 tasks.
  sprintTasks: Number(c.sprintTasks) === 0 ? 0 : Math.round(Math.min(20, Math.max(1, Number.isFinite(c.sprintTasks) ? Number(c.sprintTasks) : base.sprintTasks))),
  sprintBudgetUsd: Math.min(500, Math.max(0.5, Number.isFinite(c.sprintBudgetUsd) ? Number(c.sprintBudgetUsd) : base.sprintBudgetUsd)),
  autoMerge: typeof c.autoMerge === 'boolean' ? c.autoMerge : base.autoMerge,
  unattended: typeof c.unattended === 'boolean' ? c.unattended : (base.unattended ?? false),
  unattendedUntil:
    c.unattendedUntil === null ? null : Number.isFinite(c.unattendedUntil) ? Math.min(Number(c.unattendedUntil), Date.now() + 48 * 3600_000) : (base.unattendedUntil ?? null),
  unattendedBudgetUsd: Math.min(500, Math.max(1, Number.isFinite(c.unattendedBudgetUsd) ? Number(c.unattendedBudgetUsd) : (base.unattendedBudgetUsd ?? 20))),
  parallel: typeof c.parallel === 'boolean' ? c.parallel : (base.parallel ?? true),
  fastStart: typeof c.fastStart === 'boolean' ? c.fastStart : (base.fastStart ?? true),
  plannerModel: c.plannerModel === null ? null : (normalizeModel(c.plannerModel) ?? base.plannerModel ?? null)
})

/** Pieces a fast MVP start may plan (built at the same time, as many as "agents at once" allows). */
export const MVP_ITEMS = 6
/** The model a fast MVP start plans with, unless you chose another planning model. */
export const MVP_PLANNER = 'claude-fable-5-1'

/** Most sprint items built at once (each agent still does its own items one after another). */
export const MAX_SPRINT_ITEMS = 4

const PLAN_PREFIX = 'Autopilot: plan sprint '
const ITEM_PREFIX = 'Autopilot item '
const WRAPUP_PREFIX = 'Autopilot: wrap up sprint '

/**
 * The Lead's plan for a parallel sprint: the last ```json block of its reply, {"items":[{agent, title, brief, files}]}.
 * Only builder roles count; files are kept as plain relative paths; anything else is dropped. The Lead's reply is
 * an agent's text, so it's read as data: bounded, hidden characters removed.
 */
export function parseSprintPlan(text: string, builders: string[], max = MAX_SPRINT_ITEMS): Omit<SprintItem, 'id' | 'status'>[] {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)]
  const raw = blocks.length ? blocks[blocks.length - 1]![1]! : ''
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const items = Array.isArray((data as { items?: unknown })?.items) ? ((data as { items: unknown[] }).items) : []
  const clean = (v: unknown, n: number): string => (typeof v === 'string' ? stripHidden(v).trim().slice(0, n) : '')
  const out: Omit<SprintItem, 'id' | 'status'>[] = []
  const taken = new Set<string>()
  for (const it of items) {
    const o = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
    const agentId = clean(o.agent, 40)
    const title = clean(o.title, 120).replace(/\s+/g, ' ')
    const brief = clean(o.brief, 6000)
    if (!builders.includes(agentId) || !title || !brief) continue
    const files = (Array.isArray(o.files) ? o.files : [])
      .map((f) => clean(f, 200))
      .filter((f) => f && !f.startsWith('/') && !f.split(/[\\/]/).includes('..'))
      .slice(0, 20)
    // Parallel pieces must not share files: one that does waits for a later sprint.
    if (files.some((f) => taken.has(f))) continue
    files.forEach((f) => taken.add(f))
    const size = o.size === 'simple' ? 'simple' : o.size === 'hard' ? 'hard' : undefined
    out.push({ agentId, title, brief, files, ...(size ? { size } : {}) })
    if (out.length >= max) break
  }
  return out
}

/** How often a run paused by a plan or spending limit tries again while unattended. */
const UNATTENDED_RETRY_MS = 30 * 60_000

/** The note the Lead gets when a check-in answers itself. */
export const AWAY_FEEDBACK =
  "The product owner is away and left autopilot running unattended. Go ahead with the plan you proposed in your check-in. Decide any open questions yourself from the design docs, choosing the option that's easiest to change later, and record each decision with its reason in design-vault/Decisions.md (under \"Decided while you were away\") so the owner can review them in the morning."

export class Autopilot {
  private store: JsonStore<{ states: Record<string, AutopilotState> }>
  private merging = new Set<string>()

  constructor(private readonly deps: AutopilotDeps) {
    this.store = new JsonStore(deps.file, { states: {} as Record<string, AutopilotState> })
    // Queued tasks don't survive a restart, so a running autopilot resumes only when you say so.
    // Feedback put into a step that never finished goes back for the next one, whatever the status.
    for (const st of Object.values(this.store.get().states)) {
      let back = this.giveBack(st)
      // Items handed to agents but not started are gone with the queue: they're handed out again on Resume.
      if (back.parallel?.items.some((i) => i.status === 'queued' && i.sent)) {
        back = { ...back, parallel: { ...back.parallel, items: back.parallel.items.map((i) => (i.status === 'queued' ? { ...i, sent: false } : i)) } }
      }
      if (st.status === 'running' || st.status === 'waiting') {
        this.put({ ...back, status: 'paused', reason: 'Hangar was closed. Resume to carry on where it left off.' })
      } else if (back !== st) this.put(back)
    }
  }

  // ---------- state ----------

  get(projectId: string): AutopilotState {
    return (
      this.store.get().states[projectId] ?? {
        projectId,
        status: 'off',
        config: { ...DEFAULT_AUTOPILOT },
        sprint: 0,
        tasksDone: 0,
        spentAtSprintStart: 0,
        reason: null,
        awaitingReviewId: null,
        feedback: [],
        sprintTasks: [],
        reports: [],
        consecutiveFailures: 0,
        updatedAt: 0
      }
    )
  }

  list(): AutopilotState[] {
    return Object.values(this.store.get().states)
  }

  private put(st: AutopilotState): AutopilotState {
    const next = { ...st, updatedAt: Date.now() }
    this.store.update((s) => ({ states: { ...s.states, [st.projectId]: next } }))
    this.deps.emit({ type: 'autopilot', state: next })
    return next
  }

  remove(projectId: string): void {
    this.store.update((s) => {
      const states = { ...s.states }
      delete states[projectId]
      return { states }
    })
  }

  private spent(projectId: string): number {
    return this.deps.costs.summary().projectTotalUsd[projectId] ?? 0
  }

  /** Who plans sprints: the Planner when the game has one (it runs on its own model, Fable), else the Lead. */
  private plannerOf(projectId: string): string {
    try {
      return listRoles(this.deps.registry.get(projectId).path).some((r) => r.id === 'planner') ? 'planner' : this.leadOf(projectId)
    } catch {
      return this.leadOf(projectId)
    }
  }

  private leadOf(projectId: string): string {
    const project = this.deps.registry.get(projectId)
    return listRoles(project.path).some((r) => r.id === 'lead') ? 'lead' : 'main'
  }

  /**
   * How the Lead splits a task among the project's specialists (subagents it calls with the Agent tool): building to
   * the Scripter and UI Builder, then a playtest by the QA Tester against the acceptance criteria, with fixes and a
   * re-test. Only the roles the project has are named; with none, the Lead works alone.
   */
  private teamwork(projectId: string): { build: string; test: string } | null {
    let ids: Set<string>
    try {
      ids = new Set(listRoles(this.deps.registry.get(projectId).path).filter((r) => r.mode !== 'research').map((r) => r.id))
    } catch {
      return null
    }
    if (this.leadOf(projectId) !== 'lead') return null
    const builders = [ids.has('scripter') ? '"scripter" (gameplay, server and client code)' : null, ids.has('ui-builder') ? '"ui-builder" (screens, HUD and menus)' : null].filter(Boolean)
    const qa = ids.has('qa-tester')
    if (!builders.length && !qa) return null
    return {
      build: builders.length
        ? `Don't write the feature yourself: hand the building to ${builders.join(' and ')} with the Agent tool, one clear brief each for one small piece: the exact files to read and change, what to build, and the acceptance criteria. Work in parallel: give independent parts (server code, UI) their own briefs and files, and send those Agent calls in ONE message so they build at the same time; run them in the foreground and wait (not run_in_background). Do only glue too small to hand off.`
        : 'Build it yourself.',
      test: qa
        ? 'Then hand "qa-tester" a playtest with the Agent tool: write or update Luau tests (*.spec.luau) for the acceptance criteria, play it in Studio when Studio tools are available, and report what fails. Have the builders fix what it finds, then have it test again (at most twice). Say in your final message what QA found.'
        : 'Then playtest it yourself against the acceptance criteria.'
    }
  }

  /** Why an unattended run should stop now (time up, budget used), or null while it goes on. */
  private awayOver(st: AutopilotState): string | null {
    if (!st.config.unattended || !st.away) return null
    if (st.config.unattendedUntil && Date.now() >= st.config.unattendedUntil) return 'the time you set is up'
    if (!this.deps.usesPlan?.() && this.spent(st.projectId) - st.away.spentAtStart >= (st.config.unattendedBudgetUsd ?? 20)) return 'its budget is used up'
    return null
  }

  /** True while an unattended run is on and not over. */
  isAway(projectId: string): boolean {
    const st = this.get(projectId)
    return !!st.config.unattended && !!st.away && !st.away.endedAt && this.awayOver(st) === null
  }

  private bumpAway(projectId: string, key: 'tasks' | 'merged' | 'leftForYou' | 'sprints' | 'declined'): void {
    const st = this.get(projectId)
    if (!st.away || st.away.endedAt) return
    this.put({ ...st, away: { ...st.away, [key]: st.away[key] + 1 } })
  }

  /** An action needing your OK during an unattended run: kept for the morning (the agent carries on without it). */
  setAside(request: ApprovalRequest, taskId?: string | null): void {
    this.bumpAway(request.projectId, 'declined')
    const st = this.get(request.projectId)
    const item = {
      id: request.id,
      agentId: request.agentId,
      toolName: request.toolName,
      summary: request.summary.slice(0, 4000),
      reason: request.reason.slice(0, 300),
      dangerous: request.dangerous,
      at: Date.now(),
      inputJson: request.inputJson.slice(0, 8000),
      ...(taskId ? { taskId } : {})
    }
    this.put({ ...st, setAside: [...(st.setAside ?? []), item].slice(-50) })
  }

  /**
   * A task ended: the actions it set aside aren't needed any more (it carried on without them, and its working copy
   * is gone). They're listed on its review instead, so you can see what was skipped.
   */
  taskEnded(projectId: string, taskId: string, reviewId: string | null): void {
    const st = this.get(projectId)
    const done = (st.setAside ?? []).filter((x) => x.taskId === taskId)
    if (!done.length) return
    this.put({ ...st, setAside: (st.setAside ?? []).filter((x) => x.taskId !== taskId) })
    if (!reviewId) return
    try {
      const review = this.deps.reviews.get(reviewId)
      const skipped = [...(review.skippedActions ?? []), ...done.map((x) => x.summary.split('\n')[0]!.slice(0, 200))].slice(-20)
      this.deps.emit({ type: 'review', review: this.deps.reviews.update(reviewId, { skippedActions: skipped }) })
    } catch {
      // the review is gone
    }
  }

  /** At startup no task is running, so nothing set aside earlier is still needed. */
  clearSetAside(): void {
    for (const st of this.list()) if (st.setAside?.length) this.put({ ...st, setAside: [] })
  }

  /** The action as an approval request again, for the safety checker to explain. */
  setAsideRequest(projectId: string, id: string): ApprovalRequest | null {
    const item = (this.get(projectId).setAside ?? []).find((x) => x.id === id)
    if (!item) return null
    const inputJson = item.inputJson ?? JSON.stringify(item.toolName === 'Bash' ? { command: item.summary.replace(/^\$ /, '') } : { summary: item.summary })
    return { id: item.id, projectId, agentId: item.agentId, toolName: item.toolName, summary: item.summary, inputJson, reason: item.reason, dangerous: item.dangerous, canAlwaysAllow: false, truncated: inputJson.length >= 8000, ts: item.at }
  }

  /** Attach the safety checker's explanation to a set-aside action. */
  explainedSetAside(projectId: string, id: string, explanation: ApprovalExplanation): AutopilotState {
    const st = this.get(projectId)
    if (!(st.setAside ?? []).some((x) => x.id === id)) return st
    return this.put({ ...st, setAside: (st.setAside ?? []).map((x) => (x.id === id ? { ...x, explanation } : x)) })
  }

  /** "Do it now" (sent back to the agent that wanted it) or "Dismiss" for a set-aside action. */
  resolveSetAside(projectId: string, id: string, doIt: boolean): AutopilotState {
    const st = this.get(projectId)
    const item = (st.setAside ?? []).find((x) => x.id === id)
    if (!item) throw new Error('That action is no longer waiting.')
    const next = this.put({ ...st, setAside: (st.setAside ?? []).filter((x) => x.id !== id) })
    if (doIt) {
      this.deps.send(
        projectId,
        item.agentId,
        `While I was away you wanted to do this, and it needed my OK, so it was set aside:\n\n${item.summary}\n\nI'm here now: do it (you'll get an approval card for me to allow), then finish whatever it was for.`,
        // One action: it doesn't need (or re-read) the agent's whole conversation.
        { origin: undefined, fresh: true }
      )
    }
    return next
  }

  private endAway(projectId: string, why: string): AutopilotState {
    const st = this.get(projectId)
    const away = st.away ? { ...st.away, endedAt: Date.now(), endReason: why } : null
    return this.put({ ...st, away, config: { ...st.config, unattended: false } })
  }

  private retryTimers = new Map<string, NodeJS.Timeout>()

  /** Unattended and stopped by a plan or spending limit: try again in a while (until the run ends). */
  private retryLater(projectId: string): void {
    clearTimeout(this.retryTimers.get(projectId))
    const t = setTimeout(() => {
      this.retryTimers.delete(projectId)
      const st = this.get(projectId)
      if (st.status !== 'paused' || !this.isAway(projectId)) return
      try {
        this.resume(projectId)
      } catch {
        // not resumable any more
      }
    }, UNATTENDED_RETRY_MS)
    t.unref?.()
    this.retryTimers.set(projectId, t)
  }

  // ---------- controls ----------

  configure(projectId: string, config: Partial<AutopilotConfig>): AutopilotState {
    const before = this.get(projectId)
    // Turning unattended on starts a fresh summary for the morning.
    if (config.unattended === true && !before.config.unattended) {
      this.put({ ...before, away: { since: Date.now(), spentAtStart: this.spent(projectId), tasks: 0, merged: 0, leftForYou: 0, sprints: 0, declined: 0, endedAt: null, endReason: null } })
    }
    if (config.unattended === false && before.away && !before.away.endedAt) this.put({ ...this.get(projectId), away: { ...before.away, endedAt: Date.now(), endReason: 'you turned it off' } })
    const st = this.get(projectId)
    const next = this.put({ ...st, config: clampConfig(config, st.config) })
    // Turned on while autopilot was waiting for you: carry on now (that's the point of going to bed).
    if (config.unattended === true && !before.config.unattended && this.isAway(projectId)) {
      if (next.status === 'checkin') {
        this.bumpAway(projectId, 'sprints')
        return this.start(projectId, { feedback: AWAY_FEEDBACK })
      }
      if (next.status === 'waiting' && next.awaitingReviewId) this.evaluate(next.awaitingReviewId)
      else if (next.status === 'paused') {
        try {
          return this.resume(projectId)
        } catch {
          // stays paused
        }
      }
    }
    return this.get(projectId)
  }

  /** Start sprint 1 (or the next sprint) with optional extra direction for the Lead. */
  start(projectId: string, opts: { feedback?: string; config?: Partial<AutopilotConfig>; answers?: { question: string; answer: string }[] } = {}): AutopilotState {
    const project = this.deps.registry.get(projectId)
    if (!project.settings.autonomous) throw new Error('Turn on Autonomous mode for this project first (in its Project tab).')
    let st = this.get(projectId)
    if (st.status === 'running' || st.status === 'waiting') throw new Error('Autopilot is already running.')
    if (opts.config) st = { ...st, config: clampConfig(opts.config, st.config) }
    // Answers to the check-in being closed are kept on that report, so earlier check-ins show what was decided.
    if (opts.answers?.length && st.status === 'checkin' && st.reports.length) {
      const last = st.reports[st.reports.length - 1]!
      st = { ...st, reports: [...st.reports.slice(0, -1), { ...last, answers: opts.answers.slice(0, 20) }] }
    }
    const feedback = opts.feedback?.trim() ? [...st.feedback, opts.feedback.trim().slice(0, 8000)] : st.feedback
    st = this.put({
      ...st,
      status: 'running',
      sprint: st.sprint + 1,
      tasksDone: 0,
      sprintTasks: [],
      sprintDoneSaid: false,
      parallel: null,
      spentAtSprintStart: this.spent(projectId),
      reason: null,
      feedback,
      consecutiveFailures: 0
    })
    this.queueBuild(st)
    return this.get(projectId)
  }

  pause(projectId: string, reason = 'Paused by you.'): AutopilotState {
    const st = this.get(projectId)
    if (st.status === 'off' || st.status === 'checkin') return st
    return this.put({ ...st, status: 'paused', reason })
  }

  pauseAll(reason: string): void {
    for (const st of this.list()) if (st.status === 'running' || st.status === 'waiting') this.pause(st.projectId, reason)
  }

  /** Carry on the current sprint after a pause. */
  resume(projectId: string): AutopilotState {
    const st = this.get(projectId)
    if (st.status !== 'paused') throw new Error('Autopilot is not paused.')
    const next = this.put({ ...st, status: 'running', reason: null, consecutiveFailures: 0 })
    if (next.parallel?.phase === 'building') {
      // Hand out items that never started (after a restart), and look again at the ones waiting in review.
      this.dispatchItems(next)
      for (const item of next.parallel.items) if (item.status === 'review' && item.reviewId) this.evaluate(item.reviewId)
      this.itemsProgress(this.get(projectId))
    } else if (next.awaitingReviewId) this.evaluate(next.awaitingReviewId)
    else this.nextStep(next)
    return this.get(projectId)
  }

  stop(projectId: string): AutopilotState {
    clearTimeout(this.retryTimers.get(projectId))
    if (this.get(projectId).away && !this.get(projectId).away!.endedAt) this.endAway(projectId, 'autopilot was stopped')
    const st = this.get(projectId)
    return this.put({ ...st, status: 'off', reason: null, awaitingReviewId: null, parallel: null })
  }

  /**
   * Autopilot's own step was taken out of the Lead's queue before it ran: its feedback goes back for the next
   * step, and autopilot pauses so it isn't left waiting for a task that will never finish.
   */
  removedFromQueue(projectId: string, tasks: QueuedTask[]): void {
    if (!tasks.some((t) => t.origin === 'autopilot' || t.origin === 'autopilot-report')) return
    this.returnFeedback(projectId, tasks)
    this.pause(projectId, "Paused by you: you removed autopilot's next step from the queue. Resume to queue it again.")
  }

  /** An autopilot step was dropped from the queue (removed, or Stop all): its feedback goes back in line. */
  returnFeedback(projectId: string, tasks: QueuedTask[]): void {
    if (!tasks.some((t) => t.origin === 'autopilot')) return
    const st = this.get(projectId)
    const back = this.giveBack(st)
    if (back !== st) this.put(back)
  }

  /** Feedback handed to a step that never finished, back in line for the next one. */
  private giveBack(st: AutopilotState): AutopilotState {
    if (!st.handedFeedback?.length) return st
    return { ...st, feedback: [...st.handedFeedback, ...st.feedback].slice(-20), handedFeedback: [] }
  }

  /** Feedback for the Lead's next task (also works mid-sprint). */
  addFeedback(projectId: string, text: string): AutopilotState {
    const st = this.get(projectId)
    if (!text.trim()) return st
    return this.put({ ...st, feedback: [...st.feedback, text.trim().slice(0, 8000)].slice(-20) })
  }

  // ---------- the loop ----------

  private queueBuild(st: AutopilotState): void {
    // A sprint starts with the Lead planning pieces to build at the same time (unless it's off, there's nobody to
    // build them, or this sprint already fell back to one task at a time). The very first sprint sets up the
    // design first, so it runs one task at a time.
    const firstEver = st.sprint === 1 && st.reports.length === 0
    // A fast MVP start: the very first sprint is planned straight into pieces the team builds at the same time.
    if (!st.parallel && firstEver && st.config.fastStart !== false && this.parallelOn(st)) return this.queuePlan(st, true)
    if (!st.parallel && !firstEver && this.parallelOn(st)) return this.queuePlan(st)
    if (st.parallel && st.parallel.phase !== 'single') return
    const first = st.sprint === 1 && st.tasksDone === 0 && st.reports.length === 0
    const feedback = st.feedback.length ? `\n\nProduct owner feedback to act on first (record it in design-vault/Inbox.md or Decisions.md as you handle it):\n${st.feedback.map((f) => `- ${f}`).join('\n')}` : ''
    const recent = st.sprintTasks.length ? `\n\nEarlier in this sprint:\n${st.sprintTasks.map((t) => `- ${t.title} (${t.outcome})`).join('\n')}` : ''
    const team = this.teamwork(st.projectId)
    const leadDecides = st.config.sprintTasks === 0
    const which = leadDecides ? `task ${st.tasksDone + 1}` : `task ${st.tasksDone + 1} of ${st.config.sprintTasks}`
    // When the Lead decides the sprint's length, it says when the sprint's plan is done.
    const ending = leadDecides
      ? `\nThis sprint ends when its plan is done${first ? ' (the first playable piece of milestone 1)' : ' (the "Next sprint" items agreed at the last check-in, in order)'}, not after a set number of tasks. When this task finishes that plan, or nothing else is worth building before you check in with the product owner, put the line "Sprint complete." as the last line of your final message. Otherwise leave it out and the next task follows.`
      : ''
    const prompt = first
      ? `Autopilot, sprint 1, ${which}. This is a new game and the user is the product owner.
1. Read design-vault/Brief.md (the product owner's idea) and CLAUDE.md.
2. Fill in design-vault/Game Overview.md (pitch, core loop, pillars, players and platforms).
3. Write design-vault/Roadmap.md as milestones. Milestone 1 is "Ship v1": the smallest version worth publishing (fun for ten minutes, a goal players can see, two or three things to buy), following design-vault/Ship Checklist.md. Later milestones add depth after launch.
4. Write mechanic notes (copy Mechanics/_Template.md) with acceptance criteria for milestone 1.
5. Then build the first, most foundational piece of milestone 1 and playtest it.${team ? `\n   ${team.build}\n   ${team.test}` : ''}
${KEEP_BUILDING}
Finish with: what you set up and built, how you tested it, and what comes next.${ending}${feedback}`
      : `Autopilot, sprint ${st.sprint}, ${which}. The user is the product owner; you lead the build.
1. Read design-vault/Home.md, Brief.md, Game Overview.md, Roadmap.md and Inbox.md (and research/ if relevant).
2. Pick the single most valuable next step toward the current milestone — one feature or fix, small enough to review on its own. ${SHIP_FIRST}
3. Write or update its mechanic note with acceptance criteria. ${team ? `${team.build} ${team.test}` : 'Build it (delegate to the specialist agents as needed), playtest it, and check the criteria.'}
4. Update Roadmap.md (mark what's done) and Decisions.md.
${KEEP_BUILDING}
Finish with: what you built, how you tested it, and what's next.${ending}${feedback}${recent}`
    // Feedback is handed over once, and remembered until that task finishes (see removedFromQueue).
    const cur = this.get(st.projectId)
    this.put({ ...cur, feedback: [], handedFeedback: [...(cur.handedFeedback ?? []), ...cur.feedback].slice(-20) })
    this.deps.send(st.projectId, this.leadOf(st.projectId), prompt, { origin: 'autopilot' })
  }

  private queueReport(st: AutopilotState): void {
    const tasks = st.sprintTasks.map((t) => `- ${t.title}: ${t.outcome}`).join('\n') || '- (none)'
    const prompt = `Autopilot: sprint ${st.sprint} is over. Write the check-in for the product owner. Don't change any files.
Tasks this sprint and what happened to them:
${tasks}

For details, read design-vault/Roadmap.md, Decisions.md and Inbox.md, and the latest commits (git log -n 15 --stat).

Reply with only these sections, short and concrete:
## Built
## Try it (how to play or test what's new in Studio)
## Next sprint (3–5 items, in order)
## Questions for you (decisions you need from the product owner, if any)`
    this.deps.send(st.projectId, this.leadOf(st.projectId), prompt, { origin: 'autopilot-report' })
  }

  /** After a task's outcome: next task, or the check-in when the sprint is used up. */
  private nextStep(st: AutopilotState): void {
    if (st.status !== 'running') return
    // An unattended run that's over (time or budget) stops here; the morning summary says why.
    const over = st.config.unattended && st.away && !st.away.endedAt ? this.awayOver(st) : null
    if (over) {
      this.endAway(st.projectId, over)
      this.pause(st.projectId, `The unattended run finished: ${over}. See what happened on the Overview.`)
      return
    }
    if (st.parallel?.phase === 'building') return this.itemsProgress(st)
    if (st.parallel?.phase === 'wrapup') return this.queueReport(st)
    const spent = this.spent(st.projectId) - st.spentAtSprintStart
    const enough = st.config.sprintTasks === 0 ? st.sprintDoneSaid === true || st.tasksDone >= LEAD_SPRINT_MAX : st.tasksDone >= st.config.sprintTasks
    if (enough || (!this.deps.usesPlan?.() && spent >= st.config.sprintBudgetUsd)) this.queueReport(st)
    else this.queueBuild(st)
  }

  private record(projectId: string, title: string, outcome: SprintReport['tasks'][number]['outcome']): AutopilotState {
    const st = this.get(projectId)
    // The Lead's wrap-up of a parallel sprint (roadmap and notes) isn't building: marked so it doesn't count as such.
    const wrapup = st.parallel?.phase === 'wrapup'
    const next = this.put({ ...st, tasksDone: st.tasksDone + 1, sprintTasks: [...st.sprintTasks, { title, outcome, ...(wrapup ? { wrapup } : {}) }].slice(-50) })
    if (outcome !== 'failed') this.bumpAway(projectId, 'tasks')
    return this.get(projectId) ?? next
  }

  /** Called by the runner when any task ends. */
  onTaskDone(o: TaskOutcome): void {
    // A task held for plan usage continues later in the same run of autopilot: not a failure, not a finished step.
    if (o.paused) return
    if (o.task.origin !== 'autopilot' && o.task.origin !== 'autopilot-report') return
    if (o.task.origin === 'autopilot' && o.task.prompt.startsWith(ITEM_PREFIX)) return this.itemDone(o)
    if (o.task.origin === 'autopilot' && o.task.prompt.startsWith(PLAN_PREFIX)) return this.planDone(o)
    let st = this.get(o.projectId)
    // A step that finished has had its feedback. One that failed or was stopped may never have reached the
    // Lead (a limit, a missing key), so its feedback goes back for the next step: said twice beats lost.
    if (o.task.origin === 'autopilot' && st.handedFeedback?.length) st = this.put(o.ok ? { ...st, handedFeedback: [] } : this.giveBack(st))
    // The Lead says the sprint's plan is done (only counts when it decides the sprint's length).
    if (o.task.origin === 'autopilot' && o.ok && SPRINT_DONE.test(o.text)) st = this.put({ ...st, sprintDoneSaid: true })
    if (st.status === 'off') return
    const title = o.task.origin === 'autopilot-report' ? 'Check-in report' : (/^Autopilot[^\n]*/.exec(o.task.prompt) ? this.titleFrom(o) : o.task.prompt.slice(0, 80))

    if (o.task.origin === 'autopilot-report') {
      // Pausing and resuming while the check-in was being written queues a second one: the first one stands, so
      // answers given to it are never matched with another report's questions, and a late one for a sprint that's
      // over (already answered) is dropped.
      const forSprint = Number(/^Autopilot: sprint (\d+) is over/.exec(o.task.prompt)?.[1] ?? st.sprint)
      if (st.status === 'checkin' || forSprint !== st.sprint || st.reports.some((r) => r.sprint === st.sprint)) return
      if (!o.ok || !o.text.trim()) {
        this.put({ ...st, status: 'paused', reason: o.stopped ? 'Stopped while writing the check-in.' : `The check-in report failed: ${o.error ?? 'no report'}. Resume to try again.` })
        return
      }
      const report: SprintReport = { sprint: st.sprint, at: Date.now(), text: o.text.slice(0, 20_000), tasks: st.sprintTasks, spentUsd: Math.round((this.spent(o.projectId) - st.spentAtSprintStart) * 100) / 100 }
      this.put({ ...st, status: 'checkin', reason: null, reports: [...st.reports, report].slice(-30) })
      // Unattended, but stuck: two sprints in a row built nothing (each waiting on something only you can do).
      // Starting more would only repeat that, so the run stops here and says why.
      const recent = [...st.reports, report].slice(-STUCK_SPRINTS)
      const stuck = recent.length === STUCK_SPRINTS && recent.every((r) => r.tasks.filter((t) => !t.wrapup).every((t) => t.outcome === 'no-changes' || t.outcome === 'failed'))
      if (this.isAway(o.projectId) && stuck) {
        this.endAway(o.projectId, `the last ${STUCK_SPRINTS} sprints built nothing (the Lead is waiting on you: see the latest check-in)`)
        return
      }
      // Unattended: the check-in answers itself and the next sprint starts on the Lead's own plan.
      if (this.isAway(o.projectId)) {
        this.bumpAway(o.projectId, 'sprints')
        this.start(o.projectId, { feedback: AWAY_FEEDBACK })
      }
      return
    }

    if (o.stopped) {
      this.record(o.projectId, title, 'failed')
      this.pause(o.projectId, 'The Lead was stopped. Resume to carry on.')
      return
    }
    if (o.reviewId) {
      st = this.put({ ...st, awaitingReviewId: o.reviewId, consecutiveFailures: 0 })
      this.evaluate(o.reviewId)
      return
    }
    if (!o.ok && /limit (is )?reached/i.test(o.error ?? '')) {
      // A spending or plan limit: retrying can't help until it resets, so pause at once and say why.
      this.record(o.projectId, title, 'failed')
      this.pause(o.projectId, `${o.error} Resume once there's room again.`)
      if (this.isAway(o.projectId)) this.retryLater(o.projectId)
      return
    }
    if (!o.ok) {
      st = this.record(o.projectId, title, 'failed')
      st = this.put({ ...st, consecutiveFailures: st.consecutiveFailures + 1 })
      if (st.consecutiveFailures >= 2) {
        this.pause(o.projectId, `Two tasks in a row failed (last error: ${o.error ?? 'unknown'}). Check the Lead's feed, then resume.`)
        return
      }
      this.nextStep(st)
      return
    }
    st = this.record(o.projectId, title, 'no-changes')
    this.nextStep(st)
  }

  private titleFrom(o: TaskOutcome): string {
    // The agent's report starts with what it built; use its first line as the task title.
    const line = o.text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)
    return (line ?? `Sprint task`).slice(0, 100)
  }

  /** Called for every review event; acts on the review autopilot is waiting for. */
  onReview(review: Review): void {
    if (!this.awaits(this.get(review.projectId), review.id)) return
    this.evaluate(review.id)
  }

  private evaluate(reviewId: string): void {
    let review: Review
    try {
      review = this.deps.reviews.get(reviewId)
    } catch {
      return
    }
    const st = this.get(review.projectId)
    if (!this.awaits(st, reviewId)) return
    if (review.status !== 'pending') {
      const outcome = review.status === 'merged' ? 'merged' : 'discarded'
      if (outcome === 'merged') this.bumpAway(review.projectId, 'merged')
      if (outcome === 'merged') this.followUpConcerns(review)
      this.settle(review, outcome)
      return
    }
    // Checks and the reviewer agent are still working.
    if (review.checks?.status === 'running' || review.aiReview?.status === 'running') return
    if (st.status !== 'running' && st.status !== 'waiting') return
    // A clash: while you're away, the agent that made the change resolves it (a couple of tries at most); the fixed
    // change then goes through the checks and the reviewer again and comes back here.
    if (review.clash?.fixing) return
    if (review.clash && st.config.autoMerge && this.isAway(review.projectId) && this.deps.fixClash && (review.clashFixes ?? 0) < MAX_CLASH_FIXES) {
      try {
        this.deps.fixClash(reviewId)
        return
      } catch {
        // falls through: it waits for you
      }
    }
    const blocker = autoMergeBlocker(review)
    if (st.config.autoMerge && blocker === null) {
      if (this.merging.has(reviewId)) return
      this.merging.add(reviewId)
      void this.deps
        .merge(reviewId)
        .catch((err: Error) => {
          // A clash is recorded on the review: decide again with that (resolve it, or wait).
          let now: Review | null = null
          try {
            now = this.deps.reviews.get(reviewId)
          } catch {
            // gone
          }
          if (now?.clash && now.status === 'pending') return this.evaluate(reviewId)
          if (this.isAway(review.projectId)) return this.leaveForMorning(review)
          this.put({ ...this.get(review.projectId), status: 'waiting', reason: `Couldn't merge “${this.reviewTitle(review)}” automatically: ${err.message}` })
        })
        .finally(() => this.merging.delete(reviewId))
      return
    }
    // Unattended: it waits in Reviews for the morning, and work goes on.
    if (this.isAway(review.projectId)) return this.leaveForMorning(review)
    if (st.status !== 'waiting') {
      this.put({ ...st, status: 'waiting', reason: `“${this.reviewTitle(review)}” needs your review. ${st.config.autoMerge ? (blocker ?? '') : 'Auto-merge is off.'}`.trim() })
    }
  }

  /** A change that can't merge itself during an unattended run stays in Reviews; autopilot carries on without it. */
  private leaveForMorning(review: Review): void {
    const st = this.get(review.projectId)
    if (!this.awaits(st, review.id)) return
    this.bumpAway(review.projectId, 'leftForYou')
    this.settle(review, 'waiting')
  }

  /** Whether autopilot is waiting on this review: the sprint's step, or one of its parallel items. */
  private awaits(st: AutopilotState, reviewId: string): boolean {
    return st.awaitingReviewId === reviewId || !!st.parallel?.items.some((i) => i.status === 'review' && i.reviewId === reviewId)
  }

  /** A review autopilot waited on is decided (merged, discarded, or left for you): note it and take the next step. */
  /** A change merged with the reviewer's (low or medium) concerns: they're handed to the Lead for the next sprint. */
  private followUpConcerns(review: Review): void {
    const ai = review.aiReview
    if (ai?.status !== 'done' || ai.verdict !== 'concerns' || !ai.findings.length) return
    // The reviewer read agent-written code: its words are shown as data, cleaned and cut short.
    const clean = (s: string, n: number): string => stripHidden(s).replace(/\s+/g, ' ').trim().slice(0, n)
    const points = ai.findings
      .slice(0, 6)
      .map((f) => `${clean(f.title, 120)} (${clean(f.file, 80)}${f.line ? `:${f.line}` : ''}, ${f.severity})`)
      .join('; ')
    const note = `Follow-up from the reviewer agent (not the product owner): address its concerns on "${clean(review.title, 80)}", merged as is: ${points}`
    const st = this.get(review.projectId)
    this.put({ ...st, feedback: [...st.feedback, note].slice(-20) })
  }

  private settle(review: Review, outcome: SprintReport['tasks'][number]['outcome']): void {
    const after = this.record(review.projectId, review.title.startsWith('Autopilot') ? this.reviewTitle(review) : review.title, outcome)
    const items = after.parallel?.items.map((i) => (i.reviewId === review.id && i.status === 'review' ? { ...i, status: 'done' as const, outcome } : i))
    const next = this.put({
      ...after,
      awaitingReviewId: after.awaitingReviewId === review.id ? null : after.awaitingReviewId,
      ...(after.parallel && items ? { parallel: { ...after.parallel, items } } : {}),
      status: after.status === 'waiting' ? 'running' : after.status,
      reason: after.status === 'waiting' ? null : after.reason
    })
    this.nextStep(next)
  }

  // ---------- sprints built in parallel ----------

  /** The roles that build sprint items: ones that can change files, other than the Lead and the QA Tester. */
  private builders(projectId: string): { id: string; description: string }[] {
    try {
      return listRoles(this.deps.registry.get(projectId).path)
        .filter((r) => r.id !== 'qa-tester' && !(r.delegate ?? coordinatesByDefault(r.id)) && r.mode !== 'research' && !r.mcp?.length)
        .filter((r) => !r.tools?.length || r.tools.some((t) => t === 'Edit' || t === 'Write'))
        .map((r) => ({ id: r.id, description: r.description || r.name }))
    } catch {
      return []
    }
  }

  private parallelOn(st: AutopilotState): boolean {
    return st.config.parallel !== false && this.leadOf(st.projectId) === 'lead' && this.builders(st.projectId).length > 0
  }

  private hasQa(projectId: string): boolean {
    try {
      return listRoles(this.deps.registry.get(projectId).path).some((r) => r.id === 'qa-tester')
    } catch {
      return false
    }
  }

  /** The Lead plans the sprint as pieces that can be built at the same time, without changing files itself. */
  private queuePlan(st: AutopilotState, mvp = false): void {
    const builders = this.builders(st.projectId)
    const max = mvp ? MVP_ITEMS : st.config.sprintTasks ? Math.min(MAX_SPRINT_ITEMS, st.config.sprintTasks) : MAX_SPRINT_ITEMS
    if (mvp) return this.queueMvpPlan(st, builders, max)
    const feedback = st.feedback.length ? `\n\nProduct owner feedback to act on first (put it into the briefs; the wrap-up records it in design-vault):\n${st.feedback.map((f) => `- ${f}`).join('\n')}` : ''
    const prompt = `${PLAN_PREFIX}${st.sprint}. The user is the product owner; you lead the build. This sprint your team builds its pieces at the same time, each agent in its own copy of the game.
1. Read design-vault/Home.md, Brief.md, Game Overview.md, Roadmap.md and Inbox.md, and the mechanic notes involved.
2. ${SHIP_FIRST} Pick the next ${max > 1 ? `2–${max}` : '1'} most valuable pieces toward the current milestone (the "Next sprint" items agreed at the last check-in first) that can be built at the same time: no two pieces may change the same files.
3. Don't change any files in this step. Skip anything blocked (it needs the product owner, or work that isn't merged): say so in your plan instead.
Agents you can give pieces to (each can build up to ${MAX_LANES} pieces at the same time, so give pieces to whoever fits them best):
${builders.map((b) => `- "${b.id}": ${b.description}`).join('\n')}
Reply with the plan in at most 5 short lines, then one \`\`\`json block like this, and nothing after it:
\`\`\`json
{"items":[{"agent":"scripter","title":"Bots use the heavy melee","brief":"What to build, the acceptance criteria to meet, and how to test it.","files":["src/server/BotService.luau"],"size":"hard"}]}
\`\`\`
Each brief is all its agent gets: say what to build, which files to read and change, and the acceptance criteria, in at most 120 words. ${SIZE_RULE} ${KEEP_SHORT}${feedback}`
    const cur = this.get(st.projectId)
    this.put({ ...cur, parallel: { phase: 'planning', items: [] }, feedback: [], handedFeedback: [...(cur.handedFeedback ?? []), ...cur.feedback].slice(-20) })
    this.deps.send(st.projectId, this.plannerOf(st.projectId), prompt, { origin: 'autopilot', ...(st.config.plannerModel ? { model: st.config.plannerModel } : {}) })
  }

  /**
   * A new game's first sprint, as fast as possible: the planner (Fable unless you chose another) writes a short
   * overview and roadmap, then splits a playable MVP into pieces the team builds at the same time.
   */
  private queueMvpPlan(st: AutopilotState, builders: { id: string; description: string }[], max: number): void {
    const feedback = st.feedback.length ? `\n\nProduct owner notes to act on:\n${st.feedback.map((f) => `- ${f}`).join('\n')}` : ''
    const prompt = `${PLAN_PREFIX}${st.sprint} (fast MVP start). This is a new game and the user is the product owner. Goal: a playable MVP as fast as possible, built by your team at the same time.
1. Read design-vault/Brief.md (the idea), design-vault/Ship Checklist.md and CLAUDE.md. Nothing else is needed yet.
2. Write, briefly (speed beats polish; they can grow later; at most about 150 words each): design-vault/Game Overview.md (pitch, core loop, 3 pillars) and design-vault/Roadmap.md (milestone 1 is "Ship v1" from the checklist; list later milestones in one line each). Don't write mechanic notes now: the acceptance criteria go in the briefs.
3. Split the MVP into ${max > 1 ? `2–${max}` : '1'} pieces that can be built at the same time, with no two pieces changing the same files, that together make the core loop playable from start to finish: for example the map (greybox is fine), the core mechanic (server), the HUD and menus, the goal or progression, and the first purchase (with src/shared/Products.luau). Prefer more, smaller pieces.
Agents you can give pieces to (each can build up to ${MAX_LANES} pieces at the same time):
${builders.map((b) => `- "${b.id}": ${b.description}`).join('\n')}
Reply with the plan in at most 5 short lines, then one \`\`\`json block like this, and nothing after it:
\`\`\`json
{"items":[{"agent":"scripter","title":"Core loop: collect and deliver","brief":"What to build, the acceptance criteria to meet, and how to test it.","files":["src/server/DeliveryService.luau"],"size":"hard"}]}
\`\`\`
Each brief is all its agent gets: what to build, which files to create or change, and 2–4 acceptance criteria, in at most 120 words. ${SIZE_RULE} ${KEEP_SHORT}${feedback}`
    const cur = this.get(st.projectId)
    this.put({ ...cur, parallel: { phase: 'planning', items: [], mvp: true }, feedback: [], handedFeedback: [...(cur.handedFeedback ?? []), ...cur.feedback].slice(-20) })
    // The Planner runs on its own model (Fable); without one, the Lead plans this step on Fable.
    const planner = this.plannerOf(st.projectId)
    const model = st.config.plannerModel ?? (planner === 'planner' ? undefined : MVP_PLANNER)
    this.deps.send(st.projectId, planner, prompt, { origin: 'autopilot', ...(model ? { model } : {}) })
  }

  /** The Lead's plan is in: its pieces go to their agents at once, or the sprint runs one task at a time without one. */
  private planDone(o: TaskOutcome): void {
    let st = this.get(o.projectId)
    if (st.status === 'off' || st.parallel?.phase !== 'planning') return
    st = this.put({ ...st, handedFeedback: o.ok ? [] : (st.handedFeedback ?? []) })
    if (o.stopped) {
      this.put({ ...this.giveBack(st), parallel: null })
      this.pause(o.projectId, 'The Lead was stopped while planning. Resume to carry on.')
      return
    }
    const mvp = st.parallel?.mvp === true
    const planned = o.ok ? parseSprintPlan(o.text, this.builders(o.projectId).map((b) => b.id), mvp ? MVP_ITEMS : st.config.sprintTasks ? Math.min(MAX_SPRINT_ITEMS, st.config.sprintTasks) : MAX_SPRINT_ITEMS) : []
    if (!planned.length) {
      // No usable plan: this sprint goes one task at a time, as before.
      st = this.put({ ...this.giveBack(st), parallel: { phase: 'single', items: [] } })
      if (!o.ok && /limit (is )?reached/i.test(o.error ?? '')) {
        this.pause(o.projectId, `${o.error} Resume once there's room again.`)
        if (this.isAway(o.projectId)) this.retryLater(o.projectId)
        return
      }
      this.queueBuild(st)
      return
    }
    const stamp = Date.now().toString(36)
    const items: SprintItem[] = planned.map((p, i) => ({ ...p, id: `${stamp}${i}`, status: 'queued', sent: false, reviewId: null, outcome: null }))
    st = this.put({ ...st, parallel: { phase: 'building', items, ...(mvp ? { mvp: true } : {}) } })
    // The plan task changed files after all: its review is the sprint's step to wait on, like any other.
    if (o.reviewId) st = this.put({ ...st, awaitingReviewId: o.reviewId })
    this.dispatchItems(st)
    if (o.reviewId) this.evaluate(o.reviewId)
  }

  /** Hand each item that isn't with its agent yet to that agent (each agent works through its own in order). */
  private dispatchItems(st: AutopilotState): void {
    if (st.status !== 'running' || st.parallel?.phase !== 'building') return
    const qa = this.hasQa(st.projectId)
    let items = st.parallel.items
    // Several pieces for one role are built at the same time, each by its own lane of that role (up to MAX_LANES;
    // beyond that, a lane takes the next piece when it's free).
    const nth = new Map<string, number>()
    const laneFor = new Map<string, string>()
    for (const item of items) {
      const n = (nth.get(item.agentId) ?? 0) + 1
      nth.set(item.agentId, n)
      laneFor.set(item.id, item.lane ?? laneId(item.agentId, ((n - 1) % MAX_LANES) + 1))
    }
    for (const item of items) {
      if (item.status !== 'queued' || item.sent) continue
      const prompt = `${ITEM_PREFIX}${item.id}, sprint ${st.sprint}: ${item.title}
The Lead planned this sprint as pieces built at the same time, each in its own copy of the game; this one is yours.

Brief from the Lead (the acceptance criteria are in it):
${item.brief}
${item.files.length ? `\nFiles to work in: ${item.files.join(', ')}` : ''}

1. Read the files above and the design notes the brief names. Build it, staying within those files unless you truly need more. Don't edit design-vault/Roadmap.md or Decisions.md: the Lead updates those after the sprint.
2. ${st.parallel.mvp ? (qa ? 'This is a fast MVP: speed matters. Hand "qa-tester" one quick check with the Agent tool (Luau tests for the acceptance criteria, or a short playtest when Studio tools are available). Fix everything that breaks the acceptance criteria in one go; no second round unless the fix was big.' : 'This is a fast MVP: check the acceptance criteria quickly (Luau tests, or a short playtest when Studio tools are available) and move on.') : qa ? 'Hand "qa-tester" a playtest with the Agent tool: write or update Luau tests (*.spec.luau) for the acceptance criteria, and play it in Studio when Studio tools are available. Fix everything it finds in one go, then have it test again (at most twice).' : 'Test it against the acceptance criteria: Luau tests (*.spec.luau) and a playtest when Studio tools are available.'}
3. If it's blocked (it needs the product owner, or work that isn't merged), say so and stop.
Finish with: what you built, how it was tested (and what QA found), and anything left to do.`
      const lane = laneFor.get(item.id) ?? item.agentId
      this.deps.send(st.projectId, lane, prompt, { origin: 'autopilot', ...(item.size === 'simple' ? { model: SIMPLE_MODEL } : {}) })
      items = items.map((i) => (i.id === item.id ? { ...i, sent: true, lane } : i))
    }
    this.put({ ...this.get(st.projectId), parallel: { ...st.parallel, items } })
  }

  /** An item's task ended: its change goes to review (and merges itself if approved), or it built nothing. */
  private itemDone(o: TaskOutcome): void {
    const st = this.get(o.projectId)
    const id = /^Autopilot item (\w+)/.exec(o.task.prompt)?.[1]
    const item = st.parallel?.items.find((i) => i.id === id)
    if (!st.parallel || !item || item.status !== 'queued') return
    const title = item.title
    if (o.reviewId) {
      this.put({ ...st, consecutiveFailures: 0, parallel: { ...st.parallel, items: st.parallel.items.map((i) => (i.id === item.id ? { ...i, status: 'review', reviewId: o.reviewId } : i)) } })
      if (st.status !== 'off') this.evaluate(o.reviewId)
      return
    }
    const outcome = o.ok ? 'no-changes' : 'failed'
    const after = this.record(o.projectId, title, outcome)
    const next = this.put({ ...after, parallel: { ...after.parallel!, items: after.parallel!.items.map((i) => (i.id === item.id ? { ...i, status: 'done', outcome } : i)) } })
    if (!o.ok && /limit (is )?reached/i.test(o.error ?? '')) {
      this.pause(o.projectId, `${o.error} Resume once there's room again.`)
      if (this.isAway(o.projectId)) this.retryLater(o.projectId)
      return
    }
    this.nextStep(next)
  }

  /** Every item is decided: the Lead wraps the sprint up (roadmap, decisions), then the check-in. */
  private itemsProgress(st: AutopilotState): void {
    if (st.status !== 'running' || st.parallel?.phase !== 'building') return
    if (st.parallel.items.some((i) => i.status !== 'done') || st.awaitingReviewId) return
    const done = st.parallel.items.map((i) => `- ${i.title} (${i.agentId}): ${i.outcome}`).join('\n')
    this.put({ ...st, parallel: { ...st.parallel, phase: 'wrapup' } })
    this.deps.send(
      st.projectId,
      this.leadOf(st.projectId),
      `${WRAPUP_PREFIX}${st.sprint}. Your team built these pieces at the same time:
${done}

1. Read what landed (git log -n 15 --stat, and the merged files that matter).
2. Update design-vault/Roadmap.md (mark what's done; anything blocked under "## Blocked", anything not yet played under "## Needs a playtest") and Decisions.md, and the mechanic notes' status.
3. Change nothing else.
Finish with a short summary of the sprint.`,
      { origin: 'autopilot' }
    )
  }

  private reviewTitle(review: Review): string {
    const line = review.summary.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)
    return (review.title.startsWith('Autopilot') ? (line ?? 'Sprint task') : review.title).slice(0, 100)
  }
}
