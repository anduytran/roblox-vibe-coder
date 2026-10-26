import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GameIdea, IdeaCategory } from '@shared/types'
import { IDEA_CATEGORIES, ideaCategory } from '@shared/ideas'
import { attempt, closeIdeaChat, ensureTrendsFresh, openIdeaChat, openIdeaRefine, openWizard, refreshTrends, setTrends, useStore } from '../store'
import { ErrorBoundary } from './ErrorBoundary'
import { EmptyState } from './EmptyState'
import { IdeaChat } from './IdeaChat'
import { IdeaCard, ideaBrief, SaturationTag, ScoreBar, TrendRow } from './ideas'
import { Button, Icon, Modal, Skeleton, timeAgo } from './ui'

type Tab = 'ideas' | 'saved' | 'trending'
const MAX_COMPARE = 3

/** Finding and shaping the next game: idea kinds, generated and saved ideas, Brainstorm, and the Roblox charts. */
export function IdeasPage() {
  const trends = useStore((s) => s.trends)
  const loadingCharts = useStore((s) => s.trendsLoading)
  const chatOpen = useStore((s) => s.ideaChat !== null)
  const [tab, setTab] = useState<Tab>('ideas')
  const [category, setCategory] = useState<IdeaCategory>('trend')
  const [generating, setGenerating] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [compareOpen, setCompareOpen] = useState(false)

  useEffect(() => {
    ensureTrendsFresh()
  }, [])

  const ideas = trends?.ideas ?? []
  const saved = trends?.saved ?? []
  const list = tab === 'saved' ? saved : ideas
  // Picked ideas, wherever they are now (the list may have been regenerated meanwhile).
  const pickedIdeas = useMemo(() => {
    const all = new Map([...ideas, ...saved].map((i) => [i.id, i]))
    return picked.map((id) => all.get(id)).filter((i): i is GameIdea => !!i)
  }, [picked, ideas, saved])

  const generate = (): void => {
    setGenerating(true)
    setTab('ideas')
    setPicked([])
    void attempt(async () => setTrends(await window.hangar.trends.ideas(category))).finally(() => setGenerating(false))
  }
  const togglePick = (id: string): void =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_COMPARE ? [...p.slice(1), id] : [...p, id]))
  const stopComparing = (): void => {
    setComparing(false)
    setPicked([])
  }

  return (
    <div className={`ideas-page ${chatOpen ? 'ideas-with-chat' : ''}`}>
      <div className="ideas-main">
        <header className="home-head">
          <div>
            <h1>Ideas</h1>
            <p className="muted">Find your next game: short ideas grounded in what's trending on Roblox. Open one to develop it.</p>
          </div>
          <div className="row gap-xs">
            {!chatOpen && (
              <Button onClick={() => openIdeaChat('', category)}>
                <Icon name="bulb" />
                Brainstorm
              </Button>
            )}
            <Button tone="primary" disabled={generating || !trends?.games.length} onClick={generate} title={ideaCategory(category).hint}>
              {generating ? 'Thinking…' : ideas.length ? 'New ideas' : 'Generate ideas'}
            </Button>
          </div>
        </header>

        <div className="ideas-kinds">
          <div className="segmented" role="radiogroup" aria-label="Kind of ideas">
            {IDEA_CATEGORIES.map((c) => (
              <button key={c.id} role="radio" aria-checked={category === c.id} title={c.hint} className={`segment ${category === c.id ? 'segment-on' : ''}`} onClick={() => setCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          <span className="small muted">{ideaCategory(category).hint}.</span>
        </div>

        <div className="row between ideas-tabs">
          <div className="segmented segmented-sm" role="tablist" aria-label="Show">
            {(
              [
                ['ideas', `Ideas${ideas.length ? ` (${ideas.length})` : ''}`],
                ['saved', `Saved${saved.length ? ` (${saved.length})` : ''}`],
                ['trending', 'Trending on Roblox']
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`segment ${tab === id ? 'segment-on' : ''}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {tab !== 'trending' && (comparing || list.length > 1) && (
            <Button size="sm" tone="ghost" onClick={() => (comparing ? stopComparing() : setComparing(true))}>
              {comparing ? 'Cancel compare' : 'Compare'}
            </Button>
          )}
          {tab === 'trending' && (
            <span className="row gap-xs small muted">
              {trends?.fetchedAt ? `Updated ${timeAgo(trends.fetchedAt)}` : ''}
              <Button size="sm" tone="ghost" disabled={loadingCharts} onClick={() => void refreshTrends(true)}>
                {loadingCharts ? 'Updating…' : 'Refresh'}
              </Button>
            </span>
          )}
        </div>
        {trends?.error && <p className="small warn">{trends.error}</p>}

        {comparing && tab !== 'trending' && (
          <div className="compare-bar" role="status">
            <span>
              Pick 2 or 3 ideas to compare · <strong>{pickedIdeas.length}</strong> picked
            </span>
            <span className="spacer" />
            <Button size="sm" tone="primary" disabled={pickedIdeas.length < 2} onClick={() => setCompareOpen(true)}>
              Compare {pickedIdeas.length > 1 ? `(${pickedIdeas.length})` : ''}
            </Button>
          </div>
        )}

        {tab === 'trending' ? (
          <TrendingTab />
        ) : list.length ? (
          <div className="idea-grid">
            {list.map((idea, i) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                rank={tab === 'ideas' ? i + 1 : undefined}
                select={comparing ? { selected: picked.includes(idea.id), onToggle: () => togglePick(idea.id) } : undefined}
              />
            ))}
          </div>
        ) : tab === 'saved' ? (
          <EmptyState icon="review" title="No saved ideas">
            Star an idea to keep it here. Saved ideas stay when you get new ones.
          </EmptyState>
        ) : generating ? (
          <Skeleton lines={6} label="Thinking of ideas" />
        ) : (
          <EmptyState
            icon="bulb"
            title="No ideas yet"
            action={
              <Button tone="primary" disabled={!trends?.games.length} onClick={generate}>
                Generate ideas
              </Button>
            }
          >
            Pick a kind of idea above and Claude suggests six short concepts. Open one to fill in the details.
          </EmptyState>
        )}
      </div>
      {chatOpen && (
        <ErrorBoundary label="Brainstorm" onClose={closeIdeaChat}>
          <IdeaChat />
        </ErrorBoundary>
      )}
      {compareOpen && pickedIdeas.length > 1 && (
        <CompareIdeas
          ideas={pickedIdeas}
          onClose={() => setCompareOpen(false)}
          onDone={() => {
            setCompareOpen(false)
            stopComparing()
          }}
        />
      )}
    </div>
  )
}

function TrendingTab() {
  const trends = useStore((s) => s.trends)
  const loading = useStore((s) => s.trendsLoading)
  if (!trends?.games.length) {
    return loading ? (
      <Skeleton lines={8} label="Loading the charts" />
    ) : (
      <EmptyState
        icon="globe"
        title="No chart data yet"
        action={
          <Button onClick={() => void refreshTrends(true)}>
            Load the charts
          </Button>
        }
      />
    )
  }
  return (
    <div className="trend-layout">
      <div className="trend-col">
        <h3>Game spaces</h3>
        <div className="space-list">
          {trends.genres.map((g) => (
            <div key={g.genre} className="space-row" title={`Demand ${g.demand} · saturation ${g.saturation} · ${g.games} charting · led by ${g.leader}`}>
              <span className="space-name">{g.genre}</span>
              <SaturationTag value={g.saturation} />
              <ScoreBar value={g.score} />
            </div>
          ))}
        </div>
      </div>
      <div className="trend-col trend-table-wrap">
        <h3>Trending games</h3>
        <p className="small muted pad-x">
          Scored for opportunity: demand (growth, chart position, freshness, likes, players) reduced by how saturated each game space is.
        </p>
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
      </div>
    </div>
  )
}

/** Two or three ideas side by side. */
function CompareIdeas({ ideas, onClose, onDone }: { ideas: GameIdea[]; onClose: () => void; onDone: () => void }) {
  const genres = useStore((s) => s.trends?.genres ?? [])
  const space = (idea: GameIdea) => genres.find((g) => g.genre.toLowerCase() === idea.genre.toLowerCase())
  const rows: [string, (i: GameIdea) => ReactNode][] = [
    ['Pitch', (i) => i.pitch],
    ['Kind', (i) => ideaCategory(i.category).label],
    ['Genre', (i) => i.genre],
    [
      'Space',
      (i) => {
        const g = space(i)
        return g ? <SaturationTag value={g.saturation} /> : <span className="muted">Not charting</span>
      }
    ],
    ['Scope', (i) => i.scope],
    ['Score', (i) => <ScoreBar value={i.score} />],
    ['Core loop', (i) => i.coreLoop || <span className="muted">Open it to generate details</span>],
    ['Key features', (i) => (i.features?.length ? i.features.join(' · ') : <span className="muted">—</span>)],
    ['Build first', (i) => i.firstVersion || <span className="muted">—</span>],
    ['Why now', (i) => i.whyNow || <span className="muted">—</span>],
    ['Plays in', (i) => (i.inspiredBy.length ? i.inspiredBy.join(', ') : <span className="muted">An original space</span>)]
  ]
  return (
    <Modal title="Compare ideas" wide onClose={onClose}>
      <div className="compare-wrap">
        <table className="compare-table">
          <thead>
            <tr>
              <th aria-label="Field" />
              {ideas.map((i) => (
                <th key={i.id} scope="col">
                  {i.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, cell]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {ideas.map((i) => (
                  <td key={i.id}>{cell(i)}</td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row" aria-label="Actions" />
              {ideas.map((i) => (
                <td key={i.id}>
                  <div className="row gap-xs wrap">
                    <Button
                      size="sm"
                      tone="ghost"
                      onClick={() => {
                        onDone()
                        openIdeaRefine(i.id)
                      }}
                    >
                      Open
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        onDone()
                        openWizard(ideaBrief(i))
                      }}
                    >
                      Create this game
                    </Button>
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
