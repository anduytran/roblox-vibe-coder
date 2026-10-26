import { useEffect, useMemo, useRef, useState } from 'react'
import { getState, openPage, openSettings, openWizard, PROJECT_TABS, selectProject, setInboxOpen, setProjectTab, useStore, type ProjectTab } from '../store'
import { Avatar, Icon, Modal, useEscape } from './ui'

const mac = (): boolean => window.hangar.platform === 'darwin'
/** "⌘" on macOS, "Ctrl+" elsewhere. */
export const modKey = (): string => (mac() ? '⌘' : 'Ctrl+')

const TAB_LABEL: Record<ProjectTab, string> = {
  overview: 'Overview',
  design: 'Design',
  agents: 'Agents',
  models: '3D',
  reviews: 'Reviews',
  changes: 'Changes',
  files: 'Files',
  settings: 'Project'
}

/** Typing in a field: plain keys like "?" belong to the field. */
const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
/** A dialog is open: shortcuts wait until it's answered (each dialog handles its own Esc). */
const dialogOpen = (): boolean => !!document.querySelector('.modal-backdrop')

/** The letter or comma pressed, by its place on the keyboard when the layout isn't Latin (Cyrillic, Greek…). */
function keyOf(e: KeyboardEvent): string {
  if (/^[\x20-\x7e]$/.test(e.key)) return e.key.toLowerCase()
  return ({ KeyK: 'k', KeyI: 'i', Comma: ',' } as Record<string, string>)[e.code] ?? e.key
}

/** 1–9 from the number row (by position, so AZERTY works) or the numpad with NumLock on (else it's End, arrows…). */
function digitOf(e: KeyboardEvent): number | null {
  const row = /^Digit([1-9])$/.exec(e.code)
  if (row) return Number(row[1])
  return /^Numpad[1-9]$/.test(e.code) && /^[1-9]$/.test(e.key) ? Number(e.key) : null
}

/**
 * App-wide shortcuts: Cmd/Ctrl+1…8 project tabs, Cmd/Ctrl+K switcher, Cmd/Ctrl+I Inbox, Cmd/Ctrl+, Settings, ? this list.
 * Cmd on macOS, Ctrl elsewhere. Nothing fires underneath an open dialog, except Cmd/Ctrl+K closing the switcher.
 */
