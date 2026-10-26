import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeCheckinFeedback, parseCheckin } from '../src/shared/checkin'

const REPORT = `## Built
- Gliding between islands
- Parcel pickup and delivery

## Try it (how to play or test what's new in Studio)
Press Play, jump off the dock and hold Space to glide.

## Next sprint (3–5 items, in order)
1. Storms that push gliders off course
2. Upgrade shop for glider speed
3. Second island

## Questions for you (decisions you need from the product owner, if any)
- Should storms damage parcels, or only slow you down?
- Do you want a daily reward?`

test('check-in: the four sections become parts the Overview can show and answer', () => {
  const c = parseCheckin(REPORT)
  assert.equal(c.structured, true)
  assert.match(c.built, /Gliding between islands/)
  assert.match(c.tryIt, /hold Space to glide/)
  assert.deepEqual(c.next, ['Storms that push gliders off course', 'Upgrade shop for glider speed', 'Second island'])
  assert.deepEqual(c.questions, ['Should storms damage parcels, or only slow you down?', 'Do you want a daily reward?'])
})

test('check-in: "none" means no questions; bold headings work; plain text is not structured', () => {
  const c = parseCheckin('**Built:**\n- A\n\n**Next sprint:**\n- B\n\n**Questions for you:**\nNone.')
  assert.equal(c.structured, true)
  assert.deepEqual(c.next, ['B'])
  assert.deepEqual(c.questions, [])
  assert.equal(parseCheckin('Did some work today.').structured, false)
  assert.ok(!parseCheckin('## Built\nok\u202Edone').built.includes('\u202E'), 'hidden characters removed')
  const t = performance.now()
  parseCheckin('# ' + '#'.repeat(49_000) + 'x\n## Built\nok')
  parseCheckin('**' + 'a'.repeat(49_000))
  assert.ok(performance.now() - t < 300, 'linear on long lines')
})

test('check-in: answers, an edited plan and notes become one feedback text', () => {
  const text = composeCheckinFeedback({
    questions: ['Storms damage parcels?', 'Daily reward?'],
    answers: ['Only slow you down.', ''],
    plan: ['Second island', 'Storms'],
    planChanged: true,
    notes: 'Keep it cozy.'
  })
  assert.equal(text, 'Answers to your questions:\nQ: Storms damage parcels?\nA: Only slow you down.\n\nPlan for this sprint, in this order (the product owner edited it):\n1. Second island\n2. Storms\n\nOther notes:\nKeep it cozy.')
  assert.equal(composeCheckinFeedback({ questions: ['Q?'], answers: [''], plan: ['x'], planChanged: false, notes: '' }), '')
})

test('check-in: nested items join their parent; lead-ins, dividers and "no questions" lines are dropped', () => {
  const c = parseCheckin(`Good sprint overall. Gliding feels great.

## Built
- Gliding

## Next sprint
Here's what I'd do next:
- Storms
  - push gliders off course
  - lightning flashes
- Upgrade shop
---

## Notes for later
- this is not part of the plan

## Questions for you
No questions this sprint — keep going!`)
  assert.equal(c.intro, 'Good sprint overall. Gliding feels great.')
  assert.deepEqual(c.next, ['Storms — push gliders off course — lightning flashes', 'Upgrade shop'])
  assert.deepEqual(c.questions, [])
  assert.equal(parseCheckin('# Sprint 2 report\n## Built\n- A\n## Next\n- B').intro, '', "the report's own title isn't an intro")
  assert.deepEqual(parseCheckin('## Built\n- A\n## Questions\n- None of the maps feel right — redo them?').questions, ['None of the maps feel right — redo them?'], 'a real question that starts with "None" stays')
  // A bold sub-heading inside a "##" section is content, not the end of it.
  assert.match(parseCheckin('## Built\n**Movement**\n- Gliding\n## Next\n- B').built, /Gliding/)
})

test('check-in: clearing the whole plan tells the Lead not to do it', () => {
  const text = composeCheckinFeedback({ questions: [], answers: [], plan: [], planChanged: true, notes: 'Polish instead.' })
  assert.match(text, /removed every item from your proposed plan/)
  assert.match(text, /Other notes:\nPolish instead\./)
})

test('check-in: code blocks, questions with options and bold questions', () => {
  const c = parseCheckin(`## Try it
\`\`\`bash
# Next, sync with Rojo
rojo serve
\`\`\`
Press Play.

## Next sprint
1. Shop

## Questions for you
Which should come first:
1. Shop
2. Pets

Should gliding cost stamina?
- Yes
- No

A couple more:
- Do you want PvP?
- Daily rewards?`)
  assert.match(c.tryIt, /rojo serve[\s\S]*Press Play\./, "a '#' comment in a code block isn't a heading")
  assert.deepEqual(c.next, ['Shop'])
  assert.deepEqual(c.questions, ['Which should come first: Shop / Pets', 'Should gliding cost stamina? (Yes / No)', 'Do you want PvP?', 'Daily rewards?'])
  const bold = parseCheckin('**Built:**\n- A\n\n**Questions for you:**\n**Should gliding cost stamina?**\n**Do you want PvP?**')
  assert.deepEqual(bold.questions, ['Should gliding cost stamina?', 'Do you want PvP?'])
})
