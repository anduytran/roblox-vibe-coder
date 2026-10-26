import { useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'
import { attempt } from '../store'
import { Button } from './ui'

export function ApprovalCard({ request, onDecided }: { request: ApprovalRequest; onDecided?: (d: ApprovalDecision) => void }) {
  const [showInput, setShowInput] = useState(false)
  const [busy, setBusy] = useState(false)

  const decide = (d: ApprovalDecision): void => {
    setBusy(true)
    void attempt(async () => {
      await window.hangar.approvals.respond(request.id, d)
      onDecided?.(d)
    }).finally(() => setBusy(false))
  }

  const alwaysLabel = request.toolName === 'Bash' ? 'Always allow this exact command' : `Always allow ${request.toolName.replace(/^mcp__[^_]+__/, '')}`
  const title = request.toolName === 'Project setup' ? 'Review project setup' : request.dangerous ? 'Careful: high-risk action' : 'Approval needed'

  return (
    <div className={`approval ${request.dangerous ? 'approval-danger' : ''}`}>
      <div className="approval-head">
        <strong>{title}</strong>
        <span className="muted small">{request.reason}</span>
      </div>
      {/* The full summary is always shown, never clipped, so nothing can hide below the fold. */}
      <pre className="approval-summary">{request.summary}</pre>
      <button className="link small" onClick={() => setShowInput(!showInput)}>
        {showInput ? 'Hide details' : 'Show full details'}
      </button>
      {showInput && (
        <>
          <pre className="approval-input">{request.inputJson}</pre>
          {request.truncated && <span className="warn small">Details were too long to show in full. Deny if you are not sure.</span>}
        </>
      )}
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
