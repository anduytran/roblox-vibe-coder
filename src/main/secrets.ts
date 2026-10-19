import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { KeyStatus } from '@shared/ipc'

/**
 * Stores the Anthropic API key encrypted with the OS keychain (via Electron safeStorage:
 * DPAPI on Windows, Keychain on macOS). The key never leaves the main process: the
 * renderer only ever learns whether a key exists.
 */
export class SecretStore {
  /** Used when the OS cannot encrypt: kept in memory only, never written to disk. */
  private memoryOnlyKey: string | null = null

  constructor(private readonly file: string) {}

  status(): KeyStatus {
    return {
      hasKey: this.memoryOnlyKey !== null || existsSync(this.file),
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    }
  }

  setKey(key: string): KeyStatus {
    const trimmed = key.trim()
    if (!/^sk-ant-[A-Za-z0-9_\-]{10,}$/.test(trimmed)) {
      throw new Error('That does not look like an Anthropic API key (it should start with "sk-ant-").')
    }
    if (safeStorage.isEncryptionAvailable()) {
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

  clear(): KeyStatus {
    this.memoryOnlyKey = null
    rmSync(this.file, { force: true })
    return this.status()
  }
}
