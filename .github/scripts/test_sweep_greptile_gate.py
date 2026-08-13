"""Shell-tier CI test for the /sweep Greptile re-trigger gate (PR #930 false negative).

Runs THE ACTUAL gate embedded in `.claude/skills/sweep/SKILL.md` (single-source; no
copy) against a corpus of scenarios, driving it with a stub `gh` on PATH. If the gate
in SKILL.md changes, this test runs the changed code.

## What it pins

The gate skips the mandatory `@greptileai` re-trigger only when Greptile is verifiably
satisfied with the CURRENT head. Condition (4) — "has Greptile reviewed this head?" —
used to be answered with a timestamp proxy (`commits[-1].committedDate > trigger
created_at`). That proxy has a reproducible FALSE NEGATIVE, because Greptile re-reviews
by editing its sticky summary comment IN PLACE: no new comment, no new `created_at`, so
a completed re-review is invisible to timestamps.

Observed on PR #930 (2026-08-10), reproduced verbatim in SCENARIOS below:

    trigger  5237591525  2026-08-10T08:11:42Z   (+1 from greptile-apps[bot])
    commit   51ae6c23    2026-08-10T08:14:51Z   <- committedDate AFTER the trigger
    summary  "Reviews (8): Last reviewed commit: .../commit/51ae6c23..."  <- == head

The proxy read "commit newer than trigger" -> stale -> posted `@greptileai` again, which
produced review #9 of a commit Greptile had already scored 5/5. The fix prefers Greptile's
own `Last reviewed commit` marker and falls back to the proxy only when it can't parse it.

`test_mutation_*` are the load-bearing tests: they mutate the gate back to the pre-fix
behaviour and assert the #930 scenario FLIPS to posting. Without them, the regression
assertion could pass with and against the bug it names.

Run: python -m pytest .github/scripts/test_sweep_greptile_gate.py
 or: cd .github/scripts && python3 test_sweep_greptile_gate.py   (stdlib runner below)

Requires `jq` (the stub `gh` evaluates the gate's real `--jq` filters with it, so a broken
filter fails the test instead of being mocked away). Pre-installed on GitHub-hosted runners.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# Where this file sits decides where the skill sits:
#   a seeded repo   .github/scripts/                        -> <root>/.claude/skills/sweep/SKILL.md
#   the kit itself  repo-foundry/templates/github/scripts/  -> repo-foundry/templates/claude/skills/sweep/SKILL.md
# The kit ships this test as a template AND runs it in place, for the same reason
# test_section_ref_lint.py is run in place: these tests are the kit's only regression guard
# on the template it ships, so a template that rots would otherwise fail silently.
_SKILL_CANDIDATES = (
    REPO / ".claude" / "skills" / "sweep" / "SKILL.md",
    REPO / "claude" / "skills" / "sweep" / "SKILL.md",
)
SKILL = next((p for p in _SKILL_CANDIDATES if p.is_file()), _SKILL_CANDIDATES[0])

# Sentinel identifying the gate's fenced bash block inside SKILL.md.
GATE_SENTINEL = "# === Greptile re-trigger gate (shared by Step 2g and Step 2i) ==="
# Load-bearing marker on the SHA extractor the fix introduces. The mutation tests locate
# the extractor by this marker, so moving/renaming it fails loudly instead of silently
# turning the mutation into a no-op (which would make the mutation "pass" for free).
EXTRACTOR_MARKER = "# inline-sweep GREPTILE-LAST-REVIEWED extractor [#930]"

PR = "930"
# `<number>` and `<repo>` are the two placeholders SKILL.md tells the agent to substitute, so
# substituting them here is exactly what a real run does. `<repo>` must be filled even though the
# stub `gh` ignores it: left in place, bash reads `--repo <repo>` as a redirect from a file named
# `repo` and the gate dies before reaching condition (4). Copies that already carry a real slug
# (this one does) are unaffected — the replace is then a no-op. Kept so every fleet copy of this
# test is identical, and so the repo-foundry template (which does carry `<repo>`) can run it.
REPO_SLUG = "optave/data-retrieval-storage-svc"
# The kit parameterises the reviewer handle; installed copies carry the literal. Substituting
# it here is, like `<repo>` above, exactly what an install does — and a no-op in any copy that
# already carries the literal, so every fleet copy of this test stays identical.
REVIEWER_BOT_TOKEN = "{{REVIEWER_BOT}}"
REVIEWER_BOT = "@greptileai"
HEAD = "51ae6c237998c0472a7cfeec1be75cb020e3c4a5"
OTHER = "7a2c4067b1c9e4d2a8f60513be7cc1a94d2e8f01"
TRIGGER_ID = 5237591525
TRIGGER_TS = "2026-08-10T08:11:42Z"
SUMMARY_ID = 5230439302  # < TRIGGER_ID, so it is not an "after the trigger" comment
BOT = "greptile-apps[bot]"

# A push that lands AFTER the trigger — what makes the old timestamp proxy cry "stale".
COMMIT_AFTER_TRIGGER = "2026-08-10T08:14:51Z"
COMMIT_BEFORE_TRIGGER = "2026-08-10T08:00:00Z"


def _summary_body(sha: str | None, reviews: int = 8) -> str:
    """Greptile's sticky summary. `sha=None` omits the footer marker entirely."""
    body = (
        "### Greptile Summary\n\n"
        "Confidence Score: 5/5\n\n"
        "No blocking failure remains; the change is scoped and documented.\n\n"
        "<!-- greptile_other_comments_section -->\n\n"
    )
    if sha is None:
        return (
            body
            + "<sub>[Re-trigger Greptile](https://app.greptile.com/api/retrigger?id=51550856)</sub>"
        )
    # Byte-for-byte the shape observed on #930, including the HTML-escaped subject and the
    # second, NON-commit link after the marker (which a greedy `.*` must not swallow past).
    return body + (
        f"<sub>Reviews ({reviews}): Last reviewed commit: "
        f"[&quot;docs(skills): cut fake edges...&quot;]"
        f"(https://github.com/optave/data-retrieval-storage-svc/commit/{sha}) | "
        f"[Re-trigger Greptile](https://app.greptile.com/api/retrigger?id=51550856)</sub>"
    )


