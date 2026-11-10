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
import { shipStatus } from './ship'
import { isProtectedPath } from './pathScope'
import { runsAsCode } from './checks'
import { ALREADY_FAILING, cleanLuauTests, LUNE_CHECK_NAME } from './luauTests'

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
  /** Whether the plan's usage leaves room for Fable (building out the full game falls back to Opus 5.5 when not). */
  fableOk?: () => boolean
}

/**
 * Blocked items never stop the build: the Lead writes down what each one waits for and builds the next thing that
 * isn't blocked. (Twenty sprints once stalled on "playtest first" and "needs the product owner".)
 */
export function keepBuilding(lune: boolean): string {
  return `If an item is blocked (it needs the product owner, a playtest that can't run right now, or work that isn't merged yet), don't stop or wait for it: add it under a "## Blocked" heading in Roadmap.md with what it's waiting for, then build the next item that isn't blocked: this sprint's plan first, then the rest of the current milestone, then the next milestone. Never spend a task only re-checking blockers. If a playtest can't run, still build the item, check it with ${lune ? 'Luau tests (*.spec.luau files, which Hangar runs on every finished task without Studio) and ' : ''}the build and lint checks, and list it under "## Needs a playtest" in Roadmap.md. ${lune ? '' : `${NO_SPECS_RUN} `}${NO_FILLER}`
}

/**
 * Specs only run without Studio when Lune is on. Told otherwise, agents spent thirty sprints moving working code into
 * "pure" modules so it could be tested, and none of those tests ever ran.
 */
export const NO_SPECS_RUN = `Luau tests don't run without Studio in this game (Lune is off in its Project tab), so never restructure working code just so it can be tested.`

/**
 * Once everything left needs a playtest or the product owner, the only "unblocked" work was refactoring. And told to
 * stop there, one game's Lead planned nothing for six sprints while the next milestone sat waiting.
 */
export const NO_FILLER = `Don't plan refactors, clean-ups or more hardening of code that already works unless the product owner asked for it or it fixes a bug a player would hit. When everything left in the current milestone needs a playtest or the product owner, that milestone is done for now: keep what waits under "Needs you" in Roadmap.md and start the next milestone without asking (new gameplay, content, sound, polish players will notice). If the Roadmap has no next milestone, add one from design-vault/Brief.md and Game Overview.md: the features they describe that aren't built yet. Only when no milestone has anything left to build, say so and stop.`

