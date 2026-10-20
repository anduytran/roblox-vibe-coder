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
  ariaLabel?: string
}) {
  const { tone = 'default', size = 'md' } = props
  return (
    <button
      type={props.type ?? 'button'}
      aria-label={props.ariaLabel}
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

const ICONS: Record<string, string> = {
  plus: 'M8 3.5v9M3.5 8h9',
  gear: 'M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Zm5.3 3.2.9.7-1.2 2.1-1.1-.4a4.8 4.8 0 0 1-1.3.8L10.4 13H7.6l-.2-1.1a4.8 4.8 0 0 1-1.3-.8l-1.1.4-1.2-2.1.9-.7a4.9 4.9 0 0 1 0-1.6l-.9-.7 1.2-2.1 1.1.4a4.8 4.8 0 0 1 1.3-.8L7.6 3h2.8l.2 1.1c.5.2.9.5 1.3.8l1.1-.4 1.2 2.1-.9.7a4.9 4.9 0 0 1 0 1.6Z',
  stop: 'M5 5h6v6H5z',
  agents: 'M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm5.5 0a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 11 7ZM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13m1-3.4c1.9-.4 4 .9 4 3.4',
  review: 'M3 4.5h10M3 8h6M3 11.5h4m4.5-1 1.5 1.5 2.5-3',
  changes: 'M5 3v6.5M5 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm6-6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 0c0 3-6 2-6 4',
  sliders: 'M3 5h6m3 0h1M3 11h1m3 0h6M10.5 3.5v3M5.5 9.5v3',
  globe: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Zm0 0c1.5-1.5 2.2-3.5 2.2-5.5S9.5 4 8 2.5m0 11C6.5 12 5.8 10 5.8 8S6.5 4 8 2.5M2.7 6.2h10.6M2.7 9.8h10.6',
  sun: 'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 1.8v1.4m0 9.6v1.4M1.8 8h1.4m9.6 0h1.4M3.6 3.6l1 1m6.8 6.8 1 1m0-8.8-1 1m-6.8 6.8-1 1',
  moon: 'M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6Z',
  monitor: 'M2.5 3.5h11v7h-11zM6 13h4m-2-2.5V13'
}

/** Small line icons drawn at 16px on a 16-unit grid; they inherit the text colour. */
export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name] ?? ''} />
    </svg>
  )
}

/** A project's square avatar: its initial on a hue derived from the name, so each project is recognisable at a glance. */
export function Avatar({ name }: { name: string }) {
  // Blues through magentas only, so an avatar is never mistaken for a status colour (green, amber, red).
  const HUES = [200, 218, 236, 254, 272, 290, 308, 326]
  let n = 0
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span className="avatar" style={{ ['--hue' as string]: String(HUES[n % HUES.length]) }} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
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
