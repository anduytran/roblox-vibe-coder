import { useEffect, type ReactNode } from 'react'
import type { AgentStatus } from '@shared/types'

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  tone?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}) {
  const { tone = 'default', size = 'md' } = props
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn btn-${tone} btn-${size}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      <span className="toggle-text">
        <span className="toggle-label">{props.label}</span>
        {props.hint && <span className="toggle-hint">{props.hint}</span>}
      </span>
    </label>
  )
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Idle',
  queued: 'Queued',
  working: 'Working',
  awaiting_approval: 'Needs approval',
  error: 'Error',
  stopped: 'Stopped'
}

export function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`pill pill-${status}`}>
      <span className="pill-dot" />
      {STATUS_LABEL[status]}
    </span>
  )
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'modal-wide' : ''}`} role="dialog" aria-label={props.title}>
        <header className="modal-head">
          <h2>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer className="modal-foot">{props.footer}</footer>}
      </div>
    </div>
  )
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  )
}

export function usd(n: number | undefined): string {
  const v = n ?? 0
  return v < 0.01 && v > 0 ? '<$0.01' : `$${v.toFixed(2)}`
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}
