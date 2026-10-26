import { useEffect, useState } from 'react'
import type { Project, ShipStatus } from '@shared/types'
import { attempt, confirmDialog, replaceProject, setProjectTab, toast } from '../store'
import { Button, Field, timeAgo } from './ui'

/**
 * Getting the game out: the ship checklist's progress (what's left, and what needs you), its purchases, and
 * publishing the merged game to the live, public place. Publishing only ever happens on your click here.
 */
export function ShipCard({ project, watch }: { project: Project; watch: string }) {
  const [status, setStatus] = useState<ShipStatus | null>(null)
  const [busy, setBusy] = useState<'kit' | 'live' | null>(null)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [universeId, setUniverseId] = useState(project.settings.livePlace?.universeId ?? '')
  const [placeId, setPlaceId] = useState(project.settings.livePlace?.placeId ?? '')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    void attempt(() => window.hangar.ship.status(project.id)).then((s) => s && setStatus(s))
    void window.hangar.testPlaceKey.status(project.id).then((r) => setHasKey(r.hasKey))
  }, [project.id, watch, project.settings.livePlace])

  if (!status) return null
  const ready = status.hasChecklist && status.hasPurchaseCode
  const done = status.items.filter((i) => i.done).length
  const left = status.items.filter((i) => !i.done)
  const forYou = left.filter((i) => i.you)
  const live = project.settings.livePlace

  const addKit = (): void => {
    setBusy('kit')
    void attempt(async () => {
      setStatus(await window.hangar.ship.addKit(project.id))
      toast('Added the ship checklist and purchase templates. The Lead works through the checklist first.')
    }).finally(() => setBusy(null))
  }

  const saveLive = (): void => {
    void attempt(async () => {
      replaceProject(await window.hangar.projects.update(project.id, { settings: { livePlace: { universeId: universeId.trim(), placeId: placeId.trim() } } }))
      toast('Saved the live game.')
    })
  }

  const publish = (): void => {
    if (!live) return
    const warnings = [
      left.length ? `${left.length} ship checklist item${left.length === 1 ? ' isn\'t' : 's aren\'t'} done yet.` : null,
      status.purchases.listed > status.purchases.created ? `${status.purchases.listed - status.purchases.created} purchase${status.purchases.listed - status.purchases.created === 1 ? ' has' : 's have'} no ID yet, so ${status.purchases.listed - status.purchases.created === 1 ? 'it' : 'they'} can't be bought.` : null
    ].filter((w): w is string => !!w)
    void confirmDialog({
      title: 'Publish to the live game?',
      body: `Players will get this version: what's merged on your main branch, built and uploaded to place ${live.placeId} (universe ${live.universeId}). Changes still in Reviews aren't included.${warnings.length ? ' Before you go:' : ''}`,
      lines: warnings,
      confirmLabel: 'Publish to live game',
      tone: warnings.length ? 'danger' : 'primary'
    }).then((ok) => {
      if (!ok) return
      setBusy('live')
      void attempt(async () => {
        const r = await window.hangar.ship.publishLive(project.id)
        setStatus(r.status)
        toast(`Published version ${r.versionNumber} to the live game (from ${r.branch} at ${r.sha.slice(0, 7)}).`)
      }).finally(() => setBusy(null))
    })
  }

  return (
    <section className="card ship-card">
      <div className="row between">
        <h3>Ship it</h3>
        {status.items.length > 0 && (
          <span className="small muted">
            {done} of {status.items.length} done
          </span>
        )}
      </div>

      {!ready ? (
        <>
          <p className="small muted">
            Add a ship checklist (the smallest version worth publishing: fun for ten minutes, a goal, two or three things to buy) and purchase templates
            (game passes and developer products, granted safely on the server). The Lead works through the checklist before anything else.
          </p>
          <div>
            <Button tone="primary" disabled={busy !== null} onClick={addKit}>
              {busy === 'kit' ? 'Adding…' : 'Add the ship checklist and purchase templates'}
            </Button>
          </div>
        </>
      ) : (
        <>
          {status.items.length > 0 && (
            <div className="ship-progress" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={status.items.length}>
              <span style={{ width: `${Math.round((done / status.items.length) * 100)}%` }} />
            </div>
          )}
          {forYou.length > 0 && (
            <div className="checkin-block">
              <span className="side-label">Needs you</span>
              <ul className="small">
                {forYou.map((i) => (
                  <li key={i.text}>{i.text.replace(/^\(you\)\s*/i, '')}</li>
                ))}
              </ul>
            </div>
          )}
          {left.length > forYou.length && (
            <div>
              <button className="link small" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
                {showAll ? '▾' : '▸'} {left.length - forYou.length} left for the agents
              </button>
              {showAll && (
                <ul className="small muted">
                  {left
                    .filter((i) => !i.you)
                    .map((i) => (
                      <li key={i.text}>
                        {i.section ? `${i.section}: ` : ''}
                        {i.text}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
          <p className="small muted">
            Purchases: {status.purchases.listed ? `${status.purchases.listed} listed, ${status.purchases.created} created in the Creator Hub` : 'none listed yet'} ·{' '}
            <button className="link small" onClick={() => void attempt(() => window.hangar.system.openUrl('https://create.roblox.com/dashboard/creations'))}>
              Open the Creator Hub
            </button>
          </p>
        </>
      )}

      <div className="checkin-block">
        <span className="side-label">Live game</span>
        {status.lastLive && (
          <p className="small">
            Version {status.lastLive.versionNumber} published {timeAgo(status.lastLive.at)} (commit {status.lastLive.sha.slice(0, 7)}).
          </p>
        )}
        <div className="grid-2">
          <Field label="Universe ID" hint="From the Creator Hub: your game → the ⋯ menu → Copy Universe ID.">
            <input value={universeId} inputMode="numeric" onChange={(e) => setUniverseId(e.target.value)} placeholder="1234567890" />
          </Field>
          <Field label="Start place ID" hint="The number in the game's roblox.com address.">
            <input value={placeId} inputMode="numeric" onChange={(e) => setPlaceId(e.target.value)} placeholder="1234567890" />
          </Field>
        </div>
        <div className="row gap-xs wrap">
          {(universeId.trim() !== (live?.universeId ?? '') || placeId.trim() !== (live?.placeId ?? '')) && (
            <Button size="sm" disabled={!/^\d+$/.test(universeId.trim()) || !/^\d+$/.test(placeId.trim())} onClick={saveLive}>
              Save
            </Button>
          )}
          <Button tone="primary" disabled={!live || hasKey === false || busy !== null} onClick={publish}>
            {busy === 'live' ? 'Building and publishing…' : 'Publish to live game'}
          </Button>
        </div>
        {hasKey === false && (
          <p className="small warn">
            Publishing needs a Roblox Open Cloud key.{' '}
            <button className="link small" onClick={() => setProjectTab('settings')}>
              Add one in the Project tab
            </button>{' '}
            with the "universe-places Write" permission for this game.
          </p>
        )}
        {hasKey && live && (
          <p className="small muted">Uses the game's Open Cloud key: give it the "universe-places Write" permission for this game's universe too.</p>
        )}
      </div>
    </section>
  )
}
