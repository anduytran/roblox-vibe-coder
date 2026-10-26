import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileListing, FileView, GitStatus, Project } from '@shared/types'
import { CODE_HIDDEN_CHARS, DECEPTIVE_CHARS, FRONT_MATTER, readableNote, revealCodeHidden, revealHidden } from '@shared/text'
import { MAX_MARKDOWN } from '@shared/markdown'
import { attempt, useStore } from '../store'
import { EmptyState } from './EmptyState'
import { SafeText } from './SafeText'
import { Button, Icon, Skeleton, timeAgo } from './ui'

const codeHidden = new RegExp(CODE_HIDDEN_CHARS.source, 'u')
const anyHidden = new RegExp(DECEPTIVE_CHARS.source, 'u')

/**
 * Files that become agents' instructions: every hidden character in them is shown, not just the ones that disguise
 * code. Matched without case, as macOS and Windows find "claude.md" and ".Claude/" too.
 */
const isInstructions = (path: string): boolean => {
  const p = path.toLowerCase()
  return p === 'claude.md' || p.startsWith('.claude/')
}
const reveal = (path: string, text: string): string => (isInstructions(path) ? revealHidden(text) : revealCodeHidden(text))
const showLabel = (): string => (window.hangar.platform === 'darwin' ? 'Show in Finder' : 'Show in folder')

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
  // Bumped to read the open file again (picking it again, Refresh).
  const [readSeq, setReadSeq] = useState(0)
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
    const t = setTimeout(() => {
      loaded.current = true
      void reloadTree()
    }, loaded.current ? 1000 : 0)
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
  }, [project.id, pick, logTick, readSeq])

  const toggle = (path: string): void => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      // Listed again on every open, with any folders still open inside it (the cached listing shows meanwhile):
      // an agent may have changed them while they were closed.
      void loadDir(path)
      for (const p of next) if (p.startsWith(`${path}/`)) void loadDir(p)
    }
    setOpen(next)
  }
  const choose = (path: string): void => {
    if (path === pick) {
      setReadSeq((n) => n + 1)
    } else {
      setPick(path)
      setFile(null)
      setFileError(null)
    }
    // Opening a file shows the folders it's in (key files can be deep).
    const parts = path.split('/')
    const next = new Set(open)
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!next.has(dir)) {
        next.add(dir)
        void loadDir(dir)
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
            <div key={e.path}>
              <button
                className={`files-item ${pick === e.path ? 'files-item-on' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                data-path={e.path}
                data-dir={e.kind === 'dir' ? '1' : undefined}
                aria-expanded={e.kind === 'dir' ? isOpen : undefined}
                aria-current={pick === e.path ? 'true' : undefined}
                aria-label={`${revealHidden(e.name)}${e.kind === 'dir' ? ', folder' : ''}${mark ? `, ${mark === '•' ? 'has uncommitted changes' : `${(CHANGE[mark] ?? mark).toLowerCase()}, not committed`}` : ''}`}
                title={revealHidden(e.path)}
                onClick={() => (e.kind === 'dir' ? toggle(e.path) : choose(e.path))}
              >
                <span className="files-caret" aria-hidden>
                  {e.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}
                </span>
                <span className="files-name">{revealHidden(e.name)}</span>
                {mark && (
                  <span aria-hidden className={`files-mark files-mark-${mark === '?' ? 'q' : mark === '•' ? 'dot' : mark}`} title={mark === '•' ? 'Has uncommitted changes' : (CHANGE[mark] ?? mark)}>
                    {mark === '?' ? 'N' : mark}
                  </span>
                )}
              </button>
              {e.kind === 'dir' && isOpen && renderDir(e.path, depth + 1)}
            </div>
          )
        })}
        {(listing.more > 0 || listing.capped) && (
          <div className="small muted files-note" style={{ paddingLeft: 10 + depth * 14 }}>
            {listing.more.toLocaleString()}
            {listing.capped ? '+' : ''} more not shown (open the folder in your editor)
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

  // Arrow keys move through the tree (Tab still works); Right opens a folder, Left closes it or goes to its folder.
  const onTreeKey = (ev: React.KeyboardEvent<HTMLElement>): void => {
    const items = [...ev.currentTarget.querySelectorAll<HTMLButtonElement>('button.files-item')]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const el = items[at]!
    const path = el.dataset.path
    let to = -1
    if (ev.key === 'ArrowDown') to = Math.min(items.length - 1, at + 1)
    else if (ev.key === 'ArrowUp') to = Math.max(0, at - 1)
    else if (ev.key === 'Home') to = 0
    else if (ev.key === 'End') to = items.length - 1
    else if (ev.key === 'ArrowRight' && path && el.dataset.dir && !open.has(path)) toggle(path)
    else if (ev.key === 'ArrowLeft' && path) {
      if (el.dataset.dir && open.has(path)) toggle(path)
      else if (path.includes('/')) to = items.findIndex((b) => b.dataset.path === path.slice(0, path.lastIndexOf('/')))
    } else return
    ev.preventDefault()
    if (to >= 0) items[to]!.focus()
  }

  const isMarkdown = !!pick && /\.(md|markdown)$/i.test(pick)
  const text = file?.text ?? ''
  const sneaky = !!file?.text && (pick && isInstructions(pick) ? anyHidden : codeHidden).test(file.text)
  // Markdown: front matter is always shown as written (it decides a role's tools and mode); the rest can be formatted.
  // Agents' instruction files are formatted as they are, with no note clean-up, so the page shows what agents read.
  const front = isMarkdown ? (FRONT_MATTER.exec(text)?.[0] ?? '') : ''
  const body = front ? text.slice(front.length) : text
  const formattedText = pick ? reveal(pick, isInstructions(pick) ? body : readableNote(body)) : ''
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
            <button
              className="link small"
              onClick={() => {
                void reloadTree()
                setReadSeq((n) => n + 1)
              }}
            >
              Refresh
            </button>
            <button className="link small" onClick={() => void attempt(() => window.hangar.files.reveal(project.id, ''))}>
              {showLabel()}
            </button>
          </span>
        </div>
        <div className="files-list" aria-label="All files" onKeyDown={onTreeKey}>
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
                  {showLabel()}
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
                  {size(file.size)}. Use {showLabel()} to open it with another app.
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
                    <>
                      {front && <pre className="files-text files-front">{reveal(pick, front)}</pre>}
                      {formattedText.length > MAX_MARKDOWN && <p className="small warn">Formatted shows the first {MAX_MARKDOWN.toLocaleString()} characters. Switch to Plain for all of it.</p>}
                      {/* Revealed before formatting, so the ⟦U+…⟧ marks survive (formatting would drop the characters silently). */}
                      <SafeText className="files-md" text={formattedText} />
                    </>
                  ) : (
                    <pre className="files-text">{reveal(pick, text)}</pre>
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
