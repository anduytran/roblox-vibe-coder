import { useEffect, useState } from 'react'
import type { CheckCommand, Project, ProjectSettings } from '@shared/types'
import { Button, Toggle } from './ui'

const SUGGESTED: CheckCommand[] = [
  { name: 'Format', command: 'stylua --check src' },
  { name: 'Lint', command: 'selene src' },
  { name: 'Build', command: 'rojo build -o hangar-check.rbxl' }
]
const PLAIN = /^[A-Za-z0-9._/@+,-]+( [A-Za-z0-9._/@+,-]+)*$/

/** "Before you merge": check commands run on every finished task, and the reviewer agent. */
export function ChecksCard({ project, update }: { project: Project; update: (patch: { settings: Partial<ProjectSettings> }, message?: string) => void }) {
  const s = project.settings
  const [rows, setRows] = useState<CheckCommand[]>(s.checks)
  // Only a change to the saved checks resets the rows (saving another setting must not drop unsaved ones).
  const savedKey = JSON.stringify(project.settings.checks)
  useEffect(() => {
    setRows(project.settings.checks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey])
  const dirty = JSON.stringify(rows) !== JSON.stringify(s.checks)
  const invalid = rows.some((r) => r.command.trim() && !PLAIN.test(r.command.trim().replace(/\s+/g, ' ')))
  const set = (i: number, patch: Partial<CheckCommand>): void => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <section className="card">
      <h3>Before you merge</h3>
      <p className="small muted">
        Every finished autonomous task is checked before it reaches you. Results appear on the review, and Merge asks you to confirm when something failed.
      </p>
      <Toggle
        checked={s.reviewer}
        onChange={(v) => update({ settings: { reviewer: v } }, v ? 'Reviewer agent on.' : 'Reviewer agent off.')}
        label="Reviewer agent"
        hint="A separate, read-only Claude session reads each change and reports problems: client trust, backdoors, DataStore risks, performance, scope. Costs up to $1 per task (usually far less). It's advice — it can be fooled by the code it reads."
      />
      <span className="field-label">Check commands</span>
      <div className="check-list">
        {rows.length === 0 && <span className="field-hint">No checks yet.</span>}
        {rows.map((r, i) => (
          <div key={i} className="check-edit">
            <input value={r.name} placeholder="Name" maxLength={40} onChange={(e) => set(i, { name: e.target.value })} />
            <input className="mono" value={r.command} placeholder="selene src" onChange={(e) => set(i, { command: e.target.value })} />
            <Button size="sm" tone="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      {invalid && <p className="small err">Use plain words only: no quotes, $variables, pipes, ; or &&. Hangar runs checks without a shell.</p>}
      <div className="row gap-xs wrap">
        <Button size="sm" onClick={() => setRows([...rows, { name: '', command: '' }])} disabled={rows.length >= 10}>
          Add check
        </Button>
        {rows.length === 0 && (
          <Button size="sm" onClick={() => setRows(SUGGESTED)}>
            Add suggested (StyLua, Selene, Rojo build)
          </Button>
        )}
        <span className="spacer" />
        {dirty && (
          <Button size="sm" tone="primary" disabled={invalid} onClick={() => update({ settings: { checks: rows.filter((r) => r.command.trim()) } }, 'Checks saved.')}>
            Save checks
          </Button>
        )}
      </div>
      <ul className="small muted bullets">
        <li>They run in a separate copy of the task's branch, so your project folder isn't touched. Programs come from your PATH, never from the branch.</li>
        <li>Skipped automatically when a task changes files that decide what runs (rokit.toml, package.json, editor or CI config) — look at those yourself first.</li>
        <li>Linters and builds only read code. A test runner that executes game code runs it with your permissions; add one only if you're comfortable with that.</li>
      </ul>
    </section>
  )
}
