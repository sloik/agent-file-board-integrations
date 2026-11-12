---
id: SPEC-001
title: Claude Code mod - board viewer MVP (rooms, topics, messages, sub-threads, signature status, posting via boardctl)
status: in_progress
type: feature
created: 2026-11-12
nfrs: []
devkb_required: [llm-apis.md, testing.md]
depends_on: []
---

## Problem

Owner (2026-11-12): "I want the same functionality, features, but as a Claude mod,
so I can use it in a terminal CLI ... start with the simplest possible scope. But
still the viewer part, rooms, topics, channel, signing, etc."

Today a person in a Claude Code terminal session has two ways to follow a board:
`boardctl` output, or the browser viewer (`agent-file-board-ui`). Neither is visible
beside the chat. This spec adds a Claude Code mod that shows a board in a pane
next to the conversation, with the smallest feature set that is still useful.

## Decisions already made (owner, 2026-11-12)

- Own repository, `agent-file-board-integrations`, next to agent-file-board and agent-file-board-ui,
  laid out for several harnesses (`core/` + one folder per harness).
- Reads are native (the mod's `$.fs`). Posting and signature checks go through
  `boardctl` (`$.process.run`), the single source of truth for format and crypto.
- v0.1 **shows** signature status. Signed **sending** (key unlock, sign-as) is
  SPEC-002 (v0.2).
- Plain `specs/SPEC-NNN-*.md` files, the same convention as the sibling repos (owner, 2026-11-12).
- Q1 and Q2 resolved as proposed (owner, 2026-11-12): see R9 and R10.

## Implementation constraints found while drafting (2026-11-12)

- A mod may import only files inside its own plugin folder. `core/` therefore lives
  at `claude-code/core/` until a second adapter needs it; it stays pure (R1, AC2)
  so it can be moved out unchanged.
- `boardctl` is not on PATH by default. The mod takes its path from a `userConfig`
  field (`boardctl`, path to `boardctl.py`, run as `python3 <path>`). Empty or
  unrunnable means R5's "unavailable" state.
- Ordering uses `DATE` (board-local, compared as normalized text), then
  `POSTED-AT`, then filename. Exact canonical order across a DST fall-back hour or
  explicit offsets is not reproduced in v0.1. This is a display-only limitation;
  the mod never decides validity.
- `boardctl recent` carries no signature data, so R5 calls `signing inspect` once
  per message that has a `SIGNATURE:` header, only in the open topic, and caches
  the result. Messages without the header are unsigned natively.

## Requirements

- [x] R1 `core/` parses a board folder into a model: rooms (`rooms/<room>/`) and
      direct pairs (`direct/<a>--<b>/`), and in each, topics grouped by `THREAD`.
      It honours the current topic title rule, header fields (`FROM`, `TO`, `DATE`,
      `STATUS`, `REPLY-TO`) and the body. It reads the sub-thread headers
      (`SUBTHREAD`, `SUBTHREAD-ALSO`, `SUBTHREAD-STATE`, `PROMOTED-FROM`) per
      CONVENTION.md "Sub-threads (3.4)". `.DS_Store` is ignored. An invalid file is
      shown as invalid, never dropped silently. `core/` imports no harness API: its
      input is file names and text, its output is plain data.
- [x] R2 `/agent-file-board open [path]` opens a pane titled with the board's folder label.
      `path` defaults to `./.agent-board`, then to the nearest ancestor that has one.
      Without a board the command answers with a clear message and opens nothing.
- [x] R3 The pane navigates rooms/direct pairs, then topics (newest activity
      first), then messages in posting order. Sub-thread messages are indented
      under their root, and a resolved sub-thread is collapsed. Keyboard navigation
      works and Back returns one level.
- [x] R4 Unread state: an unread count per room and topic, kept per board in the
      mod's `$.store`, outside the repository (CONVENTION: read markers live outside
      it). Opening a topic marks it read.
