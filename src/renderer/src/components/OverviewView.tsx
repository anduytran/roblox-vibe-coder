import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { agentLabel } from '@shared/lanes'
import { Explanation } from './ApprovalCard'
import { BriefCard } from './BriefCard'
import type { AutopilotState, Project, SprintReport } from '@shared/types'
import { attempt, confirmDialog, openUncommitted, replaceProject, setAutopilot, setProjectTab, toast, useStore } from '../store'
import { composeCheckinFeedback, parseCheckin } from '@shared/checkin'
import { AUTOPILOT_LABEL } from './Dashboard'
import { Button, Toggle, timeAgo, usd } from './ui'
import { SafeText } from './SafeText'
import { revealHidden } from '@shared/text'

const OUTCOME: Record<SprintReport['tasks'][number]['outcome'], string> = {
  merged: 'Merged',
  waiting: 'Waiting for you',
  discarded: 'Discarded',
  'no-changes': 'No changes',
  failed: 'Failed'
}

/** A project's autopilot: start it, watch the sprint, read check-ins and steer the next sprint. */
/** On a Claude Max plan, usage limits decide when work pauses, not dollar budgets: the plan's limits and usage. */
function usePlanMode(): { on: boolean; text: string } {
  const on = useStore((s) => s.settings?.authMode === 'max')
  const limits = useStore((s) => s.settings?.planLimits)
  const usage = useStore((s) => s.costs.plan)
  const pct = (w: { usedPct: number } | null | undefined): string => (w ? `${Math.round(w.usedPct)}%` : '–')
  const text = `5-hour ${pct(usage?.fiveHour)} of ${limits?.fiveHourPct ?? 90}% · weekly ${pct(usage?.weekly)} of ${limits?.weeklyPct ?? 80}%`
  return { on, text }
}