export function useShortcuts(opts: { switcherOpen: boolean; setSwitcher: (open: boolean) => void; setHelp: (open: boolean) => void }): void {
  const { switcherOpen, setSwitcher, setHelp } = opts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = mac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      const key = keyOf(e)
      if (mod && !e.shiftKey && !e.altKey && key === 'k') {
        e.preventDefault()
        // Holding the keys down repeats them: toggle once per press.
        if (e.repeat) return
        if (switcherOpen) setSwitcher(false)
        else if (!dialogOpen()) setSwitcher(true)
        return
      }
      if (dialogOpen()) return
      if (mod && !e.altKey && !e.shiftKey) {
        const digit = digitOf(e)
        if (digit) {
          const tab = PROJECT_TABS[digit - 1]
          if (tab && getState().selectedProjectId) {
            e.preventDefault()
            // Fields save when they lose focus; switching tabs unmounts them without that, so blur first.
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
            setProjectTab(tab)
          }
          return
        }
        if (key === 'i') {
          e.preventDefault()
          if (!e.repeat) setInboxOpen(!getState().inboxOpen)
          return
        }
        if (key === ',') {
          e.preventDefault()
          openSettings()
          return
        }
      }
      if (e.key === '?' && !mod && !e.altKey && !typing(e.target)) {
        e.preventDefault()
        setHelp(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [switcherOpen, setSwitcher, setHelp])
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const m = modKey()
  const rows: [string, string][] = [
    [`${m}K`, 'Go to a game or page'],
    [`${m}1 … ${m}${PROJECT_TABS.length}`, `Project tabs: ${PROJECT_TABS.map((t) => TAB_LABEL[t]).join(', ')}`],
    [`${m}I`, 'Open or close the Inbox'],
    [`${m},`, 'Settings'],
    ['Esc', 'Close the open panel or dialog'],
    ['?', 'This list']
  ]
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="shortcut-list">
        {rows.map(([k, what]) => (
          <div key={k} className="shortcut-row">
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}

interface Target {
  key: string
  label: string
  hint: string
  icon?: string
  avatar?: string
  go: () => void
}

/** Cmd/Ctrl+K: a short list of your games and Hangar's pages; type to filter, arrows and Enter to go. */
export function Switcher({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects)
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<Element | null>(document.activeElement)
  useEscape(onClose)
  useEffect(() => {
    input.current?.focus()
    const back = opener.current
    // Focus goes back where it was when the switcher closes without going anywhere.
    return () => {
      if (back instanceof HTMLElement && document.contains(back) && !document.querySelector('.modal-backdrop')) back.focus()
    }
  }, [])

  const targets = useMemo<Target[]>(() => {
    const pages: Target[] = [
      { key: 'home', label: 'Home', hint: 'Page', icon: 'home', go: () => openPage('home') },
      { key: 'ideas', label: 'Ideas', hint: 'Page', icon: 'bulb', go: () => openPage('ideas') },
      { key: 'inbox', label: 'Inbox', hint: 'Panel', icon: 'bell', go: () => setInboxOpen(true) },
      { key: 'settings', label: 'Settings', hint: 'App settings', icon: 'gear', go: () => openSettings() },
      { key: 'new', label: 'New game', hint: 'Start a game', icon: 'plus', go: () => openWizard() }
    ]
    const games: Target[] = projects.map((p) => ({ key: `p:${p.id}`, label: p.name, hint: 'Game', avatar: p.name, go: () => selectProject(p.id) }))
    const q = query.trim().toLowerCase()
    const all = [...games, ...pages]
    return q ? all.filter((t) => t.label.toLowerCase().includes(q)) : all
  }, [projects, query])

  useEffect(() => {
    setAt(0)
  }, [query])
  // Keep the highlighted row in view as the arrows move it.
  const current = targets[at]?.key
  useEffect(() => {
    if (current) document.getElementById(`switcher-${current}`)?.scrollIntoView({ block: 'nearest' })
  }, [current])
  const pick = (t: Target | undefined): void => {
    if (!t) return
    onClose()
    // After the switcher's own backdrop is gone, so dialogs and panels it opens aren't refused.
    requestAnimationFrame(() => t.go())
  }

  return (
    <div className="modal-backdrop switcher-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="switcher"
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        // Clicks inside never take focus from the box, so Tab and the arrows keep working.
        onMouseDown={(e) => {
          if (e.target !== input.current) e.preventDefault()
        }}
      >
        <input
          ref={input}
          className="switcher-input"
          value={query}
          placeholder="Go to a game or page…"
          role="combobox"
          aria-expanded="true"
          aria-controls="switcher-list"
          aria-activedescendant={targets[at] ? `switcher-${targets[at]!.key}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter and arrows that finish or pick an IME conversion belong to the IME.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            // The box is the switcher's only control: Tab stays here instead of reaching the page behind it.
            if (e.key === 'Tab') return e.preventDefault()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setAt((i) => Math.min(i + 1, targets.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setAt((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(targets[at])
            }
          }}
        />
        <ul id="switcher-list" className="switcher-list" role="listbox" aria-label="Games and pages">
          {targets.length === 0 && <li className="muted small switcher-none">Nothing matches.</li>}
          {targets.map((t, i) => (
            <li
              key={t.key}
              id={`switcher-${t.key}`}
              role="option"
              aria-selected={i === at}
              className={`switcher-item ${i === at ? 'switcher-item-on' : ''}`}
              onMouseEnter={() => setAt(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(t)
              }}
            >
              {t.avatar ? <Avatar name={t.avatar} /> : <Icon name={t.icon ?? 'home'} />}
              <span className="switcher-label">{t.label}</span>
              <span className="muted small">{t.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
