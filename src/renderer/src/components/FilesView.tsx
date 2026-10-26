import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileListing, FileView, GitStatus, Project } from '@shared/types'
import { CODE_HIDDEN_CHARS, readableNote, revealCodeHidden, revealHidden } from '@shared/text'
import { attempt, useStore } from '../store'
import { EmptyState } from './EmptyState'
import { SafeText } from './SafeText'
import { Button, Icon, Skeleton, timeAgo } from './ui'

const codeHidden = new RegExp(CODE_HIDDEN_CHARS.source, 'u')

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** "M", "A", "?" → what the Changes tab calls them. */
const CHANGE: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'New', U: 'Conflict' }

/** Files worth finding first: the instructions every agent gets, the roles, the Rojo project and the design notes. */
function keyFiles(root: FileListing | undefined, roles: FileListing | undefined): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = []
  const has = (name: string): boolean => !!root?.entries.some((e) => e.name === name)
  if (has('CLAUDE.md')) out.push({ label: 'CLAUDE.md (instructions for every agent)', path: 'CLAUDE.md' })
  const rojo = root?.entries.find((e) => e.kind === 'file' && /\.project\.json$/i.test(e.name))
  if (rojo) out.push({ label: `${rojo.name} (Rojo project)`, path: rojo.path })
  for (const r of roles?.entries ?? []) if (r.kind === 'file' && /\.md$/i.test(r.name)) out.push({ label: `Role: ${r.name.replace(/\.md$/i, '')}`, path: r.path })
  return out
}

/**
 * The project's files, read-only: a folder tree on the left (loaded one folder at a time by the main process,
 * links and .git never shown) and the chosen file on the right as plain text. Edit files in your editor or ask an agent.
 */
