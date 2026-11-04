import { useEffect, useState } from 'react'
import type { SkillInfo, SkillView } from '@shared/types'
import { attempt, toast } from '../store'
import { Button, Field } from './ui'

/**
 * Which of the project's Claude skills (.claude/skills) this agent may use, plus adding, importing and reading them.
 * Names, descriptions and instructions arrive cleaned of hidden characters; they're shown as plain text.
 */
export function SkillsField(props: { projectId: string; value: string[]; onChange: (v: string[]) => void }) {
  const { projectId, value } = props
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [open, setOpen] = useState<SkillView | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', description: '', body: '' })

  useEffect(() => {
    let live = true
    void attempt(async () => {
      const list = await window.hangar.skills.list(projectId)
      if (live) setSkills(list)
    })
    return () => {
      live = false
    }
  }, [projectId])

  const toggle = (id: string, on: boolean): void => props.onChange(on ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id))
  const view = (id: string): void => {
    if (open?.id === id) return setOpen(null)
    void attempt(async () => setOpen(await window.hangar.skills.view(projectId, id)))
  }
  const importFolder = (): void => {
    void attempt(async () => {
      const list = await window.hangar.skills.import(projectId)
      if (!list) return
      const added = list.find((s) => !skills?.some((o) => o.id === s.id))
      setSkills(list)
      if (added) {
        toggle(added.id, true)
        toast(`Added the ${added.name} skill. Read it before saving.`)
      }
    })
  }
  const create = (): void => {
    void attempt(async () => {
      const list = await window.hangar.skills.create(projectId, draft)
      const added = list.find((s) => !skills?.some((o) => o.id === s.id))
      setSkills(list)
      if (added) toggle(added.id, true)
      setDraft({ name: '', description: '', body: '' })
      setAdding(false)
    })
  }
  // Turned on before but no longer in the project: still listed so it can be turned off.
  const missing = value.filter((id) => skills && !skills.some((s) => s.id === id))

  return (
    <div className="field">
      <span className="field-label">Skills</span>
      <span className="small muted">
        Instructions it can load when a task needs them, from the project's .claude/skills folder. A skill is guidance only: it never gives the agent more tools, and
        agents' edits to skills always ask in red. Skills from your own ~/.claude are only used once you import a copy here.
      </span>
      {skills === null ? (
        <span className="small muted">Loading…</span>
      ) : (
        <div className="skill-list">
          {skills.length === 0 && <span className="small muted">No skills in this project yet.</span>}
          {skills.map((s) => (
            <div key={s.id} className="skill-row">
              <label className="check-row">
                <input type="checkbox" checked={value.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                <span>
                  {s.name} <span className="muted small">{s.description}</span>
                  {s.problem && <span className="skill-problem small">{s.problem}</span>}
                </span>
              </label>
              <Button size="sm" tone="ghost" onClick={() => view(s.id)}>
                {open?.id === s.id ? 'Hide' : 'View'}
              </Button>
              {open?.id === s.id && (
                <div className="skill-view">
                  <pre className="skill-body mono">{open.body || '(no instructions)'}</pre>
                  {open.files.length > 0 && (
                    <span className="small muted">
                      Other files in .claude/skills/{open.id}/: {open.files.slice(0, 20).join(', ')}
                      {open.files.length > 20 ? ` and ${open.files.length - 20} more` : ''}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
          {missing.map((id) => (
            <label key={id} className="check-row">
              <input type="checkbox" checked onChange={() => toggle(id, false)} />
              <span>
                {id} <span className="skill-problem small">Not in .claude/skills any more; it won't load.</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="skill-actions">
        <Button size="sm" onClick={importFolder}>
          Import a skill folder…
        </Button>
        <Button size="sm" tone="ghost" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel new skill' : 'New skill'}
        </Button>
      </div>
      {adding && (
        <div className="skill-new">
          <div className="grid-2">
            <Field label="Name" hint="Becomes the folder name, like level-design.">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={64} />
            </Field>
            <Field label="When to use it" hint="One line. Agents read this to decide when the skill applies.">
              <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={1024} />
            </Field>
          </div>
          <Field label="Instructions">
            <textarea className="mono" rows={8} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </Field>
          <div className="skill-actions">
            <Button size="sm" tone="primary" disabled={!draft.name.trim() || !draft.description.trim() || !draft.body.trim()} onClick={create}>
              Add skill
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
