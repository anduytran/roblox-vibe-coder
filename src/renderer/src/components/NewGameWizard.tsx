import { useEffect, useState } from 'react'
import type { NewGameInput } from '@shared/types'
import { addCreatedProject, attempt, closeWizard, setAutopilot, toast, useStore } from '../store'
import { Button, Field, Icon, Modal, Toggle } from './ui'

const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']
const PLATFORMS: { id: NewGameInput['platforms'][number]; label: string }[] = [
  { id: 'phone', label: 'Phone & tablet' },
  { id: 'pc', label: 'PC' },
  { id: 'console', label: 'Console' },
  { id: 'vr', label: 'VR' }
]
const STEPS = ['Your game', 'Setup', 'Start'] as const

/** "New game": describe the idea (or attach a design doc), choose the setup, and hand it to the agents. */
export function NewGameWizard() {
  const prefill = useStore((s) => s.wizard) ?? {}
  const settings = useStore((s) => s.settings)
  const hasKey = useStore((s) => s.key.hasKey)
  const [step, setStep] = useState(0)
  const [name, setName] = useState(prefill.name ?? '')
  const [idea, setIdea] = useState(prefill.idea ?? '')
  const [doc, setDoc] = useState<{ name: string; text: string } | null>(null)
  const [genre, setGenre] = useState(prefill.genre ?? '')
  const [platforms, setPlatforms] = useState<NewGameInput['platforms']>(['phone', 'pc'])
  const [notes, setNotes] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [model, setModel] = useState(settings?.defaultModel ?? MODELS[0]!)
  const [daily, setDaily] = useState('15')
  const [studio, setStudio] = useState(true)
  const [sprintTasks, setSprintTasks] = useState(5)
  const [sprintBudget, setSprintBudget] = useState('10')
  const [autoMerge, setAutoMerge] = useState(true)
  const [startNow, setStartNow] = useState(true)
  const [tools, setTools] = useState<{ rojo: boolean; selene: boolean; stylua: boolean; git: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.hangar.system.tools().then((t) => {
      setTools(t)
      setParentDir((d) => d || t.defaultParent)
    })
  }, [])

  const canNext = step === 0 ? name.trim().length > 0 && (idea.trim().length > 0 || doc !== null) : step === 1 ? parentDir.length > 0 : true

  const create = (): void => {
    setBusy(true)
    void attempt(async () => {
      const d = parseFloat(daily)
      const res = await window.hangar.projects.create({
        name,
        parentDir,
        idea,
        document: doc,
        platforms,
        genre,
        notes,
        model,
        dailyBudgetUsd: Number.isFinite(d) && d > 0 ? d : null,
        studioTools: studio,
        autopilot: { sprintTasks, sprintBudgetUsd: parseFloat(sprintBudget) || 10, autoMerge },
        startNow
      })
      await addCreatedProject(res.project)
      const ap = await window.hangar.autopilot.list()
      for (const st of ap) setAutopilot(st)
      closeWizard()
      toast(res.started ? `${res.project.name} created. The Lead is reading your brief and starting sprint 1.` : `${res.project.name} created.`)
      if (res.note) setTimeout(() => toast(res.note!), 3800)
    }).finally(() => setBusy(false))
  }

  return (
    <Modal
      title="New game"
      wide
      onClose={closeWizard}
      footer={
        <>
          <ol className="wizard-steps" aria-label="Steps">
            {STEPS.map((label, i) => (
              <li key={label} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
                <span className="wizard-step-n">{i < step ? '✓' : i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          <span className="spacer" />
          {step > 0 && (
            <Button tone="ghost" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </Button>
          )}
          {step < 2 ? (
            <Button tone="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              Continue
            </Button>
          ) : (
            <Button tone="primary" disabled={busy} onClick={create}>
              {busy ? 'Creating…' : startNow && hasKey ? 'Create and start building' : 'Create project'}
            </Button>
          )}
        </>
      }
    >
      {step === 0 && (
        <>
          <p className="muted">Describe the game the way you'd pitch it to a team. The Lead turns it into a design, a roadmap and the first playable version.</p>
          <Field label="Name">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Sky Courier" maxLength={80} />
          </Field>
          <Field label="The idea" hint="What the player does, what makes it fun, what it should feel like. A few sentences is enough; more detail gives the agents more to work with.">
            <textarea
              rows={7}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="Players are couriers gliding between floating islands, delivering parcels before storms roll in. Upgrade your glider, unlock new islands, team up for big deliveries…"
            />
          </Field>
          <div className="row gap-sm wrap">
            {doc ? (
              <span className="attach">
                <Icon name="review" />
                {doc.name} <span className="muted small">({Math.round(doc.text.length / 1000)}k characters)</span>
                <button className="icon-btn" aria-label="Remove document" onClick={() => setDoc(null)}>
                  ×
                </button>
              </span>
            ) : (
              <Button size="sm" onClick={() => void attempt(async () => setDoc(await window.hangar.projects.readDocument()))}>
                <Icon name="plus" />
                Attach a design document
              </Button>
            )}
            <span className="muted small">Markdown or plain text, up to 300 KB.</span>
          </div>
          <div className="grid-2">
            <Field label="Genre (optional)">
              <input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="Simulator, obby, tower defense…" />
            </Field>
            <div className="field">
              <span className="field-label">Platforms</span>
              <div className="chips">
                {PLATFORMS.map((p) => (
                  <button
                    key={p.id}
                    className={`chip-toggle ${platforms.includes(p.id) ? 'on' : ''}`}
                    aria-pressed={platforms.includes(p.id)}
                    onClick={() => setPlatforms(platforms.includes(p.id) ? platforms.filter((x) => x !== p.id) : [...platforms, p.id])}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Field label="Anything else (optional)" hint="Constraints and must-haves: session length, monetisation rules, art style, games you like.">
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </>
      )}

      {step === 1 && (
        <>
          <section className="card">
            <h3>Project</h3>
            <Field label="Location">
              <div className="row gap-xs">
                <input value={parentDir} readOnly className="mono" />
                <Button onClick={() => void attempt(async () => setParentDir((await window.hangar.projects.pickFolder()) ?? parentDir))}>Change…</Button>
              </div>
            </Field>
            <p className="small muted">
              Hangar creates a Rojo project there with a code layout, lint and format settings, conventions for the agents, the starter roles (Lead, Scripter, UI Builder,
              QA Tester, Researcher), a game design vault holding your brief, and a first git commit.
            </p>
            <div className="tool-row" aria-label="Build tools found">
              {tools &&
                (['rojo', 'selene', 'stylua', 'git'] as const).map((t) => (
                  <span key={t} className={`tag ${tools[t] ? 'tag-ok' : 'tag-warn'}`}>
                    {tools[t] ? '✓' : '✗'} {t}
                  </span>
                ))}
              {tools && (!tools.rojo || !tools.selene || !tools.stylua) && <span className="small muted">Missing tools are skipped as checks (install with Rokit or Aftman).</span>}
            </div>
          </section>
          <section className="card">
            <h3>Agents</h3>
            <div className="grid-2">
              <Field label="Model">
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Field label="Daily spending limit for this game (USD)" hint="Empty = only the app-wide limit.">
                <input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" />
              </Field>
            </div>
            <Toggle checked={studio} onChange={setStudio} label="Roblox Studio tools" hint="Agents playtest in Studio. Keep Studio open with “Enable Studio as MCP server” on." />
          </section>
          <section className="card">
            <h3>Autopilot</h3>
            <p className="small muted">The Lead builds in sprints and checks in with you at the end of each one. You review what was built, answer its questions, and start the next sprint.</p>
            <div className="grid-2">
              <div className="field">
                <span className="field-label">Tasks per sprint</span>
                <div className="segmented" role="radiogroup" aria-label="Tasks per sprint">
                  {[3, 5, 8, 12].map((n) => (
                    <button key={n} role="radio" aria-checked={sprintTasks === n} className={`segment ${sprintTasks === n ? 'segment-on' : ''}`} onClick={() => setSprintTasks(n)}>
                      {n}
                    </button>
                  ))}
                </div>
                <span className="field-hint">Each task is one feature or fix on its own branch.</span>
              </div>
              <Field label="Budget per sprint (USD)" hint="The sprint ends early when it's reached.">
                <input value={sprintBudget} onChange={(e) => setSprintBudget(e.target.value)} inputMode="decimal" />
              </Field>
            </div>
            <Toggle
              checked={autoMerge}
              onChange={setAutoMerge}
              label="Merge approved work automatically"
              hint="When a task's checks pass and the reviewer agent approves, it's merged without waiting for you. Anything else waits in Reviews."
            />
          </section>
        </>
      )}

      {step === 2 && (
        <>
          <div className="summary-grid">
            <span className="muted">Game</span>
            <strong>{name}</strong>
            <span className="muted">Idea</span>
            <span className="clamp-3">{idea || '(from the attached document)'}</span>
            {doc && (
              <>
                <span className="muted">Document</span>
                <span>{doc.name}</span>
              </>
            )}
            <span className="muted">Folder</span>
            <code>{parentDir}</code>
            <span className="muted">Agents</span>
            <span>
              {model}, {daily ? `$${daily}/day` : 'no project limit'}
              {studio ? ', Studio tools on' : ''}
            </span>
            <span className="muted">Autopilot</span>
            <span>
              {sprintTasks} tasks or ${sprintBudget} per sprint, {autoMerge ? 'approved work merges automatically' : 'you merge everything'}
            </span>
          </div>
          <ol className="flow-steps">
            <li>The Lead reads your brief and writes the game overview, a roadmap with milestones, and acceptance criteria.</li>
            <li>Agents build the first playable slice, one reviewed task at a time.</li>
            <li>At the end of the sprint you get a check-in: what was built, how to try it, what's next and any questions.</li>
            <li>You give feedback and start the next sprint, until it's the game you want.</li>
          </ol>
          <Toggle
            checked={startNow}
            onChange={setStartNow}
            label="Start building right away"
            hint={hasKey ? 'Sprint 1 starts as soon as the project is created.' : 'Add your API key in Settings first; you can start from the project Overview later.'}
          />
        </>
      )}
    </Modal>
  )
}
