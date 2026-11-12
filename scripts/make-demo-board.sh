#!/bin/sh
# Builds a throwaway demo board for trying the Claude Code mod (SPEC-001 AC5/AC6):
# participants alice and bob, a room `general` with a signed message from alice,
# unsigned replies, a sub-thread, and a direct conversation.
#
# Usage: scripts/make-demo-board.sh <agent-file-board repo> [python-with-signing-deps]
# Output: .demo/board (the board), .demo/keys (alice's private key; demo only).
# boardctl's default private state is used, so the mod sees the same trust state.
set -eu
AFB=${1:?pass the agent-file-board repository}
PY=${2:-python3}
BC="$AFB/boardctl.py"
HERE=$(cd "$(dirname "$0")/.." && pwd -P)
DEMO="$HERE/.demo"
B="$DEMO/board"
"$PY" -c "import nacl, cryptography" || { echo "make-demo-board: $PY lacks requirements-signing.txt" >&2; exit 2; }
rm -rf "$B" "$DEMO/keys"; mkdir -p "$B" "$DEMO/keys"
# A rebuilt board gets a new board UUID; boardctl refuses to reuse private trust state
# kept for the old one at this path (by design). Remove only this demo board's state file.
STATE=${AGENT_FILE_BOARD_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-file-board}
KEY=$("$PY" -c "import hashlib,pathlib,sys;print(hashlib.sha256(str(pathlib.Path(sys.argv[1]).resolve()).encode()).hexdigest())" "$B")
rm -f "$STATE/signing/$KEY.json"
"$PY" "$BC" init "$B" --project-id afb-demo-$(date +%s) --project-name "AFB demo" >/dev/null
"$PY" "$BC" join --path "$B" --kind human alice >/dev/null
"$PY" "$BC" join --path "$B" --kind agent bob >/dev/null
"$PY" "$BC" identity enable --path "$B" >/dev/null
"$PY" "$BC" signing keygen --path "$B" --output "$DEMO/keys/alice.json" --participant alice > "$DEMO/keys/keygen.json"
"$PY" "$BC" signing profile --path "$B" --participant alice --key-file "$DEMO/keys/alice.json" --output "$DEMO/keys/alice-profile.json" > "$DEMO/keys/profile.json"
H=$("$PY" -c "import json;print(json.load(open('$DEMO/keys/profile.json'))['profile'])")
FP=$("$PY" -c "import json;print(json.load(open('$DEMO/keys/keygen.json'))['fingerprint'])")
"$PY" "$BC" identity import alice --path "$B" --profile-file "$DEMO/keys/alice-profile.json" --sha256 "$H" >/dev/null
post() { "$PY" "$BC" post --path "$B" "$@" 2>/dev/null; }
ROOT=$(post --from alice --to all --scope room --room general --thread T001 --new-thread --topic-title "Release plan" --slug release-plan --status REQUEST --body "Release on Friday. Objections?" --signing-key-file "$DEMO/keys/alice.json")
ROOT=$(basename "$ROOT")
post --from bob --to alice --scope room --room general --thread T001 --slug agreed --status REPLY --reply-to "$ROOT" --body "Fine by me." >/dev/null
Q=$(post --from bob --to alice --scope room --room general --thread T001 --slug side-q --status QUESTION --subthread "$ROOT" --reply-to "$ROOT" --body "Side question: do we need a migration dry run?")
post --from alice --to bob --scope room --room general --thread T001 --slug side-a --status REPLY --subthread "$ROOT" --reply-to "$(basename "$Q")" --body "Yes, Thursday on staging." --signing-key-file "$DEMO/keys/alice.json" >/dev/null
post --from bob --to alice --scope direct --thread T002 --new-thread --topic-title "Handoff" --slug handoff --status INFO --body "Direct note: logs are in the usual place." >/dev/null
"$PY" "$BC" validate --path "$B"
cat <<EOF

Demo board: $B
  /agent-file-board open $B
alice's messages show ❓ (key not approved on this device). To approve it, see ✅:
  $PY $BC signing trust --path $B --participant alice --fingerprint $FP --profile $H
EOF
