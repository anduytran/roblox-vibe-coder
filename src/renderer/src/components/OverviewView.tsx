import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AutopilotState, Project, SprintReport } from '@shared/types'
import { attempt, confirmDialog, openUncommitted, replaceProject, setAutopilot, setProjectTab, toast, useStore } from '../store'
import { composeCheckinFeedback, parseCheckin } from '@shared/checkin'
import { AUTOPILOT_LABEL } from './Dashboard'
import { Button, Toggle, timeAgo, usd } from './ui'
import { SafeText } from './SafeText'

const OUTCOME: Record<SprintReport['tasks'][number]['outcome'], string> = {
  merged: 'Merged',
  waiting: 'Waiting for you',
  discarded: 'Discarded',
  'no-changes': 'No changes',
  failed: 'Failed'
}

/** A project's autopilot: start it, watch the sprint, read check-ins and steer the next sprint. */
export function OverviewView({ project, onOpenReviews }: { project: Project; onOpenReviews: () => void }) {
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

  return (
    <div className="settings-page overview">
      <section className="card overview-status">
        <div className="row between">
          <div>
            <h3>
              Autopilot <span className={`ap-pill ap-${status}`}>{AUTOPILOT_LABEL[status]}</span>
            </h3>
            {ap && ap.sprint > 0 && (
              <p className="muted small">
                Sprint {ap.sprint} · {ap.config.sprintTasks ? `${ap.tasksDone} of ${ap.config.sprintTasks} tasks` : `${ap.tasksDone} task${ap.tasksDone === 1 ? '' : 's'} done, Lead decides when it's finished`} · {usd(sprintSpent)} of {usd(ap.config.sprintBudgetUsd)} this sprint · {usd(spentTotal)} total
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
            {status === 'running' && leadActivity && <div className="activity">Task {ap.tasksDone + 1}: {leadActivity}</div>}
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
                  Sprint {r.sprint} · {timeAgo(r.at)} · {r.tasks.filter((t) => t.outcome === 'merged').length} merged · {usd(r.spentUsd)}
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
          <span className="field-hint">{tasks === 0 ? 'The Lead works through the plan and checks in when it\'s done (or the budget runs out).' : 'Checks in after this many tasks.'}</span>
        </div>
        <label className="field">
          <span className="field-label">Budget per sprint (USD)</span>
          <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
        </label>
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

/** The next given hour (7 → 7:00 tomorrow morning if it's already past 7 today). */
function nextHour(h: number): number {
  const d = new Date()
  d.setHours(h, 0, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.getTime()
}
const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Keep autopilot going while you sleep, and what it did while you were away. */
function UnattendedCard({ project, ap }: { project: Project; ap: AutopilotState }) {
  const on = !!ap.config.unattended
  const [until, setUntil] = useState(7)
  const [budget, setBudget] = useState(String(ap.config.unattendedBudgetUsd ?? 20))
  const save = (patch: Partial<AutopilotState['config']>, ok?: string): void => {
    void attempt(async () => {
      setAutopilot(await window.hangar.autopilot.configure(project.id, patch))
      if (ok) toast(ok)
    })
  }
  const away = ap.away
  return (
    <section className={`card ${on ? 'card-accent' : ''}`}>
      <h3>While you're away</h3>
      {on ? (
        <p className="small">
          Running unattended until <strong>{ap.config.unattendedUntil ? clock(ap.config.unattendedUntil) : 'you turn it off'}</strong>, spending at most{' '}
          <strong>{usd(ap.config.unattendedBudgetUsd ?? 20)}</strong>. Check-ins answer themselves (decisions go in Decisions.md), changes that can't merge
          themselves wait in Reviews, and approvals nobody answers are declined after 10 minutes. The Mac stays awake.
        </p>
      ) : (
        <p className="small muted">
          Let autopilot keep going overnight: it won't stop for check-ins, reviews or approvals, and you get a summary in the morning. Keep Studio open if you
          want the QA Tester to playtest.
        </p>
      )}
      {!on && (
        <div className="row gap-xs wrap">
          <label className="field">
            <span className="field-label">Stop at</span>
            <select value={until} onChange={(e) => setUntil(Number(e.target.value))}>
              {[5, 6, 7, 8, 9, 10].map((h) => (
                <option key={h} value={h}>
                  {clock(nextHour(h))}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Spend at most (USD)</span>
            <input value={budget} inputMode="decimal" onChange={(e) => setBudget(e.target.value)} />
          </label>
        </div>
      )}
      <div className="row gap-xs">
        {on ? (
          <Button onClick={() => save({ unattended: false }, 'Unattended mode off.')}>Turn off</Button>
        ) : (
          <Button
            tone="primary"
            onClick={() =>
              save(
                { unattended: true, unattendedUntil: nextHour(until), unattendedBudgetUsd: parseFloat(budget) || 20 },
                `Running unattended until ${clock(nextHour(until))}. Sleep well.`
              )
            }
          >
            Keep going while I'm away
          </Button>
        )}
      </div>
      {away && (
        <div className="decisions">
          <span className="side-label">
            {away.endedAt ? `While you were away (${clock(away.since)} – ${clock(away.endedAt)})` : `Since ${clock(away.since)}`}
          </span>
          <p className="small">
            {away.tasks} task{away.tasks === 1 ? '' : 's'} done · {away.merged} merged · {away.leftForYou} waiting for you in Reviews · {away.sprints} sprint
            {away.sprints === 1 ? '' : 's'} started on the Lead's plan · {away.declined} approval{away.declined === 1 ? '' : 's'} declined
            {away.endReason ? ` · ended because ${away.endReason}` : ''}
          </p>
          {away.sprints > 0 && <p className="small muted">The Lead's decisions are in the Design tab, under Decisions.</p>}
        </div>
      )}
    </section>
  )
}

function ConfigCard({ project, ap }: { project: Project; ap: AutopilotState }) {
  const [tasks, setTasks] = useState(ap.config.sprintTasks)
  const [budget, setBudget] = useState(String(ap.config.sprintBudgetUsd))
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
        <label className="field">
          <span className="field-label">Budget per sprint (USD)</span>
          <input value={budget} inputMode="decimal" onChange={(e) => setBudget(e.target.value)} onBlur={() => parseFloat(budget) !== ap.config.sprintBudgetUsd && save({ sprintBudgetUsd: parseFloat(budget) })} />
        </label>
      </div>
      <Toggle checked={ap.config.autoMerge} onChange={(v) => save({ autoMerge: v })} label="Merge approved work automatically" hint="Off: every task waits for you in Reviews." />
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
        {timeAgo(report.at)} · {usd(report.spentUsd)} spent · {merged} of {report.tasks.length} tasks merged
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