def _fixture(
    *,
    marker_sha: str | None = HEAD,
    head: str = HEAD,
    commit_ts: str = COMMIT_AFTER_TRIGGER,
    trigger_reaction: bool = True,
    reply_reaction: bool = False,
    inline_after_trigger: bool = False,
    include_trigger: bool = True,
    fail: list[str] | None = None,
) -> dict:
    issue_comments = [
        {
            "id": SUMMARY_ID,
            "user": {"login": BOT},
            "created_at": "2026-08-09T07:49:31Z",
            "body": _summary_body(marker_sha),
        }
    ]
    if include_trigger:
        issue_comments.append(
            {
                "id": TRIGGER_ID,
                "user": {"login": "carlos-alm"},
                "created_at": TRIGGER_TS,
                "body": "@greptileai",
            }
        )
    inline_comments = [
        # A Greptile inline finding from BEFORE the trigger — must not count for condition (3).
        {
            "id": 3743075822,
            "user": {"login": BOT},
            "created_at": "2026-08-09T07:49:35Z",
            "in_reply_to_id": None,
            "body": "nit: stale wording",
        }
    ]
    if inline_after_trigger:
        inline_comments.append(
            {
                "id": 3799000001,
                "user": {"login": BOT},
                "created_at": "2026-08-10T08:20:00Z",
                "in_reply_to_id": None,
                "body": "new finding on the current head",
            }
        )
    reactions: dict[str, list] = {str(TRIGGER_ID): [], "3743075822": []}
    if trigger_reaction:
        reactions[str(TRIGGER_ID)] = [{"user": {"login": BOT}, "content": "+1"}]
    if reply_reaction:
        # A 👍 on one of OUR replies. Never a satisfied signal — the rule this fix must not weaken.
        issue_comments.append(
            {
                "id": 5237600000,
                "user": {"login": "carlos-alm"},
                "created_at": "2026-08-10T08:12:00Z",
                "body": "Addressed in 51ae6c2.",
            }
        )
        reactions["5237600000"] = [{"user": {"login": BOT}, "content": "+1"}]
    return {
        "headRefOid": head,
        "commits": [{"oid": head, "committedDate": commit_ts}],
        "issue_comments": issue_comments,
        "inline_comments": inline_comments,
        "reactions": reactions,
        "fail": fail or [],
    }


