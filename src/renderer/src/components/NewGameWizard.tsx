import { ModelSelect } from './ModelSelect'
import { DEFAULT_MODEL } from '@shared/models'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NewGameInput } from '@shared/types'
import { checksFor, suggestGameName } from '@shared/newGame'
import { addCreatedProject, attempt, closeWizard, setAutopilot, toast, useStore } from '../store'
import { Button, Field, Icon, Modal, Toggle } from './ui'

const PLATFORMS: { id: NewGameInput['platforms'][number]; label: string }[] = [
  { id: 'phone', label: 'Phone & tablet' },
  { id: 'pc', label: 'PC' },
  { id: 'console', label: 'Console' },
  { id: 'vr', label: 'VR' }
]

type Tools = Awaited<ReturnType<typeof window.hangar.system.tools>>

/** The last two folders of a path, which is all the summary needs: ".../Documents/Hangar Games". */
const shortPath = (p: string): string => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}

/**
 * "New game" on one screen: the idea and a name. Everything else has a default, summed up in one line
 * and folded away under "Setup" for anyone who wants to change it.
 */
export function NewGameWizard() {
  const prefill = useStore((s) => s.wizard) ?? {}
  const settings = useStore((s) => s.settings)
  const hasKey = useStore((s) => s.key.ready)
  const [idea, setIdea] = useState(prefill.idea ?? '')
  const [doc, setDoc] = useState<{ name: string; text: string } | null>(null)
  // Until the user types a name, it follows the idea (or the attached document's title).
  const [typedName, setTypedName] = useState<string | null>(prefill.name ?? null)
  const name = typedName ?? suggestGameName(idea, doc)
  const [genre, setGenre] = useState(prefill.genre ?? '')
  const [platforms, setPlatforms] = useState<NewGameInput['platforms']>(['phone', 'pc'])
  const [notes, setNotes] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [model, setModel] = useState(settings?.defaultModel ?? DEFAULT_MODEL)
  const [daily, setDaily] = useState('15')
  const [studio, setStudio] = useState(true)
  const [sprintTasks, setSprintTasks] = useState(0)
  const [sprintBudget, setSprintBudget] = useState('10')
  const [autoMerge, setAutoMerge] = useState(true)
  const [startNow, setStartNow] = useState(true)
  const [tools, setTools] = useState<Tools | null>(null)
  const [busy, setBusy] = useState(false)

  const checkTools = useCallback(() => {
    void attempt(() => window.hangar.system.tools()).then((t) => {
      if (!t) return
      setTools(t)
      setParentDir((d) => d || t.defaultParent)
    })
  }, [])
  useEffect(() => {
    checkTools()
  }, [checkTools])
  // When it opens, the cursor goes in the idea after any prefilled text ("What it's about: " from a trending game).
  const ideaBox = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const box = ideaBox.current
    if (!box || prefill.name) return
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const noGit = tools !== null && !tools.git
  const ready = name.trim().length > 0 && (idea.trim().length > 0 || doc !== null) && parentDir.length > 0 && !noGit
  const checks = tools ? checksFor(tools) : null
  const willStart = startNow && hasKey

  const create = (): void => {
    if (!ready || busy) return
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

  const platformText = PLATFORMS.filter((p) => platforms.includes(p.id))
    .map((p) => p.label)
    .join(', ')
  const setupLine = [
    platformText || 'No platforms picked',
    model,
    daily.trim() ? `$${daily.trim()} a day` : 'no daily limit for this game',
    sprintTasks ? `${sprintTasks} tasks per sprint` : 'the Lead decides when a sprint is done',
    autoMerge ? 'approved work merges itself' : 'you merge everything'
  ].join(' · ')

  return (
    <Modal
      title="New game"
      wide
      onClose={closeWizard}
      footer={
        <>
          <span className="small muted wizard-next">
            {willStart
              ? 'The Lead reads your idea, writes a design and a roadmap, and starts building. It checks in with you after each sprint.'
              : hasKey
                ? 'The project is set up and waits for you to start autopilot from its Overview.'
                : 'Sign in (Settings → Account) to start building. You can create the project now and start it later.'}
          </span>
          <span className="spacer" />
          <Button tone="primary" disabled={!ready || busy} onClick={create}>
            {busy ? 'Creating…' : willStart ? 'Create and start building' : 'Create project'}
          </Button>
        </>
      }
    >
      <Field label="Your game idea" hint="What the player does, what makes it fun, what it should feel like. A few sentences is enough.">
        <textarea
          ref={ideaBox}
          rows={7}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="Sky Courier: players glide between floating islands, delivering parcels before storms roll in. Upgrade your glider, unlock new islands, team up for big deliveries…"
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
          <Button size="sm" tone="ghost" onClick={() => void attempt(async () => setDoc(await window.hangar.projects.readDocument()))}>
            <Icon name="plus" />
            Or attach a design document
          </Button>
        )}
        <span className="muted small">Markdown or plain text, up to 300 KB.</span>
      </div>
      <Field label="Name" hint={typedName === null && name ? 'Taken from your idea. Change it if you like.' : undefined}>
        <input value={name} onChange={(e) => setTypedName(e.target.value)} placeholder="Sky Courier" maxLength={80} />
      </Field>

      {noGit && (
        <div className="callout callout-amber row gap-sm" role="alert">
          <span>Git isn't installed. Hangar needs it to save a first version of the game and keep each task on its own branch.</span>
          <span className="spacer" />
          <Button size="sm" onClick={checkTools}>
            Check again
          </Button>
        </div>
      )}

      <details className="wizard-setup">
        <summary>
          <span className="wizard-setup-title">Setup</span>
          <span className="small muted wizard-setup-line">{setupLine}</span>
          <span className="small wizard-setup-change">Change</span>
        </summary>

        <section className="wizard-group">
          <h3>About the game</h3>
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
        </section>

        <section className="wizard-group">
          <h3>Project</h3>
          <Field label="Folder" hint="Hangar makes a new folder for the game in here.">
            <div className="row gap-xs">
              <input value={parentDir} readOnly className="mono" />
              <Button onClick={() => void attempt(async () => setParentDir((await window.hangar.projects.pickFolder()) ?? parentDir))}>Change…</Button>
            </div>
          </Field>
          <p className="small muted">
            It holds a Rojo project with a code layout, lint and format settings, conventions for the agents, the starter roles (Lead, Scripter, UI Builder, QA Tester,
            Researcher), a game design vault with your idea in it, and a first git commit.
          </p>
          {checks && (
            <p className="small muted">
              Checks before anything is merged: {checks.on.length ? checks.on.join(', ') : 'none'}.
              {checks.missing.length > 0 && ` Not installed, so skipped: ${checks.missing.join(', ')} (install with Rokit or Aftman).`}
            </p>
          )}
          <div className="grid-2">
            <Field label="Model">
              <ModelSelect value={model} onChange={setModel} />
            </Field>
            <Field label="Daily spending limit for this game (USD)" hint="Empty = only the app-wide limit.">
              <input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" />
            </Field>
          </div>
          <Toggle checked={studio} onChange={setStudio} label="Roblox Studio tools" hint="Agents playtest in Studio. Keep Studio open with “Enable Studio as MCP server” on." />
        </section>

        <section className="wizard-group">
          <h3>Autopilot</h3>
          <p className="small muted">The Lead builds in sprints and checks in with you at the end of each one. You can change these before any sprint on the game's Overview.</p>
          <div className="grid-2">
            <div className="field">
              <span className="field-label">Sprint length</span>
              <div className="segmented" role="radiogroup" aria-label="Sprint length">
                {[0, 3, 5, 8, 12].map((n) => (
                  <button key={n} role="radio" aria-checked={sprintTasks === n} className={`segment ${sprintTasks === n ? 'segment-on' : ''}`} onClick={() => setSprintTasks(n)}>
                    {n === 0 ? 'Lead decides' : n}
                  </button>
                ))}
              </div>
              <span className="field-hint">{sprintTasks === 0 ? 'The Lead checks in when the sprint\'s plan is done (or the budget runs out).' : 'Each task is one feature or fix on its own branch.'}</span>
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
          <Toggle
            checked={startNow}
            onChange={setStartNow}
            label="Start building right away"
            hint={hasKey ? 'Sprint 1 starts as soon as the project is created.' : 'Sign in first; you can start from the project Overview later.'}
          />
        </section>
      </details>
    </Modal>
  )
}
