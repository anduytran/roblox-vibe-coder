import { useMemo } from 'react'
import { parseMarkdown, type Block, type Inline } from '@shared/markdown'
import { attempt } from '../store'

/**
 * Agent-written text (reports, check-ins, idea text) shown with light formatting. It goes through
 * the shared Markdown reader, which only ever yields plain data: no HTML, no images, hidden characters
 * removed. Links are https only; the real host is shown next to the agent's label, and opening goes
 * through Hangar's "Open in browser?" prompt with the full address.
 */
export function SafeText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className={`safe-text ${className ?? ''}`}>{blocks.map((b, i) => renderBlock(b, i))}</div>
}

function renderBlock(b: Block, key: number) {
  switch (b.t) {
    case 'heading':
      return b.level === 1 ? <h3 key={key}>{inl(b.v)}</h3> : b.level === 2 ? <h4 key={key}>{inl(b.v)}</h4> : <h5 key={key}>{inl(b.v)}</h5>
    case 'para':
      return <p key={key}>{inl(b.v)}</p>
    case 'quote':
      return <blockquote key={key}>{inl(b.v)}</blockquote>
    case 'code':
      return <pre key={key}>{b.v}</pre>
    case 'rule':
      return <hr key={key} />
    case 'list':
      return b.ordered ? (
        <ol key={key} start={b.start}>
          {b.items.map((it, i) => (
            <li key={i}>{inl(it)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {b.items.map((it, i) => (
            <li key={i}>{inl(it)}</li>
          ))}
        </ul>
      )
  }
}

function inl(nodes: Inline[]) {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <span key={i}>{n.v}</span>
      case 'bold':
        return <strong key={i}>{inl(n.v)}</strong>
      case 'italic':
        return <em key={i}>{inl(n.v)}</em>
      case 'code':
        return <code key={i}>{n.v}</code>
      case 'link': {
        // The agent's label is plain text; the real host is always shown beside it, and only the small
        // Open button acts (through the "Open in browser?" prompt with the full address).
        const host = new URL(n.url).host
        const bare = n.label === n.url || n.label === n.url.replace(/\/$/, '')
        return (
          <span key={i} className="safe-link-wrap">
            {bare ? <span className="safe-url">{n.label}</span> : <>{n.label} <span className="safe-host">({host})</span></>}{' '}
            <button type="button" className="safe-link" title={n.url} aria-label={`Open ${host} in your browser`} onClick={() => void attempt(() => window.hangar.system.openUrl(n.url))}>
              Open
            </button>
          </span>
        )
      }
    }
  })
}
