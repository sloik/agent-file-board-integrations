// Pure board model for agent-file-board (CONVENTION.md 3.4).
//
// Input is file names and text, output is plain data. Nothing here touches a
// harness API, a filesystem or a process, so the module can move to a shared
// `core/` unchanged when a second adapter needs it (SPEC-001 R1, AC2).
//
// The model is for display. Validity, signing eligibility and posting rules stay
// with `boardctl`; this module only reports what it could not read.

export type MessageFile = {
  /** Physical scope folder relative to `.agent-board`: `rooms/<room>` or `direct/<a>--<b>`. */
  dir: string
  /** The message filename, `.txt`. */
  name: string
  /** The whole file as UTF-8 text. */
  text: string
}

export type Message = {
  /** `<dir>/<name>`, relative to `.agent-board`. */
  path: string
  dir: string
  name: string
  from: string
  to: string
  status: string
  date: string
  postedAt: string
  /** Stable thread ID, `T001`. */
  threadId: string
  /** The `THREAD` label suffix (`release-plan`), may be empty. */
  threadSuffix: string
  replyTo: string | null
  subthread: string | null
  subthreadAlso: boolean
  subthreadState: 'open' | 'resolved' | null
  promotedFrom: string | null
  topicTitle: string | null
  /** Whether a `SIGNATURE` header is present; verification is boardctl's. */
  hasSignature: boolean
  body: string
  /** Canonical-ish posting order key (SPEC-001 constraints): DATE, POSTED-AT, filename. */
  order: string
}

export type InvalidFile = { path: string; dir: string; name: string; reason: string }

export type SubthreadSummary = {
  root: string
  members: Message[]
  state: 'open' | 'resolved'
  participants: string[]
}

export type Entry =
  | { kind: 'message'; message: Message; depth: 0 | 1; orphan?: boolean }
  | { kind: 'subthread'; root: string; count: number; state: 'open' | 'resolved'; participants: string[]; expanded: boolean }

export type Topic = {
  /** `<dir>|<threadId>`: unique across the board. */
  key: string
  dir: string
  threadId: string
  title: string
  messages: Message[]
  subthreads: SubthreadSummary[]
  lastOrder: string
  lastDate: string
  closed: boolean
}

export type Scope = {
  dir: string
  kind: 'room' | 'direct'
  /** Room name, or `a--b` for a direct pair. */
  name: string
  topics: Topic[]
  invalid: InvalidFile[]
}

export type Participant = { id: string; kind: string }

export type Board = {
  scopes: Scope[]
  invalid: InvalidFile[]
  participants: Participant[]
  statuses: string[]
}

const DEFAULT_STATUSES = ['INFO', 'QUESTION', 'REQUEST', 'REPLY', 'DECISION-NEEDED', 'DONE', 'CLOSED']
const FILE_RE = /^(\d{4}-\d{2}-\d{2})_(\d{4})_([a-z0-9][a-z0-9._-]*)_(T\d+)_([a-z0-9][a-z0-9-]*)\.txt$/
const THREAD_RE = /^(T\d+)(?:-(.*))?$/
const REQUIRED = ['FROM', 'TO', 'SCOPE', 'THREAD', 'DATE', 'STATUS'] as const

/** Entries a reader ignores at every board level (CONVENTION.md, Structure). */
export function isIgnored(name: string): boolean {
  return name === '.DS_Store'
}

/** Splits a message file into headers and body; null when there is no `---` line. */
export function splitMessage(text: string): { headers: Map<string, string>; body: string } | null {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const end = lines.indexOf('---')
  if (end < 0) return null
  const headers = new Map<string, string>()
  for (const line of lines.slice(0, end)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon <= 0) return null
    const key = line.slice(0, colon).trim()
    if (!/^[A-Z][A-Z0-9-]*$/.test(key)) return null
    if (!headers.has(key)) headers.set(key, line.slice(colon + 1).trim())
  }
  return { headers, body: lines.slice(end + 1).join('\n').replace(/\n+$/, '') }
}

/** Normalizes `DATE` to sortable text: `YYYY-MM-DD HH:MM[:SS]`, offsets kept as written. */
function dateKey(date: string): string {
  return date.trim().replace('T', ' ')
}

