import { useEffect, useState } from 'react'
import type { GitHubLink, Project } from '@shared/types'
import { attempt, confirmDialog, toast } from '../store'
import { Button, Field } from './ui'

/** Link the project to a GitHub repository, and push or pull its main branch. Only from here; agents never push. */
export function GitHubCard({ project }: { project: Project }) {
  const [link, setLink] = useState<GitHubLink | null>(null)
  const [url, setUrl] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'push' | 'pull' | 'link' | null>(null)

  const refresh = (): void => {
    void attempt(() => window.hangar.github.status(project.id)).then((l) => l && setLink(l))
  }
  useEffect(() => {
    refresh()
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = (kind: 'push' | 'pull' | 'link', fn: () => Promise<void>): void => {
    if (busy) return
    setBusy(kind)
    void attempt(fn).finally(() => {
      setBusy(null)
      refresh()
    })
  }

  const save = (): void =>
    run('link', async () => {
      const l = await window.hangar.github.link(project.id, url)
      setLink(l)
      setUrl('')
      setEditing(false)
      toast(`Linked to ${l.repo}.`)
    })

  return (
    <section className="card">
      <h3>GitHub</h3>
      <p className="small muted">
        Keep a copy of the game on GitHub. Push sends your committed work on the current branch; Pull brings in commits made elsewhere. Only you push or pull, from
        here — agents never do, and unreviewed task branches stay on this computer. Git signs in the way it does in your terminal (for example after{' '}
        <code>gh auth login</code>).
      </p>
      {link === null ? (
        <p className="small muted">Checking…</p>
      ) : !link.isRepo ? (
        <p className="small muted">This project isn't a git repository yet. Initialize one in the Changes tab, then link it here.</p>
      ) : (
        <>
          {link.repo && !editing ? (
            <div className="row between github-row">
              <span>
                <strong>{link.repo}</strong>
                {link.branch && <span className="muted small"> · branch {link.branch}</span>}
              </span>
              <div className="row gap-xs">
                <Button size="sm" onClick={() => link.webUrl && void attempt(() => window.hangar.system.openUrl(link.webUrl!))}>
                  Open on GitHub
                </Button>
                <Button size="sm" onClick={() => setEditing(true)}>
                  Change
                </Button>
                <Button
                  size="sm"
                  tone="ghost"
                  onClick={() =>
                    void confirmDialog({
                      title: `Unlink ${link.repo}?`,
                      body: 'Hangar forgets the link on this computer. Nothing on GitHub is changed or deleted.',
                      confirmLabel: 'Unlink'
                    }).then((ok) => ok && run('link', async () => setLink(await window.hangar.github.unlink(project.id))))
                  }
                >
                  Unlink
                </Button>
              </div>
            </div>
          ) : (
            <Field
              label="Repository link"
              hint={
                link.otherRemote
                  ? `This project's origin is ${link.otherRemote}, which isn't on GitHub. Linking replaces it.`
                  : 'Create an empty repository on GitHub (no README), then paste its link. https and ssh links both work.'
              }
            >
              <div className="row gap-xs">
                <input
                  value={url}
                  autoFocus={editing}
                  spellCheck={false}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && url.trim() && save()}
                  placeholder="https://github.com/you/my-game"
                />
                <Button size="sm" tone="primary" disabled={!url.trim() || busy !== null} onClick={save}>
                  {busy === 'link' ? 'Linking…' : 'Link'}
                </Button>
                {editing && (
                  <Button size="sm" tone="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </Field>
          )}
          {link.repo && !editing && (
            <div className="row gap-xs">
              <Button
                size="sm"
                tone="primary"
                disabled={busy !== null}
                onClick={() =>
                  run('push', async () => {
                    const r = await window.hangar.github.push(project.id)
                    toast(`Pushed ${r.branch} to ${r.repo}.`)
                  })
                }
              >
                {busy === 'push' ? 'Pushing…' : 'Push'}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  run('pull', async () => {
                    const r = await window.hangar.github.pull(project.id)
                    toast(r.commits ? `Pulled ${r.commits} commit${r.commits === 1 ? '' : 's'} from ${r.repo}.` : `Already up to date with ${r.repo}.`)
                  })
                }
              >
                {busy === 'pull' ? 'Pulling…' : 'Pull'}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
