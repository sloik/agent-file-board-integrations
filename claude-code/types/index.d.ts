/** One message's signature state as the pane shows it (SPEC-001 R5). */
export type SigBadge = 'verified' | 'unapproved' | 'invalid' | 'unavailable' | 'unsigned'
export type Sig = { badge: SigBadge; reason: string }

/** Where the person is in the pane. */
export type View = {
  /** Project folder holding `.agent-board`; null before `/board open`. */
  root: string | null
  label: string
  /** Scope folder (`rooms/general`), null on the rooms list. */
  scope: string | null
  /** Thread ID (`T001`), null on the topics list. */
  topic: string | null
  /** Sub-thread roots toggled away from their default (collapsed when resolved). */
  toggled: string[]
  /** The message a composer reply answers; null posts with `REPLY-TO: -`. */
  replyTo: string | null
}

/**
 * What the pane draws from besides the board itself. The parsed board lives in
 * the module (rebuilt by the poll after a reload); `rev` changes whenever it
 * does, so writing it redraws the pane. The contract stays self-contained.
 */
export type Snap = {
  rev: number
  /** Topic key (`rooms/general|T001`) → order key of the last message seen. */
  seen: Record<string, string>
  iam: string | null
  sigs: Record<string, Sig>
  boardctl: 'unknown' | 'ok' | 'missing'
  error: string | null
  notice: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-file-board': { view: Shaped<View>; snap: Shaped<Snap> }
  }
}
