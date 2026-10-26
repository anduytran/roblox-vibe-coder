import { useEffect, useRef, useState } from 'react'
import { agentLabel } from '@shared/lanes'
import type { Project, ProjectSettings } from '@shared/types'
import { attempt, confirmDialog, EMPTY_ROLES, removeProject, replaceProject, toast, useStore } from '../store'
import { revealHidden } from '@shared/text'
import { Button, Field, Icon, Toggle, usd } from './ui'
import { SpendBars } from './SpendBars'
import { ModelSelect } from './ModelSelect'
import { DEFAULT_MODEL, modelLabel } from '@shared/models'
import { VaultsCard } from './VaultsCard'
import { ChecksCard } from './ChecksCard'
import { GitHubCard } from './GitHubCard'

type Category = 'general' | 'tools' | 'autonomy' | 'safety' | 'spending' | 'vaults' | 'github' | 'testplace' | 'remove'

const CATEGORIES: [Category, string, string][] = [
  ['general', 'General', 'gear'],
  ['tools', 'Agents & tools', 'agents'],
  ['autonomy', 'Autonomy & reviews', 'review'],
  ['safety', 'Safety', 'shield'],
  ['spending', 'Spending', 'gauge'],
  ['vaults', 'Vaults', 'book'],
  ['github', 'GitHub', 'changes'],
  ['testplace', 'Test place', 'phone'],
  ['remove', 'Remove', 'stop']
]

