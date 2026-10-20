import { join } from 'node:path'
import { SecretStore } from './secrets'
import { validateOpenCloudKey } from './testPlace'

/** Per-project Roblox Open Cloud keys, encrypted with the OS keychain like the Anthropic key. */
export class TestPlaceKeys {
  constructor(private readonly dir: string) {}

  private store(projectId: string): SecretStore {
    if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error('Invalid project.')
    return new SecretStore(join(this.dir, `roblox-key-${projectId}.bin`), validateOpenCloudKey)
  }
  status(projectId: string): { hasKey: boolean } {
    return { hasKey: this.store(projectId).status().hasKey }
  }
  set(projectId: string, key: string): { hasKey: boolean } {
    return { hasKey: this.store(projectId).setKey(key).hasKey }
  }
  clear(projectId: string): { hasKey: boolean } {
    return { hasKey: this.store(projectId).clear().hasKey }
  }
  get(projectId: string): string | null {
    return this.store(projectId).getKey()
  }
}

