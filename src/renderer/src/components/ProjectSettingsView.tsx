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
  const [domains, setDomains] = useState(project.settings.sandboxAllowedDomains.join('\n'))
  const sandboxAvailable = window.hangar.platform === 'darwin' || window.hangar.platform === 'linux'
  const [universeId, setUniverseId] = useState(project.settings.testPlace?.universeId ?? '')
  const [placeId, setPlaceId] = useState(project.settings.testPlace?.placeId ?? '')
  const [cloudKey, setCloudKey] = useState('')
  const [hasCloudKey, setHasCloudKey] = useState(false)
  useEffect(() => {
    void window.hangar.testPlaceKey.status(project.id).then((r) => setHasCloudKey(r.hasKey))
  }, [project.id])

  useEffect(() => {
    setName(project.name)
    setPrefixes(project.settings.allowedBashPrefixes.join('\n'))
    setBudget(project.settings.dailyBudgetUsd?.toString() ?? '')
    setModel(project.settings.model ?? '')
    setDomains(project.settings.sandboxAllowedDomains.join('\n'))
    setUniverseId(project.settings.testPlace?.universeId ?? '')
    setPlaceId(project.settings.testPlace?.placeId ?? '')
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

      <section className={`card ${s.autonomous ? 'card-accent' : ''}`}>
        <h3>Autonomous mode</h3>
        <Toggle
          checked={s.autonomous}
          onChange={(v) => update({ settings: { autonomous: v } }, v ? 'Autonomous mode on.' : 'Autonomous mode off.')}
          label="Let agents work without asking inside this project"
          hint="Edits in the project, sandboxed shell commands and Studio playtest tools run freely. Each task runs on its own git branch and ends in the Reviews tab as one change to merge or discard. Anything outside the project, network access, protected files and Toolbox assets still ask."
        />
        <ul className="small muted bullets">
          <li>Needs a git repository with a first commit, and no uncommitted changes when a task starts.</li>
          <li>Tasks in this project run one at a time (they share your project folder and Studio).</li>
          {!sandboxAvailable && <li className="warn">On Windows there is no OS sandbox, so shell commands still ask for approval (you can answer from your phone).</li>}
          {sandboxAvailable && !s.sandbox && <li className="warn">The sandbox is off for this project, so shell commands still ask.</li>}
        </ul>
      </section>

      <section className="card">
        <h3>Sandbox</h3>
        {sandboxAvailable ? (
          <>
            <Toggle
              checked={s.sandbox}
              onChange={(v) => update({ settings: { sandbox: v } })}
              label="Sandbox shell commands (recommended)"
              hint="Your operating system stops commands agents run from changing anything outside this project folder, reading your credential folders, or using the network. If the sandbox can't start, nothing runs."
            />
            {s.sandbox && (
              <Field label="Websites sandboxed commands may reach" hint="One domain per line, e.g. api.github.com. Leave empty for no network access.">
                <textarea
                  className="mono"
                  rows={3}
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                  onBlur={() => update({ settings: { sandboxAllowedDomains: domains.split('\n') } }, 'Domains saved.')}
                />
              </Field>
            )}
            {s.sandbox && s.autoApproveEdits && <p className="small muted">Because file edits are auto-approved here, sandboxed commands also run without asking.</p>}
          </>
        ) : (
          <p className="small warn">
            The OS sandbox isn't available on Windows. Shell commands still need your approval, but once approved they run with your full permissions — read each one before allowing it.
          </p>
        )}
      </section>

      <section className="card">
        <h3>Permissions</h3>
        <Toggle
          checked={s.autoApproveEdits}
          onChange={(v) => update({ settings: { autoApproveEdits: v } })}
          label="Auto-approve file edits inside this project"
          hint="Edits outside the folder, and to files that control how code runs (.git, .claude, .mcp.json, CLAUDE.md, .vscode, .github, package.json), always ask. Review everything in the Changes tab before committing."
        />
        <Field
          label="Shell commands that run without asking"
          hint="One rule per line. A command runs without asking only if it matches a rule exactly. End a rule with “ *” to also allow plain file names after it (e.g. “selene *”) — never flags, quotes, variables, ~, chaining or redirection."
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

      <section className="card">
        <h3>Test place</h3>
        <p className="small muted">
          A private Roblox place (separate from your live game) that reviewed builds can be published to, so you can play them on your phone. Publishing only ever
          happens when you tap “Publish to test place” on a review.
        </p>
        <div className="grid-2">
          <Field label="Universe ID">
            <input inputMode="numeric" value={universeId} onChange={(e) => setUniverseId(e.target.value.trim())} placeholder="e.g. 1234567890" />
          </Field>
          <Field label="Place ID">
            <input inputMode="numeric" value={placeId} onChange={(e) => setPlaceId(e.target.value.trim())} placeholder="e.g. 9876543210" />
          </Field>
        </div>
        <div className="row gap-xs">
          <Button
            size="sm"
            onClick={() =>
              update(
                { settings: { testPlace: universeId && placeId ? { universeId, placeId } : null } },
                universeId && placeId ? 'Test place saved.' : 'Test place cleared.'
              )
            }
          >
            Save test place
          </Button>
          {s.testPlace && <span className="small muted">Saved: universe {s.testPlace.universeId}, place {s.testPlace.placeId}</span>}
        </div>
        <Field
          label="Roblox Open Cloud API key"
          hint="Create it on the Creator Dashboard with only the universe-places Write permission, for this one game. Stored encrypted; agents never see it."
        >
          <div className="row gap-xs">
            <input type="password" autoComplete="off" value={cloudKey} onChange={(e) => setCloudKey(e.target.value)} placeholder={hasCloudKey ? 'A key is saved — paste to replace' : 'Paste key'} />
            <Button
              size="sm"
              tone="primary"
              disabled={!cloudKey.trim()}
              onClick={() =>
                void attempt(async () => {
                  setHasCloudKey((await window.hangar.testPlaceKey.set(project.id, cloudKey)).hasKey)
                  setCloudKey('')
                  toast('Key saved securely.')
                })
              }
            >
              Save
            </Button>
            {hasCloudKey && (
              <Button size="sm" tone="danger" onClick={() => void attempt(async () => setHasCloudKey((await window.hangar.testPlaceKey.clear(project.id)).hasKey))}>
                Remove
              </Button>
            )}
          </div>
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
