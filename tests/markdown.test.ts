import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inlineText, MAX_MARKDOWN, parseInline, parseMarkdown, type Block, type Inline } from '../src/shared/markdown'
import { safeExternalUrl, stripHidden } from '../src/shared/text'

const links = (nodes: Inline[]): string[] => nodes.flatMap((n) => (n.t === 'link' ? [n.url] : n.t === 'bold' || n.t === 'italic' ? links(n.v) : []))
const allLinks = (blocks: Block[]): string[] =>
  blocks.flatMap((b) => (b.t === 'para' || b.t === 'heading' || b.t === 'quote' ? links(b.v) : b.t === 'list' ? b.items.flatMap(links) : []))

test('markdown: the check-in shape (headings, lists, code) comes out as plain data', () => {
  const blocks = parseMarkdown('## Built\n- Glider **feel**\n- Storms `every 90s`\n\n## Next sprint\n1. Islands\n2. Co-op\n\n```lua\nprint("hi")\n```\n---\n> note')
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['heading', 'list', 'heading', 'list', 'code', 'rule', 'quote']
  )
  const list = blocks[1] as Extract<Block, { t: 'list' }>
  assert.equal(list.ordered, false)
  assert.equal(inlineText(list.items[0]!), 'Glider feel')
  assert.deepEqual(list.items[1]![1], { t: 'code', v: 'every 90s' })
  const numbered = blocks[3] as Extract<Block, { t: 'list' }>
  assert.equal(numbered.ordered, true)
  assert.equal(numbered.items.length, 2)
  assert.deepEqual(blocks[4], { t: 'code', v: 'print("hi")' })
})

test('markdown: nothing can become HTML, an image or a non-https link', () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(1)</script> ![img](https://e.com/x.png) [click](javascript:alert(1)) [file](file:///etc/passwd) [plain](http://e.com) https://user:pw@e.com/x'
  const blocks = parseMarkdown(evil)
  assert.deepEqual(allLinks(blocks), ['https://e.com/x.png'], 'only the https link survives as a link (the image becomes a link, never an image)')
  const text = blocks.map((b) => (b.t === 'para' ? inlineText(b.v) : '')).join('')
  assert.match(text, /<script>alert\(1\)<\/script>/, 'markup stays visible as text')
  assert.match(text, /\[click\]\(javascript:alert\(1\)\)/)
  assert.ok(!JSON.stringify(blocks).includes('"t":"html"'))
})

test('markdown: hidden characters are removed; links keep their real address', () => {
  const blocks = parseMarkdown('Safe‮txt.exe [docs](https://create.roblox.com/docs) and https://devforum.roblox.com/t/1.')
  const para = blocks[0] as Extract<Block, { t: 'para' }>
  assert.ok(!inlineText(para.v).includes('‮'))
  assert.deepEqual(links(para.v), ['https://create.roblox.com/docs', 'https://devforum.roblox.com/t/1'])
  assert.equal(stripHidden('a​b\tc\nd'), 'ab\tc\nd', 'tabs and line breaks are kept')
})

test('markdown: snake_case and unmatched markers stay text; long input is capped and fast', () => {
  assert.equal(inlineText(parseInline('use player_data_store and 2 * 3 = 6')), 'use player_data_store and 2 * 3 = 6')
  assert.deepEqual(parseInline('**unclosed'), [{ t: 'text', v: '**unclosed' }])
  const t = performance.now()
  const huge = parseMarkdown('word **'.repeat(60_000) + '\n- item'.repeat(20_000))
  assert.ok(performance.now() - t < 2000, 'linear time')
  assert.ok(JSON.stringify(huge).length > 0)
  assert.ok(parseMarkdown('x'.repeat(MAX_MARKDOWN + 5000)).length === 1)
})

