import { expect, test } from 'claude-code/testing'

import { buildBoard, parseMessage, slugFor, topicEntries, unreadCount } from '../core/board'
import type { Entry, MessageFile } from '../core/board'
import { roomsText, topicsText } from '../core/text'
import { FIXTURES } from './fixtures'

// SPEC-001 AC1: the pure core over boards packed from agent-file-board examples.

const R1 = '2026-11-03_0900_alpha-agent_T001_release-plan.txt'
const R2 = '2026-11-03_0930_alpha-agent_T001_changelog-wording.txt'
const R3 = '2026-11-03_0940_alpha-agent_T001_guide-screenshots.txt'

function describe(entries: Entry[]): string[] {
  return entries.map(e =>
    e.kind === 'subthread'
      ? `  [${e.expanded ? '-' : '+'}] ${e.count} ${e.state}`
      : `${e.depth ? '    ' : ''}${e.message.name.slice(11, 15)} ${e.message.from}${e.orphan ? ' orphan' : ''}`,
  )
}

test('AC1: sub-thread example: topics, titles, order and the sub-thread tree', async () => {
  const fx = FIXTURES.subthreads
  const board = buildBoard(fx.files, fx.participants, fx.config)
  expect(board.invalid).toEqual([])
  expect(board.scopes.map(s => s.dir)).toEqual(['rooms/product'])
  const product = board.scopes[0]!
  // Newest activity first. Both topics end at 09:50 with equal POSTED-AT, so the
  // filename decides (canonical final tie): `_T002_` sorts after `_T001_`.
  expect(product.topics.map(t => [t.threadId, t.title])).toEqual([
    ['T002', 'User guide rewrite'],
    ['T001', 'Release plan for v2.0'],
  ])
  const t001 = product.topics.find(t => t.threadId === 'T001')!
  expect(t001.messages.length).toBe(11)
  expect(t001.messages.map(m => m.name.slice(11, 15))).toEqual(['0900', '0905', '0910', '0915', '0920', '0925', '0930', '0935', '0940', '0945', '0950'])
  expect(t001.subthreads.map(s => [s.root, s.members.length, s.state])).toEqual([
    [R1, 4, 'resolved'],
    [R2, 1, 'open'],
    [R3, 2, 'resolved'],
  ])
  expect(product.topics[0]!.messages[0]!.promotedFrom).toBe(R3)

  // Default display: resolved collapsed, open expanded, SUBTHREAD-ALSO in the main flow.
  expect(describe(topicEntries(t001))).toEqual([
    '0900 alpha-agent',
    '  [+] 4 resolved',
    '0905 bravo-agent',
    '0920 alpha-agent',
    '0930 alpha-agent',
    '  [-] 1 open',
    '    0935 bravo-agent',
    '0940 alpha-agent',
    '  [+] 2 resolved',
  ])
  // Toggling root 1 expands its members, indented, in posting order.
  expect(describe(topicEntries(t001, [R1])).slice(0, 6)).toEqual([
    '0900 alpha-agent',
    '  [-] 4 resolved',
    '    0910 bravo-agent',
    '    0915 alpha-agent',
    '    0920 alpha-agent',
    '    0925 bravo-agent',
  ])
})

test('AC1: full-conversation example: rooms and a direct pair, no config.json', async () => {
  const fx = FIXTURES.fullConversation
  expect(fx.config).toBe(null)
  const board = buildBoard(fx.files, fx.participants, fx.config)
  expect(board.invalid).toEqual([])
  expect(board.scopes.map(s => `${s.kind}:${s.name}`)).toEqual([
    'room:architecture',
    'room:product',
    'direct:implementation-agent-01--research-agent-01',
  ])
  expect(board.participants.map(p => p.id).sort()).toEqual(['human-owner-01', 'implementation-agent-01', 'research-agent-01'])
  // Without config.json the canonical default statuses apply.
  expect(board.statuses).toContain('CLOSED')
  const arch = board.scopes[0]!.topics[0]!
  expect(arch.threadId).toBe('T001')
  expect(arch.closed).toBe(true)
  expect(roomsText(board, 'demo', {})).toContain('@implementation-agent-01 ↔ research-agent-01')
})

test('AC1: a malformed message is reported invalid, .DS_Store is ignored', async () => {
  const files: MessageFile[] = [
    ...FIXTURES.subthreads.files,
    { dir: 'rooms/product', name: '.DS_Store', text: '\u0000\u0001binary' },
    { dir: 'rooms/product', name: '2026-11-03_1000_alpha-agent_T001_broken.txt', text: 'FROM: alpha-agent\nno separator here\n' },
    { dir: 'rooms/product', name: '2026-11-03_1001_alpha-agent_T001_wrong-room.txt', text: 'FROM: a\nTO: all\nSCOPE: ROOM\nROOM: other\nTHREAD: T001-x\nDATE: 2026-11-03 10:01\nSTATUS: INFO\n---\nbody' },
  ]
  const board = buildBoard(files, FIXTURES.subthreads.participants, null)
  expect(board.invalid.map(i => [i.name.slice(11, 15), i.reason])).toEqual([
    ['1000', 'no header block ending in ---'],
    ['1001', 'ROOM does not match its folder'],
  ])
  // Invalid files are kept on their scope, never dropped silently.
  expect(board.scopes[0]!.invalid.length).toBe(2)
  expect(board.scopes[0]!.topics.find(t => t.threadId === 'T001')!.messages.length).toBe(11)
})

test('AC1: STATUS CLOSED with SUBTHREAD is invalid; signature header is noticed', async () => {
  const base = 'FROM: a\nTO: all\nSCOPE: ROOM\nROOM: r\nTHREAD: T001-x\nDATE: 2026-11-03 10:01\n'
  const closed = parseMessage({ dir: 'rooms/r', name: 'x.txt', text: `${base}STATUS: CLOSED\nSUBTHREAD: y.txt\n---\nb` })
  expect('reason' in closed && closed.reason).toBe('STATUS CLOSED together with SUBTHREAD')
  const signed = parseMessage({ dir: 'rooms/r', name: 'x.txt', text: `${base}STATUS: INFO\nSIGNATURE: {"version":1,"record":"sig_x"}\n---\nb` })
  expect('hasSignature' in signed && signed.hasSignature).toBe(true)
})

test('AC1: unread counts and topic text', async () => {
  const fx = FIXTURES.subthreads
  const product = buildBoard(fx.files, fx.participants, fx.config).scopes[0]!
  const t001 = product.topics.find(t => t.threadId === 'T001')!
  expect(unreadCount(t001, undefined)).toBe(11)
  expect(unreadCount(t001, t001.messages[8]!.order)).toBe(2)
  expect(unreadCount(t001, t001.lastOrder)).toBe(0)
  expect(topicsText(product, { [t001.key]: t001.lastOrder })).toContain('T002 User guide rewrite  1 msg, 1 unread')
})

test('slugs are lowercase ASCII and bounded', async () => {
  expect(slugFor('Zażółć gęślą jaźń: Deploy at 16:00!')).toBe('zazoc-gesla-jazn-deploy-at-16-00')
  expect(slugFor('???')).toBe('message')
  expect(slugFor('a'.repeat(80)).length).toBe(32)
})
