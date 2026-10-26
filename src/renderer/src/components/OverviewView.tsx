import { useState } from 'react'
import type { AutopilotState, Project, SprintReport } from '@shared/types'
import { attempt, confirmDialog, replaceProject, setAutopilot, toast, useStore } from '../store'
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
                Sprint {ap.sprint} · {ap.tasksDone} of {ap.config.sprintTasks} tasks · {usd(sprintSpent)} of {usd(ap.config.sprintBudgetUsd)} this sprint · {usd(spentTotal)} total
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

        {ap?.reason && <div className={`callout ${status === 'waiting' ? 'callout-amber' : ''}`}>{ap.reason}</div>}
        {status === 'waiting' && (
          <Button tone="primary" onClick={onOpenReviews}>
            Open Reviews
          </Button>
        )}

        {ap && ap.status !== 'off' && ap.status !== 'checkin' && (
          <>
            <div className="sprint-meter sprint-meter-lg">
              {Array.from({ length: ap.config.sprintTasks }, (_, i) => (
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

      {status === 'checkin' && report && (
        <section className="card checkin">
          <h3>Sprint {report.sprint} check-in</h3>
          <p className="muted small">
            {timeAgo(report.at)} · {usd(report.spentUsd)} spent · {report.tasks.filter((t) => t.outcome === 'merged').length} of {report.tasks.length} tasks merged
          </p>
          <SafeText className="summary report-text" text={report.text} />
          <TaskList tasks={report.tasks} />
          <div className="field">
            <span className="field-label">Your feedback and answers</span>
            <textarea
              rows={4}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Answer the Lead's questions, say what to change, what to do next, or what you liked."
            />
          </div>
          <div className="row gap-xs">
            <Button tone="primary" disabled={busy} onClick={() => run(async () => {
              const st = await window.hangar.autopilot.start(project.id, { feedback })
              setFeedback('')
              return st
            }, `Sprint ${report.sprint + 1} started.`)}>
              Start sprint {report.sprint + 1}
            </Button>
            <Button tone="ghost" disabled={busy} onClick={() => run(() => window.hangar.autopilot.stop(project.id), 'Autopilot off. Start it again any time.')}>
              Stop here
            </Button>
          </div>
        </section>
      )}

      {status === 'off' && <StartCard project={project} ap={ap} hasLead={hasLead} busy={busy} run={run} />}

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
              </details>
            ))}
        </section>
      )}
    </div>
  )

}

function StartCard({ project, ap, hasLead, busy, run }: { project: Project; ap: AutopilotState | undefined; hasLead: boolean; busy: boolean; run: (fn: () => Promise<AutopilotState>, ok?: string) => void }) {
  const [tasks, setTasks] = useState(ap?.config.sprintTasks ?? 5)
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
          <span className="field-label">Tasks per sprint</span>
          <div className="segmented" role="radiogroup" aria-label="Tasks per sprint">
            {[3, 5, 8, 12].map((n) => (
              <button key={n} role="radio" aria-checked={tasks === n} className={`segment ${tasks === n ? 'segment-on' : ''}`} onClick={() => setTasks(n)}>
                {n}
              </button>
            ))}
          </div>
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
        <label className="field">
          <span className="field-label">Tasks per sprint</span>
          <input type="number" min={1} max={20} value={tasks} onChange={(e) => setTasks(Number(e.target.value))} onBlur={() => tasks !== ap.config.sprintTasks && save({ sprintTasks: tasks })} />
        </label>
        <label className="field">
          <span className="field-label">Budget per sprint (USD)</span>
          <input value={budget} inputMode="decimal" onChange={(e) => setBudget(e.target.value)} onBlur={() => parseFloat(budget) !== ap.config.sprintBudgetUsd && save({ sprintBudgetUsd: parseFloat(budget) })} />
        </label>
      </div>
      <Toggle checked={ap.config.autoMerge} onChange={(v) => save({ autoMerge: v })} label="Merge approved work automatically" hint="Off: every task waits for you in Reviews." />
    </section>
  )
}
