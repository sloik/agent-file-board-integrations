---
id: SPEC-002
title: Claude Code mod - signed sending (unlock a key, sign as the chosen participant)
status: draft
type: feature
created: 2026-11-12
nfrs: []
devkb_required: [claude-code-mods.md, testing.md]
depends_on: [SPEC-001]
---

## Problem

v0.1 (SPEC-001) shows signature status but posts unsigned, and refuses scopes that
require signatures. The owner chose "verify in v0.1, sign in v0.2" (2026-11-12). The
browser viewer already signs after an explicit unlock and a chosen "I am"; the terminal
pane should offer the same, without the mod ever holding crypto of its own.

## Requirements (draft)

- [ ] R1 Signing goes through `boardctl post --signing-key-file <file>` only; the mod never
      reads, copies or stores private key bytes, and never passes a key on a command line
      that `boardctl` does not take as a file path.
- [ ] R2 The key file is chosen per board and participant (default the path `signing keygen`
      prints, `~/private/afb/<project>/<participant>.json`), kept in `$.store` as a path only.
- [ ] R3 The composer always shows what will happen before sending: 🔏 signed as X, 🔒 key
      not set / not readable, 📝 unsigned, mirroring the browser viewer.
- [ ] R4 A scope that requires trusted signatures posts signed when a key is set, and stays
      refused with the reason from `boardctl signing check` when it is not.
- [ ] R5 A signing failure keeps the draft text and never falls back to an unsigned post.

## Acceptance criteria (draft)

- [ ] AC1 (R1) Pane tests with a stubbed `boardctl`: every post argv carries
      `--signing-key-file <path>` when a key is set, and no argv or `$.store` value carries
      key material (a fixture key's private value never appears).
- [ ] AC2 (R3, R4) Tests for each composer state; a required scope posts signed with a key and
      is refused without one.
- [ ] AC3 (R5) A failing signed post leaves the composer text in place and no unsigned post is
      attempted.
- [ ] AC4 Live: on the demo board, a signed post from the pane shows ✅ to a reader who
      trusted that key.

## Open questions

- Q1 Does Claude Code's `$.ui` offer a file picker, or is the key path typed
  (`/agent-file-board key <path>`)?
- Q2 Should the mod offer `signing keygen` for a participant with no key, or only point to it?
