import type { AgentEvent, AutopilotConfig, AutopilotState, QueuedTask, Review, SprintReport } from '@shared/types'
import { mergeWarnings } from '@shared/reviewRules'
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
}

export interface AutopilotDeps {
  file: string
  registry: ProjectRegistry
  reviews: ReviewStore
  costs: CostTracker
  emit: (e: AgentEvent) => void
  send: (projectId: string, agentId: string, prompt: string, opts: { origin: QueuedTask['origin'] }) => void
  merge: (reviewId: string) => Promise<unknown>
}

/** Why a finished task can't be merged without you (null = it can). */
export function autoMergeBlocker(review: Review): string | null {
  if (review.kind === 'research') return 'Research always needs your approval.'
  if (review.incomplete) return 'The task stopped before it finished.'
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
  if (ai) return ai.status === 'done' && ai.verdict === 'approve' ? null : ai.verdict === 'concerns' ? 'The reviewer agent has concerns.' : "The reviewer agent didn't approve it."
  return checksOk ? null : 'No checks or reviewer agent ran, so there is nothing to approve it automatically.'
}

const clampConfig = (c: Partial<AutopilotConfig>, base: AutopilotConfig): AutopilotConfig => ({
  // 0 = the Lead decides; otherwise 1–20 tasks.
  sprintTasks: Number(c.sprintTasks) === 0 ? 0 : Math.round(Math.min(20, Math.max(1, Number.isFinite(c.sprintTasks) ? Number(c.sprintTasks) : base.sprintTasks))),
  sprintBudgetUsd: Math.min(500, Math.max(0.5, Number.isFinite(c.sprintBudgetUsd) ? Number(c.sprintBudgetUsd) : base.sprintBudgetUsd)),
  autoMerge: typeof c.autoMerge === 'boolean' ? c.autoMerge : base.autoMerge
})

export class Autopilot {
  private store: JsonStore<{ states: Record<string, AutopilotState> }>
  private merging = new Set<string>()

  constructor(private readonly deps: AutopilotDeps) {
    this.store = new JsonStore(deps.file, { states: {} as Record<string, AutopilotState> })
    // Queued tasks don't survive a restart, so a running autopilot resumes only when you say so.
    // Feedback put into a step that never finished goes back for the next one, whatever the status.
    for (const st of Object.values(this.store.get().states)) {
      const back = this.giveBack(st)
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

  private leadOf(projectId: string): string {
    const project = this.deps.registry.get(projectId)
    return listRoles(project.path).some((r) => r.id === 'lead') ? 'lead' : 'main'
  }

  // ---------- controls ----------

  configure(projectId: string, config: Partial<AutopilotConfig>): AutopilotState {
    const st = this.get(projectId)
    return this.put({ ...st, config: clampConfig(config, st.config) })
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
    if (next.awaitingReviewId) this.evaluate(next.awaitingReviewId)
    else this.nextStep(next)
    return this.get(projectId)
  }

  stop(projectId: string): AutopilotState {
    const st = this.get(projectId)
    return this.put({ ...st, status: 'off', reason: null, awaitingReviewId: null })
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
    const first = st.sprint === 1 && st.tasksDone === 0 && st.reports.length === 0
    const feedback = st.feedback.length ? `\n\nProduct owner feedback to act on first (record it in design-vault/Inbox.md or Decisions.md as you handle it):\n${st.feedback.map((f) => `- ${f}`).join('\n')}` : ''
    const recent = st.sprintTasks.length ? `\n\nEarlier in this sprint:\n${st.sprintTasks.map((t) => `- ${t.title} (${t.outcome})`).join('\n')}` : ''
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
3. Write design-vault/Roadmap.md as milestones. Milestone 1 is a small playable vertical slice of the core loop.
4. Write mechanic notes (copy Mechanics/_Template.md) with acceptance criteria for milestone 1.
5. Then build the first, most foundational piece of milestone 1 and playtest it.
Finish with: what you set up and built, how you tested it, and what comes next.${ending}${feedback}`
      : `Autopilot, sprint ${st.sprint}, ${which}. The user is the product owner; you lead the build.
1. Read design-vault/Home.md, Brief.md, Game Overview.md, Roadmap.md and Inbox.md (and research/ if relevant).
2. Pick the single most valuable next step toward the current milestone — one feature or fix, small enough to review on its own.
3. Write or update its mechanic note with acceptance criteria, build it (delegate to the specialist agents as needed), playtest it, and check the criteria.
4. Update Roadmap.md (mark what's done) and Decisions.md.
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
    const spent = this.spent(st.projectId) - st.spentAtSprintStart
    const enough = st.config.sprintTasks === 0 ? st.sprintDoneSaid === true || st.tasksDone >= LEAD_SPRINT_MAX : st.tasksDone >= st.config.sprintTasks
    if (enough || spent >= st.config.sprintBudgetUsd) this.queueReport(st)
    else this.queueBuild(st)
  }

  private record(projectId: string, title: string, outcome: SprintReport['tasks'][number]['outcome']): AutopilotState {
    const st = this.get(projectId)
    return this.put({ ...st, tasksDone: st.tasksDone + 1, sprintTasks: [...st.sprintTasks, { title, outcome }].slice(-50) })
  }

  /** Called by the runner when any task ends. */
  onTaskDone(o: TaskOutcome): void {
    if (o.task.origin !== 'autopilot' && o.task.origin !== 'autopilot-report') return
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
    const st = this.get(review.projectId)
    if (st.awaitingReviewId !== review.id) return
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
    if (st.awaitingReviewId !== reviewId) return
    if (review.status !== 'pending') {
      const outcome = review.status === 'merged' ? 'merged' : 'discarded'
      const after = this.record(review.projectId, review.title.startsWith('Autopilot') ? this.reviewTitle(review) : review.title, outcome)
      const next = this.put({ ...after, awaitingReviewId: null, status: after.status === 'waiting' ? 'running' : after.status, reason: after.status === 'waiting' ? null : after.reason })
      this.nextStep(next)
      return
    }
    // Checks and the reviewer agent are still working.
    if (review.checks?.status === 'running' || review.aiReview?.status === 'running') return
    if (st.status !== 'running' && st.status !== 'waiting') return
    const blocker = autoMergeBlocker(review)
    if (st.config.autoMerge && blocker === null) {
      if (this.merging.has(reviewId)) return
      this.merging.add(reviewId)
      void this.deps
        .merge(reviewId)
        .catch((err: Error) => this.put({ ...this.get(review.projectId), status: 'waiting', reason: `Couldn't merge “${this.reviewTitle(review)}” automatically: ${err.message}` }))
        .finally(() => this.merging.delete(reviewId))
      return
    }
    if (st.status !== 'waiting') {
      this.put({ ...st, status: 'waiting', reason: `“${this.reviewTitle(review)}” needs your review. ${st.config.autoMerge ? (blocker ?? '') : 'Auto-merge is off.'}`.trim() })
    }
  }

  private reviewTitle(review: Review): string {
    const line = review.summary.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)
    return (review.title.startsWith('Autopilot') ? (line ?? 'Sprint task') : review.title).slice(0, 100)
  }
}
