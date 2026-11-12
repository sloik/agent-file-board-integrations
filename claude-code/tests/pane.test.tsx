import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FIXTURES } from './fixtures'

// SPEC-001 AC3-AC7, AC9, AC10: the mod against a stubbed engine. `$.fs` is
// answered from an in-memory board built from the packed fixtures, and
// `boardctl` (`$.process.run`) by a stub that records every argv.

const ROOT = '/proj'
const BASE = `${ROOT}/.agent-board`
const PANE = {
  plugin: 'agent-file-board',
  component: 'Pane',
  requestId: 'agent-file-board',
  props: { title: 'Board', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

const SIGNED_HEAD = (n: number, from: string) =>
  `FROM: ${from}\nTO: all\nSCOPE: ROOM\nROOM: signed\nTHREAD: T009-signing\nDATE: 2026-11-04 10:0${n}\nREPLY-TO: -\nSTATUS: INFO\nPOSTED-AT: 2026-11-04T09:0${n}:00.000Z\n`
const SIGNED = [
  ['verified', { eligibility: 'eligible', signature: 'valid', trust: 'trusted', reason: 'verified' }],
  ['unapproved', { eligibility: 'eligible', signature: 'valid', trust: 'unfamiliar', reason: 'verified' }],
  ['invalid', { eligibility: 'excluded', signature: 'invalid', trust: 'unknown', reason: 'signature does not match' }],
  ['unavailable', { eligibility: 'pending-verification', signature: 'unavailable', trust: 'unknown', reason: "No module named 'nacl'" }],
] as const

type Board = Map<string, string> // full path → text
type Calls = { argv: string[][]; opened: number; revs: number[] }
type Stub = { placed: boolean; missing: boolean; requirement: string; fixed?: boolean }

function makeBoard(): Board {
  const fs: Board = new Map()
  const fx = FIXTURES.subthreads
  for (const f of fx.files) fs.set(`${BASE}/${f.dir}/${f.name}`, f.text)
  fs.set(`${BASE}/participants.json`, JSON.stringify({ version: 1, participants: [{ id: 'alpha-agent', kind: 'agent' }, { id: 'bravo-agent', kind: 'agent' }] }))
  fs.set(`${BASE}/config.json`, JSON.stringify({ statuses: ['INFO', 'QUESTION', 'REQUEST', 'REPLY', 'DECISION-NEEDED', 'DONE', 'CLOSED'] }))
  fs.set(`${BASE}/rooms/product/.DS_Store`, 'x')
  SIGNED.forEach(([badge], i) => {
    fs.set(`${BASE}/rooms/signed/2026-11-04_100${i}_alpha-agent_T009_${badge}.txt`, `${SIGNED_HEAD(i, 'alpha-agent')}SIGNATURE: {"version":1,"record":"sig_${i}"}\n---\n${badge} body`)
  })
  fs.set(`${BASE}/rooms/signed/2026-11-04_1009_bravo-agent_T009_plain.txt`, `${SIGNED_HEAD(9, 'bravo-agent')}---\nplain body`)
  return fs
}

function children(fs: Board, dir: string) {
  const out = new Map<string, 'file' | 'dir'>()
  for (const path of fs.keys()) {
    if (!path.startsWith(`${dir}/`)) continue
    const rest = path.slice(dir.length + 1)
    const [head, ...more] = rest.split('/')
    out.set(head!, more.length ? 'dir' : 'file')
  }
  return [...out].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false }))
}

const run = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

