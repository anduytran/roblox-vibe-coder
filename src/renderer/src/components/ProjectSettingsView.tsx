import { useEffect, useState } from 'react'
import type { Project, ProjectSettings } from '@shared/types'
import { attempt, removeProject, replaceProject, toast, useStore } from '../store'
import { Button, Field, Toggle, usd } from './ui'

export function ProjectSettingsView({ project }: { project: Project }) {
  const totals = useStore((s) => s.costs)
  const [name, setName] = useState(project.name)
  const [prefixes, setPrefixes] = useState(project.settings.allowedBashPrefixes.join('\n'))
  const [budget, setBudget] = useState(project.settings.dailyBudgetUsd?.toString() ?? '')
  const [model, setModel] = useState(project.settings.model ?? '')

  useEffect(() => {
    setName(project.name)
    setPrefixes(project.settings.allowedBashPrefixes.join('\n'))
    setBudget(project.settings.dailyBudgetUsd?.toString() ?? '')
    setModel(project.settings.model ?? '')
  }, [project])

  const update = (patch: { name?: string; settings?: Partial<ProjectSettings> }, message?: string): void => {
    void attempt(async () => {
      replaceProject(await window.hangar.projects.update(project.id, patch))
      if (message) toast(message)
    })
  }

  const s = project.settings

  return (
    <div className="settings-page">
      <section className="card">
        <h3>General</h3>
        <div className="grid-2">
          <Field label="Display name">
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== project.name && update({ name }, 'Renamed.')} />
          </Field>
          <Field label="Model override" hint="Empty = app default. Roles can set their own model.">
            <input
              value={model}
              placeholder="claude-sonnet-5-5"
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => model !== (s.model ?? '') && update({ settings: { model: model.trim() || null } }, 'Model saved.')}
            />
          </Field>
        </div>
        <div className="row gap-sm">
          <Button size="sm" onClick={() => void attempt(() => window.hangar.projects.reveal(project.id))}>
            Open folder
          </Button>
        </div>
      </section>

      <section className="card">
        <h3>Tools</h3>
        <Toggle
          checked={s.robloxStudioMcp}
          onChange={(v) => update({ settings: { robloxStudioMcp: v } })}
          label="Roblox Studio tools"
          hint="Connects agents to Studio's built-in MCP server. Studio must be open with “Enable Studio as MCP server” turned on (Assistant → … → Manage MCP Servers)."
        />
        <p className="muted small">Other MCP servers are read from this project's .mcp.json.</p>
      </section>

      <section className="card">
        <h3>Permissions</h3>
        <Toggle
          checked={s.autoApproveEdits}
          onChange={(v) => update({ settings: { autoApproveEdits: v } })}
          label="Auto-approve file edits inside this project"
          hint="Edits outside the folder always ask. Review everything in the Changes tab before committing."
        />
        <Field
          label="Shell commands that run without asking"
          hint="One prefix per line. A command matches if it starts with the prefix. Chained or redirected commands (;, &&, |, >) always ask."
        >
          <textarea
            className="mono"
            rows={5}
            value={prefixes}
            onChange={(e) => setPrefixes(e.target.value)}
            onBlur={() => update({ settings: { allowedBashPrefixes: prefixes.split('\n') } }, 'Command rules saved.')}
          />
        </Field>
        <div className="field">
          <span className="field-label">Always-allowed tools</span>
          {s.alwaysAllowTools.length === 0 ? (
            <span className="field-hint">None yet. Click “Always allow” on an approval card to add one.</span>
          ) : (
            <ul className="chips">
              {s.alwaysAllowTools.map((t) => (
                <li key={t} className="chip">
                  <code>{t}</code>
                  <button
                    className="icon-btn"
                    aria-label={`Remove ${t}`}
                    onClick={() => update({ settings: { alwaysAllowTools: s.alwaysAllowTools.filter((x) => x !== t) } })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="card">
        <h3>Spending</h3>
        <p className="small">
          Today: <strong>{usd(totals.projectTodayUsd[project.id])}</strong> · All time: <strong>{usd(totals.projectTotalUsd[project.id])}</strong>
        </p>
        <Field label="Daily limit for this project (USD)" hint="Empty = only the app-wide limit applies. Running agents finish their current task.">
          <input
            inputMode="decimal"
            value={budget}
            placeholder="No project limit"
            onChange={(e) => setBudget(e.target.value)}
            onBlur={() => {
              const n = parseFloat(budget)
              update({ settings: { dailyBudgetUsd: Number.isFinite(n) && n > 0 ? n : null } }, 'Limit saved.')
            }}
          />
        </Field>
      </section>

      <section className="card card-danger">
        <h3>Remove project</h3>
        <p className="small muted">Removes it from Hangar only. Your files, roles and git history stay on disk.</p>
        <Button
          tone="danger"
          onClick={() => {
            if (confirm(`Remove ${project.name} from Hangar? Files on disk are not touched.`)) void removeProject(project.id)
          }}
        >
          Remove from Hangar
        </Button>
      </section>
    </div>
  )
}
