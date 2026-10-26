/**
 * Groups an agent's log for reading: each tool call sits with its result, and a stretch of three or more
 * tool calls folds into one "N tool calls" run. Assistant text, your messages and system lines stay as they are.
 * Pure; the raw log is untouched and still shown by the "Raw log" toggle.
 */
import type { LogEntry } from './types'

export interface ToolCall {
  use: LogEntry
  /** The tool's result (or its error), when one was logged. */
  result: LogEntry | null
}

export type FeedItem = { type: 'entry'; key: string; entry: LogEntry } | { type: 'tool'; key: string; call: ToolCall } | { type: 'run'; key: string; calls: ToolCall[] }

/** A stretch of at least this many tool calls in a row folds into a run. */
export const RUN_AT = 3

export function groupFeed(log: readonly LogEntry[], runAt = RUN_AT): FeedItem[] {
  const out: FeedItem[] = []
  let calls: ToolCall[] = []
  // Calls still waiting for a result, by id, across the whole log: an approval line or a subagent's work can
  // come between a call and its result. The objects are the ones already in `out`, so a late result still shows.
  const open = new Map<string, ToolCall>()
  const flush = (): void => {
    if (calls.length >= runAt) out.push({ type: 'run', key: `run:${calls[0]!.use.id}`, calls })
    else for (const call of calls) out.push({ type: 'tool', key: call.use.id, call })
    calls = []
  }
  // Entries saved before ids were recorded pair in order with id-less calls in the same stretch.
  const owner = (e: LogEntry): ToolCall | undefined => (e.toolUseId ? open.get(e.toolUseId) : calls.find((c) => !c.result && !c.use.toolUseId))

  for (const e of log) {
    if (e.kind === 'tool_use') {
      const call: ToolCall = { use: e, result: null }
      calls.push(call)
      if (e.toolUseId) open.set(e.toolUseId, call)
      continue
    }
    // Tool errors carry the id of the call they belong to; any other error is the agent's or Hangar's own.
    if (e.kind === 'tool_result' || (e.kind === 'error' && e.toolUseId)) {
      const call = owner(e)
      if (call) {
        call.result = e
        if (e.toolUseId) open.delete(e.toolUseId)
        continue
      }
    }
    flush()
    out.push({ type: 'entry', key: e.id, entry: e })
  }
  flush()
  return out
}

/** UTF-8 size of a string. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3
  }
  return bytes
}

/** "1.2 KB" / "640 B": the size of a tool's whole output (recorded before the log clipped it), or of what was logged. */
export function sizeLabel(entry: Pick<LogEntry, 'text' | 'bytes'>): string {
  const bytes = entry.bytes ?? utf8Bytes(entry.text)
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** "Read ×3, Edit, Bash": what a run did, most-used first, at most four names. */
export function runSummary(calls: readonly ToolCall[]): string {
  const counts = new Map<string, number>()
  for (const c of calls) {
    const name = c.use.tool ?? 'Tool'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1])
  const names = sorted.slice(0, 4).map(([n, k]) => (k > 1 ? `${n} ×${k}` : n))
  return sorted.length > 4 ? `${names.join(', ')}, …` : names.join(', ')
}
