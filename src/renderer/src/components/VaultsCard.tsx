import { useEffect, useState } from 'react'
import type { Project, Role } from '@shared/types'
import { attempt, EMPTY_ROLES, setRoles, toast, useStore } from '../store'
import { Button } from './ui'

/** Obsidian vaults for roles in this project (the UI Builder has one by default). */
export function VaultsCard({ project }: { project: Project }) {
  const roles = useStore((s) => s.roles[project.id] ?? EMPTY_ROLES)
  const [status, setStatus] = useState<Record<string, { exists: boolean; notes: number }>>({})
  const withVault = roles.filter((r) => r.vault)
  const uiBuilder = roles.find((r) => r.id === 'ui-builder' && !r.vault)

  useEffect(() => {
    void Promise.all(withVault.map((r) => window.hangar.vault.status(project.id, r.vault!))).then((list) =>
      setStatus(Object.fromEntries(list.map((s) => [s.folder, { exists: s.exists, notes: s.notes }])))
    )
  }, [project.id, roles]) // eslint-disable-line react-hooks/exhaustive-deps

  const giveVault = (role: Role, folder: string): void => {
    void attempt(async () => {
      setRoles(project.id, await window.hangar.roles.save(project.id, { ...role, vault: folder }))
      toast(`${role.name} now keeps notes in ${folder}/.`)
    })
  }

  return (
    <section className="card">
      <h3>Obsidian vaults</h3>
      <p className="small muted">
        A folder of Markdown notes inside the project that a role reads before working and keeps up to date — for the UI Builder: style guide, screens, components,
        decisions and an inbox for your requests. Open it in Obsidian to read and edit; changes show up in reviews like any other file.
      </p>
      {withVault.length === 0 && !uiBuilder && <p className="small muted">No roles have a vault. Add one in a role's settings (Agents → Edit role).</p>}
      {withVault.map((r) => {
        const st = status[r.vault!]
        return (
          <div key={r.id} className="row between vault-row">
            <span>
              <strong>{r.name}</strong> <code>{r.vault}/</code>{' '}
              <span className="muted small">{st ? (st.exists ? `${st.notes} notes` : 'not created yet') : ''}</span>
            </span>
            <div className="row gap-xs">
              {st && !st.exists ? (
                <Button
                  size="sm"
                  tone="primary"
                  onClick={() =>
                    void attempt(async () => {
                      const s = await window.hangar.vault.create(project.id, r.vault!)
                      setStatus((x) => ({ ...x, [s.folder]: { exists: s.exists, notes: s.notes } }))
                      toast('Vault created from templates.')
                    })
                  }
                >
                  Create vault
                </Button>
              ) : (
                <Button size="sm" onClick={() => void attempt(() => window.hangar.vault.open(project.id, r.vault!))}>
                  Open in Obsidian
                </Button>
              )}
            </div>
          </div>
        )
      })}
      {uiBuilder && (
        <div className="row between vault-row">
          <span className="small">The UI Builder doesn't have a vault yet.</span>
          <Button size="sm" tone="primary" onClick={() => giveVault(uiBuilder, 'ui-vault')}>
            Give UI Builder a vault
          </Button>
        </div>
      )}
      <p className="small muted">First time in Obsidian: “Open folder as vault” and pick the folder. Agents can never touch the vault's .obsidian settings folder.</p>
    </section>
  )
}
