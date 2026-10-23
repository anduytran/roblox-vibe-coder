import { useEffect, useMemo, useState } from 'react'
import type { AutopilotState, GameIdea, Project, TrendingGame } from '@shared/types'
import { attempt, openIdeaChat, openWizard, selectProject, setTrends, toast, useStore } from '../store'
import { Avatar, Button, Icon, planLine, timeAgo, usd } from './ui'

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
    void attempt(async () => setTrends(await window.hangar.trends.ideas())).finally(() => setLoading(null))
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
              <h3>Ideas for you</h3>
              <div className="row gap-xs">
                <Button size="sm" tone="ghost" disabled={!trends?.games.length} onClick={() => openIdeaChat()} title="Chat with Claude about game ideas, using what's trending">
                  Brainstorm
                </Button>
                <Button size="sm" tone={trends?.ideas.length ? 'ghost' : 'default'} disabled={loading !== null || !trends?.games.length} onClick={ideas}>
                  {loading === 'ideas' ? 'Thinking…' : trends?.ideas.length ? 'New ideas' : 'Generate ideas'}
                </Button>
              </div>
            </div>
            {trends?.ideas.length ? (
              trends.ideas.map((idea, i) => <IdeaCard key={idea.id} idea={idea} rank={i + 1} />)
            ) : (
              <p className="small muted">Claude suggests original game concepts that ride what's trending, preferring spaces that aren't crowded yet. About $0.05 each time.</p>
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
              <p className="small muted">{loading === 'refresh' ? 'Loading the charts…' : 'No data yet. Refresh to load the charts.'}</p>
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

export function IdeaCard({ idea, rank }: { idea: GameIdea; rank?: number }) {
  const create = (): void =>
    openWizard({
      name: idea.title,
      genre: idea.genre,
      idea: `${idea.pitch}\n\nCore loop: ${idea.coreLoop}\n\nWhy now: ${idea.whyNow}${idea.inspiredBy.length ? `\n\nSpace it plays in (be original, don't copy): ${idea.inspiredBy.join(', ')}` : ''}`
    })
  return (
    <article className="idea-card">
      <div className="row between gap-sm">
        {rank !== undefined && <span className="idea-rank">{rank}</span>}
        <h4 className="idea-title">{idea.title}</h4>
        <ScoreBar value={idea.score} />
      </div>
      <p>{idea.pitch}</p>
      <p className="small muted">
        <strong>Loop:</strong> {idea.coreLoop}
      </p>
      <p className="small muted">
        <strong>Why now:</strong> {idea.whyNow}
      </p>
      <div className="row between">
        <span className="small muted">
          {idea.genre} · {idea.scope} scope
        </span>
        <span className="row gap-xs">
          {rank !== undefined && (
            <Button size="sm" tone="ghost" onClick={() => openIdeaChat(`Let's develop idea ${rank}, “${idea.title}”. `)}>
              Discuss
            </Button>
          )}
          <Button size="sm" onClick={create}>
            Create this game
          </Button>
        </span>
      </div>
    </article>
  )
}