- [x] R5 Signature status per message: ✅ verified, ❓ verified but key not approved,
      ⚠️ invalid or excluded (with boardctl's reason), ⏳ verification unavailable,
      📝 unsigned. The status comes from `boardctl` (`signing inspect`
      or the equivalent batch output), never from crypto inside the mod.
      When `boardctl` is missing the pane still renders and shows "signatures:
      unavailable (boardctl not found)".
- [x] R6 `/agent-file-board post` and `/agent-file-board reply <message>` create a message through
      `boardctl post` with the chosen room/topic, `TO`, `STATUS` and body. The new
      file appears in the pane without reopening it. A `boardctl` refusal is shown
      verbatim and nothing is written by the mod itself. When the scope requires
      signatures (`boardctl signing check`), v0.1 refuses before posting and says
      that signed sending arrives in SPEC-002.
- [x] R7 Refresh: the open pane rescans on a timer (default 10 s, configurable)
      and redraws only when something changed.
- [x] R9 Identity ("I am"): before the first post on a board, the mod asks which
      registered participant (from `participants.json`) the person is, and stores the
      answer per board in `$.store`. `/agent-file-board iam <id>` changes it. Posting without a
      chosen identity is refused with that hint.
- [x] R10 Narrow terminal: when `$.ui.open` resolves `{ isPlaced: false }`,
      `/agent-file-board` prints the current view (rooms or topics with unread counts) as
      command text instead, so the board is usable at any width.
- [ ] R8 Install: the repository root has `.claude-plugin/marketplace.json`, and the
      README gives the one-line `/plugin install` command.

## Acceptance criteria

- [x] AC1 (R1) `core` unit tests over fixture boards packed from agent-file-board
      `examples/subthreads` and `examples/full-conversation` (no `config.json`; with a
      direct pair) by a generator script with a freshness check, produce the expected rooms, topics, titles, message order and sub-thread tree.
      A malformed fixture message is reported as invalid. The fixture includes a
      `.DS_Store`, which is ignored.
- [x] AC2 (R1) `tsc` passes, and a check proves `core/` imports nothing outside
      `core/`. Non-vacuity: adding an import of `'claude-code'` to a `core/` file
      makes the check fail.
- [x] AC3 (R2, R3) `claude plugin test` cases: `/agent-file-board open` on the fixture
      opens the pane, and the rendered tree shows rooms → topics → messages with an
      indented sub-thread. Back works. `/agent-file-board open` without a board returns the
      message and opens no pane.
- [x] AC4 (R4) A test seeds `$.store` and shows the unread counts. Opening a topic
      sets that topic to 0, and the counts survive a reload (module re-register).
- [x] AC5 (R5) With a stubbed `boardctl`, all five signature states render with
      their badges. With `boardctl` absent the pane renders the "unavailable" line.
      One manual run against a scratch board built with `boardctl init`, `signing
      keygen` and a signed `post` shows ❓, and ✅ after `signing trust`.
- [x] AC6 (R6) With a stubbed `boardctl`, post and reply pass the expected argv
      (no shell). A refusal is surfaced verbatim. A scope that requires signatures
      is refused before any post call. A manual run on a scratch board creates a real
      message file that `boardctl validate` accepts.
- [x] AC7 (R7) A test advances `$.clock`: no redraw without a change, one redraw
      after a new message file appears.
- [x] AC9 (R9) Test: posting without an identity is refused with the hint.
      `/agent-file-board iam` with an unregistered id is refused. A chosen id is used as
      `--from` and survives a reload.
- [x] AC10 (R10) Test: with `ui.open` answering `{ isPlaced: false }`, `/agent-file-board open`
      returns the room list with unread counts as text.
- [ ] AC8 (R8) `claude plugin validate claude-code/` reports no errors, and an install
      from the marketplace file in a clean session loads the mod.

## Context

- Convention: `agent-file-board/.agent-board/CONVENTION.md` (Structure, Message
  files, Rooms/direct/threads, Sub-threads 3.4, Current topic title, Reading and
  resuming, Signed messages).
- Behaviour reference: `agent-file-board-ui/docs/FEATURES.md` (navigation, unread,
  sub-threads, signing badges).
- `boardctl` commands used: `post`, `recent`, `signing inspect`, `signing check`, `validate`.
- Mod API: Claude Code plugin hooks (`$.ui.open` pane + `ui.render`,
  `$.command.register`, `$.fs.read/list`, `$.process.run`, `$.store`, `$.clock`).
- New files: `claude-code/**` (`claude-code/core/**` pure), `.claude-plugin/marketplace.json`, `README.md`.

## Out of scope (v0.1)

Signed sending and key unlock (SPEC-002); OpenUI reports and typed forms;
extensions; repair/upgrade/history inventories; follow, claims, presence; drafts;
themes; answer acceptance; nested HTML reports; adapters for other harnesses.


## Evidence (2026-11-12)

- `claude plugin test claude-code`: 19 pass, 0 fail (`tests/core.test.ts` AC1;
  `tests/pane.test.tsx` AC3-AC7, AC9, AC10). The AC5 cache test goes red when the
  re-check of `unavailable` badges is removed (mutation run).
- AC4 reload: read markers and identity live in `$.store` (the seeded-store test reads them
  back as a new session would); view and badges live in `$.state`, which a reload keeps.
- `claude plugin validate claude-code` and `claude plugin validate .` (marketplace): pass.
- `scripts/typecheck.sh <claude-code.d.ts>` (Claude Code 2.1.322 types): clean; goes red on an
  injected type error.
- AC2: `node scripts/check-core-purity.mjs` passes; `--self-test` detects all 3 mutations
  (`'claude-code'`, `node:fs`, `../hooks/register`).
- AC1 fixtures: `node scripts/pack-fixtures.mjs <agent-file-board> --check` current.
- AC5 inputs: badge mapping exercised with the exact `signing inspect` JSON shapes observed on a
  scratch board (`boardctl init`, `signing keygen`, `identity import`, signed `post`):
  `valid/unfamiliar` before `signing trust`, `valid/trusted` after, and
  `pending-verification/unavailable` from a Python without PyNaCl.
- AC6 manual: the argv the mod builds (post, reply, new topic with `--new-thread --topic-title`,
  sub-thread member reply with `--reply-to <member> --subthread <root>`) ran against the scratch
  board; `boardctl validate` reports "board is valid". Also a body `-x` and a title
  `--to be or not` (passed as `--body=` / `--topic-title=`), and a direct post bob → alice.

- Live run (2026-11-12, Claude Code 2.1.322, tmux, `--plugin-dir` + `--settings` with the
  `boardctl`/`python` options) on `.demo/board` from `scripts/make-demo-board.sh`: the pane
  showed rooms with unread counts and the "Who are you?" chooser; Enter on `[alice]` set
  the identity; `room general`, `topic T001` opened the topic with the open sub-thread
  indented; alice's signed messages showed ❓, bob's 📝; `reply 3 …` posted through
  boardctl and appeared as #5 inside the sub-thread without reopening; after
  `boardctl signing trust` and re-entering the topic both showed ✅; `boardctl validate`:
  "board is valid". Found and fixed live: an already-docked pane did not come forward on
  `open` (now `focus: true`); a stale "Posted" notice survived navigation (now cleared).

## Open

- [ ] AC6 manual typing into the live composer (the same `post()` path ran live through
  `/agent-file-board reply`; composer submit is covered by the pane test).
- [ ] R8/AC8: install from the marketplace in a clean session - needs the GitHub repository.
