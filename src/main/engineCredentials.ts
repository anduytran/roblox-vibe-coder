import type { AppSettings } from '@shared/types'

/** What an engine run gets: environment variables, a revoke hook, and an optional warning to show in the agent's feed. */
export interface EngineAuth {
  env: Record<string, string>
  release: () => void
  note?: string
}

export interface KeyProxyLike {
  start(): Promise<void>
  issueToken(): string
  baseUrl(): string
  revokeToken(token: string): void
}

export const API_KEY_PATTERN = /^sk-ant-(?!oat)[A-Za-z0-9_\-]{10,}$/
/** `claude setup-token` output: a long-lived OAuth token for a Claude subscription. */
export const MAX_TOKEN_PATTERN = /^sk-ant-oat\d{2}-[A-Za-z0-9_\-]{10,}$/

export function validateApiKey(key: string): string | null {
  if (MAX_TOKEN_PATTERN.test(key)) return 'That is a Claude subscription token, not an API key. Paste it under "Claude Max (personal use)" instead.'
  return API_KEY_PATTERN.test(key) ? null : 'That does not look like an Anthropic API key (it should start with "sk-ant-").'
}

export function validateMaxToken(token: string): string | null {
  return MAX_TOKEN_PATTERN.test(token) ? null : 'That does not look like a Claude subscription token. Run `claude setup-token` and paste the token it prints (it starts with "sk-ant-oat").'
}

/**
 * Picks the credential every engine run uses.
 *
 * Normally that is the API key, hidden behind the local key proxy whenever commands can run without a
 * click. "Claude Max" mode is for the owner's own use in development builds only: Anthropic doesn't
 * allow apps to offer claude.ai sign-in or to hold subscription credentials on someone's behalf, so the
 * token is never proxied — the engine gets it directly — and packaged builds ignore the mode entirely.
 */
export class EngineCredentials {
  constructor(
    private readonly deps: {
      /** False in packaged builds: Max mode can't be turned on there. */
      personalModeAllowed: boolean
      getSettings: () => AppSettings
      getApiKey: () => string | null
      getMaxToken: () => string | null
      keyProxy: KeyProxyLike
    }
  ) {}

  usingMax(): boolean {
    return this.deps.personalModeAllowed && this.deps.getSettings().authMode === 'max'
  }

  /** The active credential, or null if the active mode has none saved. */
  get(): string | null {
    return this.usingMax() ? this.deps.getMaxToken() : this.deps.getApiKey()
  }

  async auth(credential: string, opts: { forceHideKey: boolean }): Promise<EngineAuth> {
    if (this.usingMax()) {
      return {
        env: { CLAUDE_CODE_OAUTH_TOKEN: credential },
        release: () => {},
        // forceHideKey means commands may run without a click; with Max the real token is in the engine.
        note: opts.forceHideKey
          ? 'Claude Max mode: this run holds your subscription token directly, so commands it runs without asking could read it.'
          : undefined
      }
    }
    if (!this.deps.getSettings().hideKeyFromAgents && !opts.forceHideKey) return { env: { ANTHROPIC_API_KEY: credential }, release: () => {} }
    const proxy = this.deps.keyProxy
    await proxy.start()
    const token = proxy.issueToken()
    return {
      env: { ANTHROPIC_BASE_URL: proxy.baseUrl(), ANTHROPIC_API_KEY: token },
      release: () => proxy.revokeToken(token)
    }
  }
}
