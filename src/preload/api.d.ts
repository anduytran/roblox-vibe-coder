import type { HangarApi } from '../shared/ipc'

declare global {
  interface Window {
    hangar: HangarApi
  }
}

export {}
