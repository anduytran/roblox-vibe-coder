import type { KeyboardEvent } from 'react'
import type { GameIdea, TrendingGame } from '@shared/types'
import { ideaCategory } from '@shared/ideas'
import { attempt, openIdeaRefine, openWizard, setTrends, toast, useStore } from '../store'
import { Button } from './ui'

/** Idea and trend pieces shared by Home, the Ideas page, Brainstorm and the refine screen. */

export function ScoreBar({ value }: { value: number }) {
  return (
    <span className="score" title={`Score ${value} of 100`}>
      <span className="score-bar">
        <span style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
      </span>
      <span className="score-n">{value}</span>
    </span>
  )
}

export function SaturationTag({ value }: { value: number }) {
  const label = value >= 50 ? 'Crowded' : value >= 25 ? 'Competitive' : 'Open'
  return (
    <span className={`tag ${value >= 50 ? 'tag-err' : value >= 25 ? 'tag-warn' : 'tag-ok'}`} title={`Saturation ${value} of 100`}>
      {label}
    </span>
  )
}

export function TrendRow({ game, rank }: { game: TrendingGame; rank: number }) {
  const inspire = (): void =>
    openWizard({
      genre: game.genre,
      idea: `An original ${game.genre.toLowerCase()} game for Roblox, in the space where “${game.name}” is doing well (${game.players.toLocaleString()} playing). Don't copy it: find what players love about this kind of game and give it a fresh twist of our own.\n\nWhat it's about: `
    })
  return (
    <tr>
      <td className="muted num">{rank}</td>
      <td className="trend-game">
        <span className="trend-name" title={game.name}>
          {game.name}
        </span>
        <span className="trend-sub">
          {game.lists.map((l) => (l.list === 'top-trending' ? `Trending #${l.rank}` : l.list === 'up-and-coming' ? `Up-and-coming #${l.rank}` : `Top playing #${l.rank}`)).join(' · ')}
          {game.growth !== null ? ` · ${game.growth >= 0 ? '+' : ''}${Math.round(game.growth * 100)}% today` : ''}
        </span>
      </td>
      <td className="num">{game.players.toLocaleString()}</td>
      <td>
        <span className="trend-genre">{game.genre}</span>
        <SaturationTag value={game.parts.saturation} />
      </td>
      <td className="num" title={`Demand ${game.demand} (momentum ${game.parts.momentum}, charts ${game.parts.placement}, freshness ${game.parts.freshness}, likes ${game.parts.approval}, players ${game.parts.scale}) · saturation ${game.parts.saturation}`}>
        <ScoreBar value={game.score} />
      </td>
      <td>
        <Button size="sm" tone="ghost" onClick={inspire} title="Start a new game in this space">
          Use idea
        </Button>
      </td>
    </tr>
  )
}

/** The New game wizard's starting text for an idea. */
export function ideaBrief(idea: GameIdea): { name: string; genre: string; idea: string } {
  const parts = [
    idea.pitch,
    idea.coreLoop && `Core loop: ${idea.coreLoop}`,
    idea.features?.length ? `Key features:\n${idea.features.map((f) => `- ${f}`).join('\n')}` : '',
    idea.firstVersion && `Build first: ${idea.firstVersion}`,
    idea.whyNow && `Why now: ${idea.whyNow}`,
    idea.inspiredBy.length ? `Space it plays in (be original, don't copy): ${idea.inspiredBy.join(', ')}` : ''
  ]
  return { name: idea.title, genre: idea.genre, idea: parts.filter(Boolean).join('\n\n') }
}

/** A star that saves or unsaves an idea. */
export function SaveStar({ idea }: { idea: GameIdea }) {
  const saved = useStore((s) => !!s.trends?.saved.some((x) => x.id === idea.id))
  const toggle = (): void =>
    void attempt(async () => {
      setTrends(await (saved ? window.hangar.trends.unsaveIdea(idea.id) : window.hangar.trends.saveIdea(idea.id)))
      if (!saved) toast(`Saved “${idea.title}”.`)
    })
  return (
    <button className={`star-btn ${saved ? 'star-on' : ''}`} aria-pressed={saved} title={saved ? 'Remove from saved ideas' : 'Save this idea'} onClick={toggle}>
      {saved ? '★' : '☆'}
    </button>
  )
}

/** A short idea card. Ideas in the list or in Saved open the refine screen when clicked (or are picked, in Compare). */
export function IdeaCard({ idea, rank, select }: { idea: GameIdea; rank?: number; select?: { selected: boolean; onToggle: () => void } }) {
  const known = useStore((s) => !!(s.trends?.ideas.some((x) => x.id === idea.id) || s.trends?.saved.some((x) => x.id === idea.id)))
  // In Compare mode a click picks the card instead of opening it.
  const open = (): void => (select ? select.onToggle() : openIdeaRefine(idea.id))
  return (
    <article
      className={`idea-card ${known || select ? 'idea-card-click' : ''} ${select?.selected ? 'idea-card-picked' : ''}`}
      {...(known || select
        ? {
            role: select ? 'checkbox' : 'button',
            'aria-checked': select ? select.selected : undefined,
            tabIndex: 0,
            title: select ? 'Pick this idea to compare' : idea.detailed ? 'Open to refine this idea' : 'Open to fill in the details',
            onClick: open,
            onKeyDown: (e: KeyboardEvent) => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                open()
              }
            }
          }
        : {})}
    >
      <div className="row between gap-sm">
        {select ? (
          <span className={`idea-check ${select.selected ? 'on' : ''}`} aria-hidden>
            {select.selected ? '✓' : ''}
          </span>
        ) : (
          rank !== undefined && <span className="idea-rank">{rank}</span>
        )}
        <h4 className="idea-title">{idea.title}</h4>
        <ScoreBar value={idea.score} />
        {/* The card opens the refine screen; the star and buttons do their own thing. */}
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <SaveStar idea={idea} />
        </span>
      </div>
      <p>{idea.pitch}</p>
      {idea.detailed && idea.coreLoop && (
        <p className="small muted">
          <strong>Loop:</strong> {idea.coreLoop}
        </p>
      )}
      <div className="row between idea-foot">
        <span className="small muted">
          {ideaCategory(idea.category).label} · {idea.genre} · {idea.scope}
          {idea.detailed ? ' · detailed' : ''}
        </span>
        <span className="row gap-xs" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Button size="sm" onClick={() => openWizard(ideaBrief(idea))}>
            Create this game
          </Button>
        </span>
      </div>
    </article>
  )
}