# The stub `gh`. Serves fixture JSON through the REAL `jq`, so the gate's own `--jq`
# filters are exercised rather than mocked. Records every comment POST it is asked to make.
GH_STUB = r"""#!/usr/bin/env python3
import json, os, re, subprocess, sys

fx = json.load(open(os.environ["GH_STUB_FIXTURE"]))
argv = sys.argv[1:]

def jq(filt, payload):
    if filt is None:
        print(json.dumps(payload))
        return 0
    p = subprocess.run(["jq", "-r", filt], input=json.dumps(payload),
                       capture_output=True, text=True)
    sys.stdout.write(p.stdout)
    sys.stderr.write(p.stderr)
    return p.returncode

def opt(names):
    for n in names:
        if n in argv:
            i = argv.index(n)
            if i + 1 < len(argv):
                return argv[i + 1]
    return None

filt = opt(["--jq", "-q"])

def fail_if(key):
    if key in fx["fail"]:
        sys.exit(1)

if argv[0] == "pr" and argv[1] == "view":
    which = opt(["--json"])
    if which == "headRefOid":
        fail_if("headRefOid")
        sys.exit(jq(filt, {"headRefOid": fx["headRefOid"]}))
    if which == "commits":
        fail_if("commits")
        sys.exit(jq(filt, {"commits": fx["commits"]}))
    sys.exit(1)

if argv[0] == "api" and len(argv) > 1 and argv[1] == "graphql":
    # `gh api graphql -f query='...'` — the GraphQL pushedDate lookup some fleet copies use as
    # their timestamp FALLBACK instead of `gh pr view --json commits`. Must be matched BEFORE the
    # `-f` POST branch below: the query rides in on `-f query=`, so the POST branch would swallow
    # it and record the query text as a posted comment body. Serve it from the same fixture the
    # `commits` path uses, with a null pushedDate so the gate's `(.pushedDate // .committedDate)`
    # resolves to the scenario's commit timestamp. Inert in copies that never call graphql, which
    # keeps this file byte-identical across the fleet.
    fail_if("commits")
    sys.exit(jq(filt, {"data": {"repository": {"pullRequest": {"commits": {"nodes": [
        {"commit": {"committedDate": fx["commits"][-1]["committedDate"], "pushedDate": None}}
    ]}}}}}))

if argv[0] == "api":
    url = next(a for a in argv[1:] if not a.startswith("-"))
    # A POST: `gh api <url> -f body=@greptileai`
    if "-f" in argv:
        body = opt(["-f"])
        with open(os.environ["GH_STUB_POSTS"], "a") as fh:
            fh.write(body + "\n")
        print('{"id": 1}')
        sys.exit(0)
    if re.search(r"/issues/comments/(\d+)/reactions$", url):
        fail_if("reactions")
        cid = re.search(r"/issues/comments/(\d+)/reactions$", url).group(1)
        sys.exit(jq(filt, fx["reactions"].get(cid, [])))
    if re.search(r"/issues/\d+/comments$", url):
        fail_if("issue_comments")
        sys.exit(jq(filt, fx["issue_comments"]))
    if re.search(r"/pulls/\d+/comments$", url):
        fail_if("inline_comments")
        sys.exit(jq(filt, fx["inline_comments"]))
    sys.exit(1)

sys.exit(1)
"""


