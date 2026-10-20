// The phone remote's web app, served by remote.ts. Plain HTML/CSS/JS with no inline scripts
// (the page runs under a strict Content-Security-Policy) and no third-party code.

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Hangar</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"><div class="boot">Loading…</div></div>
<script src="/app.js"></script>
</body>
</html>`

const APP_CSS = `:root{--bg:#15171c;--bg2:#1b1e24;--bg3:#23272f;--line:#2a2e37;--text:#eceef2;--muted:#868d9c;--accent:#f0a63a;--accent-text:#f3b45a;--ink:#1d1406;--solid:#eceef2;--solid-text:#15171c;--live:#3ccb81;--err:#f0645f;--info:#66a6f5;--add:rgba(60,203,129,.12);--del:rgba(240,100,95,.12);--soft-amber:rgba(240,166,58,.12);--soft-live:rgba(60,203,129,.12);--soft-err:rgba(240,100,95,.12);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f7f8fa;--bg2:#fff;--bg3:#f2f4f7;--line:#e3e6eb;--text:#15171c;--muted:#687080;--accent:#f0a63a;--accent-text:#9a5a00;--ink:#1d1406;--solid:#15171c;--solid-text:#fff;--live:#14874d;--err:#cf3a36;--info:#2e6ccc;--add:rgba(20,135,77,.1);--del:rgba(207,58,54,.08);--soft-amber:rgba(240,166,58,.16);--soft-live:rgba(20,135,77,.1);--soft-err:rgba(207,58,54,.08);color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
body{padding:env(safe-area-inset-top) 0 calc(64px + env(safe-area-inset-bottom))}
.boot{padding:40vh 0;text-align:center;color:var(--muted)}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;background:color-mix(in srgb,var(--bg) 85%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
header h1{font-size:18px;margin:0;letter-spacing:-.02em}.spend{font-size:13px;color:var(--muted)}
main{padding:12px 16px;display:flex;flex-direction:column;gap:12px}
nav{position:fixed;bottom:0;left:0;right:0;display:flex;background:color-mix(in srgb,var(--bg2) 88%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
nav button{flex:1;background:none;border:0;color:var(--muted);font:inherit;font-size:13px;padding:10px 0 8px;display:flex;flex-direction:column;align-items:center;gap:2px}
nav button.on{color:var(--text);font-weight:600}nav .count{background:var(--accent);color:var(--ink);border-radius:9px;padding:0 6px;font-size:11px;font-weight:700}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}
.card.danger{border-color:color-mix(in srgb,var(--err) 60%,var(--line));background:linear-gradient(var(--soft-err),var(--soft-err)),var(--bg2)}.card.warn{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:linear-gradient(var(--soft-amber),var(--soft-amber)),var(--bg2)}
.card h2{font-size:16px;margin:0}.muted{color:var(--muted)}.small{font-size:13px}
.row{display:flex;gap:8px;align-items:center}.wrap{flex-wrap:wrap}.grow{flex:1}
pre{margin:0;padding:10px;background:var(--bg);border-radius:8px;white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;max-height:50vh;overflow:auto}
button.btn{font:inherit;font-weight:600;border-radius:10px;border:1px solid var(--line);background:var(--bg3);color:var(--text);padding:11px 14px;min-height:44px}
button.primary{background:var(--solid);border-color:var(--solid);color:var(--solid-text)}
button.btn:focus-visible{outline:2px solid var(--info);outline-offset:2px}
button.danger{background:transparent;border-color:var(--err);color:var(--err)}
button:disabled{opacity:.5}
input,textarea,select{width:100%;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:11px 12px}
textarea{min-height:96px;resize:vertical}
label.check{display:flex;gap:10px;align-items:center;font-size:15px}label.check input{width:22px;height:22px}
.pill{font-size:12px;padding:2px 8px;border-radius:9px;background:var(--bg3);color:var(--muted);white-space:nowrap}
.pill.working{color:var(--live);background:var(--soft-live)}.pill.awaiting_approval{background:var(--accent);color:var(--ink);font-weight:600}.pill.error{color:var(--err)}.pill.queued{color:var(--info)}
.agent{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--line)}.agent .pill{align-self:flex-start}pre.summary{font:14px/1.5 system-ui,-apple-system,sans-serif}.agent:first-of-type{border-top:0}
.diff div{white-space:pre;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:0 8px}
.diff{overflow:auto;max-height:60vh;background:var(--bg);border-radius:8px;padding:6px 0}
.tag{font-size:11px;padding:1px 7px;border-radius:9px;background:var(--bg3);color:var(--muted);margin-right:4px;white-space:nowrap}.tag.ok{color:var(--live);background:var(--soft-live)}.tag.bad{color:var(--err);background:var(--soft-err)}.tag.meh{color:var(--accent-text);background:var(--soft-amber)}
.sect{border-top:1px solid var(--line);padding-top:8px;margin-top:8px}.sect h3{font-size:13px;margin:0 0 6px;color:var(--muted);font-weight:600}
.out{white-space:pre-wrap;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;background:var(--bg);border-radius:6px;padding:6px;max-height:30vh;overflow:auto;color:var(--muted)}
.finding{border-left:3px solid var(--line);padding:2px 0 2px 8px;margin:6px 0}.finding.high{border-color:var(--err)}.finding.medium{border-color:var(--accent)}.finding.low{border-color:var(--info)}
.src{font-size:12px;word-break:break-all;color:var(--info)}
.d-add{background:var(--add)}.d-del{background:var(--del)}.d-hunk{color:var(--info)}.d-meta{color:var(--muted);font-weight:600}
video,img.frame{width:100%;border-radius:8px;background:#000}
.frames{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;align-items:flex-start}.frames img{flex:0 0 85%;width:85%;height:auto;scroll-snap-align:center;border-radius:8px}
.toast{position:fixed;left:16px;right:16px;bottom:calc(76px + env(safe-area-inset-bottom));background:var(--solid);color:var(--solid-text);border-radius:12px;padding:12px 14px;z-index:9;font-weight:500;box-shadow:0 12px 32px rgba(0,0,0,.3)}
.toast.err{background:var(--err);color:#fff}
.empty{color:var(--muted);text-align:center;padding:32px 0}
a{color:var(--accent)}`

const APP_JS = `(() => {
'use strict'
const $ = (sel) => document.querySelector(sel)
const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  return el
}
let token = null
try { token = localStorage.getItem('hangar.token') } catch {}
let state = null
let tab = 'inbox'
let openReview = null
let timer = null

function toast(text, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, text)
  document.body.append(t)
  setTimeout(() => t.remove(), err ? 6000 : 3000)
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store'
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && token && path !== '/api/pair') { forget(); throw new Error(data.error || 'Not paired') }
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'))
  return data
}

async function blobUrl(path) {
  const res = await fetch(path, { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' })
  if (!res.ok) throw new Error('Could not load the clip')
  return URL.createObjectURL(await res.blob())
}

function forget() {
  token = null
  try { localStorage.removeItem('hangar.token') } catch {}
  render()
}

async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); await refresh() } catch (e) { toast(e.message, true) }
}

async function refresh() {
  if (!token) return
  try { state = await api('/api/state'); render() } catch (e) { if (token) toast(e.message, true) }
}

function schedule() {
  clearInterval(timer)
  timer = setInterval(() => { if (document.visibilityState === 'visible' && !openReview) refresh() }, 4000)
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh() })

// ---------- pairing ----------
function pairView() {
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '6-digit code' })
  const name = h('input', { placeholder: 'Name for this phone', value: /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : 'Phone' })
  const go = async () => {
    try {
      const r = await api('/api/pair', { method: 'POST', body: { code: code.value, name: name.value } })
      token = r.token
      try { localStorage.setItem('hangar.token', token) } catch {}
      toast('Paired!')
      await refresh(); schedule()
    } catch (e) { toast(e.message, true) }
  }
  return h('main', {},
    h('div', { class: 'card' },
      h('h2', {}, 'Pair this phone'),
      h('p', { class: 'muted small' }, 'On your computer, open Hangar → Settings → Phone remote → "Pair a phone", then type the code here.'),
      code, name,
      h('button', { class: 'btn primary', onclick: go }, 'Pair')))
}

