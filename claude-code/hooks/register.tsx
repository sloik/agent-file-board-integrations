import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Sig, SigBadge, Snap, View } from '../types'
import type { Board, Message, MessageFile, Scope, Topic } from '../core/board'
import { buildBoard, otherInPair, slugFor, topicEntries, unreadCount } from '../core/board'
import { roomsText, scopeLabel, scopeUnread, topicsText } from '../core/text'
import type { Seen } from '../core/text'

// Agent File Board in a pane (SPEC-001). Reads are native ($.fs); posting,
// signing checks and signature verification run boardctl ($.process.run, argv,
// no shell). The mod never writes a board file itself.

const PANE = 'agent-file-board'
const COMMAND = 'agent-file-board'
const BADGE: Record<SigBadge, string> = { verified: '✅', unapproved: '❓', invalid: '⚠️', unavailable: '⏳', unsigned: '📝' }
const BADGE_TEXT: Record<SigBadge, string> = {
  verified: 'signature verified, key approved',
  unapproved: 'signature verified, key not approved here',
  invalid: 'signature invalid or excluded',
  unavailable: 'signature could not be checked',
  unsigned: 'unsigned',
}

const EMPTY_VIEW: View = { root: null, label: '', scope: null, topic: null, toggled: [], replyTo: null }
const EMPTY_SNAP: Snap = { rev: 0, seen: {}, iam: null, sigs: {}, boardctl: 'unknown', error: null, notice: null }

const view = atom({ plugin: 'agent-file-board', key: 'view' } as const, EMPTY_VIEW, { shape: 'view-1' })
const snap = atom({ plugin: 'agent-file-board', key: 'snap' } as const, EMPTY_SNAP, { shape: 'snap-1' })

// Module state: starts over on a hot reload, which only costs a re-read.
let options: PluginOptions = {}
let cwd = '.'
let busy = false
let again = false
let lastKey = ''
let timer: Timer | null = null
let board: Board | null = null // the parsed board of view.root; Snap.rev marks its changes
const files = new Map<string, MessageFile>() // full path → parsed input; messages are immutable

type Run = { exitCode: number; stdout: string; stderr: string } | null