def _gate_source() -> str:
    """Pull the ACTUAL gate out of .claude/skills/sweep/SKILL.md.

    Single-source: if the gate in SKILL.md changes, this test runs the changed code.
    The gate is the one ```bash fence carrying GATE_SENTINEL; `<number>` is the
    placeholder SKILL.md tells the agent to substitute, so substituting it here is
    exactly what a real run does.
    """
    text = SKILL.read_text("utf-8")
    blocks = re.findall(r"```bash\n(.*?)```", text, re.S)
    gates = [b for b in blocks if GATE_SENTINEL in b]
    assert len(gates) == 1, (
        f"expected exactly one bash fence carrying the gate sentinel, got {len(gates)}"
    )
    return (
        gates[0]
        .replace("<number>", PR)
        .replace("<repo>", REPO_SLUG)
        .replace(REVIEWER_BOT_TOKEN, REVIEWER_BOT)
    )


def _shells() -> list[str]:
    """Shells to run the gate under.

    bash is CI's shell; zsh is the maintainers' interactive session shell, and a /sweep guard
    in a sibling repo once SILENTLY PASSED under zsh while failing its job (it iterated an
    unquoted parameter, which zsh does not word-split). A gate that is only ever proven under
    bash is not proven for the shell it actually runs in, so both are required when present.
    Set REQUIRE_SHELLS=1 to turn a missing shell into a failure instead of a skip.
    """
    found = [s for s in ("bash", "zsh") if shutil.which(s)]
    missing = [s for s in ("bash", "zsh") if not shutil.which(s)]
    if missing and os.environ.get("REQUIRE_SHELLS") == "1":
        raise AssertionError(f"REQUIRE_SHELLS=1 but these shells are absent: {missing}")
    assert "bash" in found, "bash is required to run the gate"
    return found