async function start($: Engine, on: On, fs: Board, stub: Stub, store: Record<string, unknown> = {}) {
  const clock = mock.clock(on)
  // The store is a plain object here, so a test reads back what the mod kept.
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  const calls: Calls = { argv: [], opened: 0, revs: [] }
  // Every write of the pane's snapshot passes through to the kit's own state; its rev is kept.
  on('state.set', (_, e, next) => {
    const write = e as unknown as { ref?: { key?: string }; key?: string; value?: { rev?: number; value?: { rev?: number } } }
    if ((write.ref?.key ?? write.key) === 'snap') calls.revs.push(write.value?.value?.rev ?? write.value?.rev ?? -1)
    return next(e)
  })
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => {
    calls.opened++
    return { value: stub.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'the terminal is too narrow' } }
  })
  on('fs.exists', (_, e) => ({ value: fs.has(e.path) || [...fs.keys()].some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.list', (_, e) => ({ value: children(fs, e.path) }))
  on('fs.read', (_, e) => {
    const text = fs.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    calls.argv.push(argv)
    if (stub.missing) return run('', 127, 'env: boardctl: No such file or directory')
    const args = argv.slice(2)
    if (args[0] === 'signing' && args[1] === 'inspect') {
      const path = args[args.indexOf('--message') + 1]!
      const i = SIGNED.findIndex(([badge]) => path.includes(`_${badge}.txt`))
      // `fixed`: the person has since installed PyNaCl, so the unavailable one verifies.
      if (stub.fixed && SIGNED[i]?.[0] === 'unavailable') return run(JSON.stringify(SIGNED[0][1]))
      return run(JSON.stringify(SIGNED[i]?.[1] ?? { signature: 'unsigned', eligibility: 'eligible' }))
    }
    if (args[0] === 'signing' && args[1] === 'check') {
      const ready = !stub.requirement.startsWith('trusted')
      return run(JSON.stringify({ ready, summary: ready ? 'ok' : 'would be refused', checklist: [{ item: 'requirement', detail: stub.requirement }] }))
    }
    if (args[0] === 'post') {
      if (args.includes('--status') && args[args.indexOf('--status') + 1] === 'REFUSE') return run('', 2, 'boardctl: refused for a reason')
      const from = args[args.indexOf('--from') + 1]!
      const room = args[args.indexOf('--room') + 1]!
      const thread = args[args.indexOf('--thread') + 1]!
      const slug = args[args.indexOf('--slug') + 1]!
      const name = `2026-11-05_1200_${from}_${thread}_${slug}.txt`
      const body = args.find(a => a.startsWith('--body='))!.slice('--body='.length)
      fs.set(`${BASE}/rooms/${room}/${name}`, `FROM: ${from}\nTO: all\nSCOPE: ROOM\nROOM: ${room}\nTHREAD: ${thread}-x\nDATE: 2026-11-05 12:00\nSTATUS: INFO\n---\n${body}`)
      return run(`.agent-board/rooms/${room}/${name}\n`)
    }
    return run('{}')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, calls }
}

const board = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'board', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text ?? ''
const stub = (over: Partial<Stub> = {}): Stub => ({ placed: true, missing: false, requirement: 'optional (unsigned posts accepted)', ...over })

test('AC3: /board opens the pane; rooms → topics → messages with an indented sub-thread; Back', async ($, on) => {
  const { calls } = await start($, on, makeBoard(), stub())
  expect(await board($, '')).toBe('Board proj opened in a pane.')
  expect(calls.opened).toBe(1)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'scope-rooms/product' }))?.text).toContain('#product')
    await ui.press({ key: 'scope-rooms/product' })
    expect((await ui.find({ type: 'Button', key: 'topic-T001' }))?.text).toContain('Release plan for v2.0')
    await ui.press({ key: 'topic-T001' })
    // Root 2's open sub-thread is expanded, root 1's resolved one collapsed.
    expect((await ui.find({ type: 'Button', key: 'sub-2026-11-03_0930_alpha-agent_T001_changelog-wording.txt' }))?.text).toContain('▾ sub-thread: 1 reply, open')
    expect((await ui.find({ type: 'Button', key: 'sub-2026-11-03_0900_alpha-agent_T001_release-plan.txt' }))?.text).toContain('▸ sub-thread: 4 replies, resolved')
    const member = /does the database migration need a dry run first/
    expect(await ui.find({ type: 'Text', text: member })).toBeUndefined()
    await ui.press({ key: 'sub-2026-11-03_0900_alpha-agent_T001_release-plan.txt' })
    expect((await ui.find({ type: 'Button', key: 'sub-2026-11-03_0900_alpha-agent_T001_release-plan.txt' }))?.text).toContain('▾')
    expect(await ui.find({ type: 'Text', text: member })).toBeDefined()
    // The open sub-thread's member shows without a press.
    expect(await ui.find({ type: 'Text', text: /breaking/i })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'topic-T001' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'scope-rooms/signed' })).toBeDefined()
    await ui.unmount()
  }
})