test('links: only https with a host and no credentials can be offered for opening', () => {
  assert.equal(safeExternalUrl('https://create.roblox.com/docs'), 'https://create.roblox.com/docs')
  for (const bad of ['http://e.com', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@e.com', 'https://u@e.com', 'notaurl', '', 'https://' + 'a'.repeat(3000)]) {
    assert.equal(safeExternalUrl(bad), null, bad)
  }
})

test('review fixes: headings are linear, keep C#, strip only a real closing run', () => {
  const t = performance.now()
  parseMarkdown('# a' + ' '.repeat(60_000) + 'b')
  parseMarkdown('# ' + '#'.repeat(60_000) + 'x')
  assert.ok(performance.now() - t < 500, 'no backtracking on long lines')
  const h = (src: string): string => inlineText((parseMarkdown(src)[0] as Extract<Block, { t: 'heading' }>).v)
  assert.equal(h('## Porting from C#'), 'Porting from C#')
  assert.equal(h('## Title ##'), 'Title')
  assert.equal(h('### ###'), '')
  assert.equal(h('#   spaced   '), 'spaced')
})

test('review fixes: inline ```code``` is not a fence; a fence after a list is its own block', () => {
  const inline = parseMarkdown('```code``` and more\nsecond line')
  assert.equal(inline.length, 1)
  assert.equal(inline[0]!.t, 'para')
  const listThenCode = parseMarkdown('- one\n- two\n```lua\nprint(1)\n```\nafter')
  assert.deepEqual(listThenCode.map((b) => b.t), ['list', 'code', 'para'])
  assert.equal((listThenCode[0] as Extract<Block, { t: 'list' }>).items.length, 2)
})

test('review fixes: Luau __index stays text; __bold__ at word edges still works', () => {
  assert.equal(inlineText(parseInline('setmetatable(t, {__index = base, __newindex = f})')), 'setmetatable(t, {__index = base, __newindex = f})')
  assert.ok(!parseInline('setmetatable(t, {__index = base, __newindex = f})').some((n) => n.t === 'bold'))
  assert.deepEqual(parseInline('a __big__ deal')[1], { t: 'bold', v: [{ t: 'text', v: 'big' }] })
  assert.equal(inlineText(parseInline('x__y__z')), 'x__y__z')
  // Many openers with no closer stay fast.
  const t = performance.now()
  parseInline(' __a'.repeat(40_000))
  parseInline(' **a'.repeat(40_000))
  parseInline(' *a'.repeat(40_000))
  assert.ok(performance.now() - t < 1500)
})

test('review fixes: URLs with parentheses and trailing punctuation', () => {
  const urls = (s: string): string[] => parseInline(s).flatMap((n) => (n.t === 'link' ? [n.url] : []))
  assert.deepEqual(urls('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))'), ['https://en.wikipedia.org/wiki/Foo_(bar)'])
  assert.deepEqual(urls('see https://en.wikipedia.org/wiki/Foo_(bar) now'), ['https://en.wikipedia.org/wiki/Foo_(bar)'])
  assert.deepEqual(urls('(see https://x.com/a).'), ['https://x.com/a'])
  assert.deepEqual(urls('((https://x.com/a))'), ['https://x.com/a'])
  // Line breaks inside a paragraph are kept (the window shows them).
  const p = parseMarkdown('line one\nline two')[0] as Extract<Block, { t: 'para' }>
  assert.equal(inlineText(p.v), 'line one\nline two')
})

test('second pass: hostile inputs stay fast (URL trimming, long lines, backtick runs)', () => {
  const cases = [
    ('https://x.co/' + '.'.repeat(1000) + 'a' + ')'.repeat(1000) + ' ').repeat(100),
    '\u{1F600}' + '`'.repeat(199_998),
    'x' + '`'.repeat(199_999),
    ' *a'.repeat(66_000)
  ]
  for (const c of cases) {
    const t = performance.now()
    parseMarkdown(c)
    assert.ok(performance.now() - t < 600, `took ${Math.round(performance.now() - t)} ms`)
  }
})

test('second pass: fences inside list items, at any indent, become code blocks', () => {
  const nested = parseMarkdown('- Parent\n  - Child:\n    ```lua\n    print(1)\n    ```')
  assert.deepEqual(nested.map((b) => b.t), ['list', 'code'])
  assert.deepEqual(nested[1], { t: 'code', v: 'print(1)' })
  const numbered = parseMarkdown('10. Add:\n    ```lua\n    local M = {}\n\n    return M\n    ```\n11. Next')
  assert.deepEqual(numbered.map((b) => b.t), ['list', 'code', 'list'])
  assert.deepEqual(numbered[1], { t: 'code', v: 'local M = {}\n\nreturn M' })
})

test('second pass: nested emphasis and multi-backtick code spans', () => {
  const kinds = (s: string): string => JSON.stringify(parseInline(s))
  assert.equal(inlineText(parseInline('*Tip: use **Anchored** parts*')), 'Tip: use Anchored parts')
  assert.match(kinds('*Tip: use **Anchored** parts*'), /"t":"italic".*"t":"bold"/)
  assert.equal(inlineText(parseInline('***Important***')), 'Important')
  assert.equal(inlineText(parseInline('**bold *italic***')), 'bold italic')
  assert.equal(inlineText(parseInline('*italic **bold***')), 'italic bold')
  assert.deepEqual(parseInline('```code``` and more'), [{ t: 'code', v: 'code' }, { t: 'text', v: ' and more' }])
  assert.deepEqual(parseInline('use ``a`b`` here')[1], { t: 'code', v: 'a`b' })
  assert.deepEqual(parseInline('Run `` `x` `` now')[1], { t: 'code', v: '`x`' })
  assert.equal(inlineText(parseInline('a `` b')), 'a `` b', 'an unclosed run stays text')
})

test('final pass: code spans win over emphasis; link labels are plain text; tab-indented fences', () => {
  const italic = parseInline('*Only `*.luau` files are synced*')
  assert.equal(italic.length, 1)
  assert.equal(italic[0]!.t, 'italic')
  assert.deepEqual((italic[0] as Extract<Inline, { t: 'italic' }>).v[1], { t: 'code', v: '*.luau' })
  assert.equal(inlineText(parseInline('**Use `a**b` for power**')), 'Use a**b for power')
  assert.equal(inlineText(parseInline('*Note: `damage*2` doubles it*')), 'Note: damage*2 doubles it')
  const link = parseInline('[`DataStoreService`](https://create.roblox.com/docs/reference/engine/classes/DataStoreService)')[0]
  assert.deepEqual(link && link.t === 'link' ? link.label : null, 'DataStoreService')
  assert.deepEqual(parseMarkdown('\t```lua\n\tprint(1)\n\t```'), [{ t: 'code', v: 'print(1)' }])
})