/** The line a planner replies with when nothing is worth building before the product owner checks in. */
const NOTHING_TO_BUILD = /^[\s*_>#-]*nothing to build[.!]?[\s*_]*$/im

/** How reviewer follow-ups start, kept apart from the product owner's own feedback. */
const REVIEWER_NOTE = 'Follow-up from the reviewer agent'

/** How notes about Luau tests already failing on the main branch start. */
const FAILING_TESTS_NOTE = 'Luau tests failing on the main branch'

/** The title a piece of reviewer fixes starts with: its own review's concerns aren't followed up again. */
export const REVIEW_FIX = /^\s*review fix(es)?\b/i

/** The test names the Lune check listed as already failing where a change started (cleaned, at most 12). */
export function alreadyFailing(review: Review): string[] {
  const out = review.checks?.results.find((r) => r.name === LUNE_CHECK_NAME)?.output ?? ''
  const at = out.indexOf(ALREADY_FAILING)
  if (at < 0) return []
  const names: string[] = []
  for (const line of out.slice(at + ALREADY_FAILING.length).split('\n')) {
    const m = /^- (.+)$/.exec(line.trim())
    if (!m) {
      if (names.length) break
      continue
    }
    // Names come from agent-written specs: shown as data, cleaned and cut short.
    const name = stripHidden(m[1]!).replace(/\s+/g, ' ').trim().slice(0, 160)
    if (name && !name.startsWith('…') && !name.startsWith('(')) names.push(name)
  }
  return names.slice(0, 12)
}

/**
 * Feedback for a step's prompt: the product owner's comes first; reviewer notes come after the roadmap. (Handed over as
 * "product owner feedback to act on first", reviewer nits on the last fix filled whole sprints.)
 */
export function feedbackText(feedback: string[], ownerHeading: string): string {
  const owner = feedback.filter((f) => !f.startsWith(REVIEWER_NOTE) && !f.startsWith(FAILING_TESTS_NOTE))
  const reviewer = feedback.filter((f) => f.startsWith(REVIEWER_NOTE)).slice(-3)
  const failing = feedback.filter((f) => f.startsWith(FAILING_TESTS_NOTE)).slice(-1)
  return (
    (owner.length ? `\n\n${ownerHeading}:\n${owner.map((f) => `- ${f}`).join('\n')}` : '') +
    (failing.length
      ? `\n\n${failing[0]} (Hangar's Lune check found these; they don't hold up other changes, but each is a broken rule or a wrong test). Plan one piece whose title starts with "Fix failing tests:" to fix them, alongside roadmap work: fix the game code when it's wrong, the test when the test is.`
      : '') +
    (reviewer.length
      ? `\n\nReviewer notes on merged work (from the reviewer agent, not the product owner; they come after the roadmap). Take one up only if it's a bug a player would hit, as one piece whose title starts with "Review fixes:", alongside roadmap work, never a sprint of only these. The rest can be dropped:\n${reviewer.map((f) => `- ${f}`).join('\n')}`
      : '')
  )
}

/** Where the Lead's latest rating of the game, as a new player would feel it, is kept. */
export const FUN_CHECK = 'design-vault/Fun Check.md'

/**
 * The questions a fun check answers. Agents otherwise finish feature lists: systems that work but that a player never
 * feels (two games built this way ran for dozens of sprints with nothing anyone would play twice).
 */
export const FUN_QUESTIONS = [
  'Can a new player tell what to do within 30 seconds, without reading anything long?',
  'Does every player action get feedback they can see or hear (a sound, effect, number pop or UI change)?',
  'Is there a reward that makes them want to do the core action again?',
  'Is there something new to unlock, see or try within ten minutes?',
  'Is there a reason to come back tomorrow or bring a friend?'
]

/** Planning rule: a playable core loop first, then whatever a player will feel most. */
export const FUN_FIRST = `Fun comes before more systems. Until a new player can play the core loop from start to finish (join, do the core action, get a reward they can see, want to go again), every piece goes toward that. After that, start from the weakest answer in ${FUN_CHECK}: something players feel in their first ten minutes beats a system they won't notice.`

/** Wrap-up step: rate the game as a new player would, and let the weakest answer lead the next sprint. */
export const FUN_RATE = `Rate the game as a new player would, from what is merged now (not what's planned; when unsure, answer "partly"). Rewrite ${FUN_CHECK} (at most 15 lines) with each question answered yes / partly / no and one line of evidence (the feature or file):
${FUN_QUESTIONS.map((q, i) => `   ${i + 1}. ${q}`).join('\n')}
   Then put the fix for the weakest answer first under "Next sprint" in Roadmap.md, unless the product owner asked for something else first.`

/** Build rule for one piece: what the player does should be felt. */
export const MAKE_IT_FELT = `If this piece adds something the player does or gets, make it felt: a visible or audible response when it happens (a tween, particles, a UI pop, a sound, a number that counts up).`

/** How the Ship Checklist keeps up with the game, so finished items aren't planned again and again. */
export const SHIP_TICK = `Tick the items in design-vault/Ship Checklist.md that are now done (built, merged and checked by a passing spec or a Studio play). Add "(you)" to an item the Studio tools here can't check (two real players at once, a real phone, a purchase in a published place), so it goes to the product owner instead of being planned again.`

/**
 * Roadmap.md says where the game is, not what each sprint did: appended to every sprint, one grew to 443 lines of
 * logs that every planner had to read (git log keeps the history).
 */
export const ROADMAP_SHORT = `Keep design-vault/Roadmap.md short (about 80 lines at most): it says where the game is now, not what each sprint did. Mark items done in place and rewrite "Now" to the current state instead of adding a section per sprint; cut finished sprint entries down to one line or delete them (git log has the history); under "## Needs a playtest" keep only what's still unplayed, one line each, and drop what has since been played or replaced.`

/** Planning replies are kept short: every word a planner writes is output, the costliest kind of token. */
export const KEEP_SHORT = `Be brief: no restating the brief or the notes, no long rationale. Read only what the plan needs (ask "bookworm" for a summary instead of reading many files).`

/** While the game hasn't shipped, its ship checklist comes first. */
export const SHIP_FIRST = `If design-vault/Ship Checklist.md has unticked items, the next step comes from it first (skip the ones marked "(you)", or under a heading marked "(you)": they need the product owner, so list them under "Needs you" in Roadmap.md). Tick items in it as they're done. When only "(you)" items are left, the checklist is done on your side: go on to the next milestone.`

/** How the planner marks each piece, so simple ones are built on a cheaper model. */
export const SIZE_RULE = `Mark each piece's "size": "simple" for a small, well-understood change (a value, a small UI tweak, a fix in one place), built on Sonnet, which is faster and much cheaper; "hard" for a new system or tricky logic, built on the builder's own model.`
/** The model a "simple" piece is built on. */
export const SIMPLE_MODEL = 'claude-sonnet-5-5'

/** Tries at resolving one change's clash on its own before it waits for you. */
export const MAX_CLASH_FIXES = 2

/** Sprints in a row that built nothing before an unattended run stops instead of starting another. */
export const STUCK_SPRINTS = 2

/**
 * Most sprints an unattended run on the Claude plan takes when you set no end time: there's no budget to stop it, and
 * one ran 66 sprints of refactors.
 */
export const MAX_AWAY_SPRINTS = 12

/** True when a sprint built something new: not just notes, review fixes, or pieces that changed nothing. */
export function sprintBuilt(report: Pick<SprintReport, 'tasks'>): boolean {
  return report.tasks.some((t) => !t.wrapup && !REVIEW_FIX.test(t.title) && t.outcome !== 'no-changes' && t.outcome !== 'failed')
}

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
  checkIns: typeof c.checkIns === 'boolean' ? c.checkIns : (base.checkIns ?? false),
  plannerModel: c.plannerModel === null ? null : (normalizeModel(c.plannerModel) ?? base.plannerModel ?? null),
  fastTrack: typeof c.fastTrack === 'boolean' ? c.fastTrack : (base.fastTrack ?? false),
  buildOut: typeof c.buildOut === 'boolean' ? c.buildOut : (base.buildOut ?? false)
})

