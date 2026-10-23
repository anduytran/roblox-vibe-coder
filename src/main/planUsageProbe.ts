import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One window from the engine's /usage data: percent used (0–100) and when it resets. */
export interface UsageWindow {
  utilization: number | null
  resets_at: string | null
}

export interface PlanUsageAnswer {
  rate_limits_available: boolean
  rate_limits: { five_hour?: UsageWindow | null; seven_day?: UsageWindow | null } | null
}

/** The part of the SDK's query object this uses. The usage method is experimental and may be renamed. */
interface UsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts?: { skipBehaviors?: boolean }) => Promise<PlanUsageAnswer>
}

type RawQuery = (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => UsageQuery

/**
 * Ask the engine for the Claude plan's current usage (the numbers behind Claude Code's /usage).
 * No prompt is ever sent, so it uses none of the plan: the engine starts, answers, and is stopped.
 * Returns null with a reason when the answer isn't available (method missing, no plan limits, error).
 */
export async function probePlanUsage(query: RawQuery, env: Record<string, string>, timeoutMs = 20_000): Promise<{ answer: PlanUsageAnswer | null; reason: string | null }> {
  const cwd = mkdtempSync(join(tmpdir(), 'hangar-usage-'))
  const controller = new AbortController()
  let finish!: () => void
  const done = new Promise<void>((r) => (finish = r))
  // Streaming input that never sends a message: keeps the engine open for the one control request.
  async function* noPrompt(): AsyncGenerator<never> {
    await done
  }
  let timer: NodeJS.Timeout | undefined
  try {
    const q = query({
      prompt: noPrompt(),
      options: {
        cwd,
        abortController: controller,
        settingSources: [],
        agents: {},
        mcpServers: {},
        disallowedTools: ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite'],
        canUseTool: async () => ({ behavior: 'deny', message: 'No tools are available.' }),
        env
      }
    })
    const ask = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof ask !== 'function') return { answer: null, reason: 'this Agent SDK version has no usage method' }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
    })
    const answer = await Promise.race([ask.call(q, { skipBehaviors: true }), timeout])
    if (!answer?.rate_limits_available || !answer.rate_limits) return { answer: null, reason: 'the engine says plan limits are not available for this sign-in' }
    return { answer, reason: null }
  } catch (err) {
    return { answer: null, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
    finish()
    controller.abort()
    rmSync(cwd, { recursive: true, force: true })
  }
}
