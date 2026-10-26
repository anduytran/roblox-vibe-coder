import { useEffect, useRef, useState } from 'react'
import type { IdeaCategory, IdeaChatMessage } from '@shared/types'
import { IDEA_CATEGORIES } from '@shared/ideas'
import { attempt, closeIdeaChat, confirmDialog, useStore } from '../store'
import { IdeaCard } from './Dashboard'
import { Button, Modal } from './ui'
import { SafeText } from './SafeText'

const STARTERS = [
  'What could I build quickly in a space that isn’t crowded yet?',
  'Mix two trending genres into something new.',
  'I like tycoon and simulator games. What would stand out right now?'
]

/** Brainstorm game ideas with Claude, grounded in what's trending on Roblox. */
export function IdeaChat() {
  const initial = useStore((s) => s.ideaChat?.draft ?? '')
  const startCategory = useStore((s) => s.ideaChat?.category ?? 'trend')
  const [category, setCategory] = useState<IdeaCategory>(startCategory)
  const [messages, setMessages] = useState<IdeaChatMessage[]>([])
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void attempt(async () => setMessages(await window.hangar.ideaChat.get()))
  }, [])
  // Braces matter: scrollIntoView returns a promise in newer Chromium, and an effect must not return one.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' })
  }, [messages, busy])

  const send = (text: string): void => {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setDraft('')
    setMessages((m) => [...m, { id: `pending-${Date.now()}`, role: 'user', text: message, at: Date.now() }])
    void attempt(() => window.hangar.ideaChat.send(message, category))
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
    <Modal
      title="Brainstorm a game"
      wide
      onClose={closeIdeaChat}
      footer={
        <>
          <span className="small muted">Claude sees the current Roblox trends. It can't use tools or touch your projects. Star a brief to save it.</span>
          <span className="spacer" />
          {messages.length > 0 && (
            <Button tone="ghost" disabled={busy} onClick={() => void startOver()}>
              Start over
            </Button>
          )}
        </>
      }
    >
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
    </Modal>
  )
}
