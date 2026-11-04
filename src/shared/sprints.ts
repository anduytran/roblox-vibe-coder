/** Fewest pieces a sprint should have: below this, the plan, wrap-up and check-in cost more than the building. */
export const MIN_SPRINT_PIECES = 3

/**
 * Why a sprint length is a poor choice, or null when it's fine (0 = the Lead decides). One piece a sprint once spent
 * 28 sprints on a single follow-up each, with a plan, a wrap-up and a check-in around every one.
 */
export function smallSprintWarning(sprintTasks: number): string | null {
  if (!sprintTasks || sprintTasks >= MIN_SPRINT_PIECES) return null
  return `${sprintTasks === 1 ? 'One piece' : `${sprintTasks} pieces`} a sprint is slow: each sprint also has a plan, a wrap-up and a check-in, and one reviewer follow-up can take all of it. Pick "Lead decides" or ${MIN_SPRINT_PIECES}+.`
}
