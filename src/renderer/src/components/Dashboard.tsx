import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { AutopilotState, GameIdea, IdeaCategory, Project, TrendingGame } from '@shared/types'
import { IDEA_CATEGORIES, ideaCategory } from '@shared/ideas'
import { attempt, openIdeaChat, openIdeaRefine, openWizard, selectProject, setTrends, toast, useStore } from '../store'
import { Avatar, Button, Icon, planLine, Skeleton, timeAgo, usd } from './ui'
import { EmptyState } from './EmptyState'

const STALE_MS = 6 * 3600 * 1000

export const AUTOPILOT_LABEL: Record<AutopilotState['status'], string> = {
  off: 'Autopilot off',
  running: 'Building',
  waiting: 'Needs your review',
  checkin: 'Check-in ready',
  paused: 'Paused'
}

/** Home: what needs you, your games, and what's trending on Roblox right now. */
export function Dashboard() {
  const projects = useStore((s) => s.projects)
  const autopilot = useStore((s) => s.autopilot)
  const approvals = useStore((s) => s.approvals)
  const trends = useStore((s) => s.trends)
  const costs = useStore((s) => s.costs)
  const onMax = useStore((s) => s.settings?.authMode === 'max')
  const [loading, setLoading] = useState<'refresh' | 'ideas' | null>(null)
  const [category, setCategory] = useState<IdeaCategory>('trend')
  const [ideaTab, setIdeaTab] = useState<'ideas' | 'saved'>('ideas')

  useEffect(() => {
    if (!trends?.fetchedAt || Date.now() - trends.fetchedAt > STALE_MS) refresh(false)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = (announce = true): void => {
    setLoading('refresh')
    void attempt(async () => {
      const t = await window.hangar.trends.refresh()
      setTrends(t)
      if (announce && !t.error) toast('Trending games updated.')
    }).finally(() => setLoading(null))
  }
  const ideas = (): void => {
    setLoading('ideas')
    setIdeaTab('ideas')
    void attempt(async () => setTrends(await window.hangar.trends.ideas(category))).finally(() => setLoading(null))
  }

  const needsYou = useMemo(() => {
    const items: { project: Project; text: string; tone: 'amber' | 'live' }[] = []
    for (const p of projects) {
      const ap = autopilot[p.id]
      if (ap?.status === 'checkin') items.push({ project: p, text: `Sprint ${ap.sprint} check-in is ready`, tone: 'live' })
      else if (ap?.status === 'waiting') items.push({ project: p, text: ap.reason ?? 'A task needs your review', tone: 'amber' })
      else if (ap?.status === 'paused' && ap.reason && !/by you/i.test(ap.reason)) items.push({ project: p, text: `Autopilot paused: ${ap.reason}`, tone: 'amber' })
      const waiting = approvals.filter((a) => a.projectId === p.id).length
      if (waiting) items.push({ project: p, text: `${waiting} action${waiting === 1 ? '' : 's'} waiting for approval`, tone: 'amber' })
    }
    return items
  }, [projects, autopilot, approvals])

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h1>Home</h1>
          <p className="muted">
            {onMax ? `Claude plan: ${planLine(costs.plan)}` : `${usd(costs.todayUsd)} spent today`} across {projects.length} game{projects.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button tone="primary" onClick={() => openWizard()}>
          <Icon name="plus" />
          New game
        </Button>
      </header>

      {needsYou.length > 0 && (
        <section className="home-section">
          <h2>Needs you</h2>
          <div className="needs-list">
            {needsYou.map((n, i) => (
              <button key={i} className={`needs-item needs-${n.tone}`} onClick={() => selectProject(n.project.id)}>
                <Avatar name={n.project.name} />
                <span className="needs-text">
                  <strong>{n.project.name}</strong>
                  <span>{n.text}</span>
                </span>
                <span className="muted small">Open</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="home-section">
        <h2>Your games</h2>
        <div className="game-grid">
          {projects.map((p) => (
            <GameCard key={p.id} project={p} ap={autopilot[p.id]} spent={costs.projectTotalUsd[p.id] ?? 0} />
          ))}
          <button className="game-card game-card-new" onClick={() => openWizard()}>
            <Icon name="plus" size={20} />
            <strong>New game</strong>
            <span className="muted small">Describe an idea; agents build it in sprints.</span>
          </button>
        </div>
      </section>

      <section className="home-section">
        <div className="row between">
          <div>
            <h2>What's trending on Roblox</h2>
            <p className="muted small">
              Scored for opportunity: demand (growth, chart position, freshness, likes, players) reduced by how saturated each game space is.
              {trends?.fetchedAt ? ` Updated ${timeAgo(trends.fetchedAt)}.` : ''}
            </p>
          </div>
          <Button size="sm" disabled={loading !== null} onClick={() => refresh()}>
            {loading === 'refresh' ? 'Updating…' : 'Refresh'}
          </Button>
        </div>
        {trends?.error && <p className="small warn">{trends.error}</p>}

        <div className="trend-layout">
          <div className="trend-col">
            <div className="row between">
              <div className="segmented segmented-sm" role="tablist" aria-label="Ideas">
                <button role="tab" aria-selected={ideaTab === 'ideas'} className={`segment ${ideaTab === 'ideas' ? 'segment-on' : ''}`} onClick={() => setIdeaTab('ideas')}>
                  Ideas
                </button>
                <button role="tab" aria-selected={ideaTab === 'saved'} className={`segment ${ideaTab === 'saved' ? 'segment-on' : ''}`} onClick={() => setIdeaTab('saved')}>
                  Saved{trends?.saved.length ? ` (${trends.saved.length})` : ''}
                </button>
              </div>
              <Button size="sm" tone="ghost" disabled={!trends?.games.length} onClick={() => openIdeaChat('', category)} title="Chat with Claude about game ideas of the chosen kind">
                Brainstorm
              </Button>
            </div>
            <div className="row gap-xs idea-controls">
              <select value={category} aria-label="Kind of ideas" title={ideaCategory(category).hint} onChange={(e) => setCategory(e.target.value as IdeaCategory)}>
                {IDEA_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <Button size="sm" tone={trends?.ideas.length ? 'ghost' : 'default'} disabled={loading !== null || !trends?.games.length} onClick={ideas}>
                {loading === 'ideas' ? 'Thinking…' : trends?.ideas.length ? 'New ideas' : 'Generate ideas'}
              </Button>
            </div>
            <p className="small muted">{ideaCategory(category).hint}.</p>
            {ideaTab === 'saved' ? (
              trends?.saved.length ? (
                trends.saved.map((idea) => <IdeaCard key={idea.id} idea={idea} />)
              ) : (
                <EmptyState compact icon="review" title="No saved ideas">
                  Star an idea to keep it here. Saved ideas stay when you get new ones.
                </EmptyState>
              )
            ) : trends?.ideas.length ? (
              trends.ideas.map((idea, i) => <IdeaCard key={idea.id} idea={idea} rank={i + 1} />)
            ) : (
              <EmptyState compact icon="plus" title="No ideas yet">
                Pick a kind of idea and Claude suggests six short concepts. Open one to fill in the details.
              </EmptyState>
            )}
            {trends && trends.genres.length > 0 && (
              <>
                <h3 className="space-head">Game spaces</h3>
                <div className="space-list">
                  {trends.genres.map((g) => (
                    <div key={g.genre} className="space-row" title={`Demand ${g.demand} · saturation ${g.saturation} · ${g.games} charting · led by ${g.leader}`}>
                      <span className="space-name">{g.genre}</span>
                      <SaturationTag value={g.saturation} />
                      <ScoreBar value={g.score} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="trend-col trend-table-wrap">
            <h3>Trending games</h3>
            {trends?.games.length ? (
              <table className="trend-table">
                <thead>
                  <tr>
                    <th aria-label="Rank" />
                    <th>Game</th>
                    <th className="num">Playing</th>
                    <th>Space</th>
                    <th className="num">Score</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {trends.games.slice(0, 25).map((g, i) => (
                    <TrendRow key={g.universeId} game={g} rank={i + 1} />
                  ))}
                </tbody>
              </table>
            ) : (
              loading === 'refresh' ? (
                <Skeleton lines={6} label="Loading the charts" />
              ) : (
                <EmptyState compact icon="globe" title="No chart data yet" action={<Button size="sm" onClick={() => refresh()}>Load the charts</Button>} />
              )
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function GameCard({ project, ap, spent }: { project: Project; ap: AutopilotState | undefined; spent: number }) {
  const status = ap?.status ?? 'off'
  const report = ap?.reports[ap.reports.length - 1]
  return (
    <button className="game-card" onClick={() => selectProject(project.id)}>
      <div className="row gap-sm">
        <Avatar name={project.name} />
        <strong className="game-card-name">{project.name}</strong>
        <span className={`ap-pill ap-${status}`}>{AUTOPILOT_LABEL[status]}</span>
      </div>
      {ap && ap.status !== 'off' ? (
        <>
          <div className="sprint-meter" aria-label={`Sprint ${ap.sprint}: ${ap.tasksDone} of ${ap.config.sprintTasks} tasks`}>
            {Array.from({ length: ap.config.sprintTasks }, (_, i) => (
              <span key={i} className={i < ap.tasksDone ? 'done' : i === ap.tasksDone && status === 'running' ? 'now' : ''} />
            ))}
          </div>
          <span className="muted small">
            Sprint {ap.sprint} · {ap.tasksDone}/{ap.config.sprintTasks} tasks · {usd(spent)} total
          </span>
        </>
      ) : (
        <span className="muted small">{report ? `Last check-in ${timeAgo(report.at)}` : 'Open it to start autopilot or give agents tasks.'}</span>
      )}
    </button>
  )
}

function ScoreBar({ value }: { value: number }) {
  return (
    <span className="score" title={`Score ${value} of 100`}>
      <span className="score-bar">
        <span style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
      </span>
      <span className="score-n">{value}</span>
    </span>
  )
}

function SaturationTag({ value }: { value: number }) {
  const label = value >= 50 ? 'Crowded' : value >= 25 ? 'Competitive' : 'Open'
  return (
    <span className={`tag ${value >= 50 ? 'tag-err' : value >= 25 ? 'tag-warn' : 'tag-ok'}`} title={`Saturation ${value} of 100`}>
      {label}
    </span>
  )
}

function TrendRow({ game, rank }: { game: TrendingGame; rank: number }) {
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

/** A short idea card. Ideas on the dashboard or in Saved open the refine screen when clicked. */
export function IdeaCard({ idea, rank }: { idea: GameIdea; rank?: number }) {
  const known = useStore((s) => !!(s.trends?.ideas.some((x) => x.id === idea.id) || s.trends?.saved.some((x) => x.id === idea.id)))
  const open = (): void => openIdeaRefine(idea.id)
  return (
    <article
      className={`idea-card ${known ? 'idea-card-click' : ''}`}
      {...(known
        ? {
            role: 'button',
            tabIndex: 0,
            title: idea.detailed ? 'Open to refine this idea' : 'Open to fill in the details',
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
        {rank !== undefined && <span className="idea-rank">{rank}</span>}
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
