import type { Review, ReviewChecks } from './types'

/** True when any check failed, couldn't run, or the checks couldn't be prepared. */
export function checksFailed(c: ReviewChecks | null | undefined): boolean {
  if (!c || c.status === 'skipped') return false
  return c.results.some((r) => r.status !== 'passed') || (c.status === 'done' && c.reason !== null)
}

/**
 * Reasons Merge should ask "merge anyway?": failing checks, checks still running, or a reviewer
 * "block". Empty when it's fine to merge straight away. Shared by the app, the phone and the main process.
 */
export function mergeWarnings(review: Review): string[] {
  if (review.kind === 'research') return []
  const out: string[] = []
  if (review.checks?.status === 'running') out.push('Checks are still running.')
  else if (review.checks?.status === 'skipped') out.push(`Checks didn't run: ${review.checks.reason ?? 'skipped'}`)
  else if (checksFailed(review.checks)) {
    const bad = review.checks!.results.filter((r) => r.status !== 'passed').map((r) => r.name)
    out.push(bad.length ? `Checks failed: ${bad.join(', ')}.` : (review.checks!.reason ?? 'Checks could not run.'))
  }
  if (review.aiReview?.status === 'running') out.push('The reviewer agent is still reading it.')
  else if (review.aiReview?.status === 'done' && review.aiReview.verdict === 'block') out.push('The reviewer agent says not to merge this as is.')
  else if (review.aiReview?.status === 'error') out.push(`The reviewer agent didn't finish (${review.aiReview.error ?? 'unknown error'}).`)
  return out
}
