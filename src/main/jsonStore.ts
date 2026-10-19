import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Tiny JSON file store with atomic writes (write to temp file, then rename),
 * so a crash mid-write never leaves a half-written config behind.
 */
export class JsonStore<T> {
  private data: T

  constructor(
    private readonly file: string,
    defaults: T
  ) {
    this.data = this.load(defaults)
  }

  private load(defaults: T): T {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<T>
      if (raw && typeof raw === 'object' && !Array.isArray(defaults)) {
        return { ...defaults, ...raw }
      }
      return (raw as T) ?? defaults
    } catch {
      return defaults
    }
  }

  get(): T {
    return this.data
  }

  set(next: T): T {
    this.data = next
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, this.file)
    return next
  }

  update(fn: (current: T) => T): T {
    return this.set(fn(this.data))
  }
}
