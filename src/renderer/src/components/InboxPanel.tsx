import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { openProjectAt, refreshProjects, setInboxOpen, useStore } from '../store'
import { ApprovalCard } from './ApprovalCard'
import { EmptyState } from './EmptyState'
import { ReviewBadges } from './ReviewsView'
import { Avatar, Button, timeAgo, useEscape } from './ui'
import { firstLine, useWaiting } from './waiting'
import { revealHidden } from '@shared/text'

interface Item {
  kind: 'approval' | 'review' | 'checkin'
  at: number
  key: string
  node: ReactNode
}

/** Everything waiting for you, across games: approvals (oldest first), then reviews and check-ins (newest first). */
export function InboxPanel() {
  const open = useStore((s) => s.inboxOpen)
  const waiting = useWaiting()
  const close = (): void => setInboxOpen(false)
  useEscape(close, open)
  // Keyboard focus moves into the Inbox while it's open, and back to where it was afterwards.
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    return () => {
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus())
    }
  }, [open])

  const items = useMemo(() => {
    const list: Item[] = []
    for (const a of waiting.approvals) {
      list.push({
        kind: 'approval',
        at: a.request.ts,
        key: `a:${a.request.id}`,
        node: (
          <>
            <div className="inbox-meta">
              {a.project && <Avatar name={a.project.name} />}
              <span>
                <strong>{a.project?.name ?? 'A project'}</strong> · {a.agent} · {timeAgo(a.request.ts)}
              </span>
              {a.project && (
                <button className="link small" onClick={() => openProjectAt(a.project!.id, 'agents', { agentId: a.request.agentId })}>
                  Open feed
                </button>
              )}
            </div>
            {/* The same card as in the agent's feed: full summary, red for high-risk, "always" only when allowed. */}
            <ApprovalCard request={a.request} onDecided={(d) => d === 'always' && void refreshProjects()} />
          </>
        )
      })
    }
    for (const r of waiting.reviews) {
      list.push({
        kind: 'review',
        at: r.review.createdAt,
        key: `r:${r.review.id}`,
        node: (
          <div className="inbox-row">
            <Avatar name={r.project.name} />
            <span className="inbox-text">
              <strong>{revealHidden(r.review.title)}</strong>
              <span className="muted small">
                {r.project.name} · {r.agent} · {r.review.kind === 'research' ? 'web research' : `${r.review.files.length} file${r.review.files.length === 1 ? '' : 's'}`} · {timeAgo(r.review.createdAt)}
              </span>
              <ReviewBadges review={r.review} />
            </span>
            <Button size="sm" onClick={() => openProjectAt(r.project.id, 'reviews', { reviewId: r.review.id })}>
              Review
            </Button>
          </div>
        )
      })
    }
    for (const c of waiting.checkins) {
      list.push({
        kind: 'checkin',
        at: c.report?.at ?? c.ap.updatedAt,
        key: `c:${c.project.id}`,
        node: (
          <div className="inbox-row">
            <Avatar name={c.project.name} />
            <span className="inbox-text">
              <strong>
                {c.project.name} · Sprint {c.ap.sprint} check-in
              </strong>
              {c.report && <span className="muted small">{firstLine(c.report.text)}</span>}
            </span>
            <Button size="sm" tone="primary" onClick={() => openProjectAt(c.project.id, 'overview')}>
              Answer
            </Button>
          </div>
        )
      })
    }
    // Approvals first and oldest first, so a new one arriving lands below (it never pushes the card you're about
    // to click); then reviews and check-ins, newest first.
    return list.sort((x, y) =>
      (x.kind === 'approval') !== (y.kind === 'approval') ? (x.kind === 'approval' ? -1 : 1) : x.kind === 'approval' ? x.at - y.at : y.at - x.at
    )
  }, [waiting])

  if (!open) return null
  return (
    <div className="inbox-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="inbox" role="dialog" aria-modal="true" aria-label="Inbox" ref={panel} tabIndex={-1}>
        <header className="inbox-head">
          <h2>Inbox</h2>
          <span className="muted small">{waiting.count ? `${waiting.count} waiting` : ''}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={close} aria-label="Close Inbox">
            ×
          </button>
        </header>
        <div className="inbox-body">
          {items.length === 0 ? (
            <EmptyState icon="bell" title="Nothing waiting for you">
              Approvals, reviews and check-ins from every game show up here.
            </EmptyState>
          ) : (
            items.map((it) => (
              <section key={it.key} className={`inbox-item inbox-${it.kind}`}>
                {it.node}
              </section>
            ))
          )}
        </div>
        <footer className="inbox-foot muted small">Cmd/Ctrl+I opens and closes the Inbox.</footer>
      </aside>
    </div>
  )
}
