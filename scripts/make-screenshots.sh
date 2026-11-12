#!/bin/sh
# Regenerates docs/images/*.png from a live Claude Code pane (macOS, needs tmux, freeze).
# Starts a throwaway Claude Code in tmux with only this mod loaded, builds the demo
# board, drives the pane with /agent-file-board commands, crops the pane out of each
# capture (scripts/crop-pane.py) and renders it (scripts/render-shot.sh).
# No model turn is used: slash commands run locally.
#
# Usage: scripts/make-screenshots.sh <agent-file-board repo> <python-with-signing-deps>
set -eu
AFB=${1:?pass the agent-file-board repository}; PY=${2:?pass a Python with requirements-signing.txt}
HERE=$(cd "$(dirname "$0")/.." && pwd -P); cd "$HERE"
B=$HERE/.demo/board; BC=$AFB/boardctl.py; S=afb-screens
scripts/make-demo-board.sh "$AFB" "$PY" > .demo/trust.txt 2>&1
"$PY" "$BC" post --path "$B" --from bob --to all --scope room --room releases --new-room --thread T003 \
  --topic-title "v0.2 checklist" --slug checklist --status REQUEST "--body=Who takes the changelog?" >/dev/null 2>&1
OPTS="{\"boardctl\":\"$BC\",\"python\":\"$PY\",\"refreshSeconds\":5}"
SETTINGS="{\"env\":{\"CLAUDE_CODE_PLUGIN_DIRS\":\"\"},\"pluginConfigs\":{\"agent-file-board@inline\":{\"options\":$OPTS}}}"
tmux kill-session -t $S 2>/dev/null || true
tmux new-session -d -s $S -x 180 -y 34 -c "$AFB" "claude --plugin-dir '$HERE/claude-code' --settings '$SETTINGS'"
trap 'tmux kill-session -t $S 2>/dev/null || true' EXIT
sleep 10
run(){ tmux send-keys -t $S Escape; sleep 0.5; tmux send-keys -t $S "$1"; sleep 0.8; tmux send-keys -t $S Enter; sleep "${2:-4}"; }
shot(){ tmux capture-pane -e -p -t $S | python3 scripts/crop-pane.py > "$HERE/.demo/$1.ansi"
  scripts/render-shot.sh "$HERE/.demo/$1.ansi" "docs/images/$1.png" </dev/null; }
run "/agent-file-board open $B" 6; run "/agent-file-board rooms"; shot rooms
run "/agent-file-board room general"; run "/agent-file-board topic T001" 8
tmux capture-pane -p -t $S | grep -q "❓" || { echo "make-screenshots: expected ❓ before trust" >&2; exit 3; }
shot topic-unapproved
sh -c "$(tail -1 .demo/trust.txt)" >/dev/null
run "/agent-file-board topic T001" 8
tmux capture-pane -p -t $S | grep -q "✅" || { echo "make-screenshots: expected ✅ after trust" >&2; exit 3; }
shot topic-verified
echo "make-screenshots: done"