// ---------- inbox ----------
function approvalCard(a) {
  const details = h('pre', { class: 'details', hidden: true }, a.details || '')
  return h('div', { class: 'card' + (a.dangerous ? ' danger' : ' warn') },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, a.agent + (a.dangerous ? ' — high risk' : ' needs approval')), h('span', { class: 'small muted' }, projectName(a.projectId))),
    h('div', { class: 'small muted' }, a.reason),
    h('pre', {}, a.summary),
    a.details ? h('button', { class: 'btn', onclick: (e) => { details.hidden = !details.hidden; e.target.textContent = details.hidden ? 'Show full details' : 'Hide details' } }, 'Show full details') : null,
    details,
    !a.phoneOk
      ? h('div', { class: 'row' }, h('span', { class: 'small grow' }, a.dangerous ? 'High risk — approve this on your computer.' : 'Approve this on your computer (too long or complex to check here).'), h('button', { class: 'btn danger', onclick: () => act(() => api('/api/approvals/' + a.id, { method: 'POST', body: { decision: 'deny' } }), 'Denied') }, 'Deny'))
      : h('div', { class: 'row' },
          h('button', { class: 'btn primary grow', onclick: () => act(() => api('/api/approvals/' + a.id, { method: 'POST', body: { decision: 'allow' } }), 'Allowed') }, 'Allow'),
          h('button', { class: 'btn danger grow', onclick: () => act(() => api('/api/approvals/' + a.id, { method: 'POST', body: { decision: 'deny' } }), 'Denied') }, 'Deny')))
}

