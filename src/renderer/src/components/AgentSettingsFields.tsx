import type { AgentEffort, AgentSettings } from '@shared/types'
import { autoContextTokens, EFFORTS, groupsFromTools, TOOL_GROUPS, toolsFromGroups, type ToolGroup } from '@shared/agentConfig'
import { useStore } from '../store'
import { Field, Toggle } from './ui'

/** Form state for the settings every agent has (tools, connections, effort, budget, knowledge). */
export interface AgentFormState {
  groups: Set<ToolGroup>
  studio: boolean
  effort: AgentEffort | ''
  budget: string
  knowledge: string
  /** 0 = Auto (sized for the role). */
  context: number
}

export function agentFormState(a: AgentSettings): AgentFormState {
  return { groups: groupsFromTools(a.tools), studio: a.studio !== false, effort: a.effort ?? '', budget: a.budgetUsd ? String(a.budgetUsd) : '', knowledge: a.knowledge ?? '', context: a.contextTokens ?? 0 }
}

/** What to save. Defaults are left out, so the role file only lists what was changed. */
export function agentSettingsFrom(f: AgentFormState): AgentSettings {
  const budget = parseFloat(f.budget)
  return {
    tools: toolsFromGroups(f.groups),
    effort: f.effort || undefined,
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    studio: f.studio ? undefined : false,
    knowledge: f.knowledge.trim() || undefined,
    contextTokens: f.context || undefined
  }
}

export function AgentSettingsFields(props: {
  agentId: string
  value: AgentFormState
  onChange: (v: AgentFormState) => void
  /** Roles can use Blender; the Main agent can't. */
  blender?: { on: boolean; onChange: (v: boolean) => void }
}) {
  const { value: f, onChange } = props
  const perRun = useStore((s) => s.settings?.perRunBudgetUsd)
  // On a Claude Max plan, usage limits decide, not dollars.
  const onPlan = useStore((s) => s.settings?.authMode === 'max')
  const set = (patch: Partial<AgentFormState>): void => onChange({ ...f, ...patch })
  const toggleGroup = (g: ToolGroup, on: boolean): void => {
    const groups = new Set(f.groups)
    if (on) groups.add(g)
    else groups.delete(g)
    set({ groups })
  }
  return (
    <>
      <div className="field">
        <span className="field-label">What it can do</span>
        <div className="check-grid">
          <label className="check-row">
            <input type="checkbox" checked disabled />
            <span>
              Read and search files <span className="muted small">Always on</span>
            </span>
          </label>
          {TOOL_GROUPS.map((g) => (
            <label key={g.id} className="check-row">
              <input type="checkbox" checked={f.groups.has(g.id)} onChange={(e) => toggleGroup(g.id, e.target.checked)} />
              <span>
                {g.label} <span className="muted small">{g.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <Toggle checked={f.studio} onChange={(v) => set({ studio: v })} label="Roblox Studio" hint="Playtest and inspect the game in Studio, when the project has Studio tools on." />
        {props.blender && <Toggle checked={props.blender.on} onChange={props.blender.onChange} label="Blender" hint="Model 3D meshes. Needs the Blender connection in Settings → Roblox." />}
      </div>
      <div className="grid-2">
        <Field label="Effort" hint="How hard it thinks before acting. Thinking counts as output, the costliest kind of token: higher is slower and uses more of the plan.">
          <select value={f.effort} onChange={(e) => set({ effort: e.target.value as AgentEffort | '' })}>
            <option value="">Auto (medium; Haiku keeps its usual)</option>
            {EFFORTS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </Field>
        {onPlan ? (
          <div className="field">
            <span className="field-label">Spending limit per task</span>
            <span className="small muted">None on your Max plan: work pauses at the plan's usage limits instead.</span>
          </div>
        ) : (
          <Field label="Spending limit per task (USD)" hint={`Empty = the app's limit${perRun ? ` ($${perRun})` : ''}. Up to $20.`}>
            <input value={f.budget} onChange={(e) => set({ budget: e.target.value })} inputMode="decimal" placeholder={perRun ? String(perRun) : ''} />
          </Field>
        )}
      </div>
      <Field
        label="Context size"
        hint="How much of the conversation it keeps word for word. Past this, the engine summarizes the older part, so each step stays quick and light on usage. Auto is sized for the role."
      >
        <select value={f.context} onChange={(e) => set({ context: Number(e.target.value) })}>
          <option value={0}>Auto ({Math.round(autoContextTokens(props.agentId || 'x') / 1000)}k for this role)</option>
          {[...new Set([100, 150, 200, 300, 500, 1000, ...(f.context ? [Math.round(f.context / 1000)] : [])])].sort((a, b) => a - b).map((k) => (
            <option key={k} value={k * 1000}>
              {k === 1000 ? '1M' : `${k}k`}
              {k >= 500 ? ' (uses a lot of the plan on long runs)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Knowledge folder" hint="Its own notes inside the project. It searches them before working and adds what it learns. Plain Markdown, reviewed in git like code.">
        <input value={f.knowledge} onChange={(e) => set({ knowledge: e.target.value })} placeholder={`knowledge/${props.agentId || '<name>'}`} />
      </Field>
    </>
  )
}
