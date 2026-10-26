import type { AgentEvent, ApprovalExplanation, ApprovalRequest, AutopilotConfig, AutopilotState, AwaySummary, QueuedTask, Review, SprintReport } from '@shared/types'
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
  if (ai) return ai.status === 'done' && ai.verdict === 'approve' ? null : ai.verdict === 'concerns' ? 'The reviewer agent has concerns.' : "The reviewer agent didn't approve it."
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
  unattendedBudgetUsd: Math.min(500, Math.max(1, Number.isFinite(c.unattendedBudgetUsd) ? Number(c.unattendedBudgetUsd) : (base.unattendedBudgetUsd ?? 20)))
})

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
        ? `Don't write the feature yourself: hand the building to ${builders.join(' and ')} with the Agent tool, one clear brief each (what to build, which files, the acceptance criteria). Do only glue too small to hand off.`
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
  setAside(request: ApprovalRequest): void {
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
      inputJson: request.inputJson.slice(0, 8000)
    }
    this.put({ ...st, setAside: [...(st.setAside ?? []), item].slice(-50) })
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
        { origin: undefined }
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
    clearTimeout(this.retryTimers.get(projectId))
    if (this.get(projectId).away && !this.get(projectId).away!.endedAt) this.endAway(projectId, 'autopilot was stopped')
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
3. Write design-vault/Roadmap.md as milestones. Milestone 1 is a small playable vertical slice of the core loop.
4. Write mechanic notes (copy Mechanics/_Template.md) with acceptance criteria for milestone 1.
5. Then build the first, most foundational piece of milestone 1 and playtest it.${team ? `\n   ${team.build}\n   ${team.test}` : ''}
${KEEP_BUILDING}
Finish with: what you set up and built, how you tested it, and what comes next.${ending}${feedback}`
      : `Autopilot, sprint ${st.sprint}, ${which}. The user is the product owner; you lead the build.
1. Read design-vault/Home.md, Brief.md, Game Overview.md, Roadmap.md and Inbox.md (and research/ if relevant).
2. Pick the single most valuable next step toward the current milestone — one feature or fix, small enough to review on its own.
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
    const spent = this.spent(st.projectId) - st.spentAtSprintStart
    const enough = st.config.sprintTasks === 0 ? st.sprintDoneSaid === true || st.tasksDone >= LEAD_SPRINT_MAX : st.tasksDone >= st.config.sprintTasks
    if (enough || (!this.deps.usesPlan?.() && spent >= st.config.sprintBudgetUsd)) this.queueReport(st)
    else this.queueBuild(st)
  }

  private record(projectId: string, title: string, outcome: SprintReport['tasks'][number]['outcome']): AutopilotState {
    const st = this.get(projectId)
    const next = this.put({ ...st, tasksDone: st.tasksDone + 1, sprintTasks: [...st.sprintTasks, { title, outcome }].slice(-50) })
    if (outcome !== 'failed') this.bumpAway(projectId, 'tasks')
    return this.get(projectId) ?? next
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
      // Unattended, but stuck: two sprints in a row built nothing (each waiting on something only you can do).
      // Starting more would only repeat that, so the run stops here and says why.
      const recent = [...st.reports, report].slice(-STUCK_SPRINTS)
      const stuck = recent.length === STUCK_SPRINTS && recent.every((r) => r.tasks.every((t) => t.outcome === 'no-changes' || t.outcome === 'failed'))
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
      if (outcome === 'merged') this.bumpAway(review.projectId, 'merged')
      const next = this.put({ ...after, awaitingReviewId: null, status: after.status === 'waiting' ? 'running' : after.status, reason: after.status === 'waiting' ? null : after.reason })
      this.nextStep(next)
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
    if (st.awaitingReviewId !== review.id) return
    const after = this.record(review.projectId, this.reviewTitle(review), 'waiting')
    this.bumpAway(review.projectId, 'leftForYou')
    const next = this.put({ ...this.get(review.projectId), awaitingReviewId: null, status: after.status === 'waiting' ? 'running' : after.status, reason: null })
    this.nextStep(next)
  }

  private reviewTitle(review: Review): string {
    const line = review.summary.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)
    return (review.title.startsWith('Autopilot') ? (line ?? 'Sprint task') : review.title).slice(0, 100)
  }
}
