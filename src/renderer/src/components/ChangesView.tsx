import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitStatus, Project } from '@shared/types'
import { attempt, toast, useStore } from '../store'
import { Button } from './ui'

const STATUS_NAME: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'New', U: 'Conflict' }

function statusLabel(code: string): string {
  const c = code.trim()[0] ?? '?'
  return STATUS_NAME[c] ?? c
}

export function ChangesView({ project }: { project: Project }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  // Refresh whenever any agent in this project finishes a step.
  const logTick = useStore((s) => Object.values(s.agents[project.id] ?? {}).reduce((n, a) => n + a.log.length, 0))

  const refresh = useCallback(async () => {
    setLoading(true)
    const st = await attempt(() => window.hangar.git.status(project.id))
    setLoading(false)
    if (!st) return
    setStatus(st)
    if (file && !st.files.some((f) => f.path === file)) setFile(null)
  }, [project.id, file])

  useEffect(() => {
    // Debounced so a busy agent doesn't trigger a git call per log line.
    const t = setTimeout(() => void refresh(), 600)
    return () => clearTimeout(t)
  }, [refresh, logTick])

  useEffect(() => {
    if (!status?.isRepo || status.files.length === 0) {
      setDiff('')
      return
    }
    void attempt(() => window.hangar.git.diff(project.id, file ?? undefined)).then((d) => setDiff(d ?? ''))
  }, [project.id, file, status])

  const lines = useMemo(() => diff.split('\n'), [diff])

  if (!status) return <div className="empty small">{loading ? 'Loading changes…' : 'Could not read git status.'}</div>

  if (!status.isRepo) {
    return (
      <div className="empty">
        <h2>This folder is not a git repository</h2>
        <p>Git lets you review every change an agent makes and undo anything. Hangar strongly recommends it.</p>
        <Button tone="primary" onClick={() => void attempt(() => window.hangar.git.init(project.id)).then(refresh)}>
          Initialize git here
        </Button>
      </div>
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

  const revert = (path: string): void => {
    const isNew = status.files.find((f) => f.path === path)?.status === '??'
    const msg = isNew
      ? `Move the new file "${path}" to the trash?`
      : `Discard all changes to "${path}" and restore the last committed version?`
    if (!confirm(msg)) return
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
          <p className="muted small">No uncommitted changes. Everything agents did has been committed.</p>
        ) : (
          <>
            <button className={`file-item ${file === null ? 'file-item-active' : ''}`} onClick={() => setFile(null)}>
              All changes
            </button>
            {status.files.map((f) => (
              <div key={f.path} className={`file-item ${file === f.path ? 'file-item-active' : ''}`}>
                <button className="file-name" onClick={() => setFile(f.path)} title={f.path}>
                  <span className={`file-status file-status-${(f.status.trim()[0] ?? 'q').replace('?', 'q')}`}>{statusLabel(f.status)}</span>
                  {f.path}
                </button>
                <button className="icon-btn" title="Discard changes to this file" onClick={() => revert(f.path)}>
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
      <div className="diff" aria-label="Diff">
        {diff ? (
          lines.map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')
                  ? 'd-meta'
                  : l.startsWith('@@')
                    ? 'd-hunk'
                    : l.startsWith('+')
                      ? 'd-add'
                      : l.startsWith('-')
                        ? 'd-del'
                        : 'd-ctx'
              }
            >
              {l || ' '}
            </div>
          ))
        ) : (
          <div className="muted small pad">Select a file to see what changed.</div>
        )}
      </div>
    </div>
  )
}
