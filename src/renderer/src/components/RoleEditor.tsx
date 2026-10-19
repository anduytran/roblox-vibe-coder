import { useState } from 'react'
import type { Project, Role } from '@shared/types'
import { attempt, setRoles, toast } from '../store'
import { Button, Field, Modal } from './ui'

export function RoleEditor(props: { project: Project; role: Role; onClose: () => void; onSaved: (id: string) => void }) {
  const { project } = props
  const isNew = !props.role.id
  const [name, setName] = useState(props.role.name)
  const [description, setDescription] = useState(props.role.description)
  const [tools, setTools] = useState((props.role.tools ?? []).join(', '))
  const [model, setModel] = useState(props.role.model ?? '')
  const [prompt, setPrompt] = useState(props.role.prompt)

  const save = (): void => {
    void attempt(async () => {
      const role: Role = {
        id: props.role.id,
        name,
        description,
        prompt,
        tools: tools
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        model: model.trim() || undefined
      }
      const roles = await window.hangar.roles.save(project.id, role)
      setRoles(project.id, roles)
      const saved = roles.find((r) => r.name === name.trim()) ?? roles.find((r) => r.id === props.role.id)
      toast(isNew ? `Created ${name}.` : `Saved ${name}.`)
      if (saved) props.onSaved(saved.id)
      props.onClose()
    })
  }

  const remove = (): void => {
    if (!confirm(`Delete the ${props.role.name} role? Its file in .claude/agents will be removed.`)) return
    void attempt(async () => {
      setRoles(project.id, await window.hangar.roles.delete(project.id, props.role.id))
      props.onClose()
    })
  }

  return (
    <Modal
      title={isNew ? 'New role' : `Edit ${props.role.name}`}
      onClose={props.onClose}
      wide
      footer={
        <>
          {!isNew && (
            <Button tone="danger" onClick={remove}>
              Delete role
            </Button>
          )}
          <span className="spacer" />
          <Button tone="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!name.trim() || !prompt.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Level Designer" maxLength={60} />
        </Field>
        <Field label="Model (optional)" hint="Leave empty to use the project or app default.">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5-5" />
        </Field>
      </div>
      <Field label="Description" hint="One line: what this agent is for. The Lead agent uses it to decide when to delegate.">
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
      <Field label="Built-in tools allowed (optional)" hint="Comma-separated, e.g. Read, Glob, Grep. Empty = all tools. Roblox Studio tools are always offered.">
        <input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="Read, Glob, Grep, Edit, Write, Bash" />
      </Field>
      <Field label="Instructions">
        <textarea className="mono" rows={12} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <p className="muted small">Saved as .claude/agents/{props.role.id || '<name>'}.md in the project, the same format Claude Code uses.</p>
    </Modal>
  )
}
