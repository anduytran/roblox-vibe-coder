import { useEffect, useMemo, useState } from 'react'
import type { AiReview, Project, Review, ReviewChecks } from '@shared/types'
import { mergeWarnings } from '@shared/reviewRules'
import { attempt, confirmDialog, EMPTY_REVIEWS, replaceReview, toast, useStore } from '../store'
import { Button, Skeleton, timeAgo } from './ui'
import { DiffView } from './DiffView'
import { EmptyState } from './EmptyState'
import { SafeText } from './SafeText'
import { revealHidden } from '@shared/text'

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
      <EmptyState icon="review" title="No reviews yet">
        Turn on Autonomous mode in the Project tab. Each task then runs on its own branch and ends up here as one change to review, merge or discard. Reports from
        the web Researcher also wait here until you approve them.
      </EmptyState>
    )
  }

  return (
    <div className="changes">
      <div className="changes-list">
        <span className="side-label">Waiting for review ({pending.length})</span>
        {pending.length === 0 && (
          <EmptyState compact title="Nothing waiting">
            Finished autonomous tasks appear here.
          </EmptyState>
        )}
        {pending.map((r) => (
          <button key={r.id} className={`review-item ${current?.id === r.id ? 'file-item-active' : ''}`} onClick={() => setSelected(r.id)}>
            <span className="review-title">{r.title}</span>
            <span className="muted small">
              {agentName(r.agentId)} ·{' '}
              {r.kind === 'research' ? `web research · ${r.research?.fetched.length ?? 0} pages` : `${r.files.length} file${r.files.length === 1 ? '' : 's'}`} ·{' '}
              {timeAgo(r.createdAt)}
              {r.incomplete ? ' · stopped early' : ''}
              {r.clip ? ' · ▶ clip' : ''}
            </span>
            <ReviewBadges review={r} />
          </button>
        ))}
        {recent.length > 0 && <span className="side-label" style={{ marginTop: 12 }}>Recent</span>}
        {recent.map((r) => (
          <button key={r.id} className={`review-item ${current?.id === r.id ? 'file-item-active' : ''}`} onClick={() => setSelected(r.id)}>
            <span className="review-title muted">{r.title}</span>
            <span className="muted small">
              {r.status === 'merged' ? (r.kind === 'research' ? 'Approved' : 'Merged') : 'Discarded'} · {timeAgo(r.createdAt)}
            </span>
          </button>
        ))}
      </div>
      {current ? (
        current.kind === 'research' ? (
          <ResearchDetail key={current.id} review={current} agent={agentName(current.agentId)} />
        ) : (
          <ReviewDetail key={current.id} project={project} review={current} agent={agentName(current.agentId)} />
        )
      ) : (
        <EmptyState icon="review" title="Select a task" />
      )}
    </div>
  )
}

