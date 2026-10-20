// Converts Claude Agent SDK stream messages into feed entries.
// Only the fields this app reads are typed here, and every access is defensive, so newer SDK
// versions that add message types or fields keep working.
import type { LogEntry, LogKind } from '@shared/types'
import { summarizeToolUse } from './permissions'

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  content?: unknown
  is_error?: boolean
  id?: string
  tool_use_id?: string
  source?: { type?: string; media_type?: string; data?: string }
}

export interface StreamMessage {
  type?: string
  subtype?: string
  session_id?: string
  parent_tool_use_id?: string | null
  model?: string
  mcp_servers?: { name?: string; status?: string }[]
  message?: { content?: ContentBlock[] | string }
  total_cost_usd?: number
  num_turns?: number
  is_error?: boolean
  result?: string
  errors?: string[]
}

export interface Converted {
  entries: Omit<LogEntry, 'id' | 'ts'>[]
  sessionId?: string
  costUsd?: number
  activity?: string | null
  finished?: { ok: boolean; error?: string }
  /** Tool calls in this message (used to notice playtests starting and stopping). */
  toolUses?: { id: string; name: string; input: Record<string, unknown> }[]
  /** Images returned by tools, with the id of the tool call that produced them. */
  images?: { toolUseId: string; mediaType: string; data: string }[]
  /** The assistant's latest text, for the review summary. */
  text?: string
}

const MAX_TEXT = 4000
const MAX_RESULT = 800

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: ContentBlock) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : c?.type ? `[${c.type}]` : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function convertMessage(msg: StreamMessage): Converted {
  const out: Converted = { entries: [] }
  const push = (kind: LogKind, text: string, tool?: string): void => {
    out.entries.push(tool ? { kind, text, tool } : { kind, text })
  }
  if (msg.session_id) out.sessionId = msg.session_id
  const sub = msg.parent_tool_use_id ? '↳ ' : ''

  switch (msg.type) {
    case 'system': {
      if (msg.subtype !== 'init') break
      const servers = msg.mcp_servers ?? []
      const failed = servers.filter((s) => s.status && s.status !== 'connected')
      const ok = servers.length - failed.length
      push('system', `Session started${msg.model ? ` · ${msg.model}` : ''}${servers.length ? ` · ${ok}/${servers.length} tool servers connected` : ''}`)
      for (const s of failed) {
        push(
          'error',
          s.name === 'Roblox_Studio'
            ? 'Roblox Studio is not connected. Open Studio, enable "Studio as MCP server" in Assistant → Manage MCP Servers, then retry.'
            : `Tool server "${s.name}" is ${s.status}.`
        )
      }
      break
    }
    case 'assistant': {
      const content = msg.message?.content
      if (!Array.isArray(content)) break
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          push('assistant', sub + clip(block.text.trim(), MAX_TEXT))
          out.activity = 'Writing…'
          if (!msg.parent_tool_use_id) out.text = block.text.trim()
        } else if (block.type === 'tool_use' && block.name) {
          const summary = summarizeToolUse(block.name, block.input ?? {})
          push('tool_use', sub + summary, block.name)
          out.activity = summary
          ;(out.toolUses ??= []).push({ id: block.id ?? '', name: block.name, input: block.input ?? {} })
        }
      }
      break
    }
    case 'user': {
      const content = msg.message?.content
      if (!Array.isArray(content)) break
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        if (Array.isArray(block.content)) {
          for (const c of block.content as ContentBlock[]) {
            if (c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string' && /^image\/(png|jpeg|webp)$/.test(c.source.media_type ?? '')) {
              ;(out.images ??= []).push({ toolUseId: block.tool_use_id ?? '', mediaType: c.source.media_type!, data: c.source.data })
            }
          }
        }
        const text = toolResultText(block.content).trim()
        if (!text && !block.is_error) continue
        push(block.is_error ? 'error' : 'tool_result', sub + clip(text || 'Tool error', MAX_RESULT))
      }
      break
    }
    case 'result': {
      const cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined
      if (cost !== undefined) out.costUsd = cost
      const costText = cost !== undefined ? ` · $${cost.toFixed(4)}` : ''
      const turns = typeof msg.num_turns === 'number' ? ` · ${msg.num_turns} turns` : ''
      out.activity = null
      if (msg.subtype === 'success' && !msg.is_error) {
        push('result', `Done${costText}${turns}`)
        out.finished = { ok: true }
      } else {
        const reason = describeResultError(msg)
        push('error', `${reason}${costText}`)
        out.finished = { ok: false, error: reason }
      }
      break
    }
  }
  return out
}

function describeResultError(msg: StreamMessage): string {
  switch (msg.subtype) {
    case 'error_max_turns':
      return 'Stopped: reached the turn limit'
    case 'error_max_budget_usd':
      return 'Stopped: reached the per-run spending limit'
    case 'error_during_execution':
      return `Stopped with an error${msg.errors?.length ? `: ${msg.errors.join('; ')}` : ''}`
    default:
      return msg.result?.trim() ? `Stopped: ${clip(msg.result.trim(), 300)}` : `Stopped (${msg.subtype ?? 'unknown reason'})`
  }
}
