import { useEffect, useRef, type ReactNode } from 'react'
import type { AgentStatus, PlanUsage } from '@shared/types'

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  tone?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
  ariaLabel?: string
  autoFocus?: boolean
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
      autoFocus={props.autoFocus}
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

/** Open dialogs, innermost last: only the top one answers Esc (a confirm over the role editor closes alone). */
const openModals: number[] = []
let modalSeq = 0

/**
 * Esc closes this dialog or panel, but only if it's the topmost one open (dialogs and side panels share
 * the stack). Pass `active: false` while it isn't showing.
 */
export function useEscape(onClose: () => void, active = true): void {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!active) return
    const id = ++modalSeq
    openModals.push(id)
    const onKey = (e: KeyboardEvent): void => {
      // Esc that cancels an IME conversion belongs to the IME.
      if (e.key === 'Escape' && !e.isComposing && openModals[openModals.length - 1] === id) {
        e.stopPropagation()
        latest.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const at = openModals.indexOf(id)
      if (at >= 0) openModals.splice(at, 1)
    }
  }, [active])
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(props.onClose)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
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
  monitor: 'M2.5 3.5h11v7h-11zM6 13h4m-2-2.5V13',
  home: 'M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V10h2v3h3V6.5',
  folder: 'M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z',
  key: 'M5.5 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm2.3-1.9 5.7 0M11 8.6v2M13.5 8.6v1.5',
  gauge: 'M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l2.5-3.5M8 11.5h0',
  cube: 'M8 2.5 13 5v6l-5 2.5L3 11V5l5-2.5Zm0 0M3 5l5 2.5L13 5M8 7.5v6',
  phone: 'M5 2h6v12H5zM7.3 12h1.4',
  shield: 'M8 2 13 4v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4l5-2Zm-2 6 1.5 1.5L10.5 6.5',
  bulb: 'M6 12.5h4M6.5 14h3M8 2a4 4 0 0 0-2.3 7.3c.4.3.8.9.8 1.4v.3h3v-.3c0-.5.4-1.1.8-1.4A4 4 0 0 0 8 2Z',
  bell: 'M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1H3l1-1ZM6.5 14h3',
  book: 'M3 3.5h4a1 1 0 0 1 1 1v9a1 1 0 0 0-1-1H3zM13 3.5H9a1 1 0 0 0-1 1v9a1 1 0 0 1 1-1h4z'
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

/** "resets in 2h 10m", or "resets Fri 9:00 AM" when it's more than a day away. */
export function resetsText(ts: number | null): string {
  if (ts === null) return ''
  const ms = ts - Date.now()
  if (ms <= 0) return 'resetting now'
  if (ms > 24 * 3600 * 1000) return `resets ${new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  return `resets in ${h ? `${h}h ` : ''}${m}m`
}

/** Short Claude plan usage line: "5-hour 34% · week 12%". */
export function planLine(plan: PlanUsage | null): string {
  if (!plan || (!plan.fiveHour && !plan.weekly)) return 'Claude plan usage shows after the first run'
  if (plan.blocked) return `Claude plan ${plan.blocked.window} limit reached`
  return [plan.fiveHour && `5-hour ${plan.fiveHour.usedPct}%`, plan.weekly && `week ${plan.weekly.usedPct}%`].filter(Boolean).join(' · ')
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

/** Placeholder bars while something loads. */
export function Skeleton({ lines = 3, label = 'Loading…' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-bar" style={{ width: `${[92, 76, 84, 60, 70][i % 5]}%` }} />
      ))}
    </div>
  )
}
