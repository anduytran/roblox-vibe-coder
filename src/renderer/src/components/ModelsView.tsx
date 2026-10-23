import { useCallback, useEffect, useState } from 'react'
import type { ModelFile, ModelRequest, Project } from '@shared/types'
import { attempt, setRoles, toast, useStore } from '../store'
import { AgentPanel } from './AgentsView'
import { Button, Field, timeAgo } from './ui'

const METHODS: { id: ModelRequest['method']; label: string; hint: string }[] = [
  { id: 'studio', label: 'Studio (parts)', hint: 'Built from parts in Roblox Studio. Needs Studio open. Saved as a builder script in git.' },
  { id: 'blender', label: 'Blender (mesh)', hint: 'A real 3D mesh made in Blender and exported as FBX with a preview. Needs Blender and its connection set up.' }
]

/** Make 3D models with a modeler agent (Studio or Blender) and browse the ones in the project. */
export function ModelsView({ project }: { project: Project }) {
  const settings = useStore((s) => s.settings)
  const roles = useStore((s) => s.roles[project.id])
  const agents = useStore((s) => s.agents[project.id])
  const [method, setMethod] = useState<ModelRequest['method']>('studio')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [style, setStyle] = useState<ModelRequest['style']>('low-poly')
  const [size, setSize] = useState<ModelRequest['size']>('prop')
  const [models, setModels] = useState<ModelFile[]>([])

  const roleId = method === 'studio' ? 'studio-modeler' : 'blender-modeler'
  const role = roles?.find((r) => r.id === roleId)
  const state = agents?.[roleId]
  const busy = state?.status === 'working' || state?.status === 'queued' || state?.status === 'awaiting_approval'
  const blenderReady = !!settings?.blenderMcpCommand?.trim()

  const reload = useCallback(() => void attempt(async () => setModels(await window.hangar.models.list(project.id))), [project.id])
  useEffect(reload, [reload])
  // A modeler finishing usually means a new file: look again.
  useEffect(() => {
    if (state?.status === 'idle') reload()
  }, [state?.status, reload])

  const make = (): void => {
    void attempt(async () => {
      await window.hangar.models.make(project.id, { method, name, description, style, size })
      setRoles(project.id, await window.hangar.roles.list(project.id))
      toast(method === 'studio' ? 'The Studio modeler is on it. Keep Studio open.' : 'The Blender modeler is on it. Keep Blender open.')
      setDescription('')
      setName('')
    })
  }

  return (
    <div className="models">
      <section className="models-form card">
        <h3>New 3D model</h3>
        <div className="segmented" role="radiogroup" aria-label="How to model it">
          {METHODS.map((m) => (
            <button key={m.id} role="radio" aria-checked={method === m.id} className={`segment ${method === m.id ? 'segment-on' : ''}`} onClick={() => setMethod(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="small muted">{METHODS.find((m) => m.id === method)!.hint}</p>
        {method === 'blender' && !blenderReady && (
          <p className="small warn">
            Set up the Blender connection first: Settings → Roblox → Blender. Every Blender step will ask you first, because it runs code on your computer.
          </p>
        )}
        <Field label="What should it look like?">
          <textarea rows={3} value={description} placeholder="e.g. a wooden treasure chest with iron bands and a glowing gem lock" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Name (optional)">
            <input value={name} placeholder="TreasureChest" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Style">
            <select value={style} onChange={(e) => setStyle(e.target.value as ModelRequest['style'])}>
              <option value="low-poly">Low-poly</option>
              <option value="blocky">Blocky</option>
              <option value="stylized">Stylized</option>
              <option value="detailed">Detailed</option>
            </select>
          </Field>
          <Field label="Size">
            <select value={size} onChange={(e) => setSize(e.target.value as ModelRequest['size'])}>
              <option value="prop">Prop (a few studs)</option>
              <option value="character">Character-sized</option>
              <option value="vehicle">Vehicle</option>
              <option value="building">Building</option>
            </select>
          </Field>
        </div>
        <div className="row between">
          <span className="small muted">{busy ? 'The modeler is working; follow it below.' : 'Changes to your game files go through Reviews like any task.'}</span>
          <Button tone="primary" disabled={busy || !description.trim() || (method === 'blender' && !blenderReady)} onClick={make}>
            Make model
          </Button>
        </div>
      </section>

      <section className="models-list">
        <div className="row between">
          <h3>Models in this project</h3>
          <div className="row gap-xs">
            <Button size="sm" tone="ghost" onClick={reload}>
              Refresh
            </Button>
            <Button size="sm" tone="ghost" onClick={() => void attempt(() => window.hangar.models.reveal(project.id))}>
              Open folder
            </Button>
          </div>
        </div>
        {models.length === 0 ? (
          <p className="small muted">No models yet. Studio models are saved in src/shared/Models; Blender meshes in assets/models.</p>
        ) : (
          <div className="model-grid">
            {models.map((m) => (
              <button key={m.file} className="model-card" title={`Show ${m.file}`} onClick={() => void attempt(() => window.hangar.models.reveal(project.id, m.file))}>
                {m.preview ? <img src={m.preview} alt={`Preview of ${m.name}`} /> : <span className="model-ph">{m.kind === 'builder' ? 'Luau' : '3D'}</span>}
                <strong>{m.name}</strong>
                <span className="small muted">
                  {m.kind === 'builder' ? 'Studio builder' : m.file.split('.').pop()?.toUpperCase()} · {timeAgo(m.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {role && (
        <section className="models-agent">
          <AgentPanel project={project} role={role} state={state} />
        </section>
      )}
    </div>
  )
}
