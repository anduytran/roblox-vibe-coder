import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { validateApiKey } from './engineCredentials'

export interface StoredSecretStatus {
  hasKey: boolean
  /** False when the OS cannot encrypt secrets; the key is then not saved to disk. */
  encryptionAvailable: boolean
}

/** On Linux, safeStorage can fall back to a fixed password ("basic_text"), which is not real protection. */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux') {
    const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
    if (!backend || backend === 'basic_text' || backend === 'unknown') return false
  }
  return true
}

/**
 * Stores the Anthropic API key encrypted with the OS keychain (via Electron safeStorage:
 * DPAPI on Windows, Keychain on macOS). The key never leaves the main process: the
 * renderer only ever learns whether a key exists. It is passed to the Claude engine process
 * via its environment, so commands that process runs could read it.
 */
export class SecretStore {
  /** Used when the OS cannot encrypt: kept in memory only, never written to disk. */
  private memoryOnlyKey: string | null = null

  constructor(
    private readonly file: string,
    private readonly validate: (key: string) => string | null = validateApiKey
  ) {}

  status(): StoredSecretStatus {
    return {
      hasKey: this.memoryOnlyKey !== null || existsSync(this.file),
      encryptionAvailable: canEncrypt()
    }
  }

  setKey(key: string): StoredSecretStatus {
    const trimmed = key.trim()
    const problem = this.validate(trimmed)
    if (problem) throw new Error(problem)
    if (canEncrypt()) {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, safeStorage.encryptString(trimmed), { mode: 0o600 })
      this.memoryOnlyKey = null
    } else {
      this.memoryOnlyKey = trimmed
    }
    return this.status()
  }

  getKey(): string | null {
    if (this.memoryOnlyKey) return this.memoryOnlyKey
    if (!existsSync(this.file)) return null
    try {
      return safeStorage.decryptString(readFileSync(this.file))
    } catch {
      return null
    }
  }

  clear(): StoredSecretStatus {
    this.memoryOnlyKey = null
    rmSync(this.file, { force: true })
    return this.status()
  }
}
