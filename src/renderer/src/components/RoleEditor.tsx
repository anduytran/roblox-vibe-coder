import { useState } from 'react'
import type { Project, Role } from '@shared/types'
import { confirmDialog, attempt, replaceProject, setRoles, toast } from '../store'
import { AgentSettingsFields, agentFormState, agentSettingsFrom } from './AgentSettingsFields'
import { Button, Field, Modal } from './ui'
import { ModelSelect } from './ModelSelect'

export function RoleEditor(props: { project: Project; role: Role; onClose: () => void; onSaved: (id: string) => void }) {
  const { project } = props
  const isNew = !props.role.id
  const [name, setName] = useState(props.role.name)
  const [description, setDescription] = useState(props.role.description)
  const [agent, setAgent] = useState(() => agentFormState(props.role))
  const [blender, setBlender] = useState(props.role.mcp?.includes('blender') ?? false)
  const [model, setModel] = useState(props.role.model ?? '')
  const [prompt, setPrompt] = useState(props.role.prompt)
  const [vault, setVault] = useState(props.role.vault ?? '')
  const [vaultKind, setVaultKind] = useState<'ui' | 'design'>(props.role.vaultKind ?? 'ui')
  const [mode, setMode] = useState<'normal' | 'research'>(props.role.mode === 'research' ? 'research' : 'normal')
  const research = mode === 'research'

  const save = (): void => {
    void attempt(async () => {
      const role: Role = {
        id: props.role.id,
        name,
        description,
        prompt,
        ...(research ? {} : agentSettingsFrom(agent)),
        mcp: !research && blender ? ['blender'] : undefined,
        model: model.trim() || undefined,
        vault: research ? undefined : vault.trim() || undefined,
        vaultKind: !research && vault.trim() && vaultKind === 'design' ? 'design' : undefined,
        mode: research ? 'research' : undefined
      }
      const roles = await window.hangar.roles.save(project.id, role)
      setRoles(project.id, roles)
      const saved = roles.find((r) => r.name === name.trim()) ?? roles.find((r) => r.id === props.role.id)
      toast(isNew ? `Created ${name}.` : `Saved ${name}.`)
      if (saved) props.onSaved(saved.id)
      props.onClose()
    })
  }

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({ title: `Delete the ${props.role.name} role?`, body: 'Its file in .claude/agents is removed, and anything it is working on now stops.', confirmLabel: 'Delete role', tone: 'danger' })
    if (!ok) return
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
            <Button tone="danger" onClick={() => void remove()}>
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
        <Field label="Model">
          <ModelSelect value={model} onChange={setModel} inheritLabel="Same as the project" />
        </Field>
      </div>
      <Field label="Description" hint="One line: what this agent is for. The Lead agent uses it to decide when to delegate.">
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
      <Field
        label="Kind"
        hint={
          research
            ? 'Only web search and reading public web pages. No project files, commands, Studio or subagents, and no other agent can call it. Its reports wait in Reviews until you approve them into research/.'
            : 'Works in the project with the tools below.'
        }
      >
        <select value={mode} onChange={(e) => setMode(e.target.value as 'normal' | 'research')}>
          <option value="normal">Project agent</option>
          <option value="research">Web researcher (findings reviewed by you)</option>
        </select>
      </Field>
      {!research && (
        <>
          <AgentSettingsFields agentId={props.role.id} value={agent} onChange={setAgent} blender={{ on: blender, onChange: setBlender }} />
          <div className="grid-2">
            <Field label="Obsidian vault folder (optional)" hint="A notes folder inside the project this role reads first and keeps updated. Created from templates on first use.">
              <input value={vault} onChange={(e) => setVault(e.target.value)} placeholder="ui-vault" />
            </Field>
            <Field label="Vault templates" hint="UI: style guide, screens, components. Game design: overview, mechanics with acceptance criteria, balance, roadmap.">
              <select value={vaultKind} disabled={!vault.trim()} onChange={(e) => setVaultKind(e.target.value as 'ui' | 'design')}>
                <option value="ui">UI</option>
                <option value="design">Game design</option>
              </select>
            </Field>
          </div>
        </>
      )}
      <Field label="Instructions">
        <textarea className="mono" rows={12} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <p className="muted small">Saved as .claude/agents/{props.role.id || '<name>'}.md in the project, the same format Claude Code uses.</p>
    </Modal>
  )
}

/** The Main agent has no role file: its settings live with the project's settings. Its model is the project's. */
export function MainAgentEditor(props: { project: Project; onClose: () => void }) {
  const { project } = props
  const main = project.settings.mainAgent ?? {}
  const [prompt, setPrompt] = useState(main.prompt ?? '')
  const [agent, setAgent] = useState(() => agentFormState(main))

  const save = (): void => {
    void attempt(async () => {
      const mainAgent = { ...agentSettingsFrom(agent), prompt: prompt.trim() || undefined }
      replaceProject(await window.hangar.projects.update(project.id, { settings: { mainAgent } }))
      toast('Saved the Main agent.')
      props.onClose()
    })
  }

  return (
    <Modal
      title="Main agent settings"
      onClose={props.onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <Button tone="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button tone="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <p className="muted small">The general-purpose agent. It uses the project's model (Project → General → Model) and can hand work to every role.</p>
      <AgentSettingsFields agentId="main" value={agent} onChange={setAgent} />
      <Field label="Extra instructions (optional)" hint="Added to what it already knows: the project's CLAUDE.md and Hangar's rules.">
        <textarea className="mono" rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
    </Modal>
  )
}