export function OverviewView({ project, onOpenReviews }: { project: Project; onOpenReviews: () => void }) {
  const plan = usePlanMode()
  const ap = useStore((s) => s.autopilot[project.id])
  const spentTotal = useStore((s) => s.costs.projectTotalUsd[project.id] ?? 0)
  const hasLead = useStore((s) => (s.roles[project.id] ?? []).some((r) => r.id === 'lead'))
  const leadActivity = useStore((s) => {
    const a = s.agents[project.id]?.lead ?? s.agents[project.id]?.main
    return a && (a.status === 'working' || a.status === 'awaiting_approval') ? (a.activity ?? 'Working…') : null
  })
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const status = ap?.status ?? 'off'
  const report = ap?.reports[ap.reports.length - 1]
  const sprintSpent = ap ? Math.max(0, spentTotal - ap.spentAtSprintStart) : 0

  const run = (fn: () => Promise<AutopilotState>, ok?: string): void => {
    setBusy(true)
    void attempt(async () => {
      setAutopilot(await fn())
      if (ok) toast(ok)
    }).finally(() => setBusy(false))
  }

  const reviewCount = useStore((s) => (s.reviews[project.id] ?? []).filter((r) => r.status === 'pending').length)
  return (
    <div className="settings-page overview">
      {(ap?.sprint ?? 0) > 0 || reviewCount > 0 ? (
        <BriefCard
          key={project.id}
          title="Brief"
          watch={`${status}:${ap?.sprint ?? 0}:${ap?.tasksDone ?? 0}:${reviewCount}`}
          load={(refresh) => window.hangar.briefs.project(project.id, refresh)}
        />
      ) : null}
      <section className="card overview-status">
        <div className="row between">
          <div>
            <h3>
              Autopilot <span className={`ap-pill ap-${status}`}>{AUTOPILOT_LABEL[status]}</span>
            </h3>
            {ap && ap.sprint > 0 && (
              <p className="muted small">
                Sprint {ap.sprint} · {ap.config.sprintTasks ? `${ap.tasksDone} of ${ap.config.sprintTasks} tasks` : `${ap.tasksDone} task${ap.tasksDone === 1 ? '' : 's'} done, Lead decides when it's finished`} · {plan.on ? `plan usage: ${plan.text}` : `${usd(sprintSpent)} of ${usd(ap.config.sprintBudgetUsd)} this sprint · ${usd(spentTotal)} total`}
              </p>
            )}
          </div>
          <div className="row gap-xs">
            {(status === 'running' || status === 'waiting') && (
              <Button disabled={busy} onClick={() => run(() => window.hangar.autopilot.pause(project.id), 'Autopilot paused. The current task finishes first.')}>
                Pause
              </Button>
            )}
            {status === 'paused' && (
              <Button tone="primary" disabled={busy} onClick={() => run(() => window.hangar.autopilot.resume(project.id), 'Autopilot resumed.')}>
                Resume
              </Button>
            )}
            {status !== 'off' && (
              <Button tone="ghost" disabled={busy} onClick={() =>
                  void confirmDialog({ title: 'Turn autopilot off?', body: 'Running tasks finish; nothing new starts. You can start it again any time.', confirmLabel: 'Turn off' }).then(
                    (ok) => ok && run(() => window.hangar.autopilot.stop(project.id), 'Autopilot off.')
                  )
                }>
                Turn off
              </Button>
            )}
          </div>
        </div>

        {ap?.reason && (
          <div className={`callout ${status === 'waiting' ? 'callout-amber' : ''}`}>
            {ap.reason}
            {/uncommitted changes/i.test(ap.reason) && (
              <button className="link small error-bar-action" onClick={() => openUncommitted(project.id)}>
                Commit or discard them…
              </button>
            )}
          </div>
        )}
        {status === 'waiting' && (
          <Button tone="primary" onClick={onOpenReviews}>
            Open Reviews
          </Button>
        )}

        {ap && ap.status !== 'off' && ap.status !== 'checkin' && (
          <>
            <div className="sprint-meter sprint-meter-lg">
              {/* When the Lead decides the sprint's length, the meter shows the tasks so far (and the one under way). */}
              {Array.from({ length: ap.config.sprintTasks || ap.tasksDone + (status === 'running' ? 1 : 0) }, (_, i) => (
                <span key={i} className={i < ap.tasksDone ? 'done' : i === ap.tasksDone && status === 'running' ? 'now' : ''} />
              ))}
            </div>
            {status === 'running' && leadActivity && !ap.parallel?.items.length && <div className="activity">Task {ap.tasksDone + 1}: {leadActivity}</div>}
            {ap.parallel && ap.parallel.phase !== 'single' && <SprintPieces project={project} parallel={ap.parallel} running={status === 'running'} />}
            {ap.sprintTasks.length > 0 && <TaskList tasks={ap.sprintTasks} />}
            <div className="field">
              <span className="field-label">Steer the Lead</span>
              <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Make storms rarer. Focus on the glider feel before adding islands." />
              <div className="row between">
                <span className="field-hint">Given to the Lead at the start of its next task.{ap.feedback.length ? ` ${ap.feedback.length} note${ap.feedback.length === 1 ? '' : 's'} waiting.` : ''}</span>
                <Button size="sm" disabled={!feedback.trim() || busy} onClick={() => run(async () => {
                  const st = await window.hangar.autopilot.feedback(project.id, feedback)
                  setFeedback('')
                  return st
                }, 'Noted for the next task.')}>
                  Add note
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      {status === 'checkin' && report && <CheckinCard key={report.sprint + ':' + report.at} project={project} report={report} busy={busy} run={run} />}

      {status === 'off' && <StartCard project={project} ap={ap} hasLead={hasLead} busy={busy} run={run} />}

      {ap && ap.status !== 'off' && <UnattendedCard project={project} ap={ap} />}
      {ap && ap.status !== 'off' && <ConfigCard project={project} ap={ap} />}

      {ap && ap.reports.length > (status === 'checkin' ? 1 : 0) && (
        <section className="card">
          <h3>Earlier check-ins</h3>
          {[...ap.reports]
            .reverse()
            .slice(status === 'checkin' ? 1 : 0)
            .map((r) => (
              <details key={r.sprint + ':' + r.at} className="history">
                <summary>
                  Sprint {r.sprint} · {timeAgo(r.at)} · {r.tasks.filter((t) => t.outcome === 'merged').length} merged{plan.on ? '' : ` · ${usd(r.spentUsd)}`}
                </summary>
                <SafeText className="summary report-text" text={r.text} />
                {r.answers && r.answers.length > 0 && (
                  <div className="decisions">
                    <span className="side-label">Your answers</span>
                    <dl>
                      {r.answers.map((a, i) => (
                        <div key={i}>
                          <dt>{a.question}</dt>
                          <dd>{a.answer}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </details>
            ))}
        </section>
      )}
    </div>
  )

}

function StartCard({ project, ap, hasLead, busy, run }: { project: Project; ap: AutopilotState | undefined; hasLead: boolean; busy: boolean; run: (fn: () => Promise<AutopilotState>, ok?: string) => void }) {
  const [tasks, setTasks] = useState(ap?.config.sprintTasks ?? 0)
  const [budget, setBudget] = useState(String(ap?.config.sprintBudgetUsd ?? 10))
  const [autoMerge, setAutoMerge] = useState(ap?.config.autoMerge ?? true)
  const [direction, setDirection] = useState('')
  const plan = usePlanMode()
  return (
    <section className="card">
      <h3>{ap?.reports.length ? 'Start a new sprint' : 'Let the agents build'}</h3>
      <p className="small muted">
        The Lead plans from the design vault, builds one reviewed feature at a time, and checks in with you after each sprint. You act as the product owner: read the
        check-in, answer questions, give feedback, start the next sprint.
      </p>
      {!project.settings.autonomous && (
        <div className="callout">
          Autopilot needs Autonomous mode (each task on its own branch, ending as a review).{' '}
          <button className="link" onClick={() => void attempt(async () => replaceProject(await window.hangar.projects.update(project.id, { settings: { autonomous: true } })))}>
            Turn it on
          </button>
        </div>
      )}
      {!hasLead && <div className="callout">Add the starter roles (Agents tab) so there's a Lead to run the sprints. Otherwise the Main agent leads.</div>}
      <div className="grid-2">
        <div className="field">
          <span className="field-label">Sprint length</span>
          <div className="segmented" role="radiogroup" aria-label="Sprint length">
            {[0, 3, 5, 8, 12].map((n) => (
              <button key={n} role="radio" aria-checked={tasks === n} className={`segment ${tasks === n ? 'segment-on' : ''}`} onClick={() => setTasks(n)}>
                {n === 0 ? 'Lead decides' : `${n} tasks`}
              </button>
            ))}
          </div>
          <span className="field-hint">{tasks === 0 ? `The Lead works through the plan and checks in when it's done${plan.on ? '' : ' (or the budget runs out)'}.` : 'Checks in after this many tasks.'}</span>
        </div>
        {plan.on ? (
          <div className="field">
            <span className="field-label">Usage</span>
            <span className="small">Your Max plan: {plan.text}.</span>
            <span className="field-hint">Work pauses at those limits and picks up when they reset (Settings → Account).</span>
          </div>
        ) : (
          <label className="field">
            <span className="field-label">Budget per sprint (USD)</span>
            <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
          </label>
        )}
      </div>
      <Toggle checked={autoMerge} onChange={setAutoMerge} label="Merge approved work automatically" hint="Checks pass and the reviewer agent approves → merged. Anything else waits for you." />
      <label className="field">
        <span className="field-label">Direction for this sprint (optional)</span>
        <textarea rows={2} value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="Get the core loop playable end to end." />
      </label>
      <div>
        <Button
          tone="primary"
          disabled={busy || !project.settings.autonomous}
          onClick={() =>
            run(
              () => window.hangar.autopilot.start(project.id, { feedback: direction, config: { sprintTasks: tasks, sprintBudgetUsd: parseFloat(budget) || 10, autoMerge } }),
              'Autopilot started.'
            )
          }
        >
          Start autopilot
        </Button>
      </div>
    </section>
  )
}

function TaskList({ tasks }: { tasks: SprintReport['tasks'] }) {
  return (
    <ol className="sprint-tasks">
      {tasks.map((t, i) => (
        <li key={i} className={`outcome-${t.outcome}`}>
          <span className="sprint-task-title">{t.title}</span>
          <span className="sprint-task-outcome">{OUTCOME[t.outcome]}</span>
        </li>
      ))}
    </ol>
  )
}

const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const PIECE_DONE: Record<string, string> = { merged: 'Merged', waiting: 'Waiting for you in Reviews', discarded: 'Discarded', 'no-changes': 'Nothing to merge', failed: 'Failed' }

/** A sprint built in parallel: the Lead planning, each piece and how it's going, then the wrap-up. */
function SprintPieces({ project, parallel, running }: { project: Project; parallel: NonNullable<AutopilotState['parallel']>; running: boolean }) {
  const agents = useStore((s) => s.agents[project.id])
  const roles = useStore((s) => s.roles[project.id])
  const name = (id: string): string => agentLabel(id, (rid) => roles?.find((r) => r.id === rid)?.name)
  if (parallel.phase === 'planning') return <div className="activity">{running ? 'The Lead is planning pieces to build at the same time…' : 'The Lead was planning this sprint.'}</div>
  return (
    <div className="sprint-pieces">
      <span className="side-label">{parallel.phase === 'wrapup' ? 'Built at the same time · the Lead is wrapping up' : 'Being built at the same time'}</span>
      <ul className="task-list">
        {parallel.items.map((item) => {
          const a = agents?.[item.agentId]
          const status =
            item.status === 'done'
              ? (PIECE_DONE[item.outcome ?? ''] ?? 'Done')
              : item.status === 'review'
                ? 'In review'
                : a?.status === 'working' || a?.status === 'awaiting_approval'
                  ? (a.activity ?? 'Building…')
                  : 'Waiting its turn'
          return (
            <li key={item.id}>
              <strong>{name(item.agentId)}</strong>: {revealHidden(item.title)} <span className="muted small">· {status}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Set-aside actions this window already asked the safety checker about (so a re-render doesn't ask again). */
const askedToExplain = new Set<string>()

/** Keep autopilot going while you sleep, and what it did while you were away. */
function UnattendedCard({ project, ap }: { project: Project; ap: AutopilotState }) {
  const on = !!ap.config.unattended
  const limit = ap.config.unattendedBudgetUsd ?? 20
  const plan = usePlanMode()
  const stops = plan.on ? 'pauses at your Max plan limits and picks up again when they reset' : `stops after ${usd(limit)}`
  const save = (patch: Partial<AutopilotState['config']>, ok?: string): void => {
    void attempt(async () => {
      setAutopilot(await window.hangar.autopilot.configure(project.id, patch))
      if (ok) toast(ok)
    })
  }
  const away = ap.away
  // Every set-aside action gets the safety checker's explanation; older ones (from before this) are explained now.
  const [explaining, setExplaining] = useState<Set<string>>(() => new Set())
  const explainAside = (id: string, again = false): void => {
    if (!again && askedToExplain.has(id)) return
    askedToExplain.add(id)
    setExplaining((s) => new Set(s).add(id))
    void attempt(async () => setAutopilot(await window.hangar.autopilot.explainSetAside(project.id, id))).finally(() =>
      setExplaining((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    )
  }
  useEffect(() => {
    for (const a of ap.setAside ?? []) if (!a.explanation) explainAside(a.id)
  }, [ap.setAside]) // eslint-disable-line react-hooks/exhaustive-deps
  const save2 = (id: string, doIt: boolean, ok: string): void => {
    void attempt(async () => {
      setAutopilot(await window.hangar.autopilot.resolveSetAside(project.id, id, doIt))
      toast(ok)
    })
  }
  return (
    <section className={`card ${on ? 'card-accent' : ''}`}>
      <Toggle
        checked={on}
        onChange={(v) => save(v ? { unattended: true, unattendedUntil: null } : { unattended: false }, v ? 'Autopilot keeps going while you\'re away.' : 'Back to normal: autopilot checks in with you.')}
        label="Keep going while I'm away"
        hint={
          on
            ? `On until you turn it off; it ${stops}. Check-ins answer themselves, clashes get fixed, anything that needs you waits in Reviews or below, and the Mac stays awake.`
            : `Autopilot won't stop for check-ins, reviews or approvals; you get a summary when you're back. It ${stops}.`
        }
      />
      {away && (
        <div className="decisions">
          <span className="side-label">
            {away.endedAt ? `While you were away (${clock(away.since)} – ${clock(away.endedAt)})` : `Since ${clock(away.since)}`}
          </span>
          <p className="small">
            {away.tasks} task{away.tasks === 1 ? '' : 's'} done · {away.merged} merged · {away.leftForYou} waiting for you in Reviews · {away.sprints} sprint
            {away.sprints === 1 ? '' : 's'} started on the Lead's plan · {away.declined} action{away.declined === 1 ? '' : 's'} set aside for your OK
            {away.endReason ? ` · ended because ${away.endReason}` : ''}
          </p>
          {away.sprints > 0 && <p className="small muted">The Lead's decisions are in the Design tab, under Decisions.</p>}
        </div>
      )}
      {(ap.setAside ?? []).length > 0 && (
        <div className="checkin-block">
          <span className="side-label">Waiting for your OK</span>
          {(ap.setAside ?? []).map((a) => (
            <div key={a.id} className={`approval ${a.dangerous ? 'approval-danger' : ''}`}>
              <span className="muted small">
                {a.agentId} · {timeAgo(a.at)} · {a.reason}
              </span>
              <pre className="approval-summary">{revealHidden(a.summary)}</pre>
              {a.explanation ? (
                <Explanation e={a.explanation} retrying={explaining.has(a.id)} onRetry={() => explainAside(a.id, true)} />
              ) : (
                <span className="small muted">{explaining.has(a.id) ? 'The safety checker is reading it…' : 'Not explained yet.'}</span>
              )}
              <div className="row gap-xs">
                <Button size="sm" tone="primary" onClick={() => save2(a.id, true, 'Sent back to the agent. Allow it on the approval card when it asks.')}>
                  Do it now
                </Button>
                <Button size="sm" tone="ghost" onClick={() => save2(a.id, false, 'Dismissed.')}>
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ConfigCard({ project, ap }: { project: Project; ap: AutopilotState }) {
  const [tasks, setTasks] = useState(ap.config.sprintTasks)
  const [budget, setBudget] = useState(String(ap.config.sprintBudgetUsd))
  const [awayBudget, setAwayBudget] = useState(String(ap.config.unattendedBudgetUsd ?? 20))
  const plan = usePlanMode()
  const save = (patch: Partial<AutopilotState['config']>): void => {
    void attempt(async () => setAutopilot(await window.hangar.autopilot.configure(project.id, patch)))
  }
  return (
    <section className="card">
      <h3>Sprint settings</h3>
      <div className="grid-2">
        <div className="field">
          <span className="field-label">Sprint length</span>
          <div className="segmented" role="radiogroup" aria-label="Sprint length">
            {[...new Set([0, 3, 5, 8, 12, ap.config.sprintTasks])].sort((a, b) => a - b).map((n) => (
              <button key={n} role="radio" aria-checked={tasks === n} className={`segment ${tasks === n ? 'segment-on' : ''}`} onClick={() => { setTasks(n); save({ sprintTasks: n }) }}>
                {n === 0 ? 'Lead decides' : `${n}`}
              </button>
            ))}
          </div>
          <span className="field-hint">{tasks === 0 ? 'The Lead checks in when the sprint\'s plan is done.' : 'Tasks before each check-in.'}</span>
        </div>
        {plan.on ? (
          <div className="field">
            <span className="field-label">Usage</span>
            <span className="small">Your Max plan: {plan.text}.</span>
            <span className="field-hint">Work pauses at those limits and picks up when they reset (Settings → Account).</span>
          </div>
        ) : (
          <label className="field">
            <span className="field-label">Budget per sprint (USD)</span>
            <input value={budget} inputMode="decimal" onChange={(e) => setBudget(e.target.value)} onBlur={() => parseFloat(budget) !== ap.config.sprintBudgetUsd && save({ sprintBudgetUsd: parseFloat(budget) })} />
          </label>
        )}
      </div>
      <Toggle checked={ap.config.autoMerge} onChange={(v) => save({ autoMerge: v })} label="Merge approved work automatically" hint="Off: every task waits for you in Reviews." />
      <Toggle
        checked={ap.config.parallel !== false}
        onChange={(v) => save({ parallel: v })}
        label="Build the sprint's pieces at the same time"
        hint="The Lead plans pieces that don't touch the same files, and each agent builds its piece in its own copy of the game at once; Studio playtests take turns. Off: one task after another."
      />
      {!plan.on && <label className="field">
        <span className="field-label">Most to spend while you're away (USD)</span>
        <input value={awayBudget} inputMode="decimal" onChange={(e) => setAwayBudget(e.target.value)} onBlur={() => parseFloat(awayBudget) > 0 && parseFloat(awayBudget) !== (ap.config.unattendedBudgetUsd ?? 20) && save({ unattendedBudgetUsd: parseFloat(awayBudget) })} />
        <span className="field-hint">“Keep going while I'm away” stops once this much is spent.</span>
      </label>}
    </section>
  )
}

/**
 * A sprint check-in, read section by section: what was built, how to try it, the plan for next sprint
 * (reorder or drop items), and one answer box per question. Falls back to plain text and one feedback box
 * when the report doesn't have the usual sections.
 */
const FEEDBACK_MAX = 8000

interface PlanItem {
  id: number
  text: string
}

function CheckinCard({ project, report, busy, run }: { project: Project; report: SprintReport; busy: boolean; run: (fn: () => Promise<AutopilotState>, ok?: string) => void }) {
  const planMode = usePlanMode()
  const c = useMemo(() => parseCheckin(report.text), [report.text])
  // Each plan item keeps an id, so moving or removing one doesn't reset the others or lose keyboard focus.
  const nextId = useRef(0)
  const fresh = (texts: string[]): PlanItem[] => texts.map((text) => ({ id: nextId.current++, text }))
  const [plan, setPlan] = useState<PlanItem[]>(() => fresh(c.next))
  const [newItem, setNewItem] = useState('')
  const [answers, setAnswers] = useState<string[]>(() => c.questions.map(() => ''))
  const [notes, setNotes] = useState('')
  const listRef = useRef<HTMLOListElement>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const refocus = useRef<{ id: number; act: 'up' | 'down' | 'remove' } | 'add' | null>(null)
  const texts = plan.map((p) => p.text)
  const planChanged = JSON.stringify(texts) !== JSON.stringify(c.next)

  useLayoutEffect(() => {
    const want = refocus.current
    refocus.current = null
    if (!want) return
    if (want === 'add') return addRef.current?.focus()
    const q = (act: string): HTMLButtonElement | null => listRef.current?.querySelector<HTMLButtonElement>(`[data-plan="${want.id}"][data-act="${act}"]`) ?? null
    // At the top or bottom the arrow just used is disabled: land on the other one.
    const el = [q(want.act), q(want.act === 'up' ? 'down' : 'up'), q('remove')].find((b) => b && !b.disabled)
    el?.focus()
  }, [plan])

  const move = (i: number, d: -1 | 1): void => {
    const j = i + d
    if (j < 0 || j >= plan.length) return
    refocus.current = { id: plan[i]!.id, act: d < 0 ? 'up' : 'down' }
    const n = [...plan]
    ;[n[i], n[j]] = [n[j]!, n[i]!]
    setPlan(n)
  }
  const remove = (i: number): void => {
    const after = plan[i + 1] ?? plan[i - 1]
    refocus.current = after ? { id: after.id, act: 'remove' } : 'add'
    setPlan(plan.filter((_, j) => j !== i))
  }
  const add = (): void => {
    if (!newItem.trim()) return
    setPlan((p) => [...p, ...fresh([newItem.trim().slice(0, 300)])])
    setNewItem('')
  }
  const feedback = c.structured ? composeCheckinFeedback({ questions: c.questions, answers, plan: texts, planChanged, notes }) : notes
  // Autopilot keeps the first 8,000 characters of a reply: say so rather than cut the end off quietly.
  const tooLong = feedback.trim().length > FEEDBACK_MAX
  const start = (): void => {
    const pairs = c.questions.map((q, i) => ({ question: q, answer: (answers[i] ?? '').trim() })).filter((x) => x.answer)
    run(() => window.hangar.autopilot.start(project.id, { feedback, answers: pairs }), `Sprint ${report.sprint + 1} started.`)
  }
  const merged = report.tasks.filter((t) => t.outcome === 'merged').length

  return (
    <section className="card checkin">
      <h3>Sprint {report.sprint} check-in</h3>
      <p className="muted small">
        {timeAgo(report.at)} · {planMode.on ? '' : `${usd(report.spentUsd)} spent · `}{merged} of {report.tasks.length} tasks merged
      </p>
      {!c.structured ? (
        <>
          <SafeText className="summary report-text" text={report.text} />
          <TaskList tasks={report.tasks} />
        </>
      ) : (
        <>
          {c.intro && <SafeText className="summary" text={c.intro} />}
          <div className="checkin-block">
            <span className="side-label">Built</span>
            {c.built ? <SafeText text={c.built} /> : <p className="small muted">The Lead didn't list anything.</p>}
            <TaskList tasks={report.tasks} />
          </div>
          {c.tryIt && (
            <div className="checkin-block">
              <span className="side-label">Try it</span>
              <SafeText text={c.tryIt} />
              <div className="row gap-xs wrap">
                <Button size="sm" onClick={() => setProjectTab('reviews')}>
                  Open Reviews
                </Button>
              </div>
            </div>
          )}
          <div className="checkin-block">
            <span className="side-label">Next sprint {planChanged && <span className="tag tag-warn">edited</span>}</span>
            <ol className="plan-list" ref={listRef}>
              {plan.map((item, i) => (
                <li key={item.id}>
                  <span className="plan-text">{item.text}</span>
                  <span className="row gap-xs plan-tools">
                    <button className="icon-btn" data-plan={item.id} data-act="up" aria-label={`Move “${item.text}” up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button className="icon-btn" data-plan={item.id} data-act="down" aria-label={`Move “${item.text}” down`} disabled={i === plan.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    <button className="icon-btn" data-plan={item.id} data-act="remove" aria-label={`Remove “${item.text}”`} onClick={() => remove(i)}>
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            {plan.length === 0 && <p className="small muted">{c.next.length ? "Nothing planned: the Lead won't do the items you removed." : "The Lead didn't propose a plan."}</p>}
            <div className="row gap-xs">
              <input
                ref={addRef}
                value={newItem}
                placeholder="Add something to the plan…"
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add()
                }}
              />
              <Button size="sm" disabled={!newItem.trim()} onClick={add}>
                Add
              </Button>
              {planChanged && (
                <Button size="sm" tone="ghost" onClick={() => setPlan(fresh(c.next))}>
                  Undo changes
                </Button>
              )}
            </div>
          </div>
          {c.questions.length > 0 && (
            <div className="checkin-block">
              <span className="side-label">Questions for you</span>
              {c.questions.map((q, i) => (
                <label key={i} className="field">
                  <span className="field-label">{q}</span>
                  <textarea rows={2} maxLength={2000} value={answers[i] ?? ''} onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
                </label>
              ))}
            </div>
          )}
          <details className="checkin-full">
            <summary className="small muted">Full report</summary>
            <SafeText className="summary report-text" text={report.text} />
          </details>
        </>
      )}
      <label className="field">
        <span className="field-label">{c.structured ? 'Anything else for the Lead (optional)' : 'Your feedback and answers'}</span>
        <textarea
          rows={c.structured ? 2 : 4}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={c.structured ? 'What you liked, what to change…' : "Answer the Lead's questions, say what to change, what to do next, or what you liked."}
        />
      </label>
      <div className="row gap-xs">
        <Button tone="primary" disabled={busy || tooLong} onClick={start}>
          Start sprint {report.sprint + 1}
        </Button>
        {tooLong && (
          <span className="small err">
            Your reply is {feedback.trim().length.toLocaleString()} characters; the Lead takes up to {FEEDBACK_MAX.toLocaleString()}. Shorten it to start.
          </span>
        )}
        <Button tone="ghost" disabled={busy} onClick={() => run(() => window.hangar.autopilot.stop(project.id), 'Autopilot off. Start it again any time.')}>
          Stop here
        </Button>
      </div>
    </section>
  )
}