function badges(r) {
  const out = []
  const c = r.checks, ai = r.aiReview
  if (c) out.push(c.status === 'running' ? h('span', { class: 'tag' }, 'checks…') : c.status === 'skipped' ? h('span', { class: 'tag meh' }, 'checks skipped') : (c.reason || c.results.some((x) => x.status !== 'passed')) ? h('span', { class: 'tag bad' }, '✗ checks') : h('span', { class: 'tag ok' }, '✓ checks'))
  if (ai) out.push(ai.status === 'running' ? h('span', { class: 'tag' }, 'reviewing…') : ai.status === 'error' ? h('span', { class: 'tag meh' }, 'review failed') : h('span', { class: 'tag ' + (ai.verdict === 'approve' ? 'ok' : ai.verdict === 'block' ? 'bad' : 'meh') }, ai.verdict === 'approve' ? '✓ reviewer' : ai.verdict === 'block' ? '✗ reviewer' : '! reviewer'))
  return out.length ? h('div', {}, out) : null
}

function reviewRow(r) {
  const what = r.kind === 'research' ? 'web research · ' + ((r.research && r.research.fetched.length) || 0) + ' pages' : r.files.length + ' file' + (r.files.length === 1 ? '' : 's')
  return h('div', { class: 'card', onclick: () => { openReview = r; render() } },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, r.title), r.clip ? h('span', { class: 'pill' }, r.clip.kind === 'video' ? '▶ clip' : '▶ frames') : null),
    h('div', { class: 'small muted' }, r.agent + ' · ' + projectName(r.projectId) + ' · ' + what + (r.incomplete ? ' · stopped early' : '')),
    badges(r))
}

function checksSection(r) {
  const c = r.checks
  if (!c) return null
  const rows = [h('h3', {}, 'Checks')]
  if (c.status === 'running') rows.push(h('div', { class: 'small muted' }, 'Running…'))
  if (c.reason) rows.push(h('div', { class: 'small' }, '⚠ ' + c.reason))
  for (const x of c.results) {
    rows.push(h('div', { class: 'small' }, (x.status === 'passed' ? '✓ ' : '✗ ') + x.name + ' — ' + (x.status === 'error' ? "couldn't run" : x.status)))
    if (x.status !== 'passed' && x.output) rows.push(h('div', { class: 'out' }, x.output))
  }
  return h('div', { class: 'sect' }, rows)
}

