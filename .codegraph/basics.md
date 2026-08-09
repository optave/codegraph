# Codegraph — ops-codegraph-tool

Codegraph builds a function-level dependency graph of this repo (tree-sitter → SQLite) and answers
structural questions offline. It is set up here. **Prefer it over blind `grep` when orienting in,
modifying, or committing unfamiliar code** — grep finds strings; codegraph finds callers, blast radius,
and cycles.

This repo *is* codegraph, so it dogfoods itself: if a command errors or returns a wrong answer here,
that is a real bug — fix it or file it, never work around it (see `CLAUDE.md`).

## Setup

```bash
npm i -g @optave/codegraph   # once per machine
codegraph build              # from repo root; re-run after pulling
```

Working on the source instead of the published CLI? `npm install && npm run build`, then use
`node dist/cli.js <cmd>` so you exercise your changes rather than the globally-installed release.

The graph lives at `.codegraph/graph.db` — local build output, gitignored. Only this file is committed.
`.codegraphrc.json` excludes `crates/**` (the Rust engine is analysed separately from the TS tree).

## When to use what

| Situation | Command |
|---|---|
| "Where is this symbol?" | `codegraph where <name>` |
| "What does this function touch, and who calls it?" | `codegraph context <name> -T` |
| "What breaks if I change this?" | `codegraph fn-impact <name> -T` |
| "What depends on this file?" | `codegraph impact <file> -T` |
| "What does this file import / export to whom?" | `codegraph deps <file>` · `codegraph exports <file> -T` |
| Before committing | `codegraph diff-impact --staged -T` |
| Getting oriented in a new area | `codegraph brief <file>` · `codegraph structure --depth 2` |
| Understanding a whole subsystem | `codegraph audit --quick <target>` |
| Finding dead code | `codegraph roles --role dead -T` (read the caveat below) |
| Health / hotspots | `codegraph stats` · `codegraph map` · `codegraph triage -T` |

`-T` excludes test files. `-j` emits JSON. Full list: `codegraph --help`.

## This repo

- **Languages:** TypeScript (343 files under `src/`) plus a Rust engine in `crates/`. The graph reports
  34 languages across 1037 files — that spread comes from the per-language parser fixtures under
  `tests/benchmarks/resolution/fixtures/`, not from production source.
- **Size:** 1037 files · 21,770 nodes · 44,877 edges. Full build ≈ 2.5s on the native engine.
- **Entrypoints:** `src/cli.ts` (the `codegraph` bin) and `src/index.ts` (programmatic API).
  Note that `codegraph roles --role entry` also surfaces ~200 hook and script callbacks under
  `docs/examples/` and `scripts/` — those are not real entrypoints.
- **Layout:** `shared/` and `infrastructure/` (cross-cutting) → `db/` → `domain/` (parse, resolve,
  query) → `features/` (composable analyses) → `presentation/` (formatting + CLI wrappers), with
  `graph/` holding the unified model and algorithms. `crates/codegraph-core/` mirrors this tree in
  Rust. See `CLAUDE.md` for the full module table.
- **Most-connected modules** — change these carefully:

  Numbers below are from `codegraph map` (cross-file coupling). Do **not** substitute the fan-out
  column from `codegraph stats`' "coupling hotspots" — the two commands report different metrics under
  similar labels, and the `stats` figure is inflated by intra-file containment. `src/types.ts` shows
  fan-out 1322 there against 1323 symbols declared in the file, which is not cross-file coupling.

  | File | fan-in | fan-out | total |
  |---|---|---|---|
  | `src/db/index.ts` | 138 | 95 | 233 |
  | `src/types.ts` | 229 | 0 | 229 |
  | `src/domain/parser.ts` | 87 | 82 | 169 |
  | `src/domain/graph/builder/pipeline.ts` | 97 | 30 | 127 |
  | `src/domain/graph/builder.ts` | 96 | 9 | 105 |

## Health baseline (as of 2026-08-09, codegraph 3.16.0)

- **Graph quality:** 87/100 · caller coverage 79.1% (4039/5107 functions have ≥1 caller)
- **Cycles:** 2 file-level, 6 function-level. Both file-level cycles are 2-file pairs:
  - `db/repository/native-repository.ts` ↔ `db/connection.ts`
  - `domain/graph/builder/stages/resolve-imports.ts` ↔ `domain/graph/builder/context.ts`
- **Dead symbols:** 809 raw · 647 with `-T`. **Neither number is the real one** — see the caveat below.

Treat these as a baseline, not a target: don't let them grow. `.claude/hooks/pre-commit.sh` already
blocks commits that add cycles or dead exports.

## Gotchas

- **`-T` under-filters this repo — the dead-code count is inflated ~3x.** `-T` matches `.test.`,
  `.spec.`, `__test__`, `__tests__`, and `.stories.`, but *not* a plain `tests/` directory. 431 of the
  647 `-T` symbols are hand-authored parser fixtures under `tests/benchmarks/resolution/fixtures/`,
  which are dead by design. The real figure is closer to **~216**. Tracked in
  [#2256](https://github.com/optave/ops-codegraph-tool/issues/2256) — the predicate is defined in three
  places (`src/infrastructure/test-filter.ts`, `src/db/query-builder.ts`, and the Rust
  `graph/classifiers/roles.rs`) and all three must move together. Until it lands, filter `tests/` out
  yourself before trusting a dead-code number here.
- **The 34-language file count is fixtures, not product code.** Don't read it as scope.
- **Two engines must agree.** `--engine native|wasm|auto` (default `auto`). A divergence between them is
  a bug in the less-accurate engine, never an acceptable gap — see `CLAUDE.md` and `/parity`.
- **Embeddings are not built** by default; `codegraph search` needs `codegraph embed` first.
