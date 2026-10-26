import { useState } from 'react'
import type { ApprovalDecision, ApprovalExplanation, ApprovalRequest, ExplainVerdict } from '@shared/types'
import { revealHidden } from '@shared/text'
import { attempt, useStore } from '../store'
import { Button } from './ui'

/** Answers already shown, so a card that appears again (Inbox, feed) shows its explanation at once. Main caches them too. */
const explained = new Map<string, ApprovalExplanation>()

const VERDICT: Record<ExplainVerdict, { label: string; mark: string }> = {
  safe: { label: 'Looks safe', mark: '✓' },
  careful: { label: 'Be careful', mark: '!' },
  deny: { label: "Don't allow", mark: '✗' }
}

export function ApprovalCard({ request, onDecided }: { request: ApprovalRequest; onDecided?: (d: ApprovalDecision) => void }) {
  const checker = useStore((st) => st.projects.find((p) => p.id === request.projectId)?.settings.safetyChecker === true) && !request.dangerous && request.toolName !== 'Project setup' && !request.truncated
  const [showInput, setShowInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [explanation, setExplanation] = useState<ApprovalExplanation | null>(() => explained.get(request.id) ?? null)
  const [explaining, setExplaining] = useState(false)

  const decide = (d: ApprovalDecision): void => {
    setBusy(true)
    void attempt(async () => {
      await window.hangar.approvals.respond(request.id, d)
      onDecided?.(d)
    }).finally(() => setBusy(false))
  }

  const explain = (): void => {
    setExplaining(true)
    void attempt(async () => {
      const e = await window.hangar.approvals.explain(request.id)
      if (e.status === 'done') {
        explained.set(request.id, e)
        if (explained.size > 100) explained.delete(explained.keys().next().value!)
      }
      setExplanation(e)
    }).finally(() => setExplaining(false))
  }

  const alwaysLabel = request.toolName === 'Bash' ? 'Always allow this exact command' : `Always allow ${request.toolName.replace(/^mcp__[^_]+__/, '')}`
  const title = request.toolName === 'Project setup' ? 'Review project setup' : request.dangerous ? 'Careful: high-risk action' : 'Approval needed'

  return (
    <div className={`approval ${request.dangerous ? 'approval-danger' : ''}`}>
      <div className="approval-head">
        <strong>{title}</strong>
        <span className="muted small">{request.reason}</span>
        {checker && <span className="small approval-checker">Hangar's safety checker is looking at this; it approves it if it's plainly safe.</span>}
      </div>
      {/* The full summary is always shown, never clipped, so nothing can hide below the fold. */}
      <pre className="approval-summary">{request.summary}</pre>
      <div className="row gap-sm">
        <button className="link small" onClick={() => setShowInput(!showInput)}>
          {showInput ? 'Hide details' : 'Show full details'}
        </button>
        {!explanation && (
          <button className="link small" disabled={explaining} onClick={explain} title="A second AI, with no tools, reads this request and explains it. Costs a little.">
            {explaining ? 'Explaining…' : 'Explain'}
          </button>
        )}
      </div>
      {showInput && (
        <>
          <pre className="approval-input">{request.inputJson}</pre>
          {request.truncated && <span className="warn small">Details were too long to show in full. Deny if you are not sure.</span>}
        </>
      )}
      {explanation && <Explanation e={explanation} retrying={explaining} onRetry={explain} />}
      {/* The explanation is advice: these buttons, and when "Always allow" shows, depend only on Hangar's rules. */}
      <div className="row gap-xs">
        <Button tone="primary" size="sm" disabled={busy} onClick={() => decide('allow')}>
          Allow once
        </Button>
        {request.canAlwaysAllow && (
          <Button size="sm" disabled={busy} onClick={() => decide('always')} title="Saved for this project; you can remove it in the Project tab under Permissions">
            {alwaysLabel}
          </Button>
        )}
        <Button tone="danger" size="sm" disabled={busy} onClick={() => decide('deny')}>
          Deny
        </Button>
      </div>
    </div>
  )
}

function Explanation({ e, retrying, onRetry }: { e: ApprovalExplanation; retrying: boolean; onRetry: () => void }) {
  const verdict = e.verdict ? VERDICT[e.verdict] : null
  const raised = e.aiVerdict !== null && e.verdict !== null && e.aiVerdict !== e.verdict
  const yesNo = (v: boolean | null): string => (v === null ? 'not sure' : v ? 'yes' : 'no')
  return (
    <div className="explain" role="note" aria-label="Explanation (AI advice)">
      <div className="explain-head">
        {verdict && (
          <span className={`explain-verdict explain-${e.verdict}`}>
            {verdict.mark} {verdict.label}
          </span>
        )}
        <span className="muted small">{e.aiVerdict ? 'AI advice. It can be fooled, so you decide.' : "From Hangar's own checks only (the AI didn't answer)."}</span>
      </div>
      {e.what && <p className="explain-what">{e.what}</p>}
      {e.touches.length > 0 && (
        <span className="small">
          <span className="muted">Touches: </span>
          {e.touches.map(revealHidden).join(', ')}
        </span>
      )}
      {e.status === 'done' && (
        <span className="small muted">
          Changes files: {yesNo(e.writes)} · Deletes: {yesNo(e.deletes)} · Internet: {yesNo(e.network)}
        </span>
      )}
      {e.reasons.length > 0 && (
        <ul className="explain-list small">
          {e.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {raised && verdict && (
        <span className="small warn">
          The AI said “{VERDICT[e.aiVerdict!].label}”. Hangar's own checks make it “{verdict.label}”.
        </span>
      )}
      <div className="explain-checks small">
        <span className="muted">Hangar's own checks (not AI):</span>
        {e.flags.length > 0 ? (
          <ul className="explain-list explain-flags">
            {e.flags.map((f, i) => (
              <li key={i} className={f.severity === 'deny' ? 'err' : 'warn'}>
                {f.severity === 'deny' ? '✗' : '!'} {f.text}
                {f.detail && <code>{revealHidden(f.detail)}</code>}
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">Nothing flagged. They only catch common risks.</span>
        )}
      </div>
      {e.status === 'error' && (
        <div className="row gap-sm">
          <span className="small err">{e.error}</span>
          <button className="link small" disabled={retrying} onClick={onRetry}>
            {retrying ? 'Explaining…' : 'Try again'}
          </button>
        </div>
      )}
      {e.costUsd > 0 && <span className="muted small">Cost {e.costUsd < 0.01 ? 'under $0.01' : `$${e.costUsd.toFixed(2)}`}</span>}
    </div>
  )
}
