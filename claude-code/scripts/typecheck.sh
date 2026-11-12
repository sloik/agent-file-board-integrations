#!/bin/sh
# Type-check the mod (hooks, core, types, tests) against Claude Code's API types.
#
# A fresh checkout has no .claude-plugin/types/ (Claude Code writes it when it loads
# the mod; it is git-ignored). Pass either that folder or the single claude-code.d.ts
# the plugin-authoring skill prints when it loads. A scratch tsconfig is written
# outside the mod folder, as the engine requires.
#
# Usage: scripts/typecheck.sh <types-folder | claude-code.d.ts>
set -eu
TS_VERSION=5.6.3
[ "$#" -ge 1 ] || { echo "typecheck.sh: pass a types folder or claude-code.d.ts" >&2; exit 2; }
MOD_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/afb-mod-typecheck.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT
if [ -f "$1" ]; then
  TYPES_INCLUDE="\"$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")\","; ROOTS=""; NAMES=""
elif [ -f "$1/claude-code/index.d.ts" ]; then
  DIR=$(cd "$1" && pwd -P); TYPES_INCLUDE=""; ROOTS="\"typeRoots\": [\"$DIR\"],"
  NAMES=""; for n in claude-code claude-code-tools claude-code-mcp; do [ -d "$DIR/$n" ] && NAMES="$NAMES${NAMES:+, }\"$n\""; done
else
  echo "typecheck.sh: $1 is neither claude-code.d.ts nor a types folder" >&2; exit 2
fi
cat > "$SCRATCH/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment",
    $ROOTS "types": [$NAMES]
  },
  "include": [$TYPES_INCLUDE "$MOD_DIR/hooks", "$MOD_DIR/core", "$MOD_DIR/types", "$MOD_DIR/tests"]
}
JSON
cd "$SCRATCH" && npx --yes -p "typescript@$TS_VERSION" tsc -p "$SCRATCH/tsconfig.json"
