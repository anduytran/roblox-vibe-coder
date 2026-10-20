import { useState } from 'react'
import { attempt, setKey, setSettings, toast, useStore } from '../store'
import { Button, Field, Modal, Toggle } from './ui'

const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const key = useStore((s) => s.key)
  const [keyDraft, setKeyDraft] = useState('')
  const [model, setModel] = useState(settings?.defaultModel ?? MODELS[0]!)
  const [concurrency, setConcurrency] = useState(String(settings?.maxConcurrentRuns ?? 3))
  const [perRun, setPerRun] = useState(String(settings?.perRunBudgetUsd ?? 2))
  const [daily, setDaily] = useState(settings?.globalDailyBudgetUsd?.toString() ?? '')
  const [studioCmd, setStudioCmd] = useState(settings?.studioMcpCommand ?? '')
  const [studioArgs, setStudioArgs] = useState((settings?.studioMcpArgs ?? []).join(' '))
  const [hideKey, setHideKey] = useState(settings?.hideKeyFromAgents ?? true)

  const saveKey = (): void => {
    void attempt(async () => {
      setKey(await window.hangar.key.set(keyDraft))
      setKeyDraft('')
      toast('API key saved securely.')
    })
  }

  const save = (): void => {
    void attempt(async () => {
      const d = parseFloat(daily)
      const next = await window.hangar.settings.set({
        defaultModel: model,
        maxConcurrentRuns: parseInt(concurrency, 10),
        perRunBudgetUsd: parseFloat(perRun),
        globalDailyBudgetUsd: Number.isFinite(d) && d > 0 ? d : null,
        studioMcpCommand: studioCmd,
        studioMcpArgs: studioArgs.trim() ? studioArgs.trim().split(/\s+/) : [],
        hideKeyFromAgents: hideKey
      })
      setSettings(next)
      toast('Settings saved.')
      onClose()
    })
  }

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <section className="card">
        <h3>Anthropic API key</h3>
        <p className="small">
          {key.hasKey ? (
            <>
              <span className="ok">●</span> A key is saved{key.encryptionAvailable ? ', encrypted with your OS keychain.' : ' for this session only.'}
            </>
          ) : (
            'No key yet. Create one in the Claude Console (console.anthropic.com → API keys).'
          )}
        </p>
        {!key.encryptionAvailable && (
          <p className="small warn">Your system can't encrypt secrets, so the key is kept in memory only and you'll need to re-enter it next launch.</p>
        )}
        <div className="row gap-xs">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={keyDraft}
            placeholder={key.hasKey ? 'Paste a new key to replace it' : 'sk-ant-…'}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <Button tone="primary" disabled={!keyDraft.trim()} onClick={saveKey}>
            Save key
          </Button>
          {key.hasKey && (
            <Button tone="danger" onClick={() => void attempt(async () => setKey(await window.hangar.key.clear()))}>
              Remove
            </Button>
          )}
        </div>
        <Toggle
          checked={hideKey}
          onChange={setHideKey}
          label="Hide API key from agents (recommended)"
          hint="Agents get a temporary token that only works through Hangar on this computer; Hangar adds the real key when talking to Anthropic. Turn off only if agents can't connect."
        />
        <p className="muted small">
          The key is never sent to this window. {hideKey ? 'With hiding on, agents and the commands they run never see it.' : 'With hiding off, the Claude engine holds the key, so commands an agent runs could read it.'} Either way, use a dedicated key with a spending limit set in the Claude Console.
        </p>
      </section>

      <section className="card">
        <h3>Agents</h3>
        <div className="grid-2">
          <Field label="Default model">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {[...new Set([model, ...MODELS])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agents running at once" hint="Others wait in their queues.">
            <input inputMode="numeric" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="card">
        <h3>Spending limits</h3>
        <div className="grid-2">
          <Field label="Per-task limit (USD)" hint="A single run stops when it reaches this.">
            <input inputMode="decimal" value={perRun} onChange={(e) => setPerRun(e.target.value)} />
          </Field>
          <Field label="Daily limit, all projects (USD)" hint="Empty = no daily limit.">
            <input inputMode="decimal" value={daily} placeholder="No limit" onChange={(e) => setDaily(e.target.value)} />
          </Field>
        </div>
        <p className="muted small">Costs are the SDK's own estimates; check the Claude Console for exact billing.</p>
      </section>

      <section className="card">
        <h3>Roblox Studio connection</h3>
        <p className="small muted">
          Leave empty to use Roblox's default for your OS (Windows: %LOCALAPPDATA%\Roblox\mcp.bat, macOS: RobloxStudio.app's StudioMCP). Override only if
          Studio is installed somewhere else; Studio shows the exact command under Assistant Settings → MCP Servers.
        </p>
        <div className="grid-2">
          <Field label="Command">
            <input value={studioCmd} onChange={(e) => setStudioCmd(e.target.value)} placeholder="Platform default" />
          </Field>
          <Field label="Arguments">
            <input value={studioArgs} onChange={(e) => setStudioArgs(e.target.value)} placeholder="Space-separated" />
          </Field>
        </div>
      </section>
    </Modal>
  )
}
