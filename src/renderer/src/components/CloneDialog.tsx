import { useEffect, useState } from 'react'
import { addCreatedProject, attempt, toast } from '../store'
import { Button, Field, Modal } from './ui'

/** Download a game from GitHub into a new folder and open it, already linked for Push and Pull. */
export function CloneDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void attempt(() => window.hangar.system.tools()).then((t) => t && setParentDir((d) => d || t.defaultParent))
  }, [])

  const clone = (): void => {
    if (!url.trim() || busy) return
    setBusy(true)
    void attempt(async () => {
      const project = await window.hangar.github.clone(url, parentDir || undefined)
      await addCreatedProject(project)
      toast(`Downloaded ${project.name}. It's linked to GitHub for Push and Pull.`)
      onClose()
    }).finally(() => setBusy(false))
  }

  return (
    <Modal
      title="Clone from GitHub"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span className="spacer" />
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" onClick={clone} disabled={!url.trim() || busy}>
            {busy ? 'Downloading…' : 'Clone'}
          </Button>
        </>
      }
    >
      <Field label="Repository link" hint="https or ssh. Private repositories work if git can already sign in to GitHub (for example after gh auth login).">
        <input
          value={url}
          autoFocus
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && clone()}
          placeholder="https://github.com/you/my-game"
        />
      </Field>
      <Field label="Download into">
        <div className="row gap-xs">
          <span className="small muted clone-dir">{parentDir || '…'}</span>
          <Button size="sm" disabled={busy} onClick={() => void attempt(async () => setParentDir((await window.hangar.projects.pickFolder()) ?? parentDir))}>
            Change…
          </Button>
        </div>
      </Field>
    </Modal>
  )
}
