import { useEffect, useState } from 'react'
import type { GitStatus } from '@shared/types'
import { revealHidden } from '@shared/text'
import { attempt, closeUncommitted, confirmDialog, toast, useStore } from '../store'
import { Button, Field, Modal, Skeleton } from './ui'

const LABEL: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'New', U: 'Conflict' }

/**
 * Something couldn't switch branches (Try it in Studio, starting a task…) because the game folder has uncommitted
 * changes: here they are, to commit or discard on the spot. Then the blocked action runs again.
 */
export function UncommittedDialog() {
  const req = useStore((s) => s.uncommitted)
  const project = useStore((s) => s.projects.find((p) => p.id === req?.projectId) ?? null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [message, setMessage] = useState('Changes made outside Hangar')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!req) return
    setStatus(null)
    void attempt(() => window.hangar.git.status(req.projectId)).then((s) => {
      if (s) setStatus(s)
    })
  }, [req])

  if (!req || !project) return null
  const onTask = !!status?.branch?.startsWith('hangar/')
  const finish = async (ok: string): Promise<void> => {
    toast(ok)
    const retry = req.retry
    closeUncommitted()
    if (retry) await attempt(retry)
  }
  const commit = (): void => {
    setBusy(true)
    void attempt(async () => {
      await window.hangar.git.commit(project.id, message)
      await finish('Committed.')
    }).finally(() => setBusy(false))
  }
  const discard = (): void => {
    if (!status) return
    void confirmDialog({
      title: 'Discard these changes?',
      body: 'Edited files go back to their last commit. New files go to the Trash, so you can still get them back.',
      confirmLabel: 'Discard',
      tone: 'danger'
    }).then((ok) => {
      if (!ok) return
      setBusy(true)
      void attempt(async () => {
        for (const f of status.files) await window.hangar.git.revertFile(project.id, f.path)
        await finish('Discarded.')
      }).finally(() => setBusy(false))
    })
  }

  return (
    <Modal
      title="Uncommitted changes"
      onClose={closeUncommitted}
      footer={
        <>
          <Button tone="danger" disabled={busy || !status?.files.length} onClick={discard}>
            Discard
          </Button>
          <span className="spacer" />
          <Button tone="ghost" onClick={closeUncommitted}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy || !status?.files.length || !message.trim()} onClick={commit}>
            {onTask ? `Commit to ${status!.branch}` : 'Commit them'}
          </Button>
        </>
      }
    >
      <p className="small muted">
        {revealHidden(project.name)}'s folder has changes that aren't committed, so Hangar can't switch branches without risking them.
        {req.retry ? ' Commit or discard them, and it carries on with what you asked.' : ''}
      </p>
      {onTask && (
        <p className="small warn">
          The folder is on an agent's task branch ({status!.branch}): committing puts these changes into that task's review. To keep them separate, use Back to main
          in Reviews first.
        </p>
      )}
      {!status ? (
        <Skeleton lines={3} label="Loading the changes" />
      ) : status.files.length === 0 ? (
        <p className="small">Nothing is uncommitted any more.</p>
      ) : (
        <ul className="uncommitted-list">
          {status.files.slice(0, 50).map((f) => (
            <li key={f.path}>
              <span className="file-status">{LABEL[f.status.trim()[0] ?? '?'] ?? f.status}</span>
              <code>{revealHidden(f.path)}</code>
            </li>
          ))}
          {status.files.length > 50 && <li className="muted small">…and {status.files.length - 50} more (see the Changes tab)</li>}
        </ul>
      )}
      <Field label="Commit message">
        <input value={message} maxLength={200} onChange={(e) => setMessage(e.target.value)} />
      </Field>
    </Modal>
  )
}
