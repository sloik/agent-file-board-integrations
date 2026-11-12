#!/usr/bin/env node
// SPEC-001 AC2: core/ imports nothing outside core/ (no harness API, no Node,
// no other folder of the mod), so it can move to a shared core/ unchanged.
//
// Usage: node scripts/check-core-purity.mjs            check core/
//        node scripts/check-core-purity.mjs --self-test prove the check can fail
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'core')
const SPEC = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]|\bimport\s*\(/g

/** Returns one problem line per import that leaves core/. */
export function problems(files) {
  const out = []
  for (const [name, text] of files) {
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1] ?? m[2] ?? m[3]
      if (spec === undefined) {
        out.push(`${name}: dynamic import()`)
        continue
      }
      if (!spec.startsWith('./')) {
        out.push(`${name}: imports '${spec}'`)
        continue
      }
      const target = relative(core, resolve(core, dirname(name), spec))
      if (target.startsWith('..')) out.push(`${name}: imports '${spec}' outside core/`)
    }
  }
  return out
}

function coreFiles() {
  return readdirSync(core).filter(n => /\.(ts|tsx|js|mjs)$/.test(n)).map(n => [n, readFileSync(join(core, n), 'utf8')])
}

if (process.argv[2] === '--self-test') {
  const files = coreFiles()
  const clean = problems(files)
  const mutations = [
    "import type { Register } from 'claude-code'\n",
    "import { readFileSync } from 'node:fs'\n",
    "import { x } from '../hooks/register'\n",
  ]
  const missed = mutations.filter(m => problems([...files, ['board.ts', m + files[0][1]]]).length === clean.length)
  if (clean.length || missed.length) {
    console.error('core purity self-test FAILED', { clean, missed })
    process.exit(1)
  }
  console.log(`core purity self-test: all ${mutations.length} mutations detected`)
} else {
  const found = problems(coreFiles())
  if (found.length) {
    console.error(found.join('\n'))
    process.exit(1)
  }
  console.log('core purity: core/ imports only core/')
}
