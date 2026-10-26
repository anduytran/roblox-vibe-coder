import { useEffect, useRef, useState } from 'react'
import type { IdeaCategory, IdeaChatMessage } from '@shared/types'
import { IDEA_CATEGORIES } from '@shared/ideas'
import { attempt, clearIdeaChatDraft, closeIdeaChat, confirmDialog, useStore } from '../store'
import { IdeaCard } from './ideas'
import { Button, useEscape } from './ui'
import { SafeText } from './SafeText'

const STARTERS = [
  'What could I build quickly in a space that isn’t crowded yet?',
  'Mix two trending genres into something new.',
  'I like tycoon and simulator games. What would stand out right now?'
]

/**
 * A message still being answered. Kept outside the component so leaving the Ideas page (which unmounts the
 * panel) doesn't lose the reply: coming back picks it up again.
 */
let inflight: { text: string; promise: Promise<IdeaChatMessage[] | undefined> } | null = null
const pendingMessage = (text: string): IdeaChatMessage => ({ id: `pending-${Date.now()}`, role: 'user', text, at: Date.now() })

/** Brainstorm game ideas with Claude, grounded in what's trending on Roblox. */
export function IdeaChat() {
  const request = useStore((s) => s.ideaChat)
  const initial = request?.draft ?? ''
  const [category, setCategory] = useState<IdeaCategory>(request?.category ?? 'trend')
  const [messages, setMessages] = useState<IdeaChatMessage[]>([])
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const waiting = inflight
    void attempt(async () => {
      const chat = await window.hangar.ideaChat.get()
      if (alive) setMessages(waiting ? [...chat, pendingMessage(waiting.text)] : chat)
    })
    if (waiting) {
      setBusy(true)
      void waiting.promise
        .then((chat) => {
          if (!alive) return
          if (chat) setMessages(chat)
          else {
            setMessages((m) => m.filter((x) => !x.id.startsWith('pending-')))
            setDraft(waiting.text)
          }
        })
        .finally(() => alive && setBusy(false))
    }
    return () => {
      alive = false
    }
  }, [])
  // Opened again while already open (for example "Discuss in chat" on another idea): take the new draft and kind.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!request) return
    if (request.draft) setDraft(request.draft)
    setCategory(request.category)
  }, [request])
  useEscape(closeIdeaChat)
  // Braces matter: scrollIntoView returns a promise in newer Chromium, and an effect must not return one.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' })
  }, [messages, busy])

  const send = (text: string): void => {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setDraft('')
    clearIdeaChatDraft()
    setMessages((m) => [...m, pendingMessage(message)])
    const promise = attempt(() => window.hangar.ideaChat.send(message, category))
    inflight = { text: message, promise }
    void promise.finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
    void promise
      .then((chat) => {
        if (chat) setMessages(chat)
        else {
          // It failed: drop the unsent message and put it back in the box.
          setMessages((m) => m.filter((x) => !x.id.startsWith('pending-')))
          setDraft(message)
        }
      })
      .finally(() => setBusy(false))
  }
  const startOver = async (): Promise<void> => {
    const ok = await confirmDialog({ title: 'Start over?', body: 'This conversation is cleared. Starred briefs stay in Saved.', confirmLabel: 'Start over', tone: 'danger' })
    if (ok) void attempt(async () => setMessages(await window.hangar.ideaChat.clear()))
  }

  return (
    <aside className="chat-panel" aria-label="Brainstorm">
      <header className="chat-panel-head">
        <h3>Brainstorm</h3>
        <span className="spacer" />
        {messages.length > 0 && (
          <Button size="sm" tone="ghost" disabled={busy} onClick={() => void startOver()}>
            Start over
          </Button>
        )}
        <button className="icon-btn" onClick={closeIdeaChat} aria-label="Close Brainstorm">
          ×
        </button>
      </header>
      <div className="segmented segmented-sm chat-kinds" role="radiogroup" aria-label="Kind of ideas">
        {IDEA_CATEGORIES.map((c) => (
          <button key={c.id} role="radio" aria-checked={category === c.id} title={c.hint} className={`segment ${category === c.id ? 'segment-on' : ''}`} onClick={() => setCategory(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="chat-log">
        {messages.length === 0 && !busy && (
          <div className="chat-empty">
            <p className="muted">Tell Claude what kind of game you'd enjoy making, or start from one of these:</p>
            <div className="chat-starters">
              {STARTERS.map((s) => (
                <button key={s} className="chat-starter" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg chat-${m.role}`}>
            {m.role === 'assistant' ? <SafeText className="chat-bubble" text={m.text} /> : <div className="chat-bubble">{m.text}</div>}
            {m.idea && <IdeaCard idea={m.idea} />}
          </div>
        ))}
        {busy && (
          <div className="chat-msg chat-assistant">
            <div className="chat-bubble muted chat-thinking">Thinking…</div>
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="chat-compose">
        <textarea
          rows={2}
          value={draft}
          autoFocus
          placeholder="Describe what you're after, or ask Claude to turn an idea into a brief…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(draft)
            }
          }}
        />
        <Button tone="primary" disabled={busy || !draft.trim()} onClick={() => send(draft)}>
          Send
        </Button>
      </div>
      <p className="small muted chat-panel-foot">Claude sees the current Roblox trends. It can't use tools or touch your projects. Star a brief to save it.</p>
    </aside>
  )
}