export function ProjectSettingsView({ project }: { project: Project }) {
  const totals = useStore((s) => s.costs)
  const appModel = useStore((s) => s.settings?.defaultModel ?? DEFAULT_MODEL)
  const roles = useStore((s) => s.roles[project.id] ?? EMPTY_ROLES)
  const agentName = (id: string): string =>
    id === 'hangar:explain' ? 'Explain (approvals)' : revealHidden(agentLabel(id, (rid) => roles.find((r) => r.id === rid)?.name))
  const [cat, setCat] = useState<Category>('general')
  const pane = useRef<HTMLDivElement>(null)
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 })
  }, [cat])
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

  // Each field follows its own saved value, so saving one never resets a draft in another category.
  const saved = project.settings
  const savedPrefixes = saved.allowedBashPrefixes.join('\n')
  const savedDomains = saved.sandboxAllowedDomains.join('\n')
  useEffect(() => {
    setName(project.name)
  }, [project.name])
  useEffect(() => {
    setPrefixes(savedPrefixes)
  }, [savedPrefixes])
  useEffect(() => {
    setBudget(saved.dailyBudgetUsd?.toString() ?? '')
  }, [saved.dailyBudgetUsd])
  useEffect(() => {
    setModel(saved.model ?? '')
  }, [saved.model])
  useEffect(() => {
    setDomains(savedDomains)
  }, [savedDomains])
  useEffect(() => {
    setUniverseId(saved.testPlace?.universeId ?? '')
    setPlaceId(saved.testPlace?.placeId ?? '')
  }, [saved.testPlace?.universeId, saved.testPlace?.placeId])

  const update = (patch: { name?: string; settings?: Partial<ProjectSettings> }, message?: string): void => {
    void attempt(async () => {
      replaceProject(await window.hangar.projects.update(project.id, patch))
      if (message) toast(message)
    })
  }

  const s = project.settings

  return (
    <div className="settings-page project-settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Project settings categories">
          {CATEGORIES.map(([id, label, icon]) => (
            <button key={id} className={`settings-tab ${cat === id ? 'settings-tab-on' : ''}`} aria-current={cat === id ? 'page' : undefined} onClick={() => setCat(id)}>
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </nav>
        {/* Every category stays mounted (only the open one shows), so an unsaved edit survives switching. */}
        <div className="settings-pane" ref={pane}>
          <div className="pane-group" hidden={cat !== 'general'}>
            <section className="card">
              <h3>General</h3>
              <div className="grid-2">
                <Field label="Display name">
                  <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== project.name && update({ name }, 'Renamed.')} />
                </Field>
                <Field label="Model" hint="For this game's agents. Roles can pick their own.">
                  <ModelSelect
                    value={model}
                    inheritLabel={`App default (${modelLabel(appModel)})`}
                    onChange={(m) => {
                      setModel(m)
                      update({ settings: { model: m || null } }, 'Model saved.')
                    }}
                  />
                </Field>
              </div>
              <div className="row gap-sm">
                <Button size="sm" onClick={() => void attempt(() => window.hangar.projects.reveal(project.id))}>
                  Open folder
                </Button>
              </div>
            </section>
          </div>
          <div className="pane-group" hidden={cat !== 'tools'}>
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
          </div>
          <div className="pane-group" hidden={cat !== 'autonomy'}>
            <>
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
              <ChecksCard project={project} update={update} />
            </>
          </div>
          <div className="pane-group" hidden={cat !== 'safety'}>
            <>
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
                          onBlur={() => domains !== savedDomains && update({ settings: { sandboxAllowedDomains: domains.split('\n') } }, 'Domains saved.')}
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
                  checked={s.safetyChecker}
                  onChange={(v) => update({ settings: { safetyChecker: v } }, v ? 'Safety checker on.' : 'Safety checker off.')}
                  label="Let a safety checker approve plainly safe actions"
                  hint="A second AI looks at each action waiting for you (only the action, never the conversation) and approves it when it only reads or makes ordinary changes inside the game, and Hangar's own checks found nothing. High-risk actions, and anything that deletes, uses the internet or reaches outside the game, still wait for you. Each approval it gives is noted in the agent's feed. It's AI advice, so it can be fooled."
                />
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
                    onBlur={() => prefixes !== savedPrefixes && update({ settings: { allowedBashPrefixes: prefixes.split('\n') } }, 'Command rules saved.')}
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
            </>
          </div>
          <div className="pane-group" hidden={cat !== 'spending'}>
            <section className="card">
              <h3>Spending</h3>
              <p className="small">
                Today: <strong>{usd(totals.projectTodayUsd[project.id])}</strong> · All time: <strong>{usd(totals.projectTotalUsd[project.id])}</strong>
              </p>
              <SpendBars projectId={project.id} name={agentName} />
              <Field label="Daily limit for this project (USD)" hint="Empty = only the app-wide limit applies. Running agents finish their current task.">
                <input
                  inputMode="decimal"
                  value={budget}
                  placeholder="No project limit"
                  onChange={(e) => setBudget(e.target.value)}
                  onBlur={() => {
                    const n = parseFloat(budget)
                    const next = Number.isFinite(n) && n > 0 ? n : null
                    if (next !== (s.dailyBudgetUsd ?? null)) update({ settings: { dailyBudgetUsd: next } }, 'Limit saved.')
                  }}
                />
              </Field>
            </section>
          </div>
          <div className="pane-group" hidden={cat !== 'vaults'}>
            <VaultsCard project={project} />
          </div>
          <div className="pane-group" hidden={cat !== 'github'}>
            <GitHubCard project={project} />
          </div>
          <div className="pane-group" hidden={cat !== 'testplace'}>
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
                hint="Create it on the Creator Dashboard for this one game, with only the universe-places Write permission (add luau-execution-session Write too to run Luau tests on the test place). Stored encrypted; agents never see it."
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
          </div>
          <div className="pane-group" hidden={cat !== 'remove'}>
            <section className="card card-danger">
              <h3>Remove project</h3>
              <p className="small muted">Removes it from Hangar only. Your files, roles and git history stay on disk.</p>
              <Button
                tone="danger"
                onClick={() =>
                  void confirmDialog({
                    title: `Remove ${project.name}?`,
                    body: 'It is removed from Hangar only. Your files, roles and git history stay on disk.',
                    confirmLabel: 'Remove from Hangar',
                    tone: 'danger'
                  }).then((ok) => {
                    if (ok) void removeProject(project.id)
                  })
                }
              >
                Remove from Hangar
              </Button>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
