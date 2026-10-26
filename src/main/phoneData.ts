/**
 * What the phone remote shows of Ideas and check-ins, and how a check-in answered on the phone becomes
 * autopilot feedback. Pure, so the shapes and limits are tested without a server.
 *
 * Text that came from Roblox, the AI or an agent has its hidden characters made visible (⟦U+…⟧) here:
 * the phone app shows text only, but a direction override could still make one name read as another.
 */
import type { GameIdea, SprintReport, TrendsSnapshot } from '@shared/types'
import { composeCheckinFeedback, parseCheckin } from '@shared/checkin'
import { revealHidden } from '@shared/text'

const show = (s: unknown, max: number): string => revealHidden(String(s ?? '').slice(0, max))

export interface PhoneIdea {
  id: string
  title: string
  pitch: string
  genre: string
  scope: string
  score: number
  category: string | null
  detailed: boolean
  coreLoop: string
  whyNow: string
  features: string[]
  firstVersion: string
  inspiredBy: string[]
}

function phoneIdea(i: GameIdea): PhoneIdea {
  return {
    id: String(i.id),
    title: show(i.title, 200),
    pitch: show(i.pitch, 1000),
    genre: show(i.genre, 80),
    scope: show(i.scope, 20),
    score: Number.isFinite(i.score) ? Math.round(i.score) : 0,
    category: i.category ?? null,
    detailed: i.detailed === true,
    coreLoop: show(i.coreLoop, 1500),
    whyNow: show(i.whyNow, 1500),
    features: (i.features ?? []).slice(0, 12).map((f) => show(f, 300)),
    firstVersion: show(i.firstVersion, 1500),
    inspiredBy: (i.inspiredBy ?? []).slice(0, 8).map((g) => show(g, 80))
  }
}

/** Ideas for the phone: the current batch, your saved ones, and what's trending (read-only). */
export function phoneIdeas(t: TrendsSnapshot): {
  ideas: PhoneIdea[]
  saved: PhoneIdea[]
  genres: { genre: string; score: number; demand: number; saturation: number; games: number }[]
  games: { id: number; name: string; genre: string; players: number; score: number; growth: number | null }[]
  fetchedAt: number | null
  error: string | null
} {
  return {
    ideas: (t.ideas ?? []).slice(0, 40).map(phoneIdea),
    saved: (t.saved ?? []).slice(0, 100).map(phoneIdea),
    genres: [...(t.genres ?? [])]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((g) => ({ genre: show(g.genre, 80), score: Math.round(g.score), demand: Math.round(g.demand), saturation: Math.round(g.saturation), games: g.games })),
    games: (t.games ?? []).slice(0, 15).map((g) => ({
      id: g.universeId,
      name: show(g.name, 120),
      genre: show(g.genre, 80),
      players: g.players,
      score: Math.round(g.score),
      growth: g.growth
    })),
    fetchedAt: t.fetchedAt,
    error: t.error ? show(t.error, 300) : null
  }
}

/** A check-in, split into its parts for the phone (the parser already removes hidden characters). */
export function phoneCheckin(report: SprintReport): {
  sprint: number
  at: number
  spentUsd: number
  merged: number
  tasks: number
  intro: string
  built: string
  tryIt: string
  next: string[]
  questions: string[]
  structured: boolean
} {
  const c = parseCheckin(report.text)
  const tasks = report.tasks ?? []
  return {
    sprint: report.sprint,
    at: report.at,
    spentUsd: Number.isFinite(report.spentUsd) ? report.spentUsd : 0,
    merged: tasks.filter((t) => t.outcome === 'merged').length,
    tasks: tasks.length,
    intro: c.intro,
    built: c.built,
    tryIt: c.tryIt,
    next: c.next,
    questions: c.questions,
    structured: c.structured
  }
}

/** Autopilot keeps the first 8,000 characters of a reply; the phone is told instead of having the end cut off. */
export const FEEDBACK_MAX = 8000

// Control characters (newlines and tabs aside) are dropped from what the phone sends.
const clean = (s: string, max: number): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max)

/**
 * The phone's reply to a check-in as the feedback text the desktop sends. Questions are taken from the report
 * Hangar holds (the phone only sends answers, by position), so a reply can't put words in the Lead's mouth.
 */
export function checkinReply(report: SprintReport, body: Record<string, unknown>): { feedback: string; answers: { question: string; answer: string }[] } {
  const c = parseCheckin(report.text)
  const answersIn = Array.isArray(body.answers) ? body.answers.slice(0, c.questions.length) : []
  const answers = c.questions.map((_, i) => (typeof answersIn[i] === 'string' ? clean(answersIn[i] as string, 2000).trim() : ''))
  const notes = typeof body.notes === 'string' ? clean(body.notes, 4000).trim() : ''
  let plan = c.next
  let planChanged = false
  if (Array.isArray(body.plan)) {
    if (body.plan.length > 30) throw new Error('Keep the plan to 30 items or fewer.')
    // The Lead's own items come back whole; only what you added is cleaned and capped.
    const lead = new Set(c.next)
    plan = body.plan
      .filter((p): p is string => typeof p === 'string')
      .map((p) => (lead.has(p) ? p : clean(p, 300).replace(/\s+/g, ' ').trim()))
      .filter(Boolean)
    planChanged = JSON.stringify(plan) !== JSON.stringify(c.next)
  }
  const feedback = c.structured ? composeCheckinFeedback({ questions: c.questions, answers, plan, planChanged, notes }) : notes
  if (feedback.length > FEEDBACK_MAX) throw new Error(`Your reply is ${feedback.length.toLocaleString('en-US')} characters; the Lead takes up to ${FEEDBACK_MAX.toLocaleString('en-US')}. Shorten it.`)
  return {
    feedback,
    answers: c.questions.map((question, i) => ({ question: question.slice(0, 500), answer: answers[i]! })).filter((x) => x.answer)
  }
}
