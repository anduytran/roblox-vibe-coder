import type { ProjectSettings } from '@shared/types'
import { isInsideRoot, pathsFromToolInput } from './pathScope'

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason: string; outsideProject: boolean }

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'Task', 'Agent'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Read-only Roblox Studio MCP tools: inspecting the game and playtest output is safe to allow. */
export const STUDIO_MCP_NAME = 'Roblox_Studio'
const STUDIO_READ_TOOLS = new Set([
  'script_read',
  'script_search',
  'script_grep',
  'search_game_tree',
  'inspect_instance',
  'get_studio_state',
  'get_console_output',
  'screen_capture',
  'list_roblox_studios'
])
/** Shell syntax that chains or redirects commands. A prefix allow-rule never covers these. */
const SHELL_CHAINING = /[;&|`<>]|\$\(|\n/

/** The rule saved when the user clicks "Always allow" on a shell command: its first two words. */
export function bashPrefixFor(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(' ')
}

function bashAllowed(command: string, prefixes: string[]): boolean {
  const cmd = command.trim()
  if (cmd === '' || SHELL_CHAINING.test(cmd)) return false
  return prefixes.some((p) => {
    const prefix = p.trim()
    return prefix !== '' && (cmd === prefix || cmd.startsWith(prefix + ' '))
  })
}

/**
 * Decide what happens to a tool call before it runs.
 * Default posture: reading inside the project is free; anything that changes
 * things, runs commands, reaches the network or leaves the project folder asks first.
 */
export function evaluateToolUse(args: {
  toolName: string
  input: Record<string, unknown>
  projectRoot: string
  settings: ProjectSettings
}): PolicyDecision {
  const { toolName, input, projectRoot, settings } = args
  const paths = pathsFromToolInput(input)
  const outside = paths.filter((p) => !isInsideRoot(projectRoot, p))

  if (outside.length > 0) {
    return {
      action: 'ask',
      outsideProject: true,
      reason: `Touches a path outside the project folder: ${outside.join(', ')}`
    }
  }

  if (READ_TOOLS.has(toolName)) return { action: 'allow' }

  const studioPrefix = `mcp__${STUDIO_MCP_NAME}__`
  if (toolName.startsWith(studioPrefix) && STUDIO_READ_TOOLS.has(toolName.slice(studioPrefix.length))) {
    return { action: 'allow' }
  }

  if (EDIT_TOOLS.has(toolName)) {
    if (settings.autoApproveEdits || settings.alwaysAllowTools.includes(toolName)) return { action: 'allow' }
    return { action: 'ask', outsideProject: false, reason: 'Edits a file in the project' }
  }

  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (bashAllowed(command, settings.allowedBashPrefixes)) return { action: 'allow' }
    return {
      action: 'ask',
      outsideProject: false,
      reason: SHELL_CHAINING.test(command) ? 'Runs a chained or redirected shell command' : 'Runs a shell command'
    }
  }

  if (settings.alwaysAllowTools.includes(toolName)) return { action: 'allow' }

  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return { action: 'ask', outsideProject: false, reason: 'Reaches the internet' }
  }
  if (toolName.startsWith('mcp__')) {
    return { action: 'ask', outsideProject: false, reason: 'Calls a connected tool (MCP)' }
  }
  return { action: 'ask', outsideProject: false, reason: `Uses ${toolName}` }
}

/** One-line human summary of a tool call for the approval card and activity feed. */
export function summarizeToolUse(toolName: string, input: Record<string, unknown>): string {
  const s = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  switch (toolName) {
    case 'Bash':
      return `$ ${s('command') ?? ''}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${toolName} ${s('file_path') ?? s('notebook_path') ?? ''}`
    case 'Glob':
      return `Glob ${s('pattern') ?? ''}`
    case 'Grep':
      return `Grep "${s('pattern') ?? ''}"${s('path') ? ` in ${s('path')}` : ''}`
    case 'WebFetch':
      return `Fetch ${s('url') ?? ''}`
    case 'WebSearch':
      return `Search "${s('query') ?? ''}"`
    case 'Task':
    case 'Agent':
      return `Delegate to ${s('subagent_type') ?? 'subagent'}: ${s('description') ?? ''}`
    default: {
      const json = JSON.stringify(input)
      return `${toolName} ${json.length > 160 ? json.slice(0, 157) + '…' : json}`
    }
  }
}
