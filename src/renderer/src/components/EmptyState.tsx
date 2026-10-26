import type { ReactNode } from 'react'
import { Icon } from './ui'

/** What a screen shows when there's nothing in it yet: a title, a line of help, and maybe one action. */
export function EmptyState(props: { icon?: string; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state ${props.compact ? 'empty-state-compact' : ''}`}>
      {props.icon && (
        <span className="empty-state-icon" aria-hidden>
          <Icon name={props.icon} size={props.compact ? 18 : 22} />
        </span>
      )}
      <h3>{props.title}</h3>
      {props.children && <div className="empty-state-body">{props.children}</div>}
      {props.action && <div className="empty-state-action">{props.action}</div>}
    </div>
  )
}
