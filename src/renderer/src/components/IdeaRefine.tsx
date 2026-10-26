import { useState } from 'react'
import { attempt, closeIdeaRefine, openIdeaChat, openWizard, setTrends, toast, useStore } from '../store'
import { ideaBrief, SaveStar } from './ideas'
import { ideaCategory } from '@shared/ideas'
import { Button, Modal } from './ui'

const SUGGESTIONS = ['Make it co-op', 'Smaller first version', 'Make it more original', 'Add progression', 'More social']

/** One dashboard idea in full, with a box to tell Claude how to change it. Stays open to keep refining. */
export function IdeaRefine() {
  const id = useStore((s) => s.refineIdeaId)
  const ideas = useStore((s) => s.trends?.ideas)
  const saved = useStore((s) => s.trends?.saved)
  const index = ideas?.findIndex((x) => x.id === id) ?? -1
  const idea = (index >= 0 ? ideas![index] : saved?.find((x) => x.id === id)) ?? null
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
      title={index >= 0 ? `Idea ${index + 1}` : 'Saved idea'}
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
          <Button tone="ghost" onClick={() => openIdeaChat(`Let's develop “${idea.title}”: ${idea.pitch} `, idea.category)}>
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
          <span className="row gap-xs small muted">
            {ideaCategory(idea.category).label} · {idea.genre} · {idea.scope} · score {idea.score}
            <SaveStar idea={idea} />
          </span>
        </div>
        <p>{idea.pitch}</p>
        {idea.detailed ? (
          <dl className="refine-facts">
            {idea.coreLoop && (
              <>
                <dt>Core loop</dt>
                <dd>{idea.coreLoop}</dd>
              </>
            )}
            {idea.features && idea.features.length > 0 && (
              <>
                <dt>Key features</dt>
                <dd>
                  <ul className="refine-list">
                    {idea.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {idea.firstVersion && (
              <>
                <dt>Build first</dt>
                <dd>{idea.firstVersion}</dd>
              </>
            )}
            {idea.whyNow && (
              <>
                <dt>Why now</dt>
                <dd>{idea.whyNow}</dd>
              </>
            )}
            {idea.inspiredBy.length > 0 && (
              <>
                <dt>Space it plays in</dt>
                <dd>{idea.inspiredBy.join(', ')}</dd>
              </>
            )}
          </dl>
        ) : (
          <div className="refine-expand">
            <p className="small muted">This is the short version. Generate the core loop, key features and what to build first, or ask for a change below and the details come with it.</p>
            <Button tone="primary" disabled={busy} onClick={() => refine('Fill in the full details. Keep the concept as it is.')}>
              {busy ? 'Generating…' : 'Generate details'}
            </Button>
          </div>
        )}
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