function parentOf(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

function absolute(path: string): string {
  return path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`.replace(/\/\.$/, '')
}

function boardctlArgv(args: readonly string[]): string[] {
  const script = String(options['boardctl'] ?? '').trim()
  const python = String(options['python'] ?? 'python3').trim() || 'python3'
  return script ? ['/usr/bin/env', python, script, ...args] : ['/usr/bin/env', 'boardctl', ...args]
}

async function boardctl($: EngineInterface, args: readonly string[]): Promise<Run> {
  try {
    const r = await $.process.run(boardctlArgv(args), { timeoutMs: 60000 })
    if (r.exitCode === 127) return null
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch {
    return null
  }
}

/** The project folder holding `.agent-board`: the argument, else the nearest one at or above cwd. */
async function findRoot($: EngineInterface, arg: string): Promise<string | null> {
  if (arg) {
    let path = absolute(arg.trim()).replace(/\/+$/, '')
    if (baseName(path) === '.agent-board') path = parentOf(path)
    return (await $.fs.exists(`${path}/.agent-board`)) ? path : null
  }
  let dir = absolute(cwd).replace(/\/+$/, '') || '/'
  for (;;) {
    if (await $.fs.exists(`${dir}/.agent-board`)) return dir
    if (dir === '/' || dir === '') return null
    dir = parentOf(dir)
  }
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** Lists the scope folders and reads only message files not seen before. */
async function scan($: EngineInterface, root: string): Promise<{ board: Board; key: string }> {
  const base = `${root}/.agent-board`
  const found: MessageFile[] = []
  for (const kind of ['rooms', 'direct'] as const) {
    if (!(await $.fs.exists(`${base}/${kind}`))) continue
    for (const scope of await $.fs.list(`${base}/${kind}`)) {
      if (scope.kind !== 'dir' || scope.name.startsWith('.')) continue
      const dir = `${kind}/${scope.name}`
      for (const entry of await $.fs.list(`${base}/${dir}`)) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.txt')) continue
        const full = `${base}/${dir}/${entry.name}`
        let file = files.get(full)
        if (!file) {
          file = { dir, name: entry.name, text: (await readText($, full)) ?? '' }
          files.set(full, file)
        }
        found.push(file)
      }
    }
  }
  const participants = await readText($, `${base}/participants.json`)
  const config = await readText($, `${base}/config.json`)
  const key = JSON.stringify([found.map(f => `${f.dir}/${f.name}`).sort(), participants, config])
  return { board: buildBoard(found, participants, config), key }
}

function findScope(board: Board | null, dir: string | null): Scope | undefined {
  return board?.scopes.find(s => s.dir === dir)
}

function findTopic(board: Board | null, dir: string | null, id: string | null): Topic | undefined {
  return findScope(board, dir)?.topics.find(t => t.threadId === id)
}

/** Maps `boardctl signing inspect` JSON to a badge (SPEC-001 R5). */
export function badgeFor(result: Record<string, unknown>): Sig {
  const reason = typeof result['reason'] === 'string' ? (result['reason'] as string) : ''
  const signature = result['signature']
  if (signature === 'unsigned') return { badge: result['eligibility'] === 'excluded' ? 'invalid' : 'unsigned', reason }
  if (signature === 'unavailable' || result['eligibility'] === 'pending-verification') return { badge: 'unavailable', reason }
  if (signature === 'valid' && result['eligibility'] === 'eligible') {
    return { badge: result['trust'] === 'trusted' ? 'verified' : 'unapproved', reason }
  }
  return { badge: 'invalid', reason }
}

/**
 * Checks the signed messages of the open topic. A definite answer is kept until
 * the topic is entered again, the board is reopened or the mod reloads (a
 * `/config` change); an `unavailable` one is asked again on every poll, so fixing
 * the Python or boardctl path shows at once. Unsigned messages need no check.
 */
async function checkSignatures($: EngineInterface, root: string, topic: Topic, known: Record<string, Sig>, was: Snap['boardctl']): Promise<{ sigs: Record<string, Sig>; boardctl: Snap['boardctl'] } | null> {
  const todo = topic.messages.filter(m => m.hasSignature && (!known[m.path] || known[m.path]!.badge === 'unavailable'))
  if (todo.length === 0) return null
  const sigs = { ...known }
  let status: Snap['boardctl'] = 'ok'
  for (const m of todo) {
    const r = await boardctl($, ['signing', 'inspect', '--path', root, '--message', m.path])
    if (!r) {
      status = 'missing'
      break
    }
    try {
      sigs[m.path] = badgeFor(JSON.parse(r.stdout) as Record<string, unknown>)
    } catch {
      sigs[m.path] = { badge: 'unavailable', reason: (r.stderr || r.stdout).trim().slice(0, 160) }
    }
  }
  if (status === was && JSON.stringify(sigs) === JSON.stringify(known)) return null
  return { sigs, boardctl: status }
}

async function poll($: EngineInterface): Promise<void> {
  if (busy) {
    again = true // a post or a press asked for fresh data mid-poll: run once more after
    return
  }
  busy = true
  again = false
  try {
    const v = await read($, view)
    if (!v.root) return
    const scanned = await scan($, v.root)
    let s = await read($, snap)
    let changed = scanned.key !== lastKey || board === null
    if (changed) {
      lastKey = scanned.key
      board = scanned.board
      s = { ...s, rev: s.rev + 1 }
    }
    const topic = findTopic(board, v.scope, v.topic)
    if (topic) {
      if (s.seen[topic.key] !== topic.lastOrder) {
        const seen = { ...s.seen, [topic.key]: topic.lastOrder }
        await $.store.set(`seen:${v.root}`, seen)
        s = { ...s, seen }
        changed = true
      }
      const checked = await checkSignatures($, v.root, topic, s.sigs, s.boardctl)
      if (checked) {
        s = { ...s, ...checked }
        changed = true
      }
    }
    if (changed) await update($, snap, () => s)
  } catch (err) {
    await update($, snap, s => ({ ...s, error: String(err).slice(0, 200) }))
  } finally {
    busy = false
  }
  if (again) await poll($)
}

async function openBoard($: EngineInterface, root: string): Promise<void> {
  const seen = ((await $.store.get(`seen:${root}`)) ?? {}) as Seen
  const iam = ((await $.store.get(`iam:${root}`)) ?? null) as string | null
  const current = await read($, view)
  if (current.root !== root) {
    await update($, view, () => ({ ...EMPTY_VIEW, root, label: baseName(root) }))
    await update($, snap, () => ({ ...EMPTY_SNAP, seen, iam }))
    lastKey = ''
    board = null
  } else {
    // An explicit reopen re-checks signatures (trust may have changed outside).
    await update($, snap, x => ({ ...x, sigs: {}, error: null, notice: null }))
  }
  await poll($)
}

async function setIam($: EngineInterface, id: string): Promise<string> {
  const v = await read($, view)
  if (!v.root || !board) return 'No board open. Run /agent-file-board open [path] first.'
  const ids = board.participants.map(p => p.id)
  if (!ids.includes(id)) return `"${id}" is not a registered participant. Registered: ${ids.join(', ') || 'none'}.`
  await $.store.set(`iam:${v.root}`, id)
  await update($, snap, x => ({ ...x, iam: id, notice: `You post as ${id}.`, error: null }))
  return `You post as ${id} on ${v.label}.`
}

/** Next thread ID: one above the highest thread number in all message filenames, invalid ones included. */
function nextThreadId(board: Board): string {
  let max = 0
  let width = 3
  const names = [
    ...board.scopes.flatMap(sc => sc.topics.flatMap(t => t.messages.map(m => m.name))),
    ...board.invalid.map(i => i.name),
  ]
  for (const name of names) {
    const digits = /_T(\d+)_/.exec(name)?.[1]
    if (!digits) continue
    max = Math.max(max, Number(digits))
    width = Math.max(width, digits.length)
  }
  return `T${String(max + 1).padStart(width, '0')}`
}

type PostRequest = { text: string; to?: string; status?: string; newTitle?: string; replyTo?: string | null }

/** Posts through boardctl; returns what happened as one line (SPEC-001 R6). */
async function post($: EngineInterface, req: PostRequest): Promise<string> {
  const v = await read($, view)
  const s = await read($, snap)
  const fail = async (message: string) => {
    await update($, snap, x => ({ ...x, error: message, notice: null }))
    return message
  }
  if (!v.root || !board) return fail('No board open. Run /agent-file-board open [path] first.')
  const ids = board.participants.map(p => p.id)
  if (!s.iam) return fail(`Choose who you are first: /agent-file-board iam <id>${ids.length ? ` (registered: ${ids.join(', ')})` : ''}.`)
  const scope = findScope(board, v.scope)
  if (!scope) return fail('Open a room or direct conversation first.')
  const text = req.text.trim()
  if (!text) return fail('Nothing to post: the message is empty.')
  const topic = req.newTitle ? undefined : findTopic(board, v.scope, v.topic)
  if (!req.newTitle && !topic) return fail('Open a topic first, or start one with /agent-file-board post --new "Title" <text>.')
  const target = req.replyTo && topic ? topic.messages.find(m => m.name === req.replyTo) : undefined
  const thread = req.newTitle ? nextThreadId(board) : topic!.threadId
  const to = req.to ?? (scope.kind === 'direct' ? otherInPair(scope.name, s.iam) : target ? target.from : 'all')
  const status = req.status ?? (target ? 'REPLY' : 'INFO')
  if (!board.statuses.includes(status)) return fail(`Status ${status} is not allowed here: ${board.statuses.join(', ')}.`)

  const check = await boardctl($, ['signing', 'check', '--path', v.root, '--from', s.iam, '--scope', scope.dir, '--thread', thread])
  if (!check) return fail('boardctl not found: set its path in /config (agent-file-board).')
  try {
    const result = JSON.parse(check.stdout) as { ready?: boolean; summary?: string; checklist?: { item: string; detail?: string }[] }
    const requirement = result.checklist?.find(c => c.item === 'requirement')?.detail ?? ''
    if (requirement.startsWith('trusted')) {
      return fail(`${scopeLabel(scope)} ${thread} requires signed messages. Signed sending arrives in SPEC-002; use boardctl post --signing-key-file for now.`)
    }
    if (result.ready === false) return fail(result.summary ?? 'boardctl signing check refused this post.')
  } catch {
    return fail((check.stderr || check.stdout).trim() || 'boardctl signing check failed.')
  }

  const argv = [
    'post', '--path', v.root, '--from', s.iam, '--to', to,
    '--scope', scope.kind === 'direct' ? 'direct' : 'room',
    ...(scope.kind === 'room' ? ['--room', scope.name] : []),
    '--thread', thread, '--slug', slugFor(req.newTitle ?? text), '--status', status,
    // `=` keeps a body or title that starts with `-` from being read as an option.
    `--body=${text}`, '--runtime', 'claude-code',
    ...(target ? ['--reply-to', target.name] : []),
    ...(target?.subthread ? ['--subthread', target.subthread] : []),
    ...(req.newTitle ? ['--new-thread', `--topic-title=${req.newTitle}`] : []),
  ]
  const r = await boardctl($, argv)
  if (!r) return fail('boardctl not found: set its path in /config (agent-file-board).')
  if (r.exitCode !== 0) return fail((r.stderr || r.stdout).trim() || `boardctl post exited ${r.exitCode}.`)
  const written = r.stdout.trim().split('\n').pop() ?? ''
  if (req.newTitle) await update($, view, x => ({ ...x, topic: thread, replyTo: null }))
  else await update($, view, x => ({ ...x, replyTo: null }))
  await update($, snap, x => ({ ...x, error: null, notice: `Posted ${baseName(written)}` }))
  await poll($)
  return `Posted as ${s.iam}: ${written}`
}

/** `--to X --status S --new "Title"` options in front of the text. */
export function parseOptions(input: string): { opts: Record<string, string>; rest: string } {
  const opts: Record<string, string> = {}
  let rest = input
  for (;;) {
    const m = /^\s*--(to|status|new)\s+(?:"([^"]*)"|(\S+))/.exec(rest)
    if (!m) break
    opts[m[1]!] = m[2] ?? m[3] ?? ''
    rest = rest.slice(m[0].length)
  }
  return { opts, rest: rest.trim() }
}

const HELP = [
  '/agent-file-board open [path]                               open the board at or above the working directory (or at path)',
  '/agent-file-board room <name>                               show the topics of a room (#general, or alice--bob for a direct pair)',
  '/agent-file-board topic <T001>                              open a topic of the current room',
  '/agent-file-board iam <id>                                  choose the registered participant you post as',
  '/agent-file-board post [--to ID] [--status S] <text>        post in the open topic',
  '/agent-file-board post --new "Title" [--to ID] <text>       start a topic in the open room',
  '/agent-file-board reply <n> [--to ID] [--status S] <text>   reply to message #n of the open topic',
].join('\n')

/** `room general`, `room #general` or `room alice--bob`: show that scope's topics. */
async function goRoom($: EngineInterface, name: string): Promise<string> {
  if (!board) return 'No board open. Run /agent-file-board open [path] first.'
  const key = name.replace(/^[#@]/, '')
  const scope = board.scopes.find(sc => sc.name === key || sc.dir === key)
  if (!scope) return `No room or direct conversation "${name}". Have: ${board.scopes.map(scopeLabel).join(', ')}.`
  await update($, view, x => ({ ...x, scope: scope.dir, topic: null, replyTo: null }))
  await update($, snap, x => ({ ...x, notice: null, error: null }))
  return topicsText(scope, (await read($, snap)).seen)
}

/** `topic T001`: open that topic of the current room (marks it read). */
async function goTopic($: EngineInterface, id: string): Promise<string> {
  const v = await read($, view)
  const scope = findScope(board, v.scope)
  if (!scope) return 'Pick a room first: /agent-file-board room <name>.'
  const topic = scope.topics.find(t => t.threadId === id.toUpperCase())
  if (!topic) return `No topic ${id} in ${scopeLabel(scope)}. Have: ${scope.topics.map(t => t.threadId).join(', ')}.`
  await update($, view, x => ({ ...x, topic: topic.threadId, replyTo: null, toggled: [] }))
  const paths = new Set(topic.messages.map(m => m.path))
  await update($, snap, x => ({ ...x, notice: null, error: null, sigs: Object.fromEntries(Object.entries(x.sigs).filter(([path]) => !paths.has(path))) }))
  await poll($)
  return `${topic.threadId} ${topic.title}: ${topic.messages.length} message(s).`
}

async function textView($: EngineInterface): Promise<string> {
  const v = await read($, view)
  const s = await read($, snap)
  if (!board) return 'No board open.'
  const scope = findScope(board, v.scope)
  return scope ? topicsText(scope, s.seen) : roomsText(board, v.label, s.seen)
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const trimmed = args.trim()
  const [sub = 'open', ...restWords] = trimmed.split(/\s+/)
  const rest = trimmed.slice(sub.length).trim()
  if (trimmed === '' || sub === 'open') {
    const root = await findRoot($, sub === 'open' ? rest : '')
    if (!root) return rest ? `No .agent-board in ${rest}.` : 'No .agent-board found at or above the working directory. Run /agent-file-board open <path>.'
    await openBoard($, root)
    // Asked for by the person, so it comes to the front and takes the keyboard.
    const placed = await $.ui.open({ id: PANE, title: `Board · ${baseName(root)}`, focus: true })
    if (!placed.isPlaced) return `${await textView($)}\n(The terminal is too narrow for the pane; widen it or use the commands below.)\n${HELP}`
    return `Board ${baseName(root)} opened in a pane.`
  }
  if (sub === 'iam') return setIam($, restWords[0] ?? '')
  if (sub === 'room') return goRoom($, restWords[0] ?? '')
  if (sub === 'topic') return goTopic($, restWords[0] ?? '')
  if (sub === 'post') {
    const { opts, rest: text } = parseOptions(rest)
    return post($, { text, to: opts['to'], status: opts['status'], newTitle: opts['new'] })
  }
  if (sub === 'reply') {
    const n = Number(restWords[0])
    const v = await read($, view)
    const topic = findTopic(board, v.scope, v.topic)
    const target = topic?.messages[n - 1]
    if (!topic) return 'Open a topic first.'
    if (!Number.isInteger(n) || !target) return `No message #${restWords[0] ?? ''} in ${topic.threadId}; messages are numbered 1-${topic.messages.length}.`
    const { opts, rest: text } = parseOptions(rest.slice(restWords[0]!.length))
    return post($, { text, to: opts['to'], status: opts['status'], replyTo: target.name })
  }
  return HELP
}

function messageNumber(topic: Topic, m: Message): number {
  return topic.messages.indexOf(m) + 1
}

export const register: Register = (on, opts) => {
  options = opts

  on('session.start', async ($, e, next) => {
    cwd = e.cwd || '.'
    // Runs again on a reload and a /config change: re-check signatures with the new settings.
    await update($, snap, (x): Snap => ({ ...x, sigs: {}, boardctl: 'unknown' }))
    await $.command.register({ name: COMMAND, description: 'Agent File Board: rooms, topics and messages in a pane', argumentHint: '[open <path> | room <name> | topic <T001> | iam <id> | post <text> | reply <n> <text> | help]' })
    const seconds = Number(options['refreshSeconds'] ?? 10)
    timer?.cancel()
    timer = $.clock.every(Math.max(2, Number.isFinite(seconds) ? seconds : 10) * 1000, () => void poll($))
    void poll($) // after a reload the view survives in $.state; rebuild the board
    return next(e)
  })

  on('command.run', { command: 'agent-file-board' }, async ($, e) => {
    try {
      return { text: await runCommand($, e.args) }
    } catch (err) {
      return { text: `board: ${String(err).slice(0, 300)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const v = await read($, view)
    const s = await read($, snap)
    const cols = Math.max(30, e.props.bodyColumns ?? 80)

    const status = (
      <Box flexDirection="column">
        {s.error && <Text color="error" wrap="wrap">{s.error}</Text>}
        {!s.error && s.notice && <Text color="success" wrap="truncate-end">{s.notice}</Text>}
        {s.boardctl === 'missing' && <Text color="warning">signatures: unavailable (boardctl not found)</Text>}
      </Box>
    )

    if (!v.root || !board) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No board open. Run /agent-file-board open [path].</Text>
          {status}
        </Box>
      )
    }
    const shown: Board = board

    const header = (
      <Box>
        <Text bold>{v.label}</Text>
        <Text dimColor>  I am: </Text>
        {s.iam ? <Text color="claude">{s.iam}</Text> : <Text color="warning">not chosen</Text>}
      </Box>
    )

    const chooser = !s.iam && shown.participants.length > 0 && (
      <Box flexDirection="column">
        <Text dimColor>Who are you? (needed to post; /agent-file-board iam &lt;id&gt; changes it)</Text>
        <Box flexWrap="wrap">
          {shown.participants.map(p => (
            <Button key={`iam-${p.id}`} plain onPress={() => void setIam($, p.id)}>
              <Text>[{p.id}]</Text><Text dimColor> </Text>
            </Button>
          ))}
        </Box>
      </Box>
    )

    const scope = findScope(shown, v.scope)
    const topic = scope?.topics.find(t => t.threadId === v.topic)
    let body

    if (!scope) {
      body = shown.scopes.length === 0
        ? <Text dimColor>No rooms or direct conversations yet.</Text>
        : (
          <Box flexDirection="column">
            {shown.scopes.map(sc => {
              const unread = scopeUnread(sc, s.seen)
              return (
                <Button key={`scope-${sc.dir}`} plain onPress={() => update($, view, x => ({ ...x, scope: sc.dir, topic: null, replyTo: null }))}>
                  <Text bold={unread > 0}>{scopeLabel(sc)}</Text>
                  <Text dimColor>  {sc.topics.length} topic{sc.topics.length === 1 ? '' : 's'}</Text>
                  {unread > 0 && <Text color="warning"> · {unread} unread</Text>}
                  {sc.invalid.length > 0 && <Text color="error"> · {sc.invalid.length} invalid</Text>}
                </Button>
              )
            })}
          </Box>
        )
    } else if (!topic) {
      body = (
        <Box flexDirection="column">
          <Button key="back" plain onPress={() => update($, view, x => ({ ...x, scope: null, topic: null }))}>
            <Text dimColor>← Rooms  </Text><Text bold>{scopeLabel(scope)}</Text>
          </Button>
          {scope.topics.length === 0 && <Text dimColor>No topics.</Text>}
          {scope.topics.map(t => {
            const unread = unreadCount(t, s.seen[t.key])
            return (
              <Button key={`topic-${t.threadId}`} plain onPress={async () => {
                await update($, view, x => ({ ...x, topic: t.threadId, replyTo: null, toggled: [] }))
                const paths = new Set(t.messages.map(m => m.path))
                await update($, snap, x => ({ ...x, notice: null, error: null, sigs: Object.fromEntries(Object.entries(x.sigs).filter(([path]) => !paths.has(path))) }))
                await poll($)
              }}>
                <Text dimColor>{t.threadId} </Text>
                <Text bold={unread > 0} dimColor={t.closed}>{t.title}</Text>
                <Text dimColor>  {t.messages.length} msg · {t.lastDate}</Text>
                {unread > 0 && <Text color="warning"> · {unread} unread</Text>}
                {t.closed && <Text dimColor> · closed</Text>}
              </Button>
            )
          })}
          {scope.invalid.map(bad => (
            <Text key={`bad-${bad.name}`} color="error" wrap="truncate-end">invalid: {bad.name} ({bad.reason})</Text>
          ))}
        </Box>
      )
    } else {
      const entries = topicEntries(topic, v.toggled)
      const replyTarget = v.replyTo ? topic.messages.find(m => m.name === v.replyTo) : undefined
      body = (
        <Box flexDirection="column">
          <Button key="back" plain onPress={() => update($, view, x => ({ ...x, topic: null, replyTo: null }))}>
            <Text dimColor>← {scopeLabel(scope)}  </Text><Text bold>{topic.threadId} {topic.title}</Text>
          </Button>
          {entries.map(entry => {
            if (entry.kind === 'subthread') {
              const flip = () => update($, view, x => ({
                ...x,
                toggled: x.toggled.includes(entry.root) ? x.toggled.filter(r => r !== entry.root) : [...x.toggled, entry.root],
              }))
              return (
                <Box key={`st-${entry.root}`} marginLeft={2}>
                  <Button key={`sub-${entry.root}`} plain onPress={flip}>
                    <Text color="suggestion">{entry.expanded ? '▾' : '▸'} sub-thread: {entry.count} repl{entry.count === 1 ? 'y' : 'ies'}, {entry.state}</Text>
                    <Text dimColor> ({entry.participants.join(', ')})</Text>
                  </Button>
                </Box>
              )
            }
            const m = entry.message
            const n = messageNumber(topic, m)
            const sig: Sig = m.hasSignature
              ? s.sigs[m.path] ?? { badge: 'unavailable', reason: s.boardctl === 'missing' ? 'boardctl not found' : 'checking…' }
              : { badge: 'unsigned', reason: '' }
            return (
              <Box key={`m-${m.name}`} flexDirection="column" marginLeft={entry.depth * 4} marginTop={1} width={cols - entry.depth * 4}>
                <Box>
                  <Text dimColor>#{n} {m.date} </Text>
                  <Text bold>{m.from}</Text>
                  <Text dimColor> → {m.to} </Text>
                  <Text color={m.status === 'QUESTION' || m.status === 'DECISION-NEEDED' || m.status === 'REQUEST' ? 'warning' : undefined}>{m.status}</Text>
                  <Text> {BADGE[sig.badge]}</Text>
                  {sig.badge !== 'unsigned' && sig.badge !== 'verified' && <Text dimColor wrap="truncate-end"> {BADGE_TEXT[sig.badge]}{sig.reason && sig.reason !== 'verified' ? `: ${sig.reason}` : ''}</Text>}
                  {entry.orphan && <Text color="warning"> orphan</Text>}
                  <Text dimColor>  </Text>
                  <Button key={`re-${n}`} plain onPress={() => update($, view, x => ({ ...x, replyTo: m.name }))}>
                    <Text dimColor>↩</Text>
                  </Button>
                </Box>
                <Text wrap="wrap">{m.body}</Text>
              </Box>
            )
          })}
          <Box marginTop={1} flexDirection="column">
            {replyTarget && (
              <Box>
                <Text dimColor>Replying to #{messageNumber(topic, replyTarget)} by {replyTarget.from}  </Text>
                <Button key="re-clear" plain onPress={() => update($, view, x => ({ ...x, replyTo: null }))}><Text dimColor>✕</Text></Button>
              </Box>
            )}
            <Input
              key="compose"
              placeholder={s.iam ? `Message as ${s.iam} (Enter sends)` : 'Choose who you are first'}
              submitLabel="send"
              onSubmit={text => void post($, { text, replyTo: v.replyTo })}
            />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {chooser}
        {status}
        {body}
      </Box>
    )
  })
}
