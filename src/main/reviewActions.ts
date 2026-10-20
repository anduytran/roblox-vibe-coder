import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { relativeInside } from './pathScope'
import { extname, join } from 'node:path'
import type { AgentEvent, Review } from '@shared/types'
import type { AgentRunner } from './agentRunner'
import { checkoutBranch, commitFile, currentBranch, deleteTaskBranch, mergeTaskBranch, reviewDiff } from './git'
import { mergeWarnings } from '@shared/reviewRules'
import type { ReviewPipeline } from './reviewPipeline'
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
      pipeline?: ReviewPipeline | null
    }
  ) {}

  mergeWarnings(review: Review): string[] {
    return mergeWarnings(review)
  }

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
    if (review.kind === 'research') return review.research?.markdown ?? ''
    return reviewDiff(this.deps.registry.get(review.projectId).path, review.baseSha, review.headSha)
  }

  /**
   * `force` merges despite warnings, but only the warnings the user was shown (`acknowledged`): if a
   * new one appeared meanwhile (say the reviewer finished with "block"), the merge is refused.
   */
  async merge(id: string, opts: { force?: boolean; acknowledged?: string[] } = {}): Promise<Review> {
    const { review, root } = this.pending(id)
    if (review.kind === 'research') return this.approveResearch(review, root)
    const warnings = this.mergeWarnings(review)
    if (warnings.length && !opts.force) throw new Error(`${warnings.join(' ')} Choose "Merge anyway" to merge regardless.`)
    const unseen = warnings.filter((w) => !(opts.acknowledged ?? []).includes(w))
    if (unseen.length) throw new Error(`Something changed since you looked: ${unseen.join(' ')} Look again before merging.`)
    return this.deps.runner.withProjectLock(review.projectId, async () => {
      await mergeTaskBranch(root, review.base, review.branch, review.headSha, review.title)
      if (review.clip) StudioClipRecorder.remove(review.clip.files)
      return this.changed(this.deps.reviews.update(id, { status: 'merged', clip: null }))
    })
  }

  async discard(id: string): Promise<Review> {
    const { review, root } = this.pending(id)
    if (review.kind === 'research') return this.changed(this.deps.reviews.update(id, { status: 'discarded' }))
    return this.deps.runner.withProjectLock(review.projectId, async () => {
      await deleteTaskBranch(root, review.branch)
      if (review.clip) StudioClipRecorder.remove(review.clip.files)
      return this.changed(this.deps.reviews.update(id, { status: 'discarded', clip: null }))
    })
  }

  /** Run a task's checks (and, if asked, the reviewer agent) again. */
  async recheck(id: string, opts: { reviewer?: boolean } = {}): Promise<Review> {
    const { review } = this.pending(id)
    if (review.kind === 'research') throw new Error('Research has no checks.')
    if (!this.deps.pipeline) throw new Error('Checks are not set up.')
    if (review.checks?.status === 'running' || review.aiReview?.status === 'running') throw new Error('Already running.')
    void this.deps.pipeline.start(review, { reviewer: opts.reviewer === true })
    return this.deps.reviews.get(id)
  }

  /**
   * Save approved research into the project's research/ folder (and commit just that file), where every
   * agent can read it. Before this, no agent ever sees the researcher's report.
   */
  private async approveResearch(review: Review, root: string): Promise<Review> {
    const findings = review.research
    if (!findings) throw new Error('This research has no report.')
    return this.deps.runner.withProjectLock(review.projectId, () => this.saveResearch(review, findings, root))
  }

  private async saveResearch(review: Review, findings: NonNullable<Review['research']>, root: string): Promise<Review> {
    const branch = await currentBranch(root)
    if (branch?.startsWith('hangar/')) throw new Error(`Your project folder is on a task branch (${branch}). Switch back to your main branch first.`)
    const slug = review.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'research'
    const day = new Date().toISOString().slice(0, 10)
    mkdirSync(join(root, 'research'), { recursive: true })
    // research/ must be a real folder inside the project, not a link to somewhere else.
    if (lstatSync(join(root, 'research')).isSymbolicLink() || relativeInside(root, join(root, 'research')) !== 'research') {
      throw new Error('research/ in this project is a link to somewhere else, so Hangar won\'t write there.')
    }
    let rel = `research/${day}-${slug}.md`
    for (let n = 2; existsSync(join(root, rel)); n++) rel = `research/${day}-${slug}-${n}.md`
    const yaml = (v: string): string => JSON.stringify(v)
    const body = [
      '---',
      `title: ${yaml(review.title)}`,
      `approved: ${day}`,
      'source: web research (Hangar researcher), reviewed and approved by the user',
      ...(findings.fetched.length ? ['pages_opened:', ...findings.fetched.slice(0, 50).map((u) => `  - ${yaml(u)}`)] : []),
      '---',
      '',
      findings.markdown.trim(),
      ''
    ].join('\n')
    writeFileSync(join(root, rel), body, { encoding: 'utf8', flag: 'wx' })
    try {
      await commitFile(root, rel, `Research: ${review.title}`)
    } catch (err) {
      rmSync(join(root, rel), { force: true })
      throw err
    }
    return this.changed(this.deps.reviews.update(review.id, { status: 'merged', research: { ...findings, savedAs: rel } }))
  }

  async checkout(id: string): Promise<void> {
    const { review, root } = this.pending(id)
    if (review.kind === 'research') throw new Error('Research has no branch.')
    await this.deps.runner.withProjectLock(review.projectId, () => checkoutBranch(root, review.branch))
  }

  async checkoutBase(projectId: string): Promise<void> {
    const root = this.deps.registry.get(projectId).path
    const base = this.deps.reviews.list(projectId).find((r) => r.kind !== 'research')?.base
    if (!base) throw new Error('No task branches yet for this project.')
    await this.deps.runner.withProjectLock(projectId, () => checkoutBranch(root, base))
  }

  private publishing = false

  async publish(id: string): Promise<Review> {
    const { review } = this.pending(id)
    if (review.kind === 'research') throw new Error('Research has nothing to publish.')
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