export function parseMessage(file: MessageFile): Message | InvalidFile {
  const path = `${file.dir}/${file.name}`
  const bad = (reason: string): InvalidFile => ({ path, dir: file.dir, name: file.name, reason })
  const parsed = splitMessage(file.text)
  if (!parsed) return bad('no header block ending in ---')
  const h = parsed.headers
  for (const key of REQUIRED) if (!h.get(key)) return bad(`missing ${key}`)
  const thread = THREAD_RE.exec(h.get('THREAD')!)
  if (!thread) return bad('THREAD is not T<digits>-<label>')
  const [kind, scopeName] = file.dir.split('/') as [string, string]
  const scope = h.get('SCOPE')
  if (kind === 'rooms') {
    if (scope !== 'ROOM') return bad('SCOPE is not ROOM in a room folder')
    if (h.get('ROOM') !== scopeName) return bad('ROOM does not match its folder')
  } else if (kind === 'direct') {
    if (scope !== 'DIRECT') return bad('SCOPE is not DIRECT in a direct folder')
    const pair = (h.get('DIRECT-PARTICIPANTS') ?? '').split(',').map(s => s.trim())
    if (pair.join('--') !== scopeName) return bad('DIRECT-PARTICIPANTS does not match its folder')
  }
  const fileThread = FILE_RE.exec(file.name)?.[4]
  if (fileThread && fileThread !== thread[1]) return bad('filename thread differs from THREAD')
  const replyTo = h.get('REPLY-TO')
  const state = h.get('SUBTHREAD-STATE')
  const subthread = h.get('SUBTHREAD') ?? null
  if (subthread && h.get('STATUS') === 'CLOSED') return bad('STATUS CLOSED together with SUBTHREAD')
  const date = h.get('DATE')!
  const postedAt = h.get('POSTED-AT') ?? ''
  return {
    path,
    dir: file.dir,
    name: file.name,
    from: h.get('FROM')!,
    to: h.get('TO')!,
    status: h.get('STATUS')!,
    date,
    postedAt,
    threadId: thread[1]!,
    threadSuffix: thread[2] ?? '',
    replyTo: replyTo && replyTo !== '-' ? replyTo : null,
    subthread,
    subthreadAlso: h.get('SUBTHREAD-ALSO') === 'main',
    subthreadState: state === 'resolved' || state === 'open' ? state : null,
    promotedFrom: h.get('PROMOTED-FROM') ?? null,
    topicTitle: h.get('TOPIC-TITLE') ?? null,
    hasSignature: h.has('SIGNATURE'),
    body: parsed.body,
    order: `${dateKey(date)}\u0000${postedAt}\u0000${file.name}`,
  }
}

export function isInvalid(value: Message | InvalidFile): value is InvalidFile {
  return 'reason' in value
}

/** A thread label suffix as words: `release-plan-for-v2-0` → `release plan for v2 0`. */
export function humanize(suffix: string): string {
  return suffix.replace(/-+/g, ' ').trim()
}

/**
 * Current topic title (CONVENTION.md): the latest explicit `TOPIC-TITLE`, or a
 * legacy `_T001_topic-title-<slug>.txt` event's THREAD suffix; else the earliest
 * message's suffix. `messages` must be in posting order.
 */
export function topicTitle(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.topicTitle) return m.topicTitle
    if (/_T\d+_topic-title-[a-z0-9-]+\.txt$/.test(m.name)) return humanize(m.threadSuffix) || m.threadId
  }
  return humanize(messages[0]?.threadSuffix ?? '') || (messages[0]?.threadId ?? '')
}

function byOrder(a: { order: string }, b: { order: string }): number {
  return a.order < b.order ? -1 : a.order > b.order ? 1 : 0
}

function buildTopic(dir: string, threadId: string, messages: Message[]): Topic {
  messages.sort(byOrder)
  const groups = new Map<string, Message[]>()
  for (const m of messages) {
    if (!m.subthread) continue
    const list = groups.get(m.subthread) ?? []
    list.push(m)
    groups.set(m.subthread, list)
  }
  const subthreads: SubthreadSummary[] = [...groups].map(([root, members]) => {
    let state: 'open' | 'resolved' = 'open'
    for (const m of members) if (m.subthreadState) state = m.subthreadState
    return { root, members, state, participants: [...new Set(members.map(m => m.from))] }
  })
  const last = messages[messages.length - 1]!
  // A topic is closed when its latest main-flow message is CLOSED.
  const main = messages.filter(m => !m.subthread)
  return {
    key: `${dir}|${threadId}`,
    dir,
    threadId,
    title: topicTitle(messages),
    messages,
    subthreads,
    lastOrder: last.order,
    lastDate: last.date,
    closed: main[main.length - 1]?.status === 'CLOSED',
  }
}

