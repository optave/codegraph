# Proposal: Procedural Knowledge Rules via Codegraph + Session-Graph Bridge

**From:** Carlo ([@optave/codegraph](https://github.com/nicola-dg/codegraph))
**To:** Roberto ([@robertoshimizu/session-graph](https://github.com/robertoshimizu/session-graph))
**Date:** February 2026

---

## Summary

This document proposes a collaboration between **codegraph** and **session-graph** to create a new category of structured knowledge: **procedural rules** encoded as **(when, do, what)** triplets. These rules capture *behavioral guidance* — what an AI agent (or developer) should do in specific situations — and are scoped to concrete code entities (functions, files, modules) via codegraph's dependency graph.

The two projects are natural complements: session-graph excels at extracting and storing knowledge from AI conversations, while codegraph maps the structural reality of a codebase. Together they can bridge the gap between *what we know* and *what we should do*.

---

## The Problem

Today's AI coding assistants operate with two kinds of context:

1. **Structural context** — what functions exist, what calls what, how files depend on each other. Tools like codegraph provide this.
2. **Conversational context** — what was discussed, decided, and learned across coding sessions. Session-graph captures this as (subject, predicate, object) triplets.

What's missing is a third kind: **procedural context** — the accumulated rules, conventions, and lessons learned that tell an agent *how to behave* when working with specific parts of a codebase. This knowledge currently lives in:

- Flat instruction files (CLAUDE.md, .cursorrules, AGENTS.md)
- Developers' heads (tribal knowledge)
- Scattered across past conversations (unstructured)

None of these are queryable, scoped to code entities, or automatically maintained.

---

## The Proposal: (When, Do, What) Triplets

### What they are

A new triplet format that captures conditional, actionable rules:

| Field | Role | Example |
|-------|------|---------|
| **when** | The trigger condition or context | `editing parser.js`, `import resolution fails`, `adding a new language` |
| **do** | The action to take | `ensure`, `fallback to`, `follow the pattern in` |
| **what** | The target or detail of the action | `WASM grammars are not recompiled`, `parent directory lookup`, `parsers/javascript.js` |

### How they differ from session-graph's existing triplets

| | Session-graph (today) | Procedural rules (proposed) |
|---|---|---|
| **Pattern** | (subject, predicate, object) | (when, do, what) |
| **Knowledge type** | Declarative — facts about the world | Procedural — instructions for behavior |
| **Example** | `(FastAPI, uses, Pydantic)` | `(when test times out, do check, what vitest 30s timeout config)` |
| **Answers** | "What is?" / "How are things related?" | "What should I do?" / "What's the rule here?" |
| **Audience** | Understanding and discovery | Action and guidance |

These are not competing formats. They are complementary layers of the same knowledge graph. A procedural rule *references* entities that declarative triplets *describe*.

---

## Why This Matters

### 1. AI agents need scoped, actionable rules

Flat instruction files (CLAUDE.md, etc.) are a blunt instrument. Every instruction applies globally, regardless of what file or function the agent is working on. Procedural rules scoped to specific code entities let an agent ask:

> "I'm about to modify `resolveImport` in `builder.js` — what rules apply here?"

And get back targeted guidance instead of reading an entire instruction document.

### 2. Tribal knowledge becomes queryable

Every project has unwritten rules: "don't touch that function without updating the cache", "this test is flaky — retry before investigating", "always run the migration after changing the schema". These rules are learned through experience and lost when people leave. Extracting them as structured triplets makes them durable and discoverable.

### 3. Rules can generate test scenarios

Each (when, do, what) triplet implies a testable condition:

```
Rule:  (when: circular dependency detected, do: report, what: full cycle path)
Test:  "verify that cycles.js reports the full path when A -> B -> A exists"
```

This creates a natural bridge between knowledge management and quality assurance.

### 4. Cross-project pattern discovery

Session-graph already aggregates knowledge across 600+ sessions and multiple platforms. Adding procedural rules to that corpus enables questions like:

- "What common rules apply across all Python projects?"
- "What debugging patterns recur when working with tree-sitter?"
- "Which rules have been violated most often in recent sessions?"

---

## Architecture: Why Separate, How Connected

### Why the rule system should not live entirely in either project

| Putting it all in session-graph | Putting it all in codegraph |
|---|---|
| Would require tree-sitter parsing and code dependency resolution — outside session-graph's scope | Would require LLM extraction pipelines and RDF/SPARQL storage — outside codegraph's scope |
| No way to scope rules to actual code entities without duplicating codegraph's work | No way to extract rules from conversations without duplicating session-graph's work |
| Session-graph stays focused on conversation knowledge | Codegraph stays focused on code structure |

### The three-layer architecture

```
┌─────────────────────┐                          ┌─────────────────────┐
│    session-graph     │                          │      codegraph      │
│                      │    procedural rules      │                     │
│  - Extracts rules    │    (when, do, what)      │  - Maps functions,  │
│    from AI sessions  │ ───────────────────────► │    files, deps      │
│  - Stores as RDF     │                          │  - Attaches rules   │
│  - Queries via       │ ◄─────────────────────── │    to graph nodes   │
│    SPARQL            │   "what code entities    │  - Serves scoped    │
│                      │    exist in this file?"  │    rules to agents  │
└──────────┬──────────┘                          └──────────┬──────────┘
           │                                                │
           │              ┌──────────────┐                  │
           └─────────────►│    bridge     │◄────────────────┘
                          │              │
                          │  - Protocol   │
                          │    contract   │
                          │  - Hooks /    │
                          │    optional   │
                          │    adapters   │
                          └──────────────┘
```

**Session-graph** owns:
- Extracting (when, do, what) triplets from conversation history using its LLM pipeline
- Storing them in its RDF triplestore alongside existing declarative triplets
- Exposing them via SPARQL for querying

**Codegraph** owns:
- Mapping the code's structural reality (symbols, functions, dependencies, call graphs)
- Receiving rules and scoping them to specific graph nodes (functions, files, modules)
- Serving scoped rules to AI agents via its CLI or MCP interface

**The bridge** is a thin contract between the two:
- A shared schema for rule exchange (JSON-LD, simple JSON, or direct SPARQL)
- Optional hooks so either tool can call the other
- No hard dependency — both projects work fully standalone without the bridge

### Example hook interactions

```bash
# Codegraph asks session-graph: "what rules apply to this symbol?"
# (via SPARQL endpoint or exported file)
curl "http://localhost:3030/kg/sparql" \
  --data-urlencode "query=
    SELECT ?when ?do ?what WHERE {
      ?rule a :ProceduralRule ;
            :appliesTo 'resolveImport' ;
            :when ?when ;
            :do ?do ;
            :what ?what .
    }"

# Session-graph asks codegraph: "what symbols exist in this file?"
# (via CLI or MCP)
codegraph query --file src/builder.js --format json
```

---

## Benefits for Each Project

### For session-graph

- **New knowledge category** — procedural rules extend the graph's expressiveness beyond declarative facts, making the knowledge base more complete and actionable
- **Higher-value output** — rules that tell agents what to *do* are immediately useful, increasing adoption and practical impact
- **Natural fit** — the LLM extraction pipeline already processes assistant messages; extending the predicate vocabulary to include procedural predicates (`whenCondition`, `doAction`, `whatTarget`) is incremental work
- **Differentiation** — no other conversation-to-knowledge tool produces scoped, actionable rules

### For codegraph

- **Richer graph annotations** — code structure plus behavioral rules is more useful than structure alone
- **New MCP capabilities** — AI agents querying codegraph can receive not just "what calls what" but "what to watch out for when modifying this"
- **Complements existing instruction files** — rules extracted from real sessions are more specific and numerous than hand-written CLAUDE.md instructions
- **No added complexity in core** — codegraph only needs to consume rules, not extract or store them in RDF

### For the broader AI-assisted development ecosystem

- **Structured alternative to flat instruction files** — moves beyond CLAUDE.md / .cursorrules toward queryable, scoped guidance
- **Knowledge that improves with use** — every coding session potentially generates new rules, creating a flywheel
- **Open and interoperable** — RDF/SPARQL is a standard; any tool can produce or consume these rules

---

## Concrete Next Steps

### Phase 1: Define the schema

Agree on the procedural rule triplet schema. Proposed RDF predicates to add to session-graph's ontology:

```turtle
:ProceduralRule a owl:Class .
:whenCondition  a owl:DatatypeProperty ; rdfs:domain :ProceduralRule .
:doAction       a owl:DatatypeProperty ; rdfs:domain :ProceduralRule .
:whatTarget     a owl:DatatypeProperty ; rdfs:domain :ProceduralRule .
:appliesTo      a owl:ObjectProperty   ; rdfs:domain :ProceduralRule ;
                                         rdfs:range  :CodeEntity .
:confidence     a owl:DatatypeProperty ; rdfs:domain :ProceduralRule ;
                                         rdfs:range  xsd:float .
:sourceSession  a owl:ObjectProperty   ; rdfs:domain :ProceduralRule .
```

### Phase 2: Extraction (session-graph side)

Extend session-graph's LLM extraction to identify procedural rules in assistant messages. Many already exist implicitly:

> "When you modify the parser, make sure to run the WASM build step first."

Becomes:

```turtle
:rule_042 a :ProceduralRule ;
    :whenCondition "modifying the parser" ;
    :doAction "run first" ;
    :whatTarget "WASM build step" ;
    :appliesTo :parser_module ;
    :sourceSession :session_287 .
```

### Phase 3: Consumption (codegraph side)

Add an optional `rules` command or MCP tool to codegraph that:
- Reads rules from a SPARQL endpoint or JSON export
- Matches `appliesTo` references to codegraph's symbol/file nodes
- Returns scoped rules when querying a specific function or file

### Phase 4: Bridge and hooks

Formalize the hook contract so the two tools can optionally call each other. This could start as simple as a shared JSON file and evolve into live API calls.

---

## Open Questions

1. **Extraction prompt design** — what prompt template best identifies procedural rules in conversation history? This likely needs experimentation with session-graph's existing pipeline.
2. **Entity resolution** — how do we match a rule's `appliesTo` field (a natural language reference like "the parser") to codegraph's concrete symbols (`parser.js:extractFunctions`)? Session-graph's Wikidata linking approach may inform this.
3. **Rule lifecycle** — how do we detect and retire stale rules when code changes? Codegraph's incremental hash tracking could signal when rules need revalidation.
4. **Granularity** — should rules attach at file level, function level, or both? Codegraph supports both, but extraction accuracy may vary.

---

## Closing

Session-graph turns conversations into knowledge. Codegraph turns code into structure. Procedural rules — (when, do, what) — are the missing bridge that turns both into *actionable guidance* for AI agents working on real codebases.

The proposed architecture keeps both projects focused on what they do best, connected by a thin protocol that either side can adopt incrementally. No hard dependencies, no scope creep — just a shared format that multiplies the value of both tools.

I'd welcome your thoughts on the schema, the extraction approach, and whether this aligns with where you see session-graph heading.

---

*This proposal is a starting point for discussion, not a final specification.*