function aiSection(r) {
  const ai = r.aiReview
  if (!ai) return null
  const rows = [h('h3', {}, 'Reviewer agent')]
  if (ai.status === 'running') rows.push(h('div', { class: 'small muted' }, 'Reading the change…'))
  if (ai.status === 'error') rows.push(h('div', { class: 'small' }, '⚠ ' + (ai.error || 'Failed')))
  if (ai.status === 'done') {
    rows.push(h('div', { class: 'small' }, h('span', { class: 'tag ' + (ai.verdict === 'approve' ? 'ok' : ai.verdict === 'block' ? 'bad' : 'meh') }, ai.verdict === 'approve' ? 'Looks good' : ai.verdict === 'block' ? "Don't merge as is" : 'Has concerns'), ai.summary))
    for (const f of ai.findings) rows.push(h('div', { class: 'finding ' + f.severity }, h('div', { class: 'small' }, h('strong', {}, f.title)), f.file ? h('div', { class: 'small muted' }, f.file + (f.line ? ':' + f.line : '')) : null, f.detail ? h('div', { class: 'small' }, f.detail) : null))
    rows.push(h('div', { class: 'small muted' }, "Advice from an AI that read another agent's code; it can be fooled."))
  }
  return h('div', { class: 'sect' }, rows)
}

function researchView(r) {
  const res = r.research || { fetched: [], queries: [] }
  const textBox = h('div', {}, h('div', { class: 'small muted' }, 'Loading report…'))
  api('/api/reviews/' + r.id + '/diff').then((d) => textBox.replaceChildren(h('pre', { class: 'summary' }, d.diff))).catch((e) => textBox.replaceChildren(h('div', { class: 'small' }, e.message)))
  const done = (msg) => () => { openReview = null; toast(msg); refresh() }
  return h('main', {},
    h('button', { class: 'btn', onclick: () => { openReview = null; render() } }, '← Back'),
    h('div', { class: 'card' + (r.note || r.incomplete ? ' warn' : '') },
      h('h2', {}, r.title),
      h('div', { class: 'small muted' }, r.agent + ' · web research · no agent sees this until you approve it'),
      r.incomplete ? h('div', { class: 'small' }, '⚠ ' + r.incomplete) : null,
      r.note ? h('div', { class: 'small' }, '⚠ ' + r.note) : null,
      h('div', { class: 'sect' }, h('h3', {}, 'Pages it opened (' + res.fetched.length + ')'), res.fetched.length ? res.fetched.map((u) => h('div', { class: 'src' }, u)) : h('div', { class: 'small muted' }, 'None — search results only.')),
      res.queries.length ? h('div', { class: 'sect' }, h('h3', {}, 'Searches'), res.queries.map((q) => h('div', { class: 'small' }, '“' + q + '”'))) : null,
      h('div', { class: 'sect' }, h('h3', {}, 'Report'), textBox),
      h('div', { class: 'small muted' }, 'Check it is right and current, and that it has no instructions aimed at an AI. Approving saves it to research/ for the agents.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary grow', onclick: () => act(async () => { await api('/api/reviews/' + r.id + '/merge', { method: 'POST', body: {} }); done('Saved to research/')() }) }, 'Approve & save'),
        h('button', { class: 'btn danger grow', onclick: () => { if (confirm('Discard this research?')) act(async () => { await api('/api/reviews/' + r.id + '/discard', { method: 'POST', body: {} }); done('Discarded')() }) } }, 'Discard'))))
}

function inboxView() {
  const items = []
  for (const p of state.projects) {
    if (p.autopilot && (p.autopilot.status === 'checkin' || p.autopilot.status === 'waiting')) {
      items.push(h('div', { class: 'card warn', onclick: () => { tab = 'projects'; render() } },
        h('strong', {}, p.name + (p.autopilot.status === 'checkin' ? ': sprint ' + p.autopilot.sprint + ' check-in' : ' needs you')),
        h('div', { class: 'small muted' }, p.autopilot.status === 'checkin' ? 'Read it and start the next sprint (Projects tab).' : (p.autopilot.reason || 'A task is waiting for your review.'))))
    }
  }
  for (const a of state.approvals) items.push(approvalCard(a))
  if (state.reviews.length) items.push(h('div', { class: 'small muted' }, 'Ready for review'))
  for (const r of state.reviews) items.push(reviewRow(r))
  if (!items.length) items.push(h('div', { class: 'empty' }, 'Nothing needs you right now.'))
  return h('main', {}, items)
}

