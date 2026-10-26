import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiReview, Project, Review, ReviewChecks } from '@shared/types'
import { mergeWarnings } from '@shared/reviewRules'
import { diffTotals, splitDiff } from '@shared/diff'
import { attempt, confirmDialog, EMPTY_REVIEWS, getState, replaceReview, setProjectTab, toast, useStore } from '../store'
import { Button, Skeleton, timeAgo } from './ui'
import { DiffView } from './DiffView'
import { EmptyState } from './EmptyState'
import { SafeText } from './SafeText'
import { revealHidden } from '@shared/text'

export function ReviewsView({ project }: { project: Project }) {
  const reviews = useStore((s) => s.reviews[project.id] ?? EMPTY_REVIEWS)
  const roles = useStore((s) => s.roles[project.id])
  // Opened from Home or the Inbox for a particular review: show it.
  const focus = useStore((s) => s.focus)
  const [selected, setSelected] = useState<string | null>(() => getState().focus?.reviewId ?? null)
  useEffect(() => {
    if (focus?.reviewId) setSelected(focus.reviewId)
  }, [focus])
  const pending = useMemo(() => reviews.filter((r) => r.status === 'pending'), [reviews])
  const recent = useMemo(() => reviews.filter((r) => r.status !== 'pending').slice(0, 15), [reviews])
  const current = reviews.find((r) => r.id === selected) ?? pending[0] ?? null
  const agentName = (id: string): string => (id === 'main' ? 'Main' : (roles?.find((r) => r.id === id)?.name ?? id))
  const [mergingAll, setMergingAll] = useState(false)
  /** Merge every waiting change, oldest first; clashes go to Fix with AI and merge once fixed. */
  const mergeAll = (): void => {
    const changes = pending.filter((r) => r.kind !== 'research')
    const acknowledged = Object.fromEntries(changes.map((r) => [r.id, mergeWarnings(r)]))
    const warned = changes.filter((r) => acknowledged[r.id]!.length > 0)
    void confirmDialog({
      title: `Merge all ${changes.length} changes?`,
      body: `Oldest first, into ${changes[0]?.base ?? 'main'}. A change that clashes with one merged before it goes to Fix with AI, and merges itself once the fixed version passes its checks again.${warned.length ? ' These need a second look:' : ''}`,
      lines: warned.flatMap((r) => acknowledged[r.id]!.map((w) => `${revealHidden(r.title).slice(0, 60)}: ${revealHidden(w)}`)),
      confirmLabel: 'Merge all',
      tone: warned.length ? 'danger' : 'primary'
    }).then((ok) => {
      if (!ok) return
      setMergingAll(true)
      void attempt(async () => {
        const r = await window.hangar.reviews.mergeAll(project.id, acknowledged)
        for (const fresh of await window.hangar.reviews.list(project.id)) replaceReview(fresh)
        const parts = [
          r.merged.length ? `${r.merged.length} merged` : null,
          r.fixing.length ? `${r.fixing.length} being fixed by AI (they merge themselves once checked)` : null,
          r.skipped.length ? `${r.skipped.length} left for you: ${r.skipped.map((x) => `${x.title.slice(0, 40)} (${x.reason})`).join('; ')}` : null
        ].filter(Boolean)
        toast(parts.join(' · ') || 'Nothing to merge.', r.skipped.length ? 'error' : 'info')
      }).finally(() => setMergingAll(false))
    })
  }

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
        <div className="row between">
          <span className="side-label">Waiting for review ({pending.length})</span>
          {pending.filter((r) => r.kind !== 'research').length > 1 && (
            <Button size="sm" disabled={mergingAll} onClick={mergeAll}>
              {mergingAll ? 'Merging…' : 'Merge all'}
            </Button>
          )}
        </div>
        {pending.length === 0 && (
          <EmptyState compact title="Nothing waiting">
            Finished autonomous tasks appear here.
          </EmptyState>
        )}
        {pending.map((r) => (
          <button key={r.id} className={`review-item ${current?.id === r.id ? 'file-item-active' : ''}`} onClick={() => setSelected(r.id)}>
            <span className="review-title">{revealHidden(r.title)}</span>
            <span className="muted small">
              {agentName(r.agentId)} ·{' '}
              {r.kind === 'research' ? `web research · ${r.research?.fetched.length ?? 0} pages` : `${r.files.length} file${r.files.length === 1 ? '' : 's'}`} ·{' '}
              {timeAgo(r.createdAt)}
              {(r.messages ?? 1) > 1 ? ` · ${r.messages} messages` : ''}
              {r.incomplete ? ' · stopped early' : ''}
              {r.clip ? ' · ▶ clip' : ''}
            </span>
            <ReviewBadges review={r} />
          </button>
        ))}
        {recent.length > 0 && <span className="side-label" style={{ marginTop: 12 }}>Recent</span>}
        {recent.map((r) => (
          <button key={r.id} className={`review-item ${current?.id === r.id ? 'file-item-active' : ''}`} onClick={() => setSelected(r.id)}>
            <span className="review-title muted">{revealHidden(r.title)}</span>
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

  const warnings = mergeWarnings(review)
  const totals = useMemo(() => (diff ? diffTotals(splitDiff(diff).files) : null), [diff])
  const [showWarnings, setShowWarnings] = useState(false)
  const studioShowsThis = useStore((s) => s.studioSync.reviewId === review.id && s.studioSync.status !== 'off')
  // The strip's chips jump to their section ("top" is the start of the body).
  const at = useRef<Record<string, HTMLElement | null>>({})
  const go = (k: string): void => {
    if (k === 'warnings') return setShowWarnings((v) => !v)
    const body = at.current.top
    const target = k === 'top' ? body : at.current[k]
    if (!body || !target) return
    // Scroll only the body (scrollIntoView would also move the panes around it), then move keyboard focus there
    // so the next Tab carries on from that section instead of jumping back up.
    body.scrollTop = k === 'top' ? 0 : body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top
    target.focus({ preventScroll: true })
  }
  const merge = (): void => {
    const doMerge = (): void => run('merge', () => window.hangar.reviews.merge(review.id, { force: warnings.length > 0, acknowledged: warnings }), `Merged into ${review.base}.`)
    if (!warnings.length) return doMerge()
    void confirmDialog({ title: 'Merge anyway?', body: 'This change needs a second look before it goes into your game:', lines: warnings.map(revealHidden), confirmLabel: 'Merge anyway', tone: 'danger' }).then((ok) => ok && doMerge())
  }

  return (
    <div className="review-detail">
      {/* The header and strip stay put; only the body below them scrolls. */}
      <header className="review-head">
        <div>
          <h2>{revealHidden(review.title)}</h2>
          <p className="muted small">
            {agent} · branch <code>{review.branch}</code> from <code>{review.base}</code> · {timeAgo(review.createdAt)}
          </p>
        </div>
        {isPending && (
          <div className="review-actions">
            <div className="row gap-xs">
              <Button tone={warnings.length ? 'default' : 'primary'} disabled={!!busy} onClick={merge}>
                {warnings.length ? 'Merge anyway…' : 'Merge'}
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
            <div className="row gap-xs">
              {/* Shown from a separate copy: the game folder never switches branches, so there's nothing to switch back. */}
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() => run('studio', () => window.hangar.studio.syncReview(review.id), 'Studio now shows this change. In Studio: Plugins → Rojo → Connect, then Play.')}
              >
                {studioShowsThis ? 'Showing in Studio' : 'Try it in Studio'}
              </Button>
              {project.settings.testPlace ? (
                <Button size="sm" disabled={!!busy} onClick={() => run('publish', () => window.hangar.reviews.publish(review.id), 'Published to your test place. Open it in the Roblox app.')}>
                  {busy === 'publish' ? 'Building and publishing…' : 'Publish to test place'}
                </Button>
              ) : (
                <Button size="sm" tone="ghost" title="Set a test place to play builds on your phone." onClick={() => setProjectTab('settings')}>
                  Set up a test place…
                </Button>
              )}
            </div>
          </div>
        )}
      </header>
      <ReviewStrip review={review} warnings={warnings} warningsOpen={showWarnings} totals={totals} clip={isPending && clip.length > 0} onGo={go} />
      {showWarnings && warnings.length > 0 && (
        <ul className="review-warnings">
          {warnings.map((w) => (
            <li key={w}>{revealHidden(w)}</li>
          ))}
        </ul>
      )}
      <div
        className="review-body"
        tabIndex={-1}
        ref={(el) => {
          at.current.top = el
        }}
      >
        {isPending && review.clash && (
          <div className="callout callout-amber row gap-sm wrap" role="status">
            <span>
              {review.clash.fixing
                ? `An agent is resolving the clash with ${review.base}. When it's done, the checks and the reviewer run again.`
                : `This change clashes with newer work on ${review.base}${review.clash.files.length ? ` (in ${review.clash.files.slice(0, 4).join(', ')}${review.clash.files.length > 4 ? '…' : ''})` : ''}, so it wasn't merged.`}
              {!review.clash.fixing && review.clash.failed && <> Last try didn't work: {review.clash.failed}</>}
            </span>
            <span className="spacer" />
            {!review.clash.fixing && (
              <Button size="sm" tone="primary" disabled={!!busy} onClick={() => run('fix', () => window.hangar.reviews.fixClash(review.id), 'An agent is resolving the clash.')}>
                Fix with AI
              </Button>
            )}
          </div>
        )}
        {review.incomplete && <div className="error-bar">This run stopped before finishing: {review.incomplete}</div>}
        {review.note && <div className="error-bar">{review.note}</div>}
        {!isPending && <p className="muted">This task was {review.status}.</p>}
        {review.summary && (
          <>
            <span className="side-label">Agent's report</span>
            <SafeText className="summary" text={review.summary} />
          </>
        )}
        {isPending && review.clip && clip.length > 0 && (
          <div
            className="review-section"
            tabIndex={-1}
            ref={(el) => {
              at.current.clip = el
            }}
          >
            {review.clip.kind === 'video' ? (
              <video className="clip" src={clip[0]} controls preload="metadata" />
            ) : (
              <div className="frames">
                {clip.map((src, i) => (
                  <img key={i} src={src} alt={`Playtest screenshot ${i + 1}`} />
                ))}
              </div>
            )}
          </div>
        )}
        {review.checks && (
          <div
            className="review-section"
            tabIndex={-1}
            ref={(el) => {
              at.current.checks = el
            }}
          >
            <ChecksPanel
              checks={review.checks}
              busy={!!busy}
              onRerun={isPending ? () => run('recheck', () => window.hangar.reviews.recheck(review.id), 'Running the checks again.') : undefined}
            />
          </div>
        )}
        {review.aiReview && (
          <div
            className="review-section"
            tabIndex={-1}
            ref={(el) => {
              at.current.reviewer = el
            }}
          >
            <AiReviewPanel
              ai={review.aiReview}
              busy={!!busy}
              onRerun={isPending ? () => run('recheck', () => window.hangar.reviews.recheck(review.id, { reviewer: true }), 'Asked the reviewer again.') : undefined}
            />
          </div>
        )}
        {review.published && (
          <p
            className="small review-section"
            tabIndex={-1}
            ref={(el) => {
              at.current.published = el
            }}
          >
            Published to the test place as version {review.published.versionNumber} ({timeAgo(review.published.at)}).
          </p>
        )}
        {isPending && (
          <div
            className="review-section"
            tabIndex={-1}
            ref={(el) => {
              at.current.diff = el
            }}
          >
            {diffError ? (
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
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** One line of what a review holds: checks, reviewer, warnings, files and size, clip. Each chip jumps to its part. */
function ReviewStrip(props: {
  review: Review
  warnings: string[]
  warningsOpen: boolean
  totals: { added: number; removed: number } | null
  clip: boolean
  onGo: (k: string) => void
}) {
  const { review, warnings, totals, onGo } = props
  const c = review.checks
  const ai = review.aiReview
  const failed = c?.results.filter((r) => r.status !== 'passed').length ?? 0
  const chips: { k: string; tone: '' | 'ok' | 'err' | 'warn'; text: string; title?: string }[] = []
  if (c)
    chips.push(
      c.status === 'running'
        ? { k: 'checks', tone: '', text: 'Checks running…' }
        : c.status === 'skipped'
          ? { k: 'checks', tone: 'warn', text: 'Checks skipped' }
          : failed || c.reason
            ? { k: 'checks', tone: 'err', text: failed ? `✗ ${failed} check${failed === 1 ? '' : 's'} failed` : '✗ Checks' }
            : { k: 'checks', tone: 'ok', text: `✓ ${c.results.length} check${c.results.length === 1 ? '' : 's'} passed` }
    )
  if (ai)
    chips.push(
      ai.status === 'running'
        ? { k: 'reviewer', tone: '', text: 'Reviewer reading…' }
        : ai.status === 'error'
          ? { k: 'reviewer', tone: 'warn', text: 'Reviewer failed' }
          : ai.verdict === 'approve'
            ? { k: 'reviewer', tone: 'ok', text: '✓ Reviewer: looks good' }
            : ai.verdict === 'block'
              ? { k: 'reviewer', tone: 'err', text: "✗ Reviewer: don't merge" }
              : { k: 'reviewer', tone: 'warn', text: '! Reviewer has concerns' }
    )
  if (warnings.length) chips.push({ k: 'warnings', tone: 'warn', text: `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`, title: warnings.map(revealHidden).join('\n') })
  if (review.status === 'pending' && review.clash) chips.push({ k: 'top', tone: review.clash.fixing ? '' : 'err', text: review.clash.fixing ? 'Resolving clash…' : `✗ Clashes with ${review.base}` })
  if (review.incomplete) chips.push({ k: 'top', tone: 'err', text: 'Stopped early' })
  // Merged and discarded reviews have no diff to jump to: their file count is shown as plain text.
  chips.push({
    k: review.status === 'pending' ? 'diff' : '',
    tone: '',
    text: `${review.files.length} file${review.files.length === 1 ? '' : 's'}${totals ? ` · +${totals.added} −${totals.removed}` : ''}`
  })
  if (props.clip) chips.push({ k: 'clip', tone: '', text: `▶ Playtest ${review.clip?.kind === 'frames' ? 'screenshots' : 'clip'}` })
  if (review.published) chips.push({ k: 'published', tone: 'ok', text: `Published v${review.published.versionNumber}` })
  return (
    <div className="review-strip" aria-label="Summary">
      {chips.map((x, i) =>
        x.k ? (
          <button key={i} className={`strip-chip ${x.tone}`} title={x.title} aria-expanded={x.k === 'warnings' ? props.warningsOpen : undefined} onClick={() => onGo(x.k)}>
            {x.text}
          </button>
        ) : (
          <span key={i} className={`strip-chip strip-chip-static ${x.tone}`}>
            {x.text}
          </span>
        )
      )}
    </div>
  )
}

export function ReviewBadges({ review }: { review: Review }) {
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
          <h2>{revealHidden(review.title)}</h2>
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
