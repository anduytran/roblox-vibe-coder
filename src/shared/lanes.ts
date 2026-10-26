/**
 * Lanes: "scripter~2" is a second Scripter working at the same time as the first: the same role file and settings,
 * with its own conversation and its own copy of the game. Autopilot uses them when a sprint has several pieces for
 * one role.
 */
export const MAX_LANES = 3
const LANE_RE = /^([a-z0-9][a-z0-9-]{0,39})~([2-9])$/
/** The role an agent id runs as ("scripter~2" → "scripter"). */
export const roleOf = (agentId: string): string => LANE_RE.exec(agentId)?.[1] ?? agentId
/** Which lane an agent id is (1 for the role itself). */
export const laneOf = (agentId: string): number => Number(LANE_RE.exec(agentId)?.[2] ?? 1)
export const laneId = (agentId: string, lane: number): string => (lane <= 1 ? agentId : `${agentId}~${lane}`)

/** How an agent id is shown: its role's name ("Main" for main), plus "(2)" for a second lane. */
export function agentLabel(agentId: string, nameOf: (roleId: string) => string | undefined): string {
  const id = roleOf(agentId)
  const base = id === 'main' ? 'Main' : (nameOf(id) ?? id)
  return laneOf(agentId) > 1 ? `${base} (${laneOf(agentId)})` : base
}