// ---------- review detail ----------
function diffView(text) {
  const box = h('div', { class: 'diff' })
  for (const l of text.split('\\n')) {
    const cls = /^(\\+\\+\\+|---|diff |index )/.test(l) ? 'd-meta' : l.startsWith('@@') ? 'd-hunk' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : ''
    box.append(h('div', { class: cls }, l || ' '))
  }
  return box
}

function reviewView(r) {
  if (r.kind === 'research') return researchView(r)
  const project = state.projects.find((p) => p.id === r.projectId)
  const warnings = r.mergeWarnings || []
  const clipBox = h('div', {})
  if (r.clip) {
    if (r.clip.kind === 'video') {
      blobUrl('/api/reviews/' + r.id + '/clip/0').then((u) => clipBox.append(h('video', { src: u, controls: true, playsinline: true, preload: 'metadata' }))).catch((e) => clipBox.append(h('div', { class: 'small muted' }, e.message)))
    } else {
      const strip = h('div', { class: 'frames' })
      clipBox.append(strip)
      for (let i = 0; i < r.clip.count; i++) {
        // Placeholders first, so screenshots stay in order however fast each one loads.
        const img = h('img', { alt: 'Playtest screenshot ' + (i + 1) })
        strip.append(img)
        blobUrl('/api/reviews/' + r.id + '/clip/' + i).then((u) => { img.src = u }).catch(() => img.remove())
      }
    }
  }
  const diffBox = h('div', {}, h('button', { class: 'btn', onclick: async (e) => {
    e.target.disabled = true
    try { const d = await api('/api/reviews/' + r.id + '/diff'); diffBox.replaceChildren(diffView(d.diff)) } catch (err) { toast(err.message, true); e.target.disabled = false }
  } }, 'Show changes (' + r.files.length + ' file' + (r.files.length === 1 ? '' : 's') + ')'))
  const done = (msg) => () => { openReview = null; toast(msg); refresh() }
  return h('main', {},
    h('button', { class: 'btn', onclick: () => { openReview = null; render() } }, '← Back'),
    h('div', { class: 'card' + (r.incomplete ? ' warn' : '') },
      h('h2', {}, r.title),
      h('div', { class: 'small muted' }, r.agent + ' · ' + (project ? project.name : '') + ' · branch ' + r.branch),
      r.incomplete ? h('div', { class: 'small' }, '⚠ ' + r.incomplete) : null,
      r.note ? h('div', { class: 'small' }, '⚠ ' + r.note) : null,
      clipBox,
      checksSection(r),
      aiSection(r),
      r.summary ? h('pre', { class: 'summary' }, r.summary) : h('div', { class: 'small muted' }, 'No summary from the agent.'),
      h('div', { class: 'small muted' }, r.files.join('\\n')),
      diffBox,
      r.published ? h('div', { class: 'small' }, 'Published to your test place (version ' + r.published.versionNumber + ').') : null,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary grow', onclick: () => {
          if (warnings.length && !confirm(warnings.join(' ') + ' Merge anyway?')) return
          act(async () => { await api('/api/reviews/' + r.id + '/merge', { method: 'POST', body: { force: warnings.length > 0, acknowledged: warnings } }); done('Merged')() })
        } }, warnings.length ? 'Merge anyway…' : 'Merge'),
        h('button', { class: 'btn danger grow', onclick: () => { if (confirm('Discard this work? The branch will be deleted.')) act(async () => { await api('/api/reviews/' + r.id + '/discard', { method: 'POST', body: {} }); done('Discarded')() }) } }, 'Discard')),
      project && project.hasTestPlace
        ? h('button', { class: 'btn', onclick: (e) => { e.target.disabled = true; e.target.textContent = 'Building and publishing…'; act(async () => { const x = await api('/api/reviews/' + r.id + '/publish', { method: 'POST', body: {} }); openReview = Object.assign({}, r, x.review, { agent: r.agent, clip: r.clip }); render() }, 'Published — open your test place in the Roblox app') } }, 'Publish to test place')
        : h('div', { class: 'small muted' }, 'Set a test place for this project on your computer to play builds on your phone.')))
}