/** Pieces a fast MVP start may plan (built at the same time, as many as "agents at once" allows). */
export const MVP_ITEMS = 6
/** The model a fast MVP start plans with, unless you chose another planning model. */
export const MVP_PLANNER = 'claude-fable-5-1'

/** Most sprint items built at once (each agent still does its own items one after another). */
export const MAX_SPRINT_ITEMS = 4

/** Fast track: the model that plans, leads and builds the hard pieces. */
export const FAST_TRACK_MODEL = 'claude-fable-5-1'
/** Fast track: most pieces a sprint may plan. */
export const FAST_TRACK_ITEMS = 6

/** Fast track: the plan aims for the most the game can be, while keeping it working. */
export const PUSH_LIMITS = `Fast track is on: improve the game as fast as possible and push it to the limit of what Roblox can do, not the minimum that works. Each sprint, plan the full set of pieces and take the biggest jump in what a player sees and feels: richer effects, sound and animation, more content and variety, smarter opponents, bigger moments, slicker UI. Be ambitious in scope, but keep each piece buildable and testable in one go, keep what already works working, and keep it running smoothly on a phone (a bigger game that breaks or lags is not better).`

/** Building out the full game: the model when the plan's usage allows Fable, and the one used otherwise. */
export const BUILD_OUT_MODEL = 'claude-fable-5-1'
export const BUILD_OUT_FALLBACK = 'claude-opus-5-5'

/** Building out: what every sprint aims at until the game can launch. */
export const BUILD_OUT = `You're building out the full game: everything in design-vault/Roadmap.md up to a complete game players can keep coming back to and that can launch publicly, not an MVP or a demo. Work through the milestones in order and plan the full set of pieces each sprint. Build each feature properly (real content, sound, effects, UI and saving where they belong), not as a placeholder to fill in later, and keep what already works working.`

