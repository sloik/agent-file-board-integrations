// Plain-text views of a board, for `/agent-file-board` when no pane can be placed
// (SPEC-001 R10). Pure: board model in, text out.
import type { Board, Scope } from './board'
import { unreadCount } from './board'

export type Seen = Record<string, string>

export function scopeLabel(scope: Pick<Scope, 'kind' | 'name'>): string {
  return scope.kind === 'room' ? `#${scope.name}` : `@${scope.name.replace('--', ' ↔ ')}`
}

export function scopeUnread(scope: Scope, seen: Seen): number {
  return scope.topics.reduce((n, t) => n + unreadCount(t, seen[t.key]), 0)
}

export function roomsText(board: Board, label: string, seen: Seen): string {
  if (board.scopes.length === 0) return `${label}: no rooms or direct conversations yet.`
  const lines = [`${label}: ${board.scopes.length} room(s) and direct conversation(s)`]
  for (const scope of board.scopes) {
    const unread = scopeUnread(scope, seen)
    lines.push(`  ${scopeLabel(scope)}  ${scope.topics.length} topic(s)${unread ? `, ${unread} unread` : ''}`)
  }
  return lines.join('\n')
}

export function topicsText(scope: Scope, seen: Seen): string {
  const lines = [`${scopeLabel(scope)}: ${scope.topics.length} topic(s)`]
  for (const t of scope.topics) {
    const unread = unreadCount(t, seen[t.key])
    lines.push(`  ${t.threadId} ${t.title}  ${t.messages.length} msg${unread ? `, ${unread} unread` : ''}${t.closed ? ' [CLOSED]' : ''}`)
  }
  return lines.join('\n')
}
