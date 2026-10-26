import type { AgentEvent, AutopilotStatus } from '@shared/types'

/**
 * Desktop notifications for things that need you, shown only while Hangar isn't the focused window:
 * a new approval, a task ready for review, a sprint check-in. Fixed wording only: no command text,
 * file paths, titles or anything an agent wrote. At most one per game and kind every 30 seconds.
 *
 * While autopilot is building, its own tasks' reviews don't notify: it checks and merges them itself,
 * and if one does need you it stops on "waiting", which notifies instead.
 */
export class Notifier {
  private seen = new Set<string>()
  private status = new Map<string, AutopilotStatus>()
  private lastShown = new Map<string, number>()

  constructor(
    private readonly deps: {
      enabled: () => boolean
      /** True while the Hangar window is focused (then nothing is shown). */
      focused: () => boolean
      show: (n: { title: string; body: string }) => void
      projectName: (projectId: string) => string | null
      now?: () => number
    }
  ) {}

  /** Things already waiting when Hangar starts don't notify again. */
  seed(items: { approvals?: string[]; reviews?: string[]; autopilot?: { projectId: string; status: AutopilotStatus }[] }): void {
    for (const id of items.approvals ?? []) this.seen.add(`a:${id}`)
    for (const id of items.reviews ?? []) this.seen.add(`r:${id}`)
    for (const a of items.autopilot ?? []) this.status.set(a.projectId, a.status)
  }

  onEvent(e: AgentEvent): void {
    if (e.type === 'approval') {
      if (!this.firstTime(`a:${e.request.id}`)) return
      this.notify(e.request.projectId, 'approval', e.request.dangerous ? 'A high-risk action is waiting for your approval.' : 'An action is waiting for your approval.')
    } else if (e.type === 'review') {
      const fresh = this.firstTime(`r:${e.review.id}`)
      if (!fresh || e.review.status !== 'pending') return
      const research = e.review.kind === 'research'
      if (!research && this.status.get(e.review.projectId) === 'running') return
      this.notify(e.review.projectId, 'review', research ? 'Web research is ready for you to check.' : 'A task is ready for you to review.')
    } else if (e.type === 'autopilot') {
      const before = this.status.get(e.state.projectId)
      this.status.set(e.state.projectId, e.state.status)
      if (e.state.status === 'checkin' && before !== 'checkin') this.notify(e.state.projectId, 'checkin', `Sprint ${e.state.sprint} check-in is ready.`)
      // The reason can quote a task title the Lead wrote, so it is never shown here.
      else if (e.state.status === 'waiting' && before !== 'waiting') this.notify(e.state.projectId, 'review', 'Autopilot is waiting for you to review a task.')
    }
  }

  private firstTime(key: string): boolean {
    if (this.seen.has(key)) return false
    // Bounded: the oldest ids are forgotten first.
    if (this.seen.size >= 5000) this.seen.delete(this.seen.values().next().value!)
    this.seen.add(key)
    return true
  }

  private notify(projectId: string, kind: string, body: string): void {
    if (!this.deps.enabled() || this.deps.focused()) return
    const now = this.deps.now?.() ?? Date.now()
    const key = `${projectId}:${kind}`
    if (now - (this.lastShown.get(key) ?? -Infinity) < 30_000) return
    this.lastShown.set(key, now)
    const name = this.deps.projectName(projectId) ?? 'A game'
    this.deps.show({ title: `${name.slice(0, 60)} needs you`, body })
  }
}
