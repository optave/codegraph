---
name: release
description: Prepare a codegraph release — bump versions, update CHANGELOG, update ROADMAP, create PR
argument-hint: <version e.g. 3.1.1>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# Release v$ARGUMENTS

You are preparing a release for `@optave/codegraph` version **$ARGUMENTS**.

---

## Step 1: Gather context

Run these in parallel:
1. `git log --oneline v<previous-tag>..HEAD` — all commits since the last release tag
2. Read `CHANGELOG.md` (first 80 lines) — understand the format
3. Read `package.json` — current version
4. `git describe --tags --match "v*" --abbrev=0` — find the previous stable release tag

## Step 2: Bump version in package.json

Edit `package.json` to set `"version": "$ARGUMENTS"`.

**Do NOT bump:**
- `crates/codegraph-core/Cargo.toml` — synced automatically by `scripts/sync-native-versions.js` during the publish workflow
- `optionalDependencies` versions — also synced automatically by the same script

Then run `npm install --package-lock-only` to update `package-lock.json`.

## Step 3: Update CHANGELOG.md

Add a new section at the top (below the header) following the existing format:

```
## [X.Y.Z](https://github.com/optave/codegraph/compare/vPREVIOUS...vX.Y.Z) (YYYY-MM-DD)

**One-line summary.** Expanded description of the release highlights.

### Features
* **scope:** description ([#PR](url))

### Bug Fixes
* **scope:** description ([#PR](url))

### Refactors
* description ([#PR](url))

### Chores
* **scope:** description ([#PR](url))
```

Rules:
- Categorize every commit since the last tag (skip docs-only and benchmark-only commits unless they're notable)
- Use the conventional commit scope as the bold prefix
- Link every PR number
- Write a summary line that captures the release theme

## Step 4: Update ROADMAP.md

Read `docs/roadmap/ROADMAP.md` and update:
1. **Version header** — update `Current version: X.Y.Z`
2. **Phase status table** — if any phase moved from Planned to In Progress (or completed), update the status column
3. **Task-level progress** — for any roadmap tasks that have been completed or partially completed by commits in this release:
   - Add a progress note with version and PR links
   - Add checklist items: `- ✅` for done, `- 🔲` for remaining
   - Check actual code exists (glob/grep for new files/directories mentioned in PRs) before marking tasks complete

## Step 5: Check README.md

Grep `README.md` for version references. Only update if there are version-specific references that need bumping (e.g., install commands). Historical milestone markers like "Complete (v3.0.0)" should stay as-is.

## Step 6: Verify package-lock.json

Run `grep` to confirm the new version appears in `package-lock.json` and that all `@optave/codegraph-*` optional dependency entries are complete (have version, resolved, integrity, cpu, os fields). Flag any incomplete entries — they indicate an unpublished platform binary.

## Step 7: Create branch, commit, push, PR

1. Create branch: `git checkout -b release/$ARGUMENTS`
2. Stage only the files you changed: `CHANGELOG.md`, `package.json`, `package-lock.json`, `docs/roadmap/ROADMAP.md`, and `README.md` if changed
3. Commit: `chore: release v$ARGUMENTS`
4. Push: `git push -u origin release/$ARGUMENTS`
5. Create PR:

```
gh pr create --title "chore: release v$ARGUMENTS" --body "$(cat <<'EOF'
## Summary
- Bump version to $ARGUMENTS
- Add CHANGELOG entry for all commits since previous release
- Update ROADMAP progress

## Test plan
- [ ] `npm install` succeeds with updated lock file
- [ ] CHANGELOG renders correctly on GitHub
- [ ] ROADMAP checklist items match actual codebase state
EOF
)"
```

## Important reminders

- **No co-author lines** in commit messages
- **No Claude Code references** in commit messages or PR descriptions
- The publish workflow (`publish.yml`) handles: Cargo.toml version sync, optionalDependencies version sync, npm publishing, git tagging, and the post-publish version bump PR
- If you find issues (incomplete lock entries, phantom packages), fix them in a separate commit with a descriptive message