/** Builds the whole board from its message files and optional registry/config text. */
export function buildBoard(
  files: readonly MessageFile[],
  participantsJson?: string | null,
  configJson?: string | null,
): Board {
  const byDir = new Map<string, { messages: Message[]; invalid: InvalidFile[] }>()
  const invalid: InvalidFile[] = []
  for (const file of files) {
    if (isIgnored(file.name) || !file.name.endsWith('.txt')) continue
    const slot = byDir.get(file.dir) ?? { messages: [], invalid: [] }
    byDir.set(file.dir, slot)
    const parsed = parseMessage(file)
    if (isInvalid(parsed)) {
      slot.invalid.push(parsed)
      invalid.push(parsed)
    } else slot.messages.push(parsed)
  }
  const scopes: Scope[] = []
  for (const [dir, slot] of byDir) {
    const threads = new Map<string, Message[]>()
    for (const m of slot.messages) {
      const list = threads.get(m.threadId) ?? []
      list.push(m)
      threads.set(m.threadId, list)
    }
    const topics = [...threads].map(([id, list]) => buildTopic(dir, id, list))
    topics.sort((a, b) => (a.lastOrder < b.lastOrder ? 1 : a.lastOrder > b.lastOrder ? -1 : 0))
    const [kind, name] = dir.split('/') as [string, string]
    scopes.push({ dir, kind: kind === 'direct' ? 'direct' : 'room', name, topics, invalid: slot.invalid })
  }
  scopes.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === 'room' ? -1 : 1))
  return { scopes, invalid, participants: parseParticipants(participantsJson), statuses: parseStatuses(configJson) }
}

export function parseParticipants(text?: string | null): Participant[] {
  if (!text) return []
  try {
    const data = JSON.parse(text) as { participants?: unknown }
    if (!Array.isArray(data.participants)) return []
    return data.participants.flatMap(p => {
      const one = p as { id?: unknown; kind?: unknown }
      return typeof one.id === 'string' ? [{ id: one.id, kind: typeof one.kind === 'string' ? one.kind : 'agent' }] : []
    })
  } catch {
    return []
  }
}

export function parseStatuses(text?: string | null): string[] {
  if (!text) return DEFAULT_STATUSES
  try {
    const data = JSON.parse(text) as { statuses?: unknown }
    const list = Array.isArray(data.statuses) ? data.statuses.filter((s): s is string => typeof s === 'string') : []
    return list.length > 0 ? list : DEFAULT_STATUSES
  } catch {
    return DEFAULT_STATUSES
  }
}

/**
 * The topic as display entries: the main flow in posting order, each root
 * followed by a sub-thread line and its members (indented). A resolved sub-thread
 * is collapsed and an open one expanded, each flipped when its root is in `expanded`. A member with `SUBTHREAD-ALSO: main` shows
 * in both places. Members whose root is not in the topic show as orphans.
 */
export function topicEntries(topic: Topic, expanded: readonly string[] = []): Entry[] {
  const names = new Set(topic.messages.map(m => m.name))
  const subs = new Map(topic.subthreads.map(s => [s.root, s]))
  const out: Entry[] = []
  for (const m of topic.messages) {
    if (m.subthread) {
      if (!names.has(m.subthread)) out.push({ kind: 'message', message: m, depth: 0, orphan: true })
      else if (m.subthreadAlso) out.push({ kind: 'message', message: m, depth: 0 })
      continue
    }
    out.push({ kind: 'message', message: m, depth: 0 })
    const sub = subs.get(m.name)
    if (!sub) continue
    // An open sub-thread is expanded unless collapsed by hand; a resolved one is
    // collapsed unless expanded by hand. `expanded` lists roots toggled away from that default.
    const toggled = expanded.includes(m.name)
    const isOpen = sub.state === 'resolved' ? toggled : !toggled
    out.push({ kind: 'subthread', root: m.name, count: sub.members.length, state: sub.state, participants: sub.participants, expanded: isOpen })
    if (isOpen) for (const member of sub.members) out.push({ kind: 'message', message: member, depth: 1 })
  }
  return out
}

/** Unread count of a topic given the order key last seen (`''` when never opened). */
export function unreadCount(topic: Topic, seen: string | undefined): number {
  if (!seen) return topic.messages.length
  return topic.messages.filter(m => m.order > seen).length
}

/** A lowercase ASCII slug for a new message filename (`boardctl post --slug`). */
export function slugFor(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return slug || 'message'
}

/** The other participant of a direct pair. */
export function otherInPair(pair: string, me: string): string {
  const [a, b] = pair.split('--') as [string, string]
  return a === me ? b : a
}
