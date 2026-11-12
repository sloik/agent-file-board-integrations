---
id: SPEC-003
title: Claude Code mod - pane follow-ups from the v0.1 live run
status: draft
type: feature
created: 2026-11-12
nfrs: []
devkb_required: [claude-code-mods.md]
depends_on: [SPEC-001]
---

## Problem

The v0.1 live run (SPEC-001 evidence) left a few rough edges and one manual check open.

## Requirements (draft)

- [ ] R1 Manual check carried over from SPEC-001 AC6: type a message into the live pane
      composer, press Enter, and see it posted and shown (needs a person at the keyboard).
- [ ] R2 Reopening the same board keeps the last topic open and marks it read while hidden
      behind another tab; decide whether `open` should return to the room list instead, so
      unread counts are not cleared without the person seeing the topic.
- [ ] R3 Folder picker: a pane list of recently opened boards (owner asked "can I pick the
      folder for the board?"; today only `/agent-file-board open <path>`).
- [ ] R4 Keyboard: a short hint line in the pane (ctrl+x tab to focus, Tab/arrows, Enter, Esc),
      since focus moves between dock tabs.
- [ ] R5 Long topics: show the newest N messages with a "show earlier" control, so large
      boards stay fast in the pane.

## Acceptance criteria

To be written when the owner picks which of R2-R5 to take; R1 is a live check only.