test('AC3: /board open without a board answers and opens nothing', async ($, on) => {
  const { calls } = await start($, on, new Map(), stub())
  expect(await board($, '')).toContain('No .agent-board found')
  expect(await board($, 'open /elsewhere')).toBe('No .agent-board in /elsewhere.')
  expect(calls.opened).toBe(0)
})

test('AC4: unread counts come from $.store; opening a topic clears them and persists', async ($, on) => {
  const fs = makeBoard()
  const store: Record<string, unknown> = {}
  await start($, on, fs, stub(), store)
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'scope-rooms/product' }))?.text).toContain('12 unread')
  await ui.press({ key: 'scope-rooms/product' })
  await ui.press({ key: 'topic-T001' })
  await ui.press({ key: 'back' })
  expect((await ui.find({ type: 'Button', key: 'topic-T001' }))?.text).not.toContain('unread')
  expect((await ui.find({ type: 'Button', key: 'topic-T002' }))?.text).toContain('1 unread')
  await ui.unmount()
  // What was stored is what a later session (or a reload) reads back.
  const seen = store['seen:/proj'] as Record<string, string>
  expect(Object.keys(seen)).toEqual(['rooms/product|T001'])
})

test('AC4: seeded read markers show as fewer unread', async ($, on) => {
  const fs = makeBoard()
  const order = '2026-11-03 09:45\u00002026-11-03T08:45:00.000Z\u00002026-11-03_0945_bravo-agent_T001_guide-rewrite.txt'
  await start($, on, fs, stub(), { 'seen:/proj': { 'rooms/product|T001': order } })
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scope-rooms/product' })
  expect((await ui.find({ type: 'Button', key: 'topic-T001' }))?.text).toContain('1 unread')
  await ui.unmount()
})

test('AC5: all five signature badges; inspect runs once per signed message', async ($, on) => {
  const { calls } = await start($, on, makeBoard(), stub())
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scope-rooms/signed' })
  await ui.press({ key: 'topic-T009' })
  const row = async (word: string) => (await ui.find({ type: 'Text', text: new RegExp(word) }))?.text ?? ''
  expect(await row('✅')).toContain('✅')
  expect(await row('❓')).toContain('❓')
  expect(await row('signature verified, key not approved here')).toBeTruthy()
  expect(await row('signature invalid or excluded: signature does not match')).toBeTruthy()
  expect(await row("signature could not be checked: No module named 'nacl'")).toBeTruthy()
  expect(await row('📝')).toContain('📝')
  const inspects = calls.argv.filter(a => a[2] === 'signing' && a[3] === 'inspect')
  expect(inspects.length).toBe(4)
  for (const argv of inspects) expect(argv.slice(0, 7)).toEqual(['/usr/bin/env', 'boardctl', 'signing', 'inspect', '--path', '/proj', '--message'])
  await ui.unmount()
})

