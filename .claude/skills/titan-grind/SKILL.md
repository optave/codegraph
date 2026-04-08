---
name: titan-grind
description: Adopt extracted helpers — find dead symbols from forge, wire them into consumers, replace duplicated inline patterns, and gate on dead-symbol delta (Titan Paradigm Phase 4.5)
argument-hint: <--dry-run> <--phase N> <--yes>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Titan GRIND — Adopt Extracted Helpers

You are running the **GRIND** phase of the Titan Paradigm.

Forge shapes the metal. Grind smooths the rough edges. Your goal: find helpers that forge extracted but never wired into consumers, adopt them across the codebase, and gate on a non-positive dead-symbol delta.

> **Why this phase exists:** Forge decomposes god-functions into smaller helpers, but those helpers are only called within their own file. The dead symbol count inflates with every forge phase because the adoption loop is never closed. Grind closes it.

> **Context budget:** One forge phase per invocation. Process all targets from one forge phase's commits, then stop. User re-runs for the next phase.

**Arguments** (from `$ARGUMENTS`):
- No args → process the next unground forge phase
- `--phase N` → process a specific forge phase
- `--dry-run` → analyze and report without making changes
- `--yes` → skip confirmation prompt (typically passed by `/titan-run` orchestrator)

---

## Step 0 — Pre-flight

1. **Worktree check:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   If not in a worktree, stop: "Run `/worktree` first."

2. **Sync with main:**
   ```bash
   git fetch origin main && git merge origin/main --no-edit
   ```
   If merge conflicts → stop: "Merge conflict detected. Resolve and re-run `/titan-grind`."

3. **Load artifacts.** Read:
   - `.codegraph/titan/titan-state.json` — current state (required)
   - `.codegraph/titan/sync.json` — execution plan (required)
   - `.codegraph/titan/gate-log.ndjson` — gate verdicts (optional)

4. **Validate state.** Grind runs after forge. Check:
   - `titan-state.json → execution` block exists
   - `execution.completedPhases` has at least one entry
   - If no `execution` block → stop: "No forge execution found. Run `/titan-forge` first."

5. **Initialize grind state** (if first run). Add to `titan-state.json`:
   ```json
   {
     "grind": {
       "completedPhases": [],
       "currentPhase": null,
       "adoptions": [],
       "deadSymbolBaseline": null,
       "deadSymbolCurrent": null
     }
   }
   ```

6. **Capture dead-symbol baseline** (if first run):
   ```bash
   codegraph roles --role dead -T --json | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const items=JSON.parse(Buffer.concat(d));console.log(JSON.stringify({total:items.length,byRole:items.reduce((a,i)=>{a[i.role]=(a[i.role]||0)+1;return a},{})}));})"
   ```
   Store the total in `grind.deadSymbolBaseline`.

7. **Determine next phase.** Use `--phase N` if provided, otherwise find the lowest forge phase number not in `grind.completedPhases`.

8. **Print plan and ask for confirmation** (unless `--yes`):
   ```
   GRIND — Phase N: <label>
   Forge made N commits for this phase.
   Dead symbol baseline: <N>
   
   Will: identify new dead symbols, find adoption opportunities, wire helpers into consumers.
   Proceed? [y/n]
   ```

---

## Step 1 — Identify forge's new symbols

For the target forge phase, get the commits from `titan-state.json → execution.commits` that belong to this phase (cross-reference with `sync.json → executionOrder[phase].targets`).

For each commit's changed files:

```bash
codegraph where --file <changed-file> -T --json
```

Collect all symbols defined in files touched by this forge phase. These are the **candidate symbols** — forge created or modified them.

---

## Step 2 — Find dead helpers

Run dead-code detection scoped to the candidate files:

```bash
codegraph roles --role dead -T --file <changed-file> --json
```