function ReviewDetail({ project, review, agent }: { project: Project; review: Review; agent: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [clip, setClip] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const isPending = review.status === 'pending'

  const [diffError, setDiffError] = useState(false)
  const [diffTry, setDiffTry] = useState(0)
  // The diff loads once per review (this component is keyed by review id). Updates to the review (checks,
  // reviewer, publish) don't reload it, so what you opened, closed and scrolled stays put.
  useEffect(() => {
    if (!isPending) return
    let stale = false
    setDiffError(false)
    void attempt(() => window.hangar.reviews.diff(review.id)).then((d) => {
      if (stale) return
      if (d === undefined) setDiffError(true)
      else setDiff(d)
    })
    return () => {
      stale = true
    }
  }, [review.id, isPending, diffTry])
  // The clip loads when its files change, not on every review update.
  const clipKey = review.clip ? `${review.clip.kind}\n${review.clip.files.join('\n')}` : ''
  useEffect(() => {
    if (!isPending || !review.clip) {
      // Merged or discarded: the clip's files are deleted, so stop showing it.
      setClip([])
      return
    }
    let stale = false
    void Promise.all(review.clip.files.map((_, i) => window.hangar.reviews.clipFile(review.id, i)))
      .then((c) => !stale && setClip(c))
      .catch(() => !stale && setClip([]))
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.id, isPending, clipKey])

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
            <Button
              tone={mergeWarnings(review).length ? 'default' : 'primary'}
              disabled={!!busy}
              onClick={() => {
                const warnings = mergeWarnings(review)
                const merge = (): void => run('merge', () => window.hangar.reviews.merge(review.id, { force: warnings.length > 0, acknowledged: warnings }), `Merged into ${review.base}.`)
                if (!warnings.length) return merge()
                void confirmDialog({ title: 'Merge anyway?', body: 'This change needs a second look before it goes into your game:', lines: warnings, confirmLabel: 'Merge anyway', tone: 'danger' }).then((ok) => ok && merge())
              }}
            >
              {mergeWarnings(review).length ? 'Merge anyway…' : 'Merge'}
            </Button>
            <Button
              tone="danger"
              disabled={!!busy}
              onClick={() =>
                void confirmDialog({ title: 'Discard this work?', body: `The branch ${review.branch} and everything on it will be deleted.`, confirmLabel: 'Discard', tone: 'danger' }).then(
                  (ok) => ok && run('discard', () => window.hangar.reviews.discard(review.id), 'Discarded.')
                )
              }
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
        {isPending && review.clip && clip.length > 0 &&
          (review.clip.kind === 'video' ? (
            <video className="clip" src={clip[0]} controls preload="metadata" />
          ) : (
            <div className="frames">
              {clip.map((src, i) => (
                <img key={i} src={src} alt={`Playtest screenshot ${i + 1}`} />
              ))}
            </div>
          ))}
        {review.checks && (
          <ChecksPanel
            checks={review.checks}
            busy={!!busy}
            onRerun={isPending ? () => run('recheck', () => window.hangar.reviews.recheck(review.id), 'Running the checks again.') : undefined}
          />
        )}
        {review.aiReview && (
          <AiReviewPanel
            ai={review.aiReview}
            busy={!!busy}
            onRerun={isPending ? () => run('recheck', () => window.hangar.reviews.recheck(review.id, { reviewer: true }), 'Asked the reviewer again.') : undefined}
          />
        )}
        {review.summary && (
          <>
            <span className="side-label">Agent's report</span>
            <SafeText className="summary" text={review.summary} />
          </>
        )}
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
              <span className="muted small">Set a test place in the Project tab to play builds on your phone.</span>
            )}
          </div>
        )}
        {review.published && <p className="small">Published to the test place as version {review.published.versionNumber} ({timeAgo(review.published.at)}).</p>}
        {isPending &&
          (diffError ? (
            <EmptyState
              compact
              icon="changes"
              title="Couldn't load the changes"
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setDiff(null)
                    setDiffTry((n) => n + 1)
                  }}
                >
                  Try again
                </Button>
              }
            >
              {review.files.length > 0 && `Files in this task: ${review.files.map(revealHidden).join(', ')}`}
            </EmptyState>
          ) : diff === null ? (
            <Skeleton lines={6} label="Loading changes" />
          ) : diff ? (
            <DiffView key={review.id} diff={diff} className="review-diff" />
          ) : (
            <EmptyState compact title="No file changes" />
          ))}
      </div>
    </div>
  )
}

function ReviewBadges({ review }: { review: Review }) {
  const c = review.checks
  const ai = review.aiReview
  if (!c && !ai) return null
  return (
    <span className="badges">
      {c &&
        (c.status === 'running' ? (
          <span className="tag">checks…</span>
        ) : c.status === 'skipped' ? (
          <span className="tag tag-warn">checks skipped</span>
        ) : c.results.some((r) => r.status !== 'passed') || c.reason ? (
          <span className="tag tag-err">✗ checks</span>
        ) : (
          <span className="tag tag-ok">✓ checks</span>
        ))}
      {ai &&
        (ai.status === 'running' ? (
          <span className="tag">reviewing…</span>
        ) : ai.status === 'error' ? (
          <span className="tag tag-warn">review failed</span>
        ) : (
          <span className={`tag ${ai.verdict === 'approve' ? 'tag-ok' : ai.verdict === 'block' ? 'tag-err' : 'tag-warn'}`}>
            {ai.verdict === 'approve' ? '✓ reviewer' : ai.verdict === 'block' ? '✗ reviewer' : '! reviewer'}
          </span>
        ))}
    </span>
  )
}

function ChecksPanel({ checks, busy, onRerun }: { checks: ReviewChecks; busy: boolean; onRerun?: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <section className="check-panel">
      <div className="row between">
        <span className="side-label">Checks</span>
        {onRerun && checks.status !== 'running' && (
          <Button size="sm" tone="ghost" disabled={busy} onClick={onRerun}>
            Run again
          </Button>
        )}
      </div>
      {checks.status === 'running' && <p className="small muted">Running in a separate checkout of this branch…</p>}
      {checks.reason && <p className={`small ${checks.status === 'skipped' ? 'warn' : 'err'}`}>{checks.reason}</p>}
      {checks.status === 'done' && checks.sandboxed === false && checks.results.length > 0 && (
        <p className="small muted">Ran without the OS sandbox (Windows, or the sandbox is off for this project).</p>
      )}
      {checks.results.map((r) => (
        <div key={r.name} className="check-row">
          <button className="check-line" onClick={() => setOpen(open === r.name ? null : r.name)}>
            <span className={r.status === 'passed' ? 'ok' : 'err'}>{r.status === 'passed' ? '✓' : '✗'}</span>
            <strong>{r.name}</strong>
            <code className="muted">{r.command}</code>
            <span className="spacer" />
            <span className="muted small">
              {r.status === 'error' ? "couldn't run" : r.status} · {(r.ms / 1000).toFixed(1)}s
            </span>
          </button>
          {(open === r.name || (r.status !== 'passed' && open === null)) && r.output && <pre className="check-output">{r.output}</pre>}
        </div>
      ))}
    </section>
  )
}

