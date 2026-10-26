import { useMemo, useRef, useState } from 'react'
import { chipLabels, diffTotals, fileKeys, splitDiff, type DiffFile } from '@shared/diff'
import { CODE_HIDDEN_CHARS, hasHidden, revealCodeHidden, revealHidden } from '@shared/text'

/** Above this many lines in total, every file starts collapsed so the view opens quickly. */
const COLLAPSE_ALL_OVER = 4000
/** A single file this long starts collapsed. */
const COLLAPSE_FILE_OVER = 1500

const STATUS_LABEL: Record<DiffFile['status'], string> = { added: 'New', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', modified: 'Modified' }

/** How a file is named on screen: hidden characters (which could make one name look like another) shown as ⟦U+…⟧. */
const shownPath = (f: DiffFile): string => revealHidden(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)
const codeHidden = new RegExp(CODE_HIDDEN_CHARS.source, 'u')

/**
 * A git diff shown file by file: a summary, a jump list, and one collapsible section per file.
 * Parents give it a `key` per change (review, file) so a different change starts from its own defaults;
 * a refreshed diff of the same change keeps what you opened or closed.
 */
export function DiffView({ diff, className }: { diff: string; className?: string }) {
  const { files, notes } = useMemo(() => splitDiff(diff), [diff])
  const totals = useMemo(() => diffTotals(files), [files])
  const keys = useMemo(() => fileKeys(files), [files])
  const labels = useMemo(() => chipLabels(files), [files])
  // Files whose code holds characters that can make it read differently from how it runs.
  const sneaky = useMemo(() => files.map((f) => f.lines.some((l) => l.kind !== 'meta' && codeHidden.test(l.text))), [files])
  const startCollapsed = totals.lines > COLLAPSE_ALL_OVER
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const refs = useRef<Record<string, HTMLElement | null>>({})

  const isOpen = (f: DiffFile, k: string): boolean => open[k] ?? !(startCollapsed || f.lines.length > COLLAPSE_FILE_OVER)
  const jump = (k: string): void => {
    setOpen((o) => ({ ...o, [k]: true }))
    requestAnimationFrame(() => {
      void refs.current[k]?.scrollIntoView({ block: 'start' })
    })
  }

  if (!files.length && !notes.length) return <p className="muted small dv-none">No differences to show.</p>
  return (
    <div className={`dv ${className ?? ''}`}>
      {files.length > 1 && (
        <div className="dv-summary">
          <span className="dv-count">
            {files.length} files · <span className="ok">+{totals.added}</span> <span className="err">−{totals.removed}</span>
          </span>
          <nav className="dv-jump" aria-label="Jump to a file">
            {files.map((f, i) => (
              <button key={keys[i]} className="dv-chip" title={shownPath(f)} aria-label={`Jump to ${shownPath(f)}`} onClick={() => jump(keys[i]!)}>
                {labels[i]}
              </button>
            ))}
          </nav>
          {startCollapsed && <span className="muted small">Large change: files start collapsed.</span>}
        </div>
      )}
      {files.map((f, i) => {
        const k = keys[i]!
        const shown = isOpen(f, k)
        const odd = hasHidden(f.path) || (f.oldPath !== null && hasHidden(f.oldPath))
        return (
          <section
            key={k}
            className="dv-file"
            ref={(el) => {
              refs.current[k] = el
            }}
          >
            <button className="dv-head" aria-expanded={shown} onClick={() => setOpen((o) => ({ ...o, [k]: !shown }))}>
              <span className="dv-caret" aria-hidden>
                {shown ? '▾' : '▸'}
              </span>
              <span className={`tag dv-status dv-${f.status}`}>{STATUS_LABEL[f.status]}</span>
              {f.binary && <span className="tag">Binary</span>}
              {odd && (
                <span className="tag tag-err" title="This file name contains hidden characters that can make it look like a different name.">
                  Hidden characters
                </span>
              )}
              {sneaky[i] && (
                <span className="tag tag-err" title="This file's changes contain invisible or text-direction characters, which can make code read differently from how it runs. They're shown as ⟦U+…⟧.">
                  Hidden characters in code
                </span>
              )}
              <span className="dv-path" title={shownPath(f)}>
                {shownPath(f)}
              </span>
              <span className="dv-stat">
                {f.added > 0 && <span className="ok">+{f.added}</span>} {f.removed > 0 && <span className="err">−{f.removed}</span>}
              </span>
            </button>
            {shown && (
              <div className="dv-lines">
                {f.lines.map((l, j) => (
                  <div key={j} className={`d-${l.kind}`}>
                    {/* Header lines show every hidden character; code lines only the ones that can disguise code. */}
                    {(l.kind === 'meta' ? revealHidden(l.text) : revealCodeHidden(l.text)) || ' '}
                  </div>
                ))}
              </div>
            )}
          </section>
        )
      })}
      {notes.length > 0 && (
        <div className="dv-notes">
          {notes.map((n, i) => (
            <p key={i} className="small warn">
              {revealHidden(n)}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