test('AC5: definite badges are kept, unavailable ones re-checked; re-entering a topic re-checks all', async ($, on) => {
  const s = stub()
  const { calls, clock } = await start($, on, makeBoard(), s)
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scope-rooms/signed' })
  await ui.press({ key: 'topic-T009' })
  const inspected = (badge: string) => calls.argv.filter(a => a[3] === 'inspect' && a[a.length - 1]!.endsWith(`_${badge}.txt`)).length
  await clock.advance(10000)
  await clock.advance(10000)
  for (const badge of ['verified', 'unapproved', 'invalid']) expect(inspected(badge)).toBe(1)
  expect(inspected('unavailable')).toBe(3)
  // PyNaCl installed: the next poll turns ⏳ into ✅ without any press.
  s.fixed = true
  await clock.advance(10000)
  expect(await ui.find({ type: 'Text', text: /could not be checked/ })).toBeUndefined()
  // Re-entering the topic asks boardctl again for every signed message.
  await ui.press({ key: 'back' })
  await ui.press({ key: 'topic-T009' })
  for (const badge of ['verified', 'unapproved', 'invalid']) expect(inspected(badge)).toBe(2)
  await ui.unmount()
})

test('AC5: without boardctl the pane still renders and says signatures are unavailable', async ($, on) => {
  await start($, on, makeBoard(), stub({ missing: true }))
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scope-rooms/signed' })
  await ui.press({ key: 'topic-T009' })
  expect(await ui.find({ type: 'Text', text: /^signatures: unavailable \(boardctl not found\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /plain body/ })).toBeDefined()
  await ui.unmount()
})

test('AC5: a configured boardctl.py runs under the configured Python', { options: { boardctl: '/opt/afb/boardctl.py', python: '/opt/venv/bin/python' } }, async ($, on) => {
  const { calls } = await start($, on, makeBoard(), stub())
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scope-rooms/signed' })
  await ui.press({ key: 'topic-T009' })
  expect(calls.argv[0]!.slice(0, 5)).toEqual(['/usr/bin/env', '/opt/venv/bin/python', '/opt/afb/boardctl.py', 'signing', 'inspect'])
  await ui.unmount()
})

test('AC6 + AC9: identity first, then post and reply pass the expected argv', async ($, on) => {
  const fs = makeBoard()
  const store: Record<string, unknown> = {}
  const { calls } = await start($, on, fs, stub(), store)
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scope-rooms/product' })
  await ui.press({ key: 'topic-T001' })
  // AC9: no identity yet: refused with the hint, nothing run.
  expect(await board($, 'post hello')).toBe('Choose who you are first: /board iam <id> (registered: alpha-agent, bravo-agent).')
  expect(await board($, 'iam mallory')).toBe('"mallory" is not a registered participant. Registered: alpha-agent, bravo-agent.')
  await ui.press({ key: 'iam-bravo-agent' })
  expect(store['iam:/proj']).toBe('bravo-agent')
  expect(calls.argv.filter(a => a[2] === 'post')).toEqual([])

  expect(await board($, 'post --status QUESTION Ready for Thursday?')).toBe('Posted as bravo-agent: .agent-board/rooms/product/2026-11-05_1200_bravo-agent_T001_ready-for-thursday.txt')
  const posts = calls.argv.filter(a => a[2] === 'post')
  expect(posts[0]).toEqual(['/usr/bin/env', 'boardctl', 'post', '--path', '/proj', '--from', 'bravo-agent', '--to', 'all', '--scope', 'room', '--room', 'product',
    '--thread', 'T001', '--slug', 'ready-for-thursday', '--status', 'QUESTION', '--body=Ready for Thursday?', '--runtime', 'claude-code'])
  // The signing check ran first, for the same sender, scope and thread.
  const check = calls.argv.find(a => a[3] === 'check')!
  expect(check.slice(2)).toEqual(['signing', 'check', '--path', '/proj', '--from', 'bravo-agent', '--scope', 'rooms/product', '--thread', 'T001'])
  // The new file appears without reopening.
  expect(await ui.find({ type: 'Text', text: /^Ready for Thursday\?$/ })).toBeDefined()

  // Reply to #8 (root 2's member, in an open sub-thread) joins that sub-thread.
  await board($, 'reply 8 Agreed.')
  const reply = calls.argv.filter(a => a[2] === 'post')[1]!
  expect(reply.slice(reply.indexOf('--to'), reply.indexOf('--to') + 2)).toEqual(['--to', 'bravo-agent'])
  expect(reply).toContain('REPLY')
  expect(reply.slice(-4)).toEqual(['--reply-to', '2026-11-03_0935_bravo-agent_T001_breaking-change.txt', '--subthread', '2026-11-03_0930_alpha-agent_T001_changelog-wording.txt'])

  // The composer posts too.
  await ui.input({ key: 'compose', text: 'From the pane' })
  expect(calls.argv.filter(a => a[2] === 'post').length).toBe(3)
  await ui.unmount()
})

test('AC6: a boardctl refusal is shown verbatim; required signing is refused before posting', async ($, on) => {
  const fs = makeBoard()
  const s = stub()
  const { calls } = await start($, on, fs, s, { 'iam:/proj': 'alpha-agent' })
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scope-rooms/product' })
  await ui.press({ key: 'topic-T002' })
  expect(await board($, 'post --status REFUSE x')).toBe('Status REFUSE is not allowed here: INFO, QUESTION, REQUEST, REPLY, DECISION-NEEDED, DONE, CLOSED.')
  fs.set(`${BASE}/config.json`, JSON.stringify({ statuses: ['INFO', 'REFUSE'] }))
  await board($, 'open /proj')
  expect(await board($, 'post --status REFUSE x')).toBe('boardctl: refused for a reason')
  expect(await ui.find({ type: 'Text', text: /^boardctl: refused for a reason$/ })).toBeDefined()
  s.requirement = 'trusted (set by the shared config)'
  const before = calls.argv.filter(a => a[2] === 'post').length
  expect(await board($, 'post signed please')).toContain('requires signed messages. Signed sending arrives in SPEC-002')
  expect(calls.argv.filter(a => a[2] === 'post').length).toBe(before)
  await ui.unmount()
})

test('AC6: a new topic gets the next thread ID and an explicit title', async ($, on) => {
  const { calls } = await start($, on, makeBoard(), stub(), { 'iam:/proj': 'alpha-agent' })
  await board($, 'open /proj')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scope-rooms/product' })
  await board($, 'post --new "Launch checklist" First item')
  const argv = calls.argv.filter(a => a[2] === 'post')[0]!
  expect(argv.slice(argv.indexOf('--thread'), argv.indexOf('--thread') + 4)).toEqual(['--thread', 'T010', '--slug', 'launch-checklist'])
  expect(argv.slice(-2)).toEqual(['--new-thread', '--topic-title=Launch checklist'])
  await ui.unmount()
})

test('AC7: the poll redraws only when a message file appears', async ($, on) => {
  const fs = makeBoard()
  const { clock, calls } = await start($, on, fs, stub())
  await board($, 'open /proj')
  const rev = async () => calls.revs[calls.revs.length - 1]
  const writes = calls.revs.length
  const first = (await rev()) ?? -1
  expect(first).toBeGreaterThan(0)
  await clock.advance(10000)
  await clock.advance(10000)
  expect(calls.revs.length).toBe(writes)
  fs.set(`${BASE}/rooms/product/2026-11-05_1300_alpha-agent_T002_more.txt`, 'FROM: alpha-agent\nTO: all\nSCOPE: ROOM\nROOM: product\nTHREAD: T002-x\nDATE: 2026-11-05 13:00\nSTATUS: INFO\n---\nmore')
  await clock.advance(10000)
  expect(await rev()).toBe(first + 1)
  await clock.advance(10000)
  expect(await rev()).toBe(first + 1)
})

test('AC10: when no pane can be placed, /board prints the rooms with unread counts', async ($, on) => {
  await start($, on, makeBoard(), stub({ placed: false }))
  const text = await board($, 'open /proj')
  expect(text).toContain('proj: 2 room(s) and direct conversation(s)')
  expect(text).toContain('#product  2 topic(s), 12 unread')
  expect(text).toContain('/board reply <n>')
})