function AiReviewPanel({ ai, busy, onRerun }: { ai: AiReview; busy: boolean; onRerun?: () => void }) {
  return (
    <section className={`check-panel ${ai.verdict === 'block' ? 'check-panel-err' : ''}`}>
      <div className="row between">
        <span className="side-label">Reviewer agent</span>
        {onRerun && ai.status !== 'running' && (
          <Button size="sm" tone="ghost" disabled={busy} onClick={onRerun}>
            Review again
          </Button>
        )}
      </div>
      {ai.status === 'running' && <p className="small muted">Reading the change…</p>}
      {ai.status === 'error' && <p className="small warn">The review didn't finish: {ai.error}</p>}
      {ai.status === 'done' && (
        <>
          <p>
            <span className={`tag ${ai.verdict === 'approve' ? 'tag-ok' : ai.verdict === 'block' ? 'tag-err' : 'tag-warn'}`}>
              {ai.verdict === 'approve' ? 'Looks good' : ai.verdict === 'block' ? "Don't merge as is" : 'Has concerns'}
            </span>{' '}
            {ai.summary}
          </p>
          {ai.findings.map((f, i) => (
            <div key={i} className={`finding finding-${f.severity}`}>
              <div className="row gap-xs">
                <span className="finding-sev">{f.severity}</span>
                <strong>{f.title}</strong>
              </div>
              {f.file && (
                <code className="small muted">
                  {f.file}
                  {f.line ? `:${f.line}` : ''}
                </code>
              )}
              {f.detail && <p className="small">{f.detail}</p>}
            </div>
          ))}
          <p className="small muted">Advice from an AI that read code another agent wrote — it can miss things or be fooled. ${ai.costUsd.toFixed(2)}</p>
        </>
      )}
    </section>
  )
}

function ResearchDetail({ review, agent }: { review: Review; agent: string }) {
  const [busy, setBusy] = useState(false)
  const r = review.research
  const isPending = review.status === 'pending'
  const act = (fn: () => Promise<Review>, ok: string): void => {
    setBusy(true)
    void attempt(async () => {
      replaceReview(await fn())
      toast(ok)
    }).finally(() => setBusy(false))
  }
  const fetched = new Set(r?.fetched ?? [])
  const citedNotOpened = (r?.cited ?? []).filter((u) => !fetched.has(u))
  return (
    <div className="review-detail">
      <header className="review-head">
        <div>
          <h2>{review.title}</h2>
          <p className="muted small">{agent} · web research · nothing here reaches other agents until you approve it</p>
        </div>
        {isPending && (
          <div className="row gap-xs">
            <Button tone="primary" disabled={busy} onClick={() => act(() => window.hangar.reviews.merge(review.id), 'Saved to research/. Agents can read it now.')}>
              Approve & save
            </Button>
            <Button tone="danger" disabled={busy} onClick={() =>
                void confirmDialog({ title: 'Discard this research?', body: 'The report is thrown away and no agent will see it.', confirmLabel: 'Discard', tone: 'danger' }).then(
                  (ok) => ok && act(() => window.hangar.reviews.discard(review.id), 'Discarded.')
                )
              }>
              Discard
            </Button>
          </div>
        )}
      </header>
      <div className="review-body">
        {review.incomplete && <div className="error-bar">This run stopped before finishing: {review.incomplete}</div>}
        {review.note && <div className="error-bar">{review.note}</div>}
        {!isPending && <p className="muted">{review.status === 'merged' ? `Approved and saved as ${r?.savedAs ?? 'research/'}.` : 'Discarded.'}</p>}
        <p className="small muted">
          Check it the way you'd check anything from the internet: is it right, is it current, and does it contain instructions aimed at an AI (“ignore previous…”, “run
          this”)? Once approved, it's saved as a Markdown file in research/ and committed, and every agent may read it.
        </p>
        <div className="grid-2">
          <section className="check-panel">
            <span className="side-label">Pages it opened ({r?.fetched.length ?? 0})</span>
            {r?.fetched.length ? (
              <ul className="source-list">
                {r.fetched.map((u) => (
                  <li key={u}>
                    <a href={u} target="_blank" rel="noreferrer">
                      {u}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">None — the report is from search results only.</p>
            )}
            <p className="small muted">Recorded by Hangar, not taken from the report. Pages on a few documentation sites the engine trusts may not be listed.</p>
          </section>
          <section className="check-panel">
            <span className="side-label">Searches ({r?.queries.length ?? 0})</span>
            <ul className="source-list">
              {(r?.queries ?? []).map((q) => (
                <li key={q}>“{q}”</li>
              ))}
            </ul>
            {citedNotOpened.length > 0 && (
              <>
                <span className="side-label">Cited but not opened</span>
                <ul className="source-list">
                  {citedNotOpened.map((u) => (
                    <li key={u} className="warn">
                      {u}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
        <span className="side-label">Report (shown as plain text, exactly as it will be saved)</span>
        <pre className="summary research-text">{r?.markdown ?? ''}</pre>
      </div>
    </div>
  )
}
