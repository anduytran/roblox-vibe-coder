import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { attempt, openPage, openSettings, openWizard, useStore } from '../store'
import { Button } from './ui'

type Tools = Awaited<ReturnType<typeof window.hangar.system.tools>>

/** Home before the first game: what Hangar needs, each with the one thing to do about it. Gone once a game exists. */
export function FirstRun() {
  const signedIn = useStore((s) => s.key.ready)
  const onMax = useStore((s) => s.settings?.authMode === 'max')
  const [tools, setTools] = useState<Tools | null>(null)
  const check = useCallback(() => {
    void attempt(() => window.hangar.system.tools()).then((t) => {
      if (t) setTools(t)
    })
  }, [])
  useEffect(() => {
    check()
  }, [check])

  const mark = (ok: boolean | undefined): string => (ok === undefined ? '…' : ok ? '✓' : '✗')
  const buildOk = !!tools && tools.rojo && tools.git
  return (
    <section className="home-section">
      <h2>Get set up</h2>
      <ol className="firstrun">
        <Step n={1} done={signedIn} title="Sign in" action={<Button size="sm" tone={signedIn ? 'ghost' : 'primary'} onClick={() => openSettings('account')}>{signedIn ? 'Settings' : 'Open Settings'}</Button>}>
          {signedIn
            ? onMax
              ? 'Signed in with your Claude plan.'
              : 'Your Anthropic API key is saved.'
            : 'Add an Anthropic API key in Settings → Account so agents can run.'}
        </Step>
        <Step
          n={2}
          done={tools ? buildOk : undefined}
          title="Tools"
          action={
            <Button size="sm" tone="ghost" onClick={check}>
              Check again
            </Button>
          }
        >
          <span className="firstrun-tools">
            Rojo {mark(tools?.rojo)} · Git {mark(tools?.git)} · Selene {mark(tools?.selene)} · StyLua {mark(tools?.stylua)} · Roblox Studio {mark(tools?.studio)}
          </span>
          {tools && !buildOk && ' Rojo builds and publishes your game; Git keeps each task on its own branch. Selene and StyLua are optional checks.'}
          {tools &&
            (tools.studio
              ? ' So agents can playtest: with Studio open, turn on Assistant → … → Manage MCP Servers → Enable Studio as MCP server.'
              : ' Optional, so agents can playtest: install Roblox Studio, then turn on Assistant → … → Manage MCP Servers → Enable Studio as MCP server. If it lives somewhere else, set its command in Settings → Roblox.')}
        </Step>
        <Step
          n={3}
          done={false}
          title="Create your first game"
          action={
            <>
              <Button size="sm" tone="primary" onClick={() => openWizard()}>
                New game
              </Button>
              <Button size="sm" tone="ghost" onClick={() => openPage('ideas')}>
                Find an idea
              </Button>
            </>
          }
        >
          Describe it and agents build it in sprints, checking in with you as they go.
        </Step>
      </ol>
    </section>
  )
}

function Step(props: { n: number; done: boolean | undefined; optional?: boolean; title: string; action: ReactNode; children: ReactNode }) {
  const state = props.done === undefined ? 'checking' : props.done ? 'done' : 'todo'
  return (
    <li className={`firstrun-step firstrun-${state}`}>
      <span className="firstrun-mark" aria-hidden>
        {props.done ? '✓' : props.n}
      </span>
      <span className="firstrun-text">
        <strong>
          {props.title}
          {props.optional && <span className="muted small"> · optional</span>}
          <span className="sr-only">{state === 'done' ? ' (done)' : state === 'checking' ? ' (checking)' : ''}</span>
        </strong>
        <span className="small muted">{props.children}</span>
      </span>
      <span className="row gap-xs firstrun-action">{props.action}</span>
    </li>
  )
}