// ---------- projects ----------
function projectName(id) { const p = state && state.projects.find((x) => x.id === id); return p ? p.name : '' }

const AP_LABEL = { off: 'Autopilot off', running: 'Building', waiting: 'Needs your review', checkin: 'Check-in ready', paused: 'Paused' }

/** Autopilot on the phone: status, check-in report, feedback and "start next sprint". */
function autopilotBox(p) {
  const ap = p.autopilot
  if (!ap || ap.status === 'off') return null
  const feedback = h('textarea', { placeholder: ap.status === 'checkin' ? 'Answer the questions, say what to change or do next…' : 'A note for the Lead’s next task…' })
  const post = (action, ok) => act(async () => { await api('/api/autopilot/' + p.id + '/' + action, { method: 'POST', body: { feedback: feedback.value } }); feedback.value = '' }, ok)
  return h('div', { class: 'sect' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Autopilot · sprint ' + ap.sprint), h('span', { class: 'pill ' + (ap.status === 'running' ? 'working' : ap.status === 'waiting' ? 'awaiting_approval' : '') }, AP_LABEL[ap.status] || ap.status)),
    ap.status !== 'checkin' ? h('div', { class: 'small muted' }, ap.tasksDone + ' of ' + ap.sprintTasks + ' tasks done') : null,
    ap.reason ? h('div', { class: 'small' }, ap.reason) : null,
    ap.report ? h('pre', { class: 'summary' }, ap.report) : null,
    feedback,
    h('div', { class: 'row wrap' },
      ap.status === 'checkin' ? h('button', { class: 'btn primary grow', onclick: () => post('continue', 'Sprint ' + (ap.sprint + 1) + ' started') }, 'Start sprint ' + (ap.sprint + 1)) : null,
      ap.status === 'paused' ? h('button', { class: 'btn primary grow', onclick: () => post('resume', 'Resumed') }, 'Resume') : null,
      ap.status === 'running' || ap.status === 'waiting' ? h('button', { class: 'btn grow', onclick: () => post('pause', 'Paused') }, 'Pause') : null,
      ap.status !== 'checkin' ? h('button', { class: 'btn grow', onclick: () => { if (!feedback.value.trim()) return toast('Write a note first', true); post('feedback', 'Noted') } }, 'Add note') : null))
}

function projectsView() {
  if (!state.projects.length) return h('main', {}, h('div', { class: 'empty' }, 'No projects yet. Add one on your computer.'))
  return h('main', {}, state.projects.map((p) => {
    const agent = h('select', {}, p.agents.map((a) => h('option', { value: a.id }, a.name)))
    const prompt = h('textarea', { placeholder: 'Task for the agent…' })
    const record = h('input', { type: 'checkbox' })
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, p.name), p.autonomous ? h('span', { class: 'pill' }, 'Autonomous') : null),
      autopilotBox(p),
      h('div', {}, p.agents.map((a) => h('div', { class: 'agent' },
        h('div', {}, h('div', {}, a.name), h('div', { class: 'small muted' }, a.lastError || a.activity || (a.queued ? a.queued + ' queued' : ''))),
        h('span', { class: 'pill ' + a.status }, a.status.replace('_', ' '))))),
      agent, prompt,
      h('label', { class: 'check' }, record, 'Record playtest'),
      h('button', { class: 'btn primary', onclick: () => {
        if (!prompt.value.trim()) return toast('Write a task first', true)
        act(async () => { await api('/api/tasks', { method: 'POST', body: { projectId: p.id, agentId: agent.value, prompt: prompt.value, record: record.checked } }); prompt.value = '' }, 'Queued')
      } }, 'Queue task'))
  }))
}

