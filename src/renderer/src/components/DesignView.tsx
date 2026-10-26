import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project } from '@shared/types'
import { attempt, setProjectTab, useStore } from '../store'
import { EmptyState } from './EmptyState'
import { SafeText } from './SafeText'
import { Button, Skeleton } from './ui'
import { readableNote, revealHidden } from '@shared/text'

type Vault = Awaited<ReturnType<typeof window.hangar.vault.notes>>[number]

/** Drops a first-line "# Title" that only repeats the note's name (shown as the page heading already). */
function dropTitle(text: string, title: string): string {
  const t = text.trimStart()
  const nl = t.indexOf('\n')
  const first = (nl < 0 ? t : t.slice(0, nl)).trim()
  if (!first.startsWith('# ')) return text
  // A loop, not a regex: a long line of '#'s stays linear.
  let end = first.length
  while (end > 2 && (first[end - 1] === '#' || first[end - 1] === ' ')) end--
  return first.slice(2, end).trim().toLowerCase() === title.trim().toLowerCase() ? (nl < 0 ? '' : t.slice(nl + 1)) : text
}

/** The game's design as the Lead keeps it: roadmap, overview, mechanics, decisions. Read-only; edit in Obsidian. */
export function DesignView({ project }: { project: Project }) {
  const [vaults, setVaults] = useState<Vault[] | null>(null)
  const [pick, setPick] = useState<{ folder: string; path: string } | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState(false)
  // Agents keep the vault up to date as they work: look again when any of them logs a step.
  const logTick = useStore((s) =>
    Object.values(s.agents[project.id] ?? {})
      .map((a) => a.log[a.log.length - 1]?.id ?? '')
      .join('|')
  )

  const load = useCallback(() => {
    void attempt(() => window.hangar.vault.notes(project.id)).then((v) => {
      if (!v) return setError(true)
      setError(false)
      setVaults(v)
      setPick((p) => {
        if (p && v.some((x) => x.folder === p.folder && x.notes.some((n) => n.path === p.path))) return p
        const first = v.find((x) => x.notes.length)
        return first ? { folder: first.folder, path: first.notes[0]!.path } : null
      })
    })
  }, [project.id])
  useEffect(() => {
    const t = setTimeout(load, vaults ? 1000 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, logTick])

  useEffect(() => {
    setMissing(false)
  }, [pick])
  useEffect(() => {
    if (!pick) {
      setText(null)
      return
    }
    let stale = false
    // No error toast: a note that moved, or isn't on the branch now checked out, just says so here.
    window.hangar.vault.read(project.id, pick.folder, pick.path).then(
      (t) => {
        if (stale) return
        setMissing(false)
        setText(t)
      },
      () => {
        if (stale) return
        setText(null)
        setMissing(true)
        load()
      }
    )
    return () => {
      stale = true
    }
  }, [project.id, pick, logTick, load])

  const note = pick ? vaults?.find((v) => v.folder === pick.folder)?.notes.find((n) => n.path === pick.path) : undefined
  const title = note?.title ?? pick?.path.replace(/\.md$/i, '').split('/').pop() ?? ''
  const shown = useMemo(() => (text === null ? null : dropTitle(readableNote(text), title)), [text, title])

  if (error && !vaults) return <EmptyState icon="book" title="Couldn't read the design notes" action={<Button onClick={load}>Try again</Button>} />
  if (!vaults) return <div className="pad"><Skeleton lines={6} label="Loading the design notes" /></div>
  if (!vaults.some((v) => v.notes.length)) {
    return (
      <EmptyState icon="book" title="No design notes yet" action={<Button onClick={() => setProjectTab('settings')}>Set up vaults in the Project tab</Button>}>
        The Lead keeps the game's design here (overview, mechanics, roadmap, decisions) once its vault is set up. Projects made with New game have one from the start.
      </EmptyState>
    )
  }

  return (
    <div className="design">
      <nav className="design-list" aria-label="Design notes">
        {vaults
          .filter((v) => v.notes.length)
          .map((v) => (
            <div key={v.folder} className="design-vault">
              <div className="row between">
                <span className="side-label">
                  {v.kind === 'design' ? 'Game design' : 'UI'} · {revealHidden(v.role)}
                </span>
                <button className="link small" onClick={() => void attempt(() => window.hangar.vault.open(project.id, v.folder))}>
                  Open in Obsidian
                </button>
              </div>
              {v.notes.map((n) => {
                const on = pick?.folder === v.folder && pick.path === n.path
                const sub = n.path.includes('/') ? n.path.split('/')[0]! : ''
                return (
                  <button
                    key={n.path}
                    className={`file-item design-note ${on ? 'file-item-active' : ''}`}
                    title={revealHidden(n.path)}
                    aria-current={on ? 'true' : undefined}
                    onClick={() => setPick({ folder: v.folder, path: n.path })}
                  >
                    {sub && sub !== n.title && <span className="muted">{revealHidden(sub)} / </span>}
                    {revealHidden(n.title)}
                  </button>
                )
              })}
            </div>
          ))}
      </nav>
      <article className="design-note-body">
        {pick && <h2>{revealHidden(title)}</h2>}
        {missing ? (
          <p className="muted">This note was moved or isn't on the current branch.</p>
        ) : shown === null ? (
          <Skeleton lines={8} label="Loading the note" />
        ) : shown.trim() ? (
          <SafeText text={shown} />
        ) : (
          <p className="muted">This note is empty.</p>
        )}
        <p className="small muted design-hint">Read-only here. Edit it in Obsidian, or ask the Lead to update it.</p>
      </article>
    </div>
  )
}