For each file touched by forge in this phase, collect symbols flagged as dead. Filter to:
- **Functions** and **constants** only (skip interfaces, parameters, type aliases — these are typically false positives from TypeScript type-level usage)
- **Symbols that are exported** (file-local helpers called within their own file are not dead — they're just private)
- **Symbols NOT in the public API barrel** (`src/index.ts`) unless they have zero external consumers

These are the **grind targets** — helpers forge created that nothing outside their file consumes.

If zero grind targets found → print "Phase N: no dead helpers to adopt. Forge wired everything correctly." Mark phase complete, stop.

---

## Step 3 — Analyze adoption opportunities

For each grind target, determine the adoption strategy:

### 3a. Duplicate-logic scan

Search the codebase for inline code that duplicates what the helper does:

```bash
codegraph context <helper-name> -T --json
```

Read the helper's source to understand its signature and behavior. Then search for the duplicated pattern:

```bash
# Search for the key pattern the helper encapsulates
# Example: if helper is toSymbolRef({ name, kind, file, line }),
# search for inline { name: r.name, kind: r.kind, file: r.file, line: r.line }
```

Use `Grep` with patterns derived from the helper's implementation. Look for:
- Identical multi-line patterns (e.g., object literal mappings)
- Equivalent `.map()` callbacks that the helper could replace
- Hand-rolled loops that duplicate the helper's logic

### 3b. Consumer-wiring scan

Check if the helper should be called by existing code that currently does the same work differently:

```bash
codegraph fn-impact <helper-name> -T --json
```

If the helper wraps a common operation (error construction, AST traversal, data mapping), search for call sites of the underlying operation that could use the wrapper instead.

### 3c. Re-export check

If the helper is in a module with a barrel file (index.ts, mod.rs), check if it needs to be re-exported:

```bash
codegraph exports <barrel-file> -T --json
```

### 3d. Classify the target

For each grind target, assign one of:

| Classification | Action |
|---------------|--------|
| **adopt** | Found N sites where this helper replaces duplicated code. Wire it in. |
| **re-export** | Helper is consumed internally but missing from barrel. Add re-export. |
| **promote** | Helper is file-local but useful elsewhere. Export and wire consumers. |
| **false-positive** | Not actually dead (dynamic import, closure, re-export chain). Skip. |
| **intentionally-private** | Helper is file-local and only used within its file. Remove export or leave as-is. |
| **remove** | Helper is genuinely unused and has no adoption opportunity. Delete it. |

---

## Step 4 — Execute adoptions

For each grind target classified as **adopt**, **re-export**, or **promote**:

1. **Understand before touching.** Run codegraph commands:
   ```bash
   codegraph context <target> -T --json
   codegraph fn-impact <target> -T --json
   ```

2. **Apply the change:**
   - **adopt**: Replace inline duplications with calls to the helper. Add imports at each consumer.
   - **re-export**: Add the symbol to the barrel file's export list.
   - **promote**: Add `export` keyword (or pub visibility in Rust), add to barrel if applicable, then wire consumers as in **adopt**.

3. **Stage changed files:**
   ```bash
   git add <specific changed files>
   ```

4. **Run /titan-gate:**
   Use the Skill tool to invoke `titan-gate`.
   - If FAIL → rollback (same as forge: `git reset HEAD -- $(git diff --cached --name-only) && git checkout -- $(git diff --name-only)`), record failure, continue to next target.

5. **Commit on success:**
   ```bash
   git commit -m "grind(<scope>): adopt <helper> across <N> consumers"
   ```
   Record in `grind.adoptions`:
   ```json
   {
     "target": "<helper-name>",
     "classification": "adopt|re-export|promote",
     "consumers": ["file1.ts", "file2.ts"],
     "commit": "<sha>",
     "phase": N
   }
   ```

For targets classified as **remove**:
1. Delete the symbol
2. Clean up orphaned imports
3. Stage, gate, commit: `grind(<scope>): remove unused <helper>`

For **false-positive** and **intentionally-private**: log them but make no changes. These inform future improvements to codegraph's dead-code detection.

---

## Step 5 — Dead-symbol delta gate

After all targets in the phase are processed:

```bash
codegraph roles --role dead -T --json | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const items=JSON.parse(Buffer.concat(d));console.log(JSON.stringify({total:items.length,byRole:items.reduce((a,i)=>{a[i.role]=(a[i.role]||0)+1;return a},{})}));})"
```

Store in `grind.deadSymbolCurrent`.

Compute delta: `current - baseline`.

| Delta | Verdict |
|-------|---------|
| delta < 0 | **PASS** — grind reduced dead symbols |
| delta == 0 | **PASS** — neutral (all new helpers were adopted or removed) |
| delta > 0, delta <= 10 | **WARN** — slight increase, likely false positives from type-level symbols |
| delta > 10 | **FAIL** — forge created helpers that grind couldn't adopt. Review `grind.adoptions` for missed opportunities |

On FAIL: print the new dead symbols that were not addressed and their files. Do NOT block — log the warning and continue.

---

## Step 6 — Phase completion

1. Add phase number to `grind.completedPhases`
2. Update `grind.deadSymbolBaseline` to `grind.deadSymbolCurrent` (rolling baseline for next phase)
3. Clear `grind.currentPhase`
4. Write updated `titan-state.json`

---

## Step 7 — Report

Print:

```
## Grind Phase N Complete: <label>

Dead symbols: <baseline> → <current> (delta: <+/-N>)
Adoptions: <N> helpers wired into <M> consumers
Removals: <N> unused helpers deleted
False positives: <N> (codegraph resolution bugs)
Intentionally private: <N>
Failed: <N> (gate rejected)

### Adoptions:
- <helper>: adopted by <N> consumers (<classification>)
  Commit: <sha>

### False positives (codegraph bugs to investigate):
- <symbol>: <reason> (dynamic import / re-export chain / closure)

### Next: Phase M — <label> (N grind targets)
Run /titan-grind to continue.
```

If all phases are complete:

```
## All grind phases complete

Dead symbols: <initial baseline> → <final> (total delta: <+/-N>)
Total adoptions: <N> across <M> consumers
Total removals: <N>
Total false positives: <N>

Run /titan-close to finalize.
```

---

## Edge Cases

- **No dead helpers in a phase:** Skip with note. Some forge phases may have wired everything correctly.
- **Helper is used via dynamic import:** Classify as false-positive. Note for codegraph bug tracking.
- **Helper is in Rust, consumers are TypeScript (or vice versa):** Cross-language helpers cannot be adopted across the FFI boundary. Classify as intentionally-private if used within their language, or false-positive if the dead flag is from FFI resolution limits.
- **Gate fails on adoption:** Rollback, record failure, continue. A failed adoption may indicate the helper's semantics don't match the inline pattern exactly.
- **Interrupted mid-phase:** Re-running picks up from remaining unprocessed targets. Already-committed adoptions are skipped.
- **`--dry-run`:** Walk through all targets, classify them, print the adoption plan, but make no changes or commits.

---

## Rules

- **One forge phase per invocation.** Stop after the phase completes. User re-runs for next.
- **Resumable.** If interrupted, re-running picks up where it left off.
- **Always use `--json` and `-T`** for codegraph commands.
- **Gate before commit.** Every commit must pass `/titan-gate`. No exceptions.
- **Stage only specific files.** Never `git add .` or `git add -A`.
- **Never change control flow.** Adoptions must be semantically identical to the code they replace. If the helper does something slightly different from the inline pattern, skip it.
- **Rollback on failure is gentle** — same as forge.
- **Dead-symbol delta is advisory, not blocking.** Some increase from type-level symbols is expected. The gate catches real problems.
- **Log false positives.** These are codegraph bugs. The report feeds back into improving dead-code detection.

## Relationship to Other Skills

| Skill | Relationship |
|-------|-------------|
| `/titan-forge` | Grind runs after forge — processes forge's output |
| `/titan-gate` | Called per-commit for validation (same as forge) |
| `/titan-close` | Runs after grind — includes grind metrics in final report |
| `/titan-sync` | Grind reads sync.json to map commits to phases |

## Self-Improvement

This skill lives at `.claude/skills/titan-grind/SKILL.md`. Edit if adoption strategies need refinement or the dead-symbol delta thresholds need adjustment after dogfooding.