export function FilesView({ project }: { project: Project }) {
  const [dirs, setDirs] = useState<Record<string, FileListing>>({})
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(['']))
  const [pick, setPick] = useState<string | null>(null)
  const [file, setFile] = useState<FileView | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [rootError, setRootError] = useState(false)
  const [changes, setChanges] = useState<Map<string, string>>(new Map())
  const [formatted, setFormatted] = useState(true)
  // Agents change files as they work: look again (open folders and the open file) when any of them logs a step.
  const logTick = useStore((s) =>
    Object.values(s.agents[project.id] ?? {})
      .map((a) => a.log[a.log.length - 1]?.id ?? '')
      .join('|')
  )
  const loaded = useRef(false)
  const openRef = useRef(open)
  openRef.current = open

  const loadDir = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const listing = await window.hangar.files.list(project.id, path)
        setDirs((d) => ({ ...d, [path]: listing }))
        return true
      } catch {
        // Gone (moved, deleted, or now a link): forget it and close it.
        setDirs((d) => {
          const next = { ...d }
          delete next[path]
          return next
        })
        setOpen((o) => {
          const next = new Set(o)
          next.delete(path)
          return next
        })
        return false
      }
    },
    [project.id]
  )

  const loadChanges = useCallback(async () => {
    // Uncommitted changes get a mark in the tree (no repo, or a repo Hangar won't run git in: no marks).
    const st: GitStatus | null = await window.hangar.git.status(project.id).catch(() => null)
    setChanges(new Map((st?.files ?? []).map((f) => [f.path, f.status.trim()[0] ?? '?'])))
  }, [project.id])

  // The whole visible tree, again.
  const reloadTree = useCallback(async () => {
    const ok = await loadDir('')
    setRootError(!ok)
    await Promise.all([...openRef.current].filter((p) => p !== '').map((p) => loadDir(p)))
    void loadDir('.claude/agents')
    void loadChanges()
  }, [loadDir, loadChanges])

  useEffect(() => {
    const t = setTimeout(() => void reloadTree(), loaded.current ? 1000 : 0)
    loaded.current = true
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, logTick])

  useEffect(() => {
    if (!pick) {
      setFile(null)
      return
    }
    let stale = false
    window.hangar.files.read(project.id, pick).then(
      (f) => {
        if (stale) return
        setFile(f)
        setFileError(null)
      },
      () => {
        if (stale) return
        setFile(null)
        setFileError("This file was moved or deleted, or it's a link (Hangar doesn't follow links).")
      }
    )
    return () => {
      stale = true
    }
  }, [project.id, pick, logTick])

  const toggle = (path: string): void => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (!dirs[path]) void loadDir(path)
    }
    setOpen(next)
  }
  const choose = (path: string): void => {
    setPick(path)
    setFile(null)
    setFileError(null)
    // Opening a file shows the folders it's in (key files can be deep).
    const parts = path.split('/')
    const next = new Set(open)
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!next.has(dir)) {
        next.add(dir)
        if (!dirs[dir]) void loadDir(dir)
      }
    }
    setOpen(next)
  }

  // A folder holds a change if any changed path is inside it.
  const changedDirs = useMemo(() => {
    const set = new Set<string>()
    for (const p of changes.keys()) {
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'))
    }
    return set
  }, [changes])

  const key = useMemo(() => keyFiles(dirs[''], dirs['.claude/agents']), [dirs])

  if (rootError && !dirs['']) {
    return <EmptyState icon="folder" title="Couldn't read the project folder" action={<Button onClick={() => void reloadTree()}>Try again</Button>} />
  }
  if (!dirs['']) return <div className="pad"><Skeleton lines={8} label="Loading the project's files" /></div>

  const renderDir = (path: string, depth: number): ReactNode => {
    const listing = dirs[path]
    if (!listing) return <div className="files-loading small muted" style={{ paddingLeft: 10 + depth * 14 }}>Loading…</div>
    return (
      <>
        {listing.entries.map((e) => {
          const isOpen = open.has(e.path)
          const mark = e.kind === 'file' ? changes.get(e.path) : changedDirs.has(e.path) ? '•' : undefined
          return (
            <div key={e.path} role="none">
              <button
                className={`files-item ${pick === e.path ? 'files-item-on' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                role="treeitem"
                aria-expanded={e.kind === 'dir' ? isOpen : undefined}
                aria-selected={pick === e.path}
                title={revealHidden(e.path)}
                onClick={() => (e.kind === 'dir' ? toggle(e.path) : choose(e.path))}
              >
                <span className="files-caret" aria-hidden>
                  {e.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}
                </span>
                <span className="files-name">{revealHidden(e.name)}</span>
                {mark && (
                  <span className={`files-mark files-mark-${mark === '?' ? 'q' : mark === '•' ? 'dot' : mark}`} title={mark === '•' ? 'Has uncommitted changes' : (CHANGE[mark] ?? mark)}>
                    {mark === '?' ? 'N' : mark}
                  </span>
                )}
              </button>
              {e.kind === 'dir' && isOpen && <div role="group">{renderDir(e.path, depth + 1)}</div>}
            </div>
          )
        })}
        {listing.more > 0 && (
          <div className="small muted files-note" style={{ paddingLeft: 10 + depth * 14 }}>
            {listing.more} more not shown
          </div>
        )}
        {listing.entries.length === 0 && (
          <div className="small muted files-note" style={{ paddingLeft: 10 + depth * 14 }}>
            Empty
          </div>
        )}
      </>
    )
  }

  const isMarkdown = !!pick && /\.(md|markdown)$/i.test(pick)
  const text = file?.text ?? ''
  const sneaky = !!file?.text && codeHidden.test(file.text)
  const change = pick ? changes.get(pick) : undefined

  return (
    <div className="files">
      <nav className="files-tree" aria-label="Project files">
        {key.length > 0 && (
          <div className="files-key">
            <span className="side-label">Key files</span>
            {key.map((k) => (
              <button key={k.path} className={`files-item ${pick === k.path ? 'files-item-on' : ''}`} onClick={() => choose(k.path)} title={revealHidden(k.path)}>
                <span className="files-name files-name-sans">{revealHidden(k.label)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="row between files-head">
          <span className="side-label">All files</span>
          <span className="row gap-xs">
            <button className="link small" onClick={() => void reloadTree()}>
              Refresh
            </button>
            <button className="link small" onClick={() => void attempt(() => window.hangar.files.reveal(project.id, ''))}>
              Show in Finder
            </button>
          </span>
        </div>
        <div role="tree" aria-label="All files">
          {renderDir('', 0)}
        </div>
        {dirs['']!.skipped > 0 && <p className="small muted files-note">Links and .git aren't shown.</p>}
      </nav>
      <article className="files-view">
        {!pick ? (
          <EmptyState icon="folder" title="Pick a file">
            Everything in {revealHidden(project.name)}'s folder, read-only. Edit files in your editor, or ask an agent to change them.
          </EmptyState>
        ) : (
          <>
            <header className="files-view-head">
              <div className="files-view-title">
                <h2 title={revealHidden(pick)}>{revealHidden(pick.split('/').pop() ?? pick)}</h2>
                <span className="small muted">
                  {revealHidden(pick)}
                  {file && ` · ${size(file.size)} · changed ${timeAgo(file.mtime)}`}
                  {change && ` · ${CHANGE[change] ?? change} (not committed)`}
                </span>
              </div>
              <span className="row gap-xs">
                {isMarkdown && file?.kind === 'text' && (
                  <div className="segmented segmented-sm" role="group" aria-label="Show as">
                    <button className={`segment ${formatted ? 'segment-on' : ''}`} aria-pressed={formatted} onClick={() => setFormatted(true)}>
                      Formatted
                    </button>
                    <button className={`segment ${!formatted ? 'segment-on' : ''}`} aria-pressed={!formatted} onClick={() => setFormatted(false)}>
                      Plain
                    </button>
                  </div>
                )}
                <Button size="sm" tone="ghost" onClick={() => void attempt(() => window.hangar.files.reveal(project.id, pick))}>
                  <Icon name="folder" />
                  Show in Finder
                </Button>
              </span>
            </header>
            <div className="files-view-body">
              {fileError ? (
                <p className="muted">{fileError}</p>
              ) : !file ? (
                <Skeleton lines={10} label="Loading the file" />
              ) : file.kind === 'binary' ? (
                <EmptyState compact icon="folder" title="Not a text file">
                  {size(file.size)}. Use Show in Finder to open it with another app.
                </EmptyState>
              ) : (
                <>
                  {file.truncated && <p className="small warn">Showing the first 512 KB of {size(file.size)}.</p>}
                  {sneaky && (
                    <p className="small err">
                      This file has invisible or text-direction characters, which can make it read differently from what it does. They're shown as ⟦U+…⟧.
                    </p>
                  )}
                  {!text.trim() ? (
                    <p className="muted">This file is empty.</p>
                  ) : isMarkdown && formatted ? (
                    <SafeText className="files-md" text={readableNote(text)} />
                  ) : (
                    <pre className="files-text">{revealCodeHidden(text)}</pre>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </article>
    </div>
  )
}
