import type { AiReview } from '@shared/types'

/** What a reviewer agent that read a change and found nothing wrong leaves on it (tests stand in for the real one). */
export const APPROVED: AiReview = { status: 'done', verdict: 'approve', summary: 'Looks fine.', findings: [], costUsd: 0, error: null }

/** A stand-in reviewer agent that approves everything. */
export const approvingReviewer = { review: async (): Promise<AiReview> => APPROVED }
