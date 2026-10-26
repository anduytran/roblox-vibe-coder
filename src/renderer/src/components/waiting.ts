import { useMemo } from 'react'
import type { ApprovalRequest, AutopilotState, Project, Review, SprintReport } from '@shared/types'
import { useStore } from '../store'

/** Everything waiting for you across games: the Inbox lists it, the sidebar counts it, Home summarises it. */
export interface Waiting {
  approvals: { request: ApprovalRequest; project: Project | null; agent: string }[]
  reviews: { review: Review; project: Project; agent: string }[]
  checkins: { project: Project; ap: AutopilotState; report: SprintReport | null }[]
  count: number
}

export { firstLine } from '@shared/text'

export function useWaiting(): Waiting {
  const projects = useStore((s) => s.projects)
  const approvals = useStore((s) => s.approvals)
  const reviews = useStore((s) => s.reviews)
  const autopilot = useStore((s) => s.autopilot)
  const roles = useStore((s) => s.roles)
  return useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    const agentName = (projectId: string, agentId: string): string =>
      agentId === 'main' ? 'Main' : (roles[projectId]?.find((r) => r.id === agentId)?.name ?? agentId)
    const a = approvals
      .map((request) => ({ request, project: byId.get(request.projectId) ?? null, agent: agentName(request.projectId, request.agentId) }))
      .sort((x, y) => y.request.ts - x.request.ts)
    const r = projects
      .flatMap((p) => (reviews[p.id] ?? []).filter((rv) => rv.status === 'pending').map((review) => ({ review, project: p, agent: agentName(p.id, review.agentId) })))
      .sort((x, y) => y.review.createdAt - x.review.createdAt)
    const c = projects
      .flatMap((p) => {
        const ap = autopilot[p.id]
        return ap?.status === 'checkin' ? [{ project: p, ap, report: ap.reports[ap.reports.length - 1] ?? null }] : []
      })
      .sort((x, y) => (y.report?.at ?? 0) - (x.report?.at ?? 0))
    return { approvals: a, reviews: r, checkins: c, count: a.length + r.length + c.length }
  }, [projects, approvals, reviews, autopilot, roles])
}