def _run_gate(
    fixture: dict, source: str | None = None, shell: str = "bash"
) -> tuple[str, list[str]]:
    """Run the gate under `shell` with a stub `gh` on PATH. Returns (stdout, posted bodies)."""
    if shutil.which("jq") is None:
        raise AssertionError("this test needs `jq` to evaluate the gate's real --jq filters")
    src = _gate_source() if source is None else source
    with tempfile.TemporaryDirectory() as td:
        td_p = Path(td)
        bindir = td_p / "bin"
        bindir.mkdir()
        gh = bindir / "gh"
        gh.write_text(GH_STUB, "utf-8")
        gh.chmod(0o755)
        (td_p / "fixture.json").write_text(json.dumps(fixture), "utf-8")
        posts = td_p / "posts.txt"
        posts.write_text("", "utf-8")
        script = td_p / "gate.sh"
        script.write_text(src, "utf-8")
        env = {
            **os.environ,
            "PATH": f"{bindir}:{os.environ['PATH']}",
            "GH_STUB_FIXTURE": str(td_p / "fixture.json"),
            "GH_STUB_POSTS": str(posts),
        }
        proc = subprocess.run([shell, str(script)], capture_output=True, text=True, env=env)
        assert proc.returncode == 0, (
            f"gate exited {proc.returncode} under {shell}\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
        posted = [ln for ln in posts.read_text("utf-8").splitlines() if ln.strip()]
        return proc.stdout, posted


# (name, fixture kwargs, expect_post, why)
SCENARIOS = [
    # ── THE #930 REGRESSION ────────────────────────────────────────────────────────────
    # Greptile's marker names the exact head, it reacted +1 to the trigger, and it posted
    # nothing since — yet a commit's committedDate post-dates the trigger. The old proxy
    # posted here. It must now skip.
    (
        "marker_matches_head_regression",
        {},
        False,
        "marker names the current head — satisfied despite a newer committedDate",
    ),
    # Case-insensitivity: a SHA is a SHA. A case mismatch must not resurface the bug.
    (
        "marker_matches_head_uppercase",
        {"marker_sha": HEAD.upper()},
        False,
        "marker matches the head case-insensitively",
    ),
    # ── DIRECT EVIDENCE THE OTHER WAY ──────────────────────────────────────────────────
    (
        "marker_names_other_commit",
        {"marker_sha": OTHER},
        True,
        "Greptile's last review names a different commit — it has not seen this head",
    ),
    # ── FALLBACK PRESERVED (marker unparsable) ─────────────────────────────────────────
    (
        "no_marker_commit_after_trigger",
        {"marker_sha": None},
        True,
        "no marker -> timestamp proxy -> commit newer than trigger -> stale",
    ),
    (
        "no_marker_commit_before_trigger",
        {"marker_sha": None, "commit_ts": COMMIT_BEFORE_TRIGGER},
        False,
        "no marker -> timestamp proxy -> nothing pushed since -> satisfied (pre-existing)",
    ),
    # ── FAIL-SAFE ──────────────────────────────────────────────────────────────────────
    (
        "head_sha_fetch_fails",
        {"fail": ["headRefOid"]},
        True,
        "cannot fetch the head -> post rather than assume satisfied",
    ),
    (
        "marker_fetch_fails_and_commits_fetch_fails",
        {"fail": ["commits"], "marker_sha": None},
        True,
        "no marker and no commit time -> post (fail safe)",
    ),
    # ── THE OTHER THREE CONDITIONS MUST STILL BITE ─────────────────────────────────────
    (
        "no_trigger_comment_at_all",
        {"include_trigger": False},
        True,
        "condition (1): no trigger has ever reflected this PR",
    ),
    (
        "reaction_only_on_our_reply",
        {"trigger_reaction": False, "reply_reaction": True},
        True,
        "condition (2): a 👍 on OUR reply is never satisfaction — only one on the trigger counts",
    ),
    (
        "greptile_commented_after_trigger",
        {"inline_after_trigger": True},
        True,
        "condition (3): a new inline finding outranks a matching marker",
    ),
]


def test_gate_scenarios():
    for shell in _shells():
        for name, kwargs, expect_post, why in SCENARIOS:
            out, posted = _run_gate(_fixture(**kwargs), shell=shell)
            got_post = len(posted) > 0
            assert got_post == expect_post, (
                f"[{shell}/{name}] expected {'POST' if expect_post else 'SKIP'}, got "
                f"{'POST' if got_post else 'SKIP'} — {why}\ngate said: {out.strip()}"
            )
            if got_post:
                assert posted == ["body=@greptileai"], (
                    f"[{shell}/{name}] unexpected post payload {posted!r}"
                )


def test_regression_skip_cites_the_marker_not_the_proxy():
    """The #930 case must be decided BY THE MARKER. A skip reached via the timestamp
    proxy would be the right answer for the wrong reason and would not survive a real
    push, so pin the basis the gate reports."""
    out, posted = _run_gate(_fixture())
    assert not posted
    assert "basis" not in out, f"a satisfied gate should not report a not-satisfied basis: {out}"
    assert "head reviewed per marker" in out, (
        f"expected the marker to be the deciding basis, got: {out}"
    )
    assert HEAD in out, f"expected the satisfied head SHA in the message, got: {out}"


def test_fallback_skip_cites_the_proxy():
    out, posted = _run_gate(_fixture(marker_sha=None, commit_ts=COMMIT_BEFORE_TRIGGER))
    assert not posted
    assert "head reviewed per timestamp-proxy" in out, f"expected the proxy basis, got: {out}"


# ── Mutation tests ────────────────────────────────────────────────────────────────────
# The scenario table above is only meaningful if `marker_matches_head_regression` actually
# depends on the fix. These mutate the gate back to pre-fix behaviour and require it to fail.


def _mutate_extractor(replacement: str) -> str:
    """Replace the marker-SHA extractor (located by its load-bearing marker) in the real gate."""
    src = _gate_source()
    assert EXTRACTOR_MARKER in src, f"extractor marker missing from the gate: {EXTRACTOR_MARKER!r}"
    # The extractor runs from its marker line to the end of the `reviewed_shas=$(...)` pipeline.
    pattern = re.compile(
        re.escape(EXTRACTOR_MARKER) + r"\n\s*reviewed_shas=\$\(.*?tr 'A-Z' 'a-z'\)\n",
        re.S,
    )
    mutated, n = pattern.subn(replacement, src)
    assert n == 1, f"expected to mutate exactly one extractor, matched {n}"
    return mutated


def test_mutation_removing_the_marker_lookup_reintroduces_the_930_bug():
    """Pre-fix behaviour: with no marker SHA the gate falls back to the committedDate proxy,
    which is byte-identical to the code that shipped the bug. The #930 scenario must POST."""
    mutated = _mutate_extractor('  reviewed_shas=""\n')
    out, posted = _run_gate(_fixture(), source=mutated)
    assert posted == ["body=@greptileai"], (
        "MUTATION NOT DETECTED: with the marker lookup removed, the #930 scenario still "
        f"skipped the re-trigger — the regression assertion is not load-bearing. "
        f"Gate said: {out.strip()}"
    )
    assert "basis=timestamp-proxy" in out, (
        f"expected the mutant to fall back to the proxy, got: {out}"
    )


def test_mutation_breaking_the_sha_regex_reintroduces_the_930_bug():
    """A subtler mutant: keep the extractor but make its SHA pattern wrong. It must not
    silently still pass — the extractor's precision is part of the fix."""
    broken = _gate_source()
    assert broken.count(r"[0-9a-fA-F]\{40\}") == 2, "expected two 40-hex patterns in the extractor"
    mutated = broken.replace(r"[0-9a-fA-F]\{40\}", r"[0-9a-fA-F]\{41\}")
    out, posted = _run_gate(_fixture(), source=mutated)
    assert posted == ["body=@greptileai"], (
        "MUTATION NOT DETECTED: a broken SHA pattern still produced a satisfied gate — the "
        f"extractor is not actually being exercised. Gate said: {out.strip()}"
    )


def test_mutation_ignoring_a_marker_mismatch_is_caught():
    """The inverse guard: a mutant that treats ANY marker as satisfaction (dropping the
    equality check) must be caught by the `marker_names_other_commit` scenario."""
    src = _gate_source()
    old = (
        '  if [ -n "$reviewed_shas" ] && printf \'%s\\n\' "$reviewed_shas"'
        ' | grep -qx "$head_sha"; then'
    )
    assert old in src, "could not locate the marker/head equality check to mutate"
    mutated = src.replace(old, '  if [ -n "$reviewed_shas" ]; then')
    # The mutant accepts ANY marker as satisfaction, so it SKIPS where the real gate POSTs.
    # Seeing the mutant skip is what proves `marker_names_other_commit`'s POST is produced by
    # the equality check and not by some other condition incidentally failing.
    out, posted = _run_gate(_fixture(marker_sha=OTHER), source=mutated)
    assert posted == [], (
        "MUTATION NOT DETECTED: dropping the marker==head equality check still produced a "
        f"re-trigger, so `marker_names_other_commit` passes for some other reason and is not "
        f"load-bearing. Gate said: {out.strip()}"
    )


TESTS = [
    test_gate_scenarios,
    test_regression_skip_cites_the_marker_not_the_proxy,
    test_fallback_skip_cites_the_proxy,
    test_mutation_removing_the_marker_lookup_reintroduces_the_930_bug,
    test_mutation_breaking_the_sha_regex_reintroduces_the_930_bug,
    test_mutation_ignoring_a_marker_mismatch_is_caught,
]


if __name__ == "__main__":
    failures = 0
    for t in TESTS:
        try:
            t()
        except AssertionError as exc:  # report every failure, don't stop at the first
            failures += 1
            print(f"FAIL {t.__name__}: {exc}", file=sys.stderr)
        else:
            print(f"ok   {t.__name__}")
    print(f"\n{len(TESTS) - failures}/{len(TESTS)} passed")
    sys.exit(1 if failures else 0)