// ---------- settings ----------
async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error(/iPhone|iPad/.test(navigator.userAgent) ? 'Add Hangar to your Home Screen first (Share → Add to Home Screen), then open it from there.' : 'This browser does not support notifications.')
    if (!state.vapidPublicKey) throw new Error('Notifications are not ready on your computer yet.')
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') throw new Error('Notifications were not allowed.')
    const reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    const key = Uint8Array.from(atob(state.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() })
    toast('Notifications on')
  } catch (e) { toast(e.message, true) }
}

function settingsView() {
  return h('main', {},
    h('div', { class: 'card' },
      h('h2', {}, 'Notifications'),
      h('p', { class: 'small muted' }, 'Get a notification when an agent needs approval, finishes a task, or hits a problem.'),
      h('button', { class: 'btn primary', onclick: enablePush }, 'Turn on notifications')),
    h('div', { class: 'card' },
      h('h2', {}, 'This phone'),
      h('p', { class: 'small muted' }, 'From here you can approve everyday actions, review and merge work, queue tasks and stop agents. Settings and high-risk approvals stay on your computer.'),
      h('button', { class: 'btn danger', onclick: () => { if (confirm('Unpair this phone?')) act(async () => { await api('/api/unpair', { method: 'POST', body: {} }); forget() }) } }, 'Unpair this phone')))
}

// ---------- shell ----------
function render() {
  const app = $('#app')
  if (!token) { app.replaceChildren(h('header', {}, h('h1', {}, 'Hangar')), pairView()); return }
  if (!state) { app.replaceChildren(h('div', { class: 'boot' }, 'Connecting…')); return }
  const busy = state.projects.some((p) => p.agents.some((a) => a.status === 'working' || a.status === 'awaiting_approval' || a.status === 'queued'))
  const header = h('header', {},
    h('div', {}, h('h1', {}, 'Hangar'), h('div', { class: 'spend' }, 'Today $' + state.costs.todayUsd.toFixed(2))),
    h('button', { class: 'btn danger', disabled: !busy, onclick: () => { if (confirm('Stop every agent and clear all queues?')) act(() => api('/api/stop-all', { method: 'POST', body: {} }), 'All agents stopped') } }, 'Stop all'))
  const count = state.approvals.length + state.reviews.length + state.projects.filter((p) => p.autopilot && (p.autopilot.status === 'checkin' || p.autopilot.status === 'waiting')).length
  const navBtn = (id, label) => h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; openReview = null; render() } }, label, id === 'inbox' && count ? h('span', { class: 'count' }, count) : null)
  const view = openReview ? reviewView(state.reviews.find((r) => r.id === openReview.id) || openReview) : tab === 'inbox' ? inboxView() : tab === 'projects' ? projectsView() : settingsView()
  app.replaceChildren(header, view, h('nav', {}, navBtn('inbox', 'Inbox'), navBtn('projects', 'Projects'), navBtn('settings', 'Settings')))
}

render()
if (token) { refresh(); schedule() }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
})()`

const SW_JS = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('push', (e) => {
  let data = {}
  try { data = e.data ? e.data.json() : {} } catch {}
  e.waitUntil(self.registration.showNotification(String(data.title || 'Hangar'), { body: String(data.body || ''), icon: '/icon.svg', badge: '/icon.svg', data: { url: '/' }, tag: 'hangar' }))
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus()
    return self.clients.openWindow('/')
  }))
})`

const MANIFEST = JSON.stringify({
  name: 'Hangar',
  short_name: 'Hangar',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0f1115',
  theme_color: '#0f1115',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
})

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f1115"/><path d="M12 44 32 18l20 26H40l-8-11-8 11z" fill="#f5a524"/></svg>`

export const PHONE_FILES: Record<string, { type: string; body: string }> = {
  '/index.html': { type: 'text/html; charset=utf-8', body: INDEX_HTML },
  '/app.css': { type: 'text/css; charset=utf-8', body: APP_CSS },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: APP_JS },
  '/sw.js': { type: 'text/javascript; charset=utf-8', body: SW_JS },
  '/manifest.webmanifest': { type: 'application/manifest+json', body: MANIFEST },
  '/icon.svg': { type: 'image/svg+xml', body: ICON_SVG }
}
