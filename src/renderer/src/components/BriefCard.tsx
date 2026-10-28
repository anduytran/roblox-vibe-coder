import { useRef, useState } from 'react'
import type { Brief } from '@shared/types'
import { SafeText } from './SafeText'
import { timeAgo } from './ui'

/**
 * A short brief for checking in: what happened since you last looked, what's going on, and what needs you.
 * Only written when you ask (each one is a small model call); asking again with nothing new shows the same brief.
 */
export function BriefCard({ load, title, ask }: { load: (refresh: boolean) => Promise<Brief>; title: string; ask: string; watch?: string }) {
  const [brief, setBrief] = useState<Brief | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  const seq = useRef(0)
  const fetchBrief = (refresh: boolean): void => {
    const n = ++seq.current
    setBusy(true)
    setOpen(true)
    load(refresh)
      .then((b) => n === seq.current && setBrief(b))
      .catch((e: Error) => n === seq.current && setBrief((prev) => ({ ...(prev ?? { text: '', at: 0, since: 0, upTo: 0, status: '' }), error: e.message })))
      .finally(() => n === seq.current && setBusy(false))
  }

  // Nothing asked for yet: just the button.
  if (!brief && !busy) {
    return (
      <div className="brief-ask">
        <button className="link small" onClick={() => fetchBrief(false)}>
          {ask}
        </button>
      </div>
    )
  }

  return (
    <section className="card brief-card" aria-busy={busy}>
      <div className="row between">
        <button className="link brief-title" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {title}
          {brief?.at ? <span className="muted small"> · since {timeAgo(brief.since)}</span> : null}
        </button>
        <button className="link small" disabled={busy} onClick={() => fetchBrief(true)}>
          {busy ? 'Writing…' : 'Refresh'}
        </button>
      </div>
      {open && (
        <>
          {brief?.text ? <SafeText className="summary brief-text" text={brief.text} /> : !busy && !brief?.error ? <p className="small muted">Nothing to report yet.</p> : null}
          {busy && !brief?.text && <p className="small muted">Catching up on what happened…</p>}
          {brief?.error && <p className="small warn">Couldn't write a new brief: {brief.error}</p>}
        </>
      )}
    </section>
  )
}
