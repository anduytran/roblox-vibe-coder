import type { AgentEvent, AiReview, Project, Review, ReviewChecks } from '@shared/types'
import type { ProjectRegistry } from './projects'
import type { ReviewStore } from './reviews'

export interface PipelineDeps {
  registry: ProjectRegistry
  reviews: ReviewStore
  emit: (e: AgentEvent) => void
  runChecks: (project: Project, review: Review) => Promise<ReviewChecks | null>
  reviewer: { review(project: Project, review: Review, checks: ReviewChecks | null): Promise<AiReview> } | null
}

/**
 * What happens to a finished task before you see it: first the project's checks, then the reviewer
 * agent (which also sees the check results). One task at a time, so a burst of finished tasks doesn't
 * start a pile of builds and reviewer sessions at once. Results are written onto the review as they
 * arrive, so the desktop and phone update live.
 */
export class ReviewPipeline {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: PipelineDeps) {
    // Anything left "running" by a previous launch was interrupted.
    for (const r of deps.reviews.list()) {
      if (r.status !== 'pending') continue
      const patch: Partial<Review> = {}
      if (r.checks?.status === 'running') patch.checks = { ...r.checks, status: 'done', reason: 'Interrupted when Hangar closed. Run the checks again.' }
      if (r.aiReview?.status === 'running') patch.aiReview = { ...r.aiReview, status: 'error', error: 'Interrupted when Hangar closed.' }
      if (Object.keys(patch).length) deps.reviews.update(r.id, patch)
    }
  }

  /** Queue checks and the AI review for a review. Returns when this one is done (tests await it). */
  start(review: Review, opts: { reviewer?: boolean } = {}): Promise<void> {
    if (review.kind === 'research') return Promise.resolve()
    let project: Project
    try {
      project = this.deps.registry.get(review.projectId)
    } catch {
      return Promise.resolve()
    }
    const wantChecks = project.settings.checks.length > 0
    const wantReviewer = (opts.reviewer ?? true) && project.settings.reviewer && this.deps.reviewer !== null
    if (!wantChecks && !wantReviewer) return Promise.resolve()
    this.patch(review.id, {
      ...(wantChecks ? { checks: { status: 'running', reason: null, results: [] } } : {}),
      ...(wantReviewer ? { aiReview: { status: 'running', verdict: null, summary: '', findings: [], costUsd: 0, error: null } } : {})
    })
    const job = this.chain.then(() => this.process(review.id, wantChecks, wantReviewer))
    this.chain = job.catch(() => undefined)
    return job
  }

  private async process(id: string, wantChecks: boolean, wantReviewer: boolean): Promise<void> {
    let review = this.current(id)
    if (!review) return
    let project: Project
    try {
      project = this.deps.registry.get(review.projectId)
    } catch {
      return
    }
    let checks: ReviewChecks | null = null
    if (wantChecks) {
      try {
        checks = await this.deps.runChecks(project, review)
      } catch (err) {
        checks = { status: 'done', reason: `Checks couldn't run: ${err instanceof Error ? err.message : String(err)}`, results: [] }
      }
      review = this.patch(id, { checks })
      if (!review) return
    }
    if (wantReviewer && this.deps.reviewer) {
      let ai: AiReview
      try {
        ai = await this.deps.reviewer.review(project, review, checks)
      } catch (err) {
        ai = { status: 'error', verdict: null, summary: '', findings: [], costUsd: 0, error: err instanceof Error ? err.message : String(err) }
      }
      this.patch(id, { aiReview: ai })
    }
  }

  private current(id: string): Review | null {
    try {
      const r = this.deps.reviews.get(id)
      return r.status === 'pending' ? r : null
    } catch {
      return null
    }
  }

  /** Update a still-pending review and tell the UI. Decided (merged/discarded) reviews are left alone. */
  private patch(id: string, patch: Partial<Review>): Review | null {
    if (!this.current(id)) return null
    const review = this.deps.reviews.update(id, patch)
    this.deps.emit({ type: 'review', review })
    return review
  }
}
