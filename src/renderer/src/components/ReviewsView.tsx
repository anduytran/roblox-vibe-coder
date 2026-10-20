import { useEffect, useMemo, useState } from 'react'
import type { Project, Review } from '@shared/types'
import { attempt, EMPTY_REVIEWS, replaceReview, toast, useStore } from '../store'
import { Button, timeAgo } from './ui'

export function ReviewsView({ project }: { project: Project }) {
  const reviews = useStore((s) => s.reviews[project.id] ?? EMPTY_REVIEWS)
  const roles = useStore((s) => s.roles[project.id])
  const [selected, setSelected] = useState<string | null>(null)
  const pending = useMemo(() => reviews.filter((r) => r.status === 'pending'), [reviews])
  const recent = useMemo(() => reviews.filter((r) => r.status !== 'pending').slice(0, 15), [reviews])
  const current = reviews.find((r) => r.id === selected) ?? pending[0] ?? null
  const agentName = (id: string): string => (id === 'main' ? 'Main' : (roles?.find((r) => r.id === id)?.name ?? id))

  if (!project.settings.autonomous && reviews.length === 0) {
    return (
      <div className="empty">
        <h2>No reviews yet</h2>
        <p>Turn on Autonomous mode in Project settings. Each task then runs on its own branch and ends up here as one change to review, merge or discard.</p>
      </div>
    )
  }

  return (
    <div className="changes">
      <div className="changes-list">
        <span className="side-label">Waiting for review ({pending.length})</span>
        {pending.length === 0 && <p className="muted small pad-x">Nothing waiting. Finished autonomous tasks appear here.</p>}
        {pending.map((r) => (
          <button key={r.id} className={`review-item ${current?.id === r.id ? 'file-item-active' : ''}`} onClick={() => setSelected(r.id)}>
            <span className="review-title">{r.title}</span>
            <span className="muted small">
              {agentName(r.agentId)} · {r.files.length} file{r.files.length === 1 ? '' : 's'} · {timeAgo(r.createdAt)}
              {r.incomplete ? ' · stopped early' : ''}
              {r.clip ? ' · ▶ clip' : ''}
            </span>
          </button>
        ))}
        {recent.length > 0 && <span className="side-label" style={{ marginTop: 12 }}>Recent</span>}
        {recent.map((r) => (
          <button key={r.id} className={`review-item ${current?.id === r.id ? 'file-item-active' : ''}`} onClick={() => setSelected(r.id)}>
            <span className="review-title muted">{r.title}</span>
            <span className="muted small">{r.status === 'merged' ? 'Merged' : 'Discarded'} · {timeAgo(r.createdAt)}</span>
          </button>
        ))}
      </div>
      {current ? <ReviewDetail key={current.id} project={project} review={current} agent={agentName(current.agentId)} /> : <div className="muted small pad">Select a task.</div>}
    </div>
  )
}

function ReviewDetail({ project, review, agent }: { project: Project; review: Review; agent: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [clip, setClip] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const isPending = review.status === 'pending'

  useEffect(() => {
    if (!isPending) return
    void attempt(() => window.hangar.reviews.diff(review.id)).then((d) => setDiff(d ?? ''))
    if (review.clip) {
      void Promise.all(review.clip.files.map((_, i) => window.hangar.reviews.clipFile(review.id, i))).then(setClip).catch(() => setClip([]))
    }
  }, [review.id, isPending, review.clip])

  const run = (label: string, fn: () => Promise<unknown>, ok: string): void => {
    setBusy(label)
    void attempt(async () => {
      const r = await fn()
      if (r && typeof r === 'object' && 'id' in r) replaceReview(r as Review)
      toast(ok)
    }).finally(() => setBusy(null))
  }

  return (
    <div className="review-detail">
      <header className="review-head">
        <div>
          <h2>{review.title}</h2>
          <p className="muted small">
            {agent} · branch <code>{review.branch}</code> from <code>{review.base}</code>
          </p>
        </div>
        {isPending && (
          <div className="row gap-xs">
            <Button tone="primary" disabled={!!busy} onClick={() => run('merge', () => window.hangar.reviews.merge(review.id), `Merged into ${review.base}.`)}>
              Merge
            </Button>
            <Button
              tone="danger"
              disabled={!!busy}
              onClick={() => confirm('Discard this work? The branch will be deleted.') && run('discard', () => window.hangar.reviews.discard(review.id), 'Discarded.')}
            >
              Discard
            </Button>
          </div>
        )}
      </header>
      <div className="review-body">
        {review.incomplete && <div className="error-bar">This run stopped before finishing: {review.incomplete}</div>}
        {review.note && <div className="error-bar">{review.note}</div>}
        {!isPending && <p className="muted">This task was {review.status}.</p>}
        {clip.length > 0 &&
          (review.clip?.kind === 'video' ? (
            <video className="clip" src={clip[0]} controls preload="metadata" />
          ) : (
            <div className="frames">
              {clip.map((src, i) => (
                <img key={i} src={src} alt={`Playtest screenshot ${i + 1}`} />
              ))}
            </div>
          ))}
        {review.summary && <pre className="summary">{review.summary}</pre>}
        {isPending && (
          <div className="row gap-xs wrap">
            <Button size="sm" disabled={!!busy} onClick={() => run('checkout', () => window.hangar.reviews.checkout(review.id), 'Switched your project folder to this branch. Try it in Studio, then switch back.')}>
              Try it in Studio
            </Button>
            <Button size="sm" tone="ghost" disabled={!!busy} onClick={() => run('base', () => window.hangar.reviews.checkoutBase(project.id), `Back on ${review.base}.`)}>
              Back to {review.base}
            </Button>
            {project.settings.testPlace ? (
              <Button size="sm" disabled={!!busy} onClick={() => run('publish', () => window.hangar.reviews.publish(review.id), 'Published to your test place. Open it in the Roblox app.')}>
                {busy === 'publish' ? 'Building and publishing…' : 'Publish to test place'}
              </Button>
            ) : (
              <span className="muted small">Set a test place in Project settings to play builds on your phone.</span>
            )}
          </div>
        )}
        {review.published && <p className="small">Published to the test place as version {review.published.versionNumber} ({timeAgo(review.published.at)}).</p>}
        {isPending && (
          <div className="diff review-diff">
            {diff === null ? (
              <div className="muted small pad">Loading changes…</div>
            ) : (
              diff.split('\n').map((l, i) => (
                <div
                  key={i}
                  className={
                    /^(\+\+\+|---|diff |index )/.test(l) ? 'd-meta' : l.startsWith('@@') ? 'd-hunk' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : 'd-ctx'
                  }
                >
                  {l || ' '}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
