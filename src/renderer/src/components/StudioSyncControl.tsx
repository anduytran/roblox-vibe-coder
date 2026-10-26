import { useState } from 'react'
import type { Project } from '@shared/types'
import { attempt, toast, useStore } from '../store'

/**
 * Live sync of this game into Roblox Studio (Rojo), from the game's header: start or stop it, and the one-time
 * setup (Rojo itself, and the Rojo plugin in Studio) a click away when it's missing.
 */
export function StudioSyncControl({ project }: { project: Project }) {
  const sync = useStore((s) => s.studioSync)
  const [busy, setBusy] = useState(false)
  const mine = sync.projectId === project.id
  const status = mine ? sync.status : 'off'
  const go = (fn: () => Promise<unknown>, ok?: string): void => {
    setBusy(true)
    void attempt(async () => {
      await fn()
      if (ok) toast(ok)
    }).finally(() => setBusy(false))
  }
  const start = (): void => go(() => window.hangar.studio.syncStart(project.id))
  const plugin = (
    <button className="link small" disabled={busy} onClick={() => go(() => window.hangar.studio.installPlugin(), 'Rojo plugin installed. Restart Studio, then Plugins → Rojo → Connect.')}>
      Install Studio plugin
    </button>
  )

  if (status === 'running' || status === 'starting') {
    return (
      <span className="studio-sync studio-sync-on" role="status">
        <span className="studio-dot" aria-hidden />
        {status === 'starting' ? 'Starting sync…' : 'Syncing to Studio'}
        {status === 'running' && <span className="muted"> · in Studio: Plugins → Rojo → Connect</span>}
        <button className="link small" disabled={busy} onClick={() => go(() => window.hangar.studio.syncStop())}>
          Stop
        </button>
      </span>
    )
  }
  if (status === 'error') {
    const missing = /isn't installed/i.test(sync.message ?? '')
    return (
      <span className="studio-sync studio-sync-err" title={sync.message ?? ''}>
        <span className="err">Sync stopped</span>
        <span className="muted studio-sync-msg">{sync.message}</span>
        {missing ? (
          <button className="link small" disabled={busy} onClick={() => go(async () => { await window.hangar.studio.installRojo(); await window.hangar.studio.syncStart(project.id) }, 'Rojo installed.')}>
            {busy ? 'Installing Rojo…' : 'Install Rojo'}
          </button>
        ) : (
          <button className="link small" disabled={busy} onClick={start}>
            Try again
          </button>
        )}
      </span>
    )
  }
  return (
    <span className="studio-sync">
      <button className="link small" disabled={busy} onClick={start} title={sync.projectId && sync.status !== 'off' ? 'Stops the other game\'s sync first' : 'Serve this game to Roblox Studio with Rojo'}>
        Sync to Studio
      </button>
      {plugin}
    </span>
  )
}