/** A new game's first plan when building out: the whole way to launch, then the first sprint. */
export const LAUNCH_PLAN = `Plan the whole game up to launch, not an MVP:
- design-vault/Game Overview.md: pitch, core loop, progression (what players earn and keep), the full content list (maps, modes, enemies, items, as the game needs), what's for sale, and why players come back. At most about 400 words.
- design-vault/Roadmap.md: the milestones from here to a complete, launchable game, in build order (for example: core loop playable; content and progression with saving; feel and polish with sound, effects, animation and onboarding; purchases and retention; launch readiness on phones). Under each, the features it needs, one line each with how you'll know it's done. At most about 80 lines.
- Make design-vault/Ship Checklist.md match: add any item the launch needs that it's missing.`

/** Most pieces a sprint may plan: a fast MVP's, fast track's, or the usual limit (and never more than you set). */
export function sprintMax(config: Pick<AutopilotConfig, 'sprintTasks' | 'fastTrack' | 'buildOut'>, mvp = false): number {
  if (mvp) return MVP_ITEMS
  const max = config.fastTrack || config.buildOut ? FAST_TRACK_ITEMS : MAX_SPRINT_ITEMS
  return config.sprintTasks ? Math.min(max, config.sprintTasks) : max
}

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

/** The note the Lead gets when a check-in answers itself because autopilot doesn't wait for you between sprints. */
export const CARRY_ON_FEEDBACK =
  "Autopilot keeps going without waiting for the product owner between sprints. Go ahead with the plan you proposed in your check-in. Decide any open questions yourself from the design docs, choosing the option that's easiest to change later, and record each decision with its reason in design-vault/Decisions.md (under \"Decided without you\") so the owner can review them."

/** False only when you asked autopilot to stop at each check-in and wait for you. */
export const keepsGoing = (c: AutopilotConfig): boolean => c.checkIns !== true

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
    const feedback = feedbackText(st.feedback, 'Product owner feedback to act on first (record it in design-vault/Inbox.md or Decisions.md as you handle it)')
    const keep = keepBuilding(this.lune(st.projectId))
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
3. ${st.config.buildOut ? `${LAUNCH_PLAN} ${BUILD_OUT}` : 'Write design-vault/Roadmap.md as milestones. Milestone 1 is "Ship v1": the smallest version worth publishing (fun for ten minutes, a goal players can see, two or three things to buy), following design-vault/Ship Checklist.md. Later milestones add depth after launch.'}
4. Write mechanic notes (copy Mechanics/_Template.md) with acceptance criteria for milestone 1.
5. Then build the first, most foundational piece of milestone 1 (toward a core loop a player can play from start to finish) and playtest it. ${MAKE_IT_FELT}${team ? `\n   ${team.build}\n   ${team.test}` : ''}
${keep}
Finish with: what you set up and built, how you tested it, and what comes next.${ending}${feedback}`
      : `Autopilot, sprint ${st.sprint}, ${which}. The user is the product owner; you lead the build.
