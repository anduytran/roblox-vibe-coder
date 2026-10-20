import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { AgentEvent, Review } from '@shared/types'
import type { AgentRunner } from './agentRunner'
import { checkoutBranch, deleteTaskBranch, mergeTaskBranch, reviewDiff } from './git'
import type { ProjectRegistry } from './projects'
import type { ReviewStore } from './reviews'
import { StudioClipRecorder } from './clips'

const CLIP_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

export interface Publisher {
  /** Build the review's branch and publish it to the project's private test place. */
  publish(review: Review): Promise<{ versionNumber: number }>
}

/**
 * What you can do with a finished task, from the desktop or the phone. Every action that touches the
 * project folder refuses while an agent in that project is running, so the working tree can't change
 * under it.
 */
export class ReviewActions {
  constructor(
    private readonly deps: {
      registry: ProjectRegistry
      reviews: ReviewStore
      runner: AgentRunner
      emit: (e: AgentEvent) => void
      publisher: Publisher | null
    }
  ) {}

  private pending(id: string): { review: Review; root: string } {
    const review = this.deps.reviews.get(id)
    if (review.status !== 'pending') throw new Error(`This task was already ${review.status}.`)
    return { review, root: this.deps.registry.get(review.projectId).path }
  }

  private idle(projectId: string): void {
    if (this.deps.runner.projectBusy(projectId)) throw new Error('An agent is working in this project. Wait for it to finish (or stop it) first.')
  }

  private changed(review: Review): Review {
    this.deps.emit({ type: 'review', review })
    return review
  }

  list(projectId?: string): Review[] {
    return this.deps.reviews.list(projectId)
  }

  async diff(id: string): Promise<string> {
    const review = this.deps.reviews.get(id)
    if (review.status !== 'pending') return ''
    return reviewDiff(this.deps.registry.get(review.projectId).path, review.baseSha, review.headSha)
  }

  async merge(id: string): Promise<Review> {
    const { review, root } = this.pending(id)
    this.idle(review.projectId)
    await mergeTaskBranch(root, review.base, review.branch, review.headSha, review.title)
    if (review.clip) StudioClipRecorder.remove(review.clip.files)
    return this.changed(this.deps.reviews.update(id, { status: 'merged', clip: null }))
  }

  async discard(id: string): Promise<Review> {
    const { review, root } = this.pending(id)
    this.idle(review.projectId)
    await deleteTaskBranch(root, review.branch)
    if (review.clip) StudioClipRecorder.remove(review.clip.files)
    return this.changed(this.deps.reviews.update(id, { status: 'discarded', clip: null }))
  }

  async checkout(id: string): Promise<void> {
    const { review, root } = this.pending(id)
    this.idle(review.projectId)
    await checkoutBranch(root, review.branch)
  }

  async checkoutBase(projectId: string): Promise<void> {
    this.idle(projectId)
    const root = this.deps.registry.get(projectId).path
    const base = this.deps.reviews.list(projectId)[0]?.base
    if (!base) throw new Error('No task branches yet for this project.')
    await checkoutBranch(root, base)
  }

  private publishing = false

  async publish(id: string): Promise<Review> {
    const { review } = this.pending(id)
    this.idle(review.projectId)
    if (!this.deps.publisher) throw new Error('Publishing is not set up.')
    if (this.publishing) throw new Error('Another publish is in progress.')
    this.publishing = true
    try {
      const { versionNumber } = await this.deps.publisher.publish(review)
      return this.changed(this.deps.reviews.update(id, { published: { versionNumber, at: Date.now() } }))
    } finally {
      this.publishing = false
    }
  }

  /** Path and type of one of a review's clip files. Only files recorded for this review are ever served. */
  clipPath(id: string, index: number): { path: string; type: string } {
    const review = this.deps.reviews.get(id)
    const file = Number.isInteger(index) ? review.clip?.files[index] : undefined
    if (!file) throw new Error('No such clip.')
    const type = CLIP_TYPES[extname(file).toLowerCase()]
    if (!type) throw new Error('Unsupported clip type.')
    return { path: file, type }
  }

  /** A clip file as a data: URL (for the desktop window). */
  clipFile(id: string, index: number): string {
    const { path, type } = this.clipPath(id, index)
    return `data:${type};base64,${readFileSync(path).toString('base64')}`
  }
}
