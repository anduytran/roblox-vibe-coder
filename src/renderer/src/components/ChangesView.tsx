import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus, Project } from '@shared/types'
import { attempt, confirmDialog, toast, useStore } from '../store'
import { Button, Skeleton } from './ui'
import { DiffView } from './DiffView'
import { EmptyState } from './EmptyState'
import { revealHidden } from '@shared/text'

const STATUS_NAME: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'New', U: 'Conflict' }

function statusLabel(code: string): string {
  const c = code.trim()[0] ?? '?'
  return STATUS_NAME[c] ?? c
}

export function ChangesView({ project }: { project: Project }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [file, setFile] = useState<string | null>(null)
  /** The last diff that arrived, and which view it belongs to (project + file). */
  const [diff, setDiff] = useState<{ key: string; text: string } | null>(null)
  /** The view whose diff failed to load, if any. */
  const [diffErrorKey, setDiffErrorKey] = useState<string | null>(null)
  const [diffTry, setDiffTry] = useState(0)
  const [message, setMessage] = useState('')
  // Starts true: until the first status arrives this is "loading", not "couldn't read".
  const [loading, setLoading] = useState(true)
  // Refresh whenever any agent in this project logs a step. Watches the newest entry, not the count: logs are
  // capped, so a long-running agent's count stops changing.
  const logTick = useStore((s) =>
    Object.values(s.agents[project.id] ?? {})
      .map((a) => a.log[a.log.length - 1]?.id ?? '')
      .join('|')
  )

  // Status replies can overlap (a debounced refresh and the one after a commit); only the newest counts.
  const statusSeq = useRef(0)
  const refresh = useCallback(async () => {
    const mine = ++statusSeq.current
    setLoading(true)
    const st = await attempt(() => window.hangar.git.status(project.id))
    if (mine !== statusSeq.current) return
    setLoading(false)
    if (!st) return
    setStatus(st)
    // Drop the selection if that file has no changes any more. (Not a dependency: clicking a file
    // mustn't re-run git status and fetch its diff a second time.)
    setFile((f) => (f && !st.files.some((x) => x.path === f) ? null : f))
  }, [project.id])

  // The first look is immediate; later ones are debounced so a busy agent doesn't trigger a git call per log line.
  // The flag flips only when the timer actually fires (React's development double-run cancels the first one).
  const first = useRef(true)
  useEffect(() => {
    const t = setTimeout(
      () => {
        first.current = false
        void refresh()
      },
      first.current ? 0 : 600
    )
    return () => clearTimeout(t)
  }, [refresh, logTick])

  // What the diff pane shows (project + file), and request numbers so a slow reply for the same target still
  // lands unless a newer one already did, while replies for another file or project are dropped.
  const target = useRef('')
  const seq = useRef(0)
  const applied = useRef(0)
  const hasChanges = !!status?.isRepo && status.files.length > 0
  const viewKey = hasChanges ? `${project.id}\u0000${file ?? ''}` : ''
  useEffect(() => {
    // Nothing to show: a diff still on its way is for changes that are gone now.
    target.current = viewKey
    if (!viewKey) return
    const mine = ++seq.current
    void attempt(() => window.hangar.git.diff(project.id, file ?? undefined)).then((d) => {
      if (target.current !== viewKey || mine < applied.current) return
      applied.current = mine
      if (d === undefined) setDiffErrorKey(viewKey)
      else {
        setDiff({ key: viewKey, text: d })
        setDiffErrorKey((k) => (k === viewKey ? null : k))
      }
    })
    // status is a dependency on purpose: file contents can change without the list changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, status, diffTry])
  // Decided while rendering, so another file's diff (or one from before a commit) is never shown, even for a frame.
  const shown = diff && diff.key === viewKey ? diff.text : null

  if (!status)
    return loading ? (
      <div className="pad">
        <Skeleton lines={5} label="Loading changes" />
      </div>
    ) : (
      <EmptyState icon="changes" title="Couldn't read git status" action={<Button onClick={() => void refresh()}>Try again</Button>} />
    )

  if (!status.isRepo) {
    return (
      <EmptyState
        icon="changes"
        title="This folder is not a git repository"
        action={
          <Button tone="primary" onClick={() => void attempt(() => window.hangar.git.init(project.id)).then(refresh)}>
            Initialize git here
          </Button>
        }
      >
        Git lets you review every change an agent makes and undo anything. Hangar strongly recommends it.
      </EmptyState>
    )
  }

  const commit = (): void => {
    void attempt(async () => {
      await window.hangar.git.commit(project.id, message)
      setMessage('')
      toast('Changes committed.')
      await refresh()
    })
  }

  const revert = async (path: string): Promise<void> => {
    const isNew = status.files.find((f) => f.path === path)?.status === '??'
    const ok = await confirmDialog(
      isNew
        ? { title: 'Move this new file to the trash?', body: revealHidden(path), confirmLabel: 'Move to trash', tone: 'danger' }
        : { title: 'Discard the changes to this file?', body: `${revealHidden(path)} goes back to its last committed version.`, confirmLabel: 'Discard changes', tone: 'danger' }
    )
    if (!ok) return
    void attempt(async () => {
      await window.hangar.git.revertFile(project.id, path)
      toast(isNew ? 'File moved to trash.' : 'Changes discarded.')
      await refresh()
    })
  }

  return (
    <div className="changes">
      <div className="changes-list">
        <div className="row between">
          <span className="side-label">
            {status.files.length} changed file{status.files.length === 1 ? '' : 's'}
            {status.branch ? ` on ${status.branch}` : ''}
          </span>
          <button className="link small" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {status.files.length === 0 ? (
          <EmptyState compact title="No uncommitted changes">
            Everything agents did has been committed.
          </EmptyState>
        ) : (
          <>
            <button className={`file-item ${file === null ? 'file-item-active' : ''}`} onClick={() => setFile(null)}>
              All changes
            </button>
            {status.files.map((f) => (
              <div key={f.path} className={`file-item ${file === f.path ? 'file-item-active' : ''}`}>
                <button className="file-name" onClick={() => setFile(f.path)} title={revealHidden(f.path)}>
                  <span className={`file-status file-status-${(f.status.trim()[0] ?? 'q').replace('?', 'q')}`}>{statusLabel(f.status)}</span>
                  {revealHidden(f.path)}
                </button>
                <button className="icon-btn" title="Discard changes to this file" onClick={() => void revert(f.path)}>
                  ↺
                </button>
              </div>
            ))}
            <div className="commit-box">
              <textarea rows={3} value={message} placeholder="Describe these changes…" onChange={(e) => setMessage(e.target.value)} />
              <Button tone="primary" disabled={!message.trim()} onClick={commit}>
                Commit all
              </Button>
            </div>
          </>
        )}
      </div>
      <div className="diff-pane" aria-label="Diff">
        {!hasChanges ? (
          <EmptyState icon="changes" title="Nothing to show" />
        ) : diffErrorKey === viewKey && shown === null ? (
          <EmptyState
            icon="changes"
            title="Couldn't load the changes"
            action={
              <Button
                onClick={() => {
                  setDiffErrorKey(null)
                  setDiffTry((n) => n + 1)
                }}
              >
                Try again
              </Button>
            }
          />
        ) : shown === null ? (
          <div className="pad">
            <Skeleton lines={8} label="Loading the changes" />
          </div>
        ) : shown.trim() ? (
          <DiffView key={viewKey} diff={shown} />
        ) : (
          <EmptyState icon="changes" title="No differences to show" />
        )}
      </div>
    </div>
  )
}
