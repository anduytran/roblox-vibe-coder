import { join } from 'node:path'
import type { Project } from '@shared/types'
import { serverScriptDirs } from './pathScope'

/**
 * OS-enforced sandbox for the shell commands agents run (Claude Code's built-in sandbox:
 * Seatbelt on macOS, bubblewrap on Linux/WSL2). Not available on native Windows.
 *
 * Inside it, a command and everything it starts can only write to the project folder and a temp
 * folder, has no network except the domains you allow, and can't read the credential folders
 * listed below. Claude Code itself also blocks writes to its own config (.claude, .mcp.json,
 * .git hooks/config, .vscode, .idea); Hangar adds its other protected files on top.
 */
export function sandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/** Folders with secrets that sandboxed commands may not read. */
const CREDENTIAL_DIRS = [
  '~/.ssh', '~/.aws', '~/.azure', '~/.config/gcloud', '~/.kube', '~/.gnupg', '~/.docker', '~/.config/gh',
  '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.git-credentials', '~/Library/Keychains', '~/.claude'
]

/** Hangar-protected files and folders at the project root that sandboxed commands may not write. */
const PROJECT_DENY_WRITE = [
  'CLAUDE.md', 'package.json', 'Makefile', '.envrc', '.npmrc', '.gitattributes', '.gitmodules', '.lfsconfig',
  'rokit.toml', 'aftman.toml', 'foreman.toml', 'wally.toml', 'mise.toml', '.mise.toml', '.tool-versions',
  '.pre-commit-config.yaml', '.github', '.husky', '.cursor', '.devcontainer', '.zed', '.windsurf', '.vs'
]

export interface SandboxPlan {
  /** Passed to the SDK's `settings` option (the same layer as `claude --settings`). */
  settings: { sandbox: Record<string, unknown> } | null
  active: boolean
  /** Shown in the UI when the sandbox is off. */
  reason: string | null
}

export function planSandbox(project: Project, opts: { platform?: NodeJS.Platform; appDataDir: string }): SandboxPlan {
  const platform = opts.platform ?? process.platform
  if (!project.settings.sandbox) return { settings: null, active: false, reason: 'Sandbox is turned off for this project.' }
  if (!sandboxSupported(platform)) {
    return { settings: null, active: false, reason: 'The sandbox is not available on Windows; approved commands run with your full permissions.' }
  }
  const denyWrite = [...PROJECT_DENY_WRITE, ...serverScriptDirs(project.path)].map((p) => join(project.path, p))
  return {
    active: true,
    reason: null,
    settings: {
      sandbox: {
        enabled: true,
        // Never fall back to running commands unsandboxed: if the sandbox can't start, the run fails.
        failIfUnavailable: true,
        // Ignore the engine's "retry outside the sandbox" escape hatch.
        allowUnsandboxedCommands: false,
        // Sandboxed commands run without a prompt only if this project already auto-approves edits;
        // otherwise every command still asks, with the sandbox as a second layer.
        autoAllowBashIfSandboxed: project.settings.autoApproveEdits,
        filesystem: {
          denyWrite,
          // Hangar's own data folder holds the encrypted API key.
          denyRead: [...CREDENTIAL_DIRS, opts.appDataDir]
        },
        network: { allowedDomains: project.settings.sandboxAllowedDomains }
      }
    }
  }
}