1. Read design-vault/Home.md, Brief.md, Game Overview.md, Roadmap.md, Fun Check.md (if there is one) and Inbox.md (and research/ if relevant).
2. Pick the single most valuable next step toward the current milestone — one feature or fix, small enough to review on its own. ${SHIP_FIRST} ${FUN_FIRST}${st.config.fastTrack ? ` ${PUSH_LIMITS.replace('plan the full set of pieces and ', '')}` : ''}${st.config.buildOut ? ` ${BUILD_OUT.replace(' and plan the full set of pieces each sprint', '')}` : ''}
3. Write or update its mechanic note with acceptance criteria. ${team ? `${team.build} ${team.test}` : 'Build it (delegate to the specialist agents as needed), playtest it, and check the criteria.'} ${MAKE_IT_FELT}
4. Update Roadmap.md (mark what's done) and Decisions.md. ${ROADMAP_SHORT} ${SHIP_TICK}
${keep}
Finish with: what you built, how you tested it, and what's next.${ending}${feedback}${recent}`
    // Feedback is handed over once, and remembered until that task finishes (see removedFromQueue).
    const cur = this.get(st.projectId)
    this.put({ ...cur, feedback: [], handedFeedback: [...(cur.handedFeedback ?? []), ...cur.feedback].slice(-20) })
    const leadModel = this.buildModel(st) ?? (st.config.fastTrack ? FAST_TRACK_MODEL : null)
    this.deps.send(st.projectId, this.leadOf(st.projectId), prompt, { origin: 'autopilot', ...(leadModel ? { model: leadModel } : {}) })
  }

  private queueReport(st: AutopilotState): void {
    const tasks = st.sprintTasks.map((t) => `- ${t.title}: ${t.outcome}`).join('\n') || '- (none)'
    // The parallel wrap-up has just written Fun Check.md; a single-task sprint has no wrap-up, so the check-in rates it.
    const rate = `as a new player would feel what is merged now, one line each, yes / partly / no with the evidence: ${FUN_QUESTIONS.join(' ')}`
    const funCheck = st.parallel?.items.length ? `copy the answers from ${FUN_CHECK}, one line each; if it has none, rate it ${rate}` : rate
    const prompt = `Autopilot: sprint ${st.sprint} is over. Write the check-in for the product owner. Don't change any files.
Tasks this sprint and what happened to them:
${tasks}

For details, read design-vault/Roadmap.md, Decisions.md, Fun Check.md and Inbox.md, and the latest commits (git log -n 15 --stat).

Reply with only these sections, short and concrete:
## Built
## Try it (how to play or test what's new in Studio)
## Fun check (${funCheck})
## Next sprint (3–5 items, in order; the fix for the weakest fun answer first, unless the product owner asked for something else)
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
      // The full game is built (only your launch tasks are left): sprints go back to their usual size and models.
      if (st.config.buildOut && this.buildOutDone(o.projectId)) {
        const cur = this.get(o.projectId)
        this.put({ ...cur, config: { ...cur.config, buildOut: false } })
      }
      // Going on by itself, but stuck: two sprints in a row built nothing new (each waiting on something only you can
      // do, or only fixing the reviewer's notes). Starting more would only repeat that, so it stops here and says why.
      const recent = [...st.reports, report].slice(-STUCK_SPRINTS)
      const stuck = recent.length === STUCK_SPRINTS && !recent.some(sprintBuilt)
      if (stuck && (this.isAway(o.projectId) || keepsGoing(st.config))) {
        const why = `the last ${STUCK_SPRINTS} sprints built nothing new (the Lead is waiting on you: see the latest check-in)`
        if (this.isAway(o.projectId)) this.endAway(o.projectId, why)
        this.put({ ...this.get(o.projectId), reason: `Stopped at this check-in: ${why}.` })
        return
      }
      // Its time or budget ran out during this sprint, or (on the plan, with no end time) it has run its most
      // sprints: the run ends here, at the check-in.
      const now = this.get(o.projectId)
      const away = now.config.unattended && now.away && !now.away.endedAt ? now.away : null
      const capped = !!away && !!this.deps.usesPlan?.() && !now.config.unattendedUntil && away.sprints >= MAX_AWAY_SPRINTS
      const over = away ? (this.awayOver(now) ?? (capped ? `it ran ${MAX_AWAY_SPRINTS} sprints (the most without an end time set)` : null)) : null
      if (over) {
        this.endAway(o.projectId, over)
        return
      }
      // Unattended, or not set to wait for you: the check-in answers itself and the next sprint starts on the Lead's
      // own plan. The report stays on the Overview to read whenever you like.
      if (this.isAway(o.projectId)) {
        this.bumpAway(o.projectId, 'sprints')
        this.start(o.projectId, { feedback: AWAY_FEEDBACK })
      } else if (keepsGoing(now.config)) this.start(o.projectId, { feedback: CARRY_ON_FEEDBACK })
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
      if (outcome === 'merged') {
        this.followUpConcerns(review)
        this.followUpFailingTests(review)
      }
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
          if (this.isAway(review.projectId) || keepsGoing(this.get(review.projectId).config)) return this.leaveForMorning(review)
          this.put({ ...this.get(review.projectId), status: 'waiting', reason: `Couldn't merge “${this.reviewTitle(review)}” automatically: ${err.message}` })
        })
        .finally(() => this.merging.delete(reviewId))
      return
    }
    // Unattended, or not set to wait for you: it waits in Reviews, and work goes on. (With auto-merge off you review
    // every change, so autopilot waits for each one: building on top of unmerged work would only pile up clashes.)
    if (this.isAway(review.projectId) || (keepsGoing(st.config) && st.config.autoMerge)) return this.leaveForMorning(review)
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
    if (ai?.status !== 'done' || ai.verdict !== 'concerns') return
    // Low ones are nits: following each up was a sprint of its own, whose review found more nits, and so on.
    const findings = ai.findings.filter((f) => f.severity !== 'low')
    if (!findings.length) return
    // One round only: concerns about a change that was itself review fixes aren't followed up again.
    const item = this.get(review.projectId).parallel?.items.find((i) => i.reviewId === review.id)
    if (REVIEW_FIX.test(item?.title ?? review.title)) return
    // The reviewer read agent-written code: its words are shown as data, cleaned and cut short.
    const clean = (s: string, n: number): string => stripHidden(s).replace(/\s+/g, ' ').trim().slice(0, n)
    const points = findings
      .slice(0, 6)
      .map((f) => `${clean(f.title, 120)} (${clean(f.file, 80)}${f.line ? `:${f.line}` : ''}, ${f.severity})`)
      .join('; ')
    const note = `${REVIEWER_NOTE} (not the product owner): address its concerns on "${clean(review.title.startsWith('Autopilot') ? (item?.title ?? this.reviewTitle(review)) : review.title, 80)}", merged as is: ${points}`
    const st = this.get(review.projectId)
    this.put({ ...st, feedback: [...st.feedback, note].slice(-20) })
  }

  /** Tests that were already failing on the main branch (the Lune check lists them) become a piece for the Lead. */
  private followUpFailingTests(review: Review): void {
    const names = alreadyFailing(review)
    if (!names.length) return
    const note = `${FAILING_TESTS_NOTE}: ${names.join('; ')}`
    const st = this.get(review.projectId)
    // Only the latest list counts: it replaces an older one.
    this.put({ ...st, feedback: [...st.feedback.filter((f) => !f.startsWith(FAILING_TESTS_NOTE)), note].slice(-20) })
  }

  private settle(review: Review, outcome: SprintReport['tasks'][number]['outcome']): void {
    // A planned piece keeps its planned title, so the check-in (and the stuck check) can tell review fixes apart.
    const item = this.get(review.projectId).parallel?.items.find((i) => i.reviewId === review.id && i.status === 'review')
    const after = this.record(review.projectId, item?.title ?? (review.title.startsWith('Autopilot') ? this.reviewTitle(review) : review.title), outcome)
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

  /** Whether Hangar runs this game's plain Luau tests itself (with Lune), without Studio. */
  private lune(projectId: string): boolean {
    try {
      return cleanLuauTests(this.deps.registry.get(projectId).settings.luauTests).lune
    } catch {
      return false
    }
  }

  /** Building out the full game: Fable while the plan's usage allows it, otherwise Opus 5.5. Null when not building out. */
  private buildModel(st: AutopilotState): string | null {
    if (!st.config.buildOut) return null
    return (this.deps.fableOk?.() ?? true) ? BUILD_OUT_MODEL : BUILD_OUT_FALLBACK
  }

  /** Building out ends once the launch checklist has only the owner's items left: the game is built. */
  private buildOutDone(projectId: string): boolean {
    try {
      const s = shipStatus(this.deps.registry.get(projectId).path)
      const ours = s.items.filter((i) => !i.you)
      return s.hasChecklist && ours.length > 0 && ours.every((i) => i.done)
    } catch {
      return false
    }
  }

  /** The Lead plans the sprint as pieces that can be built at the same time, without changing files itself. */
  private queuePlan(st: AutopilotState, mvp = false): void {
    const builders = this.builders(st.projectId)
    const max = sprintMax(st.config, mvp)
    if (mvp) return this.queueMvpPlan(st, builders, max)
    const feedback = feedbackText(st.feedback, 'Product owner feedback to act on first (put it into the briefs; the wrap-up records it in design-vault)')
    const lune = this.lune(st.projectId)
    const prompt = `${PLAN_PREFIX}${st.sprint}. The user is the product owner; you lead the build. This sprint your team builds its pieces at the same time, each agent in its own copy of the game.
1. Read design-vault/Home.md, Brief.md, Game Overview.md, Roadmap.md, Fun Check.md (if there is one) and Inbox.md, and the mechanic notes involved.
2. ${SHIP_FIRST} ${FUN_FIRST} ${st.config.fastTrack ? `${PUSH_LIMITS} ` : ''}${st.config.buildOut ? `${BUILD_OUT} ` : ''}Pick the next ${max > 1 ? `2–${max}` : '1'} most valuable pieces toward the current milestone (the "Next sprint" items agreed at the last check-in first) that can be built at the same time: no two pieces may change the same files.
3. Don't change any files in this step. Skip anything blocked (it needs the product owner, a playtest that can't run, or work that isn't merged): say so in your plan instead. ${lune ? '' : `${NO_SPECS_RUN} `}${NO_FILLER.replace('say so and stop.', 'reply with the line "Nothing to build." and say what it waits for, with no json block.')}
Agents you can give pieces to (each can build up to ${MAX_LANES} pieces at the same time, so give pieces to whoever fits them best):
${builders.map((b) => `- "${b.id}": ${b.description}`).join('\n')}
Reply with the plan in at most 5 short lines, then one \`\`\`json block like this, and nothing after it:
\`\`\`json
{"items":[{"agent":"scripter","title":"Bots use the heavy melee","brief":"What to build, the acceptance criteria to meet, and how to test it.","files":["src/server/BotService.luau"],"size":"hard"}]}
\`\`\`
Each brief is all its agent gets: say what to build, which files to read and change, and the acceptance criteria, in at most 120 words. ${SIZE_RULE} ${KEEP_SHORT}${feedback}`
    const cur = this.get(st.projectId)
    this.put({ ...cur, parallel: { phase: 'planning', items: [] }, feedback: [], handedFeedback: [...(cur.handedFeedback ?? []), ...cur.feedback].slice(-20) })
    const model = st.config.plannerModel ?? this.buildModel(st) ?? (st.config.fastTrack ? FAST_TRACK_MODEL : null)
    this.deps.send(st.projectId, this.plannerOf(st.projectId), prompt, { origin: 'autopilot', ...(model ? { model } : {}) })
  }

  /**
   * A new game's first sprint, as fast as possible: the planner (Fable unless you chose another) writes a short
   * overview and roadmap, then splits a playable MVP into pieces the team builds at the same time.
   */
  private queueMvpPlan(st: AutopilotState, builders: { id: string; description: string }[], max: number): void {
    const feedback = st.feedback.length ? `\n\nProduct owner notes to act on:\n${st.feedback.map((f) => `- ${f}`).join('\n')}` : ''
    const prompt = st.config.buildOut
      ? `${PLAN_PREFIX}${st.sprint} (full game start). This is a new game and the user is the product owner. Goal: the complete game, ready to launch, built by your team sprint after sprint; this first sprint lays its foundation.
1. Read design-vault/Brief.md (the idea), design-vault/Ship Checklist.md and CLAUDE.md.
2. ${LAUNCH_PLAN}
3. Split the first milestone into ${max > 1 ? `2–${max}` : '1'} pieces that can be built at the same time, with no two pieces changing the same files, that together make the core loop playable from start to finish with real feedback a player can see and hear: for example the map, the core mechanic (server), the HUD and menus, the goal and progression with saving, and the first purchase (with src/shared/Products.luau). ${BUILD_OUT}
Agents you can give pieces to (each can build up to ${MAX_LANES} pieces at the same time):
${builders.map((b) => `- "${b.id}": ${b.description}`).join('\n')}
Reply with the plan in at most 5 short lines, then one \`\`\`json block like this, and nothing after it:
\`\`\`json
{"items":[{"agent":"scripter","title":"Core loop: collect and deliver","brief":"What to build, the acceptance criteria to meet, and how to test it.","files":["src/server/DeliveryService.luau"],"size":"hard"}]}
\`\`\`
Each brief is all its agent gets: what to build, which files to create or change, and 2–4 acceptance criteria, in at most 120 words. ${KEEP_SHORT}${feedback}`
      : `${PLAN_PREFIX}${st.sprint} (fast MVP start). This is a new game and the user is the product owner. Goal: a playable MVP as fast as possible, built by your team at the same time.
1. Read design-vault/Brief.md (the idea), design-vault/Ship Checklist.md and CLAUDE.md. Nothing else is needed yet.
2. Write, briefly (speed beats polish; they can grow later; at most about 150 words each): design-vault/Game Overview.md (pitch, core loop, 3 pillars) and design-vault/Roadmap.md (milestone 1 is "Ship v1" from the checklist; list later milestones in one line each). Don't write mechanic notes now: the acceptance criteria go in the briefs.
3. Split the MVP into ${max > 1 ? `2–${max}` : '1'} pieces that can be built at the same time, with no two pieces changing the same files, that together make the core loop playable from start to finish, with feedback a player can see or hear on the core action: for example the map (greybox is fine), the core mechanic (server), the HUD and menus, the goal or progression, and the first purchase (with src/shared/Products.luau). Prefer more, smaller pieces.
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
    const model = st.config.plannerModel ?? this.buildModel(st) ?? (planner === 'planner' ? undefined : MVP_PLANNER)
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
    const planned = o.ok ? parseSprintPlan(o.text, this.builders(o.projectId).map((b) => b.id), sprintMax(st.config, mvp)) : []
    if (!planned.length && o.ok && !o.reviewId && NOTHING_TO_BUILD.test(o.text)) {
      // Nothing is worth building until you've done something (open Studio, answer a question): straight to the
      // check-in instead of a task that would only find filler. Unattended, two of these in a row end the run.
      this.queueReport(this.put({ ...st, parallel: { phase: 'wrapup', items: [] } }))
      return
    }
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
    const noSpecs = this.lune(st.projectId) ? '' : ` ${NO_SPECS_RUN}`
    for (const item of items) {
      if (item.status !== 'queued' || item.sent) continue
      const prompt = `${ITEM_PREFIX}${item.id}, sprint ${st.sprint}: ${item.title}
The Lead planned this sprint as pieces built at the same time, each in its own copy of the game; this one is yours.

Brief from the Lead (the acceptance criteria are in it):
${item.brief}
${item.files.length ? `\nFiles to work in: ${item.files.join(', ')}` : ''}

1. Read the files above and the design notes the brief names. Build it, staying within those files unless you truly need more. ${MAKE_IT_FELT} Don't edit design-vault/Roadmap.md or Decisions.md: the Lead updates those after the sprint.
2. ${st.parallel.mvp && !st.config.buildOut ? (qa ? 'This is a fast MVP: speed matters. Hand "qa-tester" one quick check with the Agent tool (Luau tests for the acceptance criteria, or a short playtest when Studio tools are available). Fix everything that breaks the acceptance criteria in one go; no second round unless the fix was big.' : 'This is a fast MVP: check the acceptance criteria quickly (Luau tests, or a short playtest when Studio tools are available) and move on.') : qa ? 'Hand "qa-tester" a playtest with the Agent tool: write or update Luau tests (*.spec.luau) for the acceptance criteria, and play it in Studio when Studio tools are available. Fix everything it finds in one go, then have it test again (at most twice).' : 'Test it against the acceptance criteria: Luau tests (*.spec.luau) and a playtest when Studio tools are available.'}${noSpecs}
3. If it's blocked (it needs the product owner, or work that isn't merged), say so and stop.
Finish with: what you built, how it was tested (and what QA found), and anything left to do.`
      const lane = laneFor.get(item.id) ?? item.agentId
      // Building out the full game, every piece is built on Fable (or Opus 5.5); otherwise simple ones go to Sonnet.
      const model = this.buildModel(st) ?? (item.size === 'simple' ? SIMPLE_MODEL : st.config.fastTrack ? FAST_TRACK_MODEL : null)
      this.deps.send(st.projectId, lane, prompt, { origin: 'autopilot', ...(model ? { model } : {}) })
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
2. Update design-vault/Roadmap.md (mark what's done; anything blocked under "## Blocked", anything not yet played under "## Needs a playtest") and Decisions.md, and the mechanic notes' status. ${ROADMAP_SHORT}
3. ${SHIP_TICK}
4. ${FUN_RATE}
5. Change nothing else.
Finish with a short summary of the sprint.`,
      { origin: 'autopilot' }
    )
  }

  private reviewTitle(review: Review): string {
    const line = review.summary.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)
    return (review.title.startsWith('Autopilot') ? (line ?? 'Sprint task') : review.title).slice(0, 100)
  }
}
