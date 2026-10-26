import { MODELS, isKnownModel, modelLabel } from '@shared/models'

/**
 * Pick a Claude model from the list Hangar knows. `inheritLabel` adds a first choice for "use the default" (value '').
 * A saved name that isn't in the list (typed by hand, or a newer model) stays visible so it can be replaced.
 */
export function ModelSelect(props: { value: string; onChange: (id: string) => void; inheritLabel?: string; id?: string; disabled?: boolean }) {
  const { value, inheritLabel } = props
  const unknown = !!value && !isKnownModel(value)
  return (
    <select id={props.id} value={value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
      {inheritLabel !== undefined && <option value="">{inheritLabel}</option>}
      {unknown && <option value={value}>{value} (not in Hangar's list: pick another if it fails)</option>}
      {MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {modelLabel(m.id)}
        </option>
      ))}
    </select>
  )
}
