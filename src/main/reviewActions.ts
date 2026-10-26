import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { relativeInside } from './pathScope'
import { extname, join } from 'node:path'
import type { AgentEvent, Review } from '@shared/types'
import type { AgentRunner } from './agentRunner'
import { checkoutBranch, commitFile, currentBranch, deleteTaskBranch, githubLink, MergeClashError, mergeTaskBranch, pushToGitHub, reviewDiff, tidyWorkingFolder } from './git'
import { checksFailed, mergeWarnings } from '@shared/reviewRules'
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
      // Edits made outside Hangar are saved first instead of blocking the merge.
      await tidyWorkingFolder(root)
      try {
        await mergeTaskBranch(root, review.base, review.branch, review.headSha, review.title)
      } catch (err) {
        // Remembered on the review, so it can offer Fix with AI (and autopilot can use it while you're away).
        if (err instanceof MergeClashError) this.changed(this.deps.reviews.update(id, { clash: { files: err.files, at: Date.now(), fixing: false, failed: null } }))
        throw err
      }
      if (review.clip) StudioClipRecorder.remove(review.clip.files)
      const merged = this.changed(this.deps.reviews.update(id, { status: 'merged', clip: null }))
      void this.pushAfterMerge(merged)
      return merged
    })
  }

  /** In the background after a merge: send the branch to the linked GitHub repository, unless that's turned off. */
  private pushing: Promise<unknown> = Promise.resolve()
  private pushAfterMerge(review: Review): Promise<unknown> {
    // One push at a time, in merge order (Merge all merges several in a row).
    this.pushing = this.pushing.then(async () => {
      let root: string
      try {
        const project = this.deps.registry.get(review.projectId)
        if (project.settings.autoPush === false) return
        root = project.path
        if (!(await githubLink(root)).repo) return
      } catch {
        return
      }
      try {
        const r = await pushToGitHub(root, review.base)
        this.changed(this.deps.reviews.update(review.id, { pushed: { at: Date.now(), repo: r.repo }, pushError: null }))
      } catch (err) {
        this.changed(this.deps.reviews.update(review.id, { pushError: (err instanceof Error ? err.message : String(err)).slice(0, 300) }))
      }
    })
    return this.pushing
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

  /**
   * Hand a clashing change to the agent that made it: Hangar merges the latest base branch into the change's branch,
   * the agent resolves the conflicts, and the updated change goes through the checks and the reviewer again.
   */
  fixClash(id: string): Review {
    const { review } = this.pending(id)
    if (review.kind === 'research') throw new Error('Research has nothing to merge.')
    if (!review.clash) throw new Error('This change has no clash to resolve. Try merging it first.')
    if (review.clash.fixing) throw new Error('An agent is already resolving this clash.')
    const project = this.deps.registry.get(review.projectId)
    if (!project.settings.autonomous) throw new Error('Fixing a clash needs autonomous mode (Project → General).')
    // The agent that made the change knows it best; if that role is gone, the Main agent does it.
    const agentId = this.deps.runner.agentIds(project).includes(review.agentId) ? review.agentId : 'main'
    this.deps.runner.send(review.projectId, agentId, `Resolve the merge clash in “${review.title}”`, { fixClash: id })
    return this.changed(this.deps.reviews.update(id, { clash: { ...review.clash, fixing: true, failed: null } }))
  }

  /** Changes Merge all handed to Fix with AI, to merge once the fixed version has been checked again. */
  private readonly mergeWhenFixed = new Map<string, { tries: number }>()

  /**
   * Merge every waiting change in a project, oldest first. A change that clashes with what was merged before it goes
   * to Fix with AI and merges itself once the fixed version has passed its checks again. You confirm the warnings
   * first (`acknowledged`, per change); one with a warning you weren't shown, or still being checked, is skipped.
   */
  async mergeAll(projectId: string, acknowledged: Record<string, string[]> = {}): Promise<{ merged: string[]; fixing: string[]; skipped: { id: string; title: string; reason: string }[] }> {
    const result = { merged: [] as string[], fixing: [] as string[], skipped: [] as { id: string; title: string; reason: string }[] }
    const waiting = this.deps.reviews
      .list(projectId)
      .filter((r) => r.status === 'pending' && r.kind !== 'research')
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const r of waiting) {
      const skip = (reason: string): void => void result.skipped.push({ id: r.id, title: r.title, reason })
      const now = this.deps.reviews.get(r.id)
      if (now.clash?.fixing) {
        this.mergeWhenFixed.set(r.id, { tries: 0 })
        result.fixing.push(r.id)
        continue
      }
      if (now.checks?.status === 'running' || now.aiReview?.status === 'running') {
        skip('It is still being checked.')
        continue
      }
      try {
        await this.merge(r.id, { force: true, acknowledged: acknowledged[r.id] ?? [] })
        result.merged.push(r.id)
      } catch (err) {
        const after = this.deps.reviews.get(r.id)
        if (after.status === 'pending' && after.clash && (after.clashFixes ?? 0) < 2) {
          try {
            this.fixClash(r.id)
            this.mergeWhenFixed.set(r.id, { tries: 0 })
            result.fixing.push(r.id)
            continue
          } catch (e) {
            skip(e instanceof Error ? e.message : String(e))
            continue
          }
        }
        skip(err instanceof Error ? err.message : String(err))
      }
    }
    return result
  }

  /**
   * Every review update: a change Merge all sent to Fix with AI merges once it's fixed and checked again, unless the
   * checks failed or the reviewer says not to merge (then it waits for you, with the reason on it).
   */
  onReview(review: Review): void {
    const follow = this.mergeWhenFixed.get(review.id)
    if (!follow) return
    if (review.status !== 'pending') return void this.mergeWhenFixed.delete(review.id)
    if (review.clash?.fixing || review.checks?.status === 'running' || review.aiReview?.status === 'running') return
    // The fix didn't work (it's on the review), or it wasn't checked yet (the pipeline starts it): wait or stop.
    if (review.clash) return void this.mergeWhenFixed.delete(review.id)
    if (!review.checks && !review.aiReview) return
    if (checksFailed(review.checks) || (review.aiReview?.status === 'done' && review.aiReview.verdict === 'block')) {
      this.mergeWhenFixed.delete(review.id)
      return
    }
    void this.merge(review.id, { force: true, acknowledged: mergeWarnings(review) })
      .then(() => this.mergeWhenFixed.delete(review.id))
      .catch(() => {
        const after = this.deps.reviews.get(review.id)
        // Another agent is working: try again a little later (a few times).
        if (after.status === 'pending' && !after.clash && follow.tries < 20) {
          follow.tries++
          setTimeout(() => this.onReview(this.deps.reviews.get(review.id)), 30_000).unref?.()
        } else this.mergeWhenFixed.delete(review.id)
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
