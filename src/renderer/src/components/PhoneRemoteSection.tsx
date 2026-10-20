import { useEffect, useState } from 'react'
import type { RemoteStatus } from '@shared/ipc'
import { attempt, toast } from '../store'
import { Button, timeAgo, Toggle } from './ui'

export function PhoneRemoteSection() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void window.hangar.remote.status().then(setStatus)
  }, [])

  useEffect(() => {
    if (!pairing) return
    const t = setInterval(() => {
      setNow(Date.now())
      // Refresh the device list while pairing so a new phone shows up.
      void window.hangar.remote.status().then((s) => {
        setStatus(s)
        if (status && s.devices.length > status.devices.length) {
          setPairing(null)
          toast('Phone paired.')
        }
      })
    }, 2000)
    return () => clearInterval(t)
  }, [pairing, status])

  if (!status) return null
  const secondsLeft = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0

  return (
    <section className="card">
      <h3>Phone remote</h3>
      <Toggle
        checked={status.enabled}
        onChange={(v) => void attempt(async () => setStatus(await window.hangar.remote.set({ enabled: v })))}
        label="Control Hangar from your phone"
        hint="Approve actions, review and merge finished tasks, queue work and stop agents from your phone, over your private Tailscale network. Settings and high-risk approvals stay on this computer."
      />
      {status.enabled && (
        <>
          <ol className="small steps">
            <li>
              Install Tailscale on this computer and your phone, signed in to the same account.{' '}
            </li>
            <li>
              Run this once on this computer (it makes Hangar reachable only from your own Tailscale devices, over HTTPS):
              <div className="row gap-xs">
                <code className="cmd">{status.serveCommand}</code>
                <Button size="sm" tone="ghost" onClick={() => void navigator.clipboard.writeText(status.serveCommand).then(() => toast('Copied.'))}>
                  Copy
                </Button>
              </div>
            </li>
            <li>
              On your phone, open {status.url ? <code>{status.url}</code> : <span>your computer’s Tailscale address (https://&lt;computer-name&gt;.&lt;tailnet&gt;.ts.net)</span>}, add it to your Home Screen,
              then pair it:
            </li>
          </ol>
          <div className="row gap-sm">
            <Button tone="primary" onClick={() => void attempt(async () => setPairing(await window.hangar.remote.pair()))}>
              Pair a phone
            </Button>
            {pairing && secondsLeft > 0 && (
              <span className="pair-code" aria-live="polite">
                {pairing.code} <span className="muted small">({Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')})</span>
              </span>
            )}
          </div>
          {status.devices.length > 0 && (
            <ul className="device-list">
              {status.devices.map((d) => (
                <li key={d.id} className="row between">
                  <span>
                    {d.name} <span className="muted small">· paired {timeAgo(d.pairedAt)}{d.lastSeen ? ` · seen ${timeAgo(d.lastSeen)}` : ''}</span>
                  </span>
                  <Button size="sm" tone="danger" onClick={() => void attempt(async () => setStatus(await window.hangar.remote.unpair(d.id)))}>
                    Unpair
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">{status.pushReady ? 'Notifications are on for at least one phone.' : 'Turn on notifications from the phone app’s Settings tab.'}</p>
        </>
      )}
    </section>
  )
}
