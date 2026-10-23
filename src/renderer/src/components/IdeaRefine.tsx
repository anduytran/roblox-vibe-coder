import { useState } from 'react'
import { attempt, closeIdeaRefine, openIdeaChat, openWizard, setTrends, toast, useStore } from '../store'
import { ideaBrief } from './Dashboard'
import { Button, Modal } from './ui'

const SUGGESTIONS = ['Make it co-op', 'Smaller scope for a first version', 'A spookier theme', 'Add a progression system', 'Make it more social']

/** One dashboard idea in full, with a box to tell Claude how to change it. Stays open to keep refining. */
export function IdeaRefine() {
  const id = useStore((s) => s.refineIdeaId)
  const ideas = useStore((s) => s.trends?.ideas)
  const index = ideas?.findIndex((x) => x.id === id) ?? -1
  const idea = index >= 0 ? ideas![index]! : null
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)

  if (!idea) return null

  const refine = (text: string): void => {
    const ask = text.trim()
    if (!ask || busy) return
    setBusy(true)
    void attempt(async () => {
      setTrends(await window.hangar.trends.refineIdea(idea.id, ask))
      setRequest('')
      toast('Idea updated.')
    }).finally(() => setBusy(false))
  }
  const undo = (): void => void attempt(async () => setTrends(await window.hangar.trends.undoRefine(idea.id)))

  return (
    <Modal
      title={`Idea ${index + 1}`}
      wide
      onClose={closeIdeaRefine}
      footer={
        <>
          {idea.previous && (
            <Button tone="ghost" disabled={busy} onClick={undo}>
              Undo last change
            </Button>
          )}
          <span className="spacer" />
          <Button tone="ghost" onClick={() => openIdeaChat(`Let's develop idea ${index + 1}, “${idea.title}”. `)}>
            Discuss in chat
          </Button>
          <Button tone="primary" onClick={() => openWizard(ideaBrief(idea))}>
            Create this game
          </Button>
        </>
      }
    >
      <div key={idea.title} className={`refine-idea ${busy ? 'refine-busy' : ''}`}>
        <div className="row between gap-sm">
          <h3 className="refine-title">{idea.title}</h3>
          <span className="small muted">
            Score {idea.score} · {idea.genre} · {idea.scope} scope
          </span>
        </div>
        <p>{idea.pitch}</p>
        <dl className="refine-facts">
          <dt>Core loop</dt>
          <dd>{idea.coreLoop}</dd>
          <dt>Why now</dt>
          <dd>{idea.whyNow}</dd>
          {idea.inspiredBy.length > 0 && (
            <>
              <dt>Space it plays in</dt>
              <dd>{idea.inspiredBy.join(', ')}</dd>
            </>
          )}
        </dl>
        {idea.previous && <p className="small muted">Before your last change it was “{idea.previous.title}”.</p>}
      </div>

      <div className="refine-ask">
        <label className="small" htmlFor="refine-request">
          How should it change?
        </label>
        <textarea
          id="refine-request"
          rows={3}
          autoFocus
          value={request}
          disabled={busy}
          placeholder="e.g. make it co-op, set it underwater, cut it down to one map…"
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              refine(request)
            }
          }}
        />
        <div className="row between gap-sm refine-row">
          <div className="chat-starters refine-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chat-starter" disabled={busy} onClick={() => refine(s)}>
                {s}
              </button>
            ))}
          </div>
          <Button tone="primary" disabled={busy || !request.trim()} onClick={() => refine(request)}>
            {busy ? 'Refining…' : 'Refine'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
