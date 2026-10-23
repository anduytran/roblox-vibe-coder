import { useEffect, useRef, useState } from 'react'
import type { IdeaChatMessage } from '@shared/types'
import { attempt, closeIdeaChat, useStore } from '../store'
import { IdeaCard } from './Dashboard'
import { Button, Modal } from './ui'

const STARTERS = [
  'What could I build quickly in a space that isn’t crowded yet?',
  'Mix two trending genres into something new.',
  'I like tycoon and simulator games. What would stand out right now?'
]

/** Brainstorm game ideas with Claude, grounded in what's trending on Roblox. */
export function IdeaChat() {
  const initial = useStore((s) => s.ideaChat?.draft ?? '')
  const [messages, setMessages] = useState<IdeaChatMessage[]>([])
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void attempt(async () => setMessages(await window.hangar.ideaChat.get()))
  }, [])
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [messages, busy])

  const send = (text: string): void => {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setDraft('')
    setMessages((m) => [...m, { id: `pending-${Date.now()}`, role: 'user', text: message, at: Date.now() }])
    void attempt(() => window.hangar.ideaChat.send(message))
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
  const startOver = (): void => {
    void attempt(async () => setMessages(await window.hangar.ideaChat.clear()))
  }

  return (
    <Modal
      title="Brainstorm a game"
      wide
      onClose={closeIdeaChat}
      footer={
        <>
          <span className="small muted">Claude sees the current Roblox trends. It can't use tools or touch your projects. About $0.01–0.05 a reply.</span>
          <span className="spacer" />
          {messages.length > 0 && (
            <Button tone="ghost" disabled={busy} onClick={startOver}>
              Start over
            </Button>
          )}
        </>
      }
    >
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
            <div className="chat-bubble">{m.text}</div>
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
