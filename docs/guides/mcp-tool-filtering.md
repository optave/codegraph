# MCP Tool Filtering

The codegraph MCP server exposes 30+ tools that AI agents can call. Every tool's input schema is sent to the model on the first turn, and large schemas eat tokens that could go toward actual work. This guide shows how to trim the toolset to the slice you actually use.

---

## When to filter

Disable tools when:

- **You're using a small-context model.** Loading 30+ tool schemas can consume thousands of tokens before the model sees a single user message. Cutting the list to the 5–10 you actually call is the easiest single optimization.
- **Your workflow only uses a subset.** A code-review agent may only need `diff_impact`, `fn_impact`, and `context`; a refactor agent may only need `query`, `where`, and `audit`. Hiding the rest reduces noise in tool selection.
- **You want to lock down capabilities.** Disabling `export_graph` or `semantic_search` can keep agents on the rails for narrow tasks.
- **You want consistent behavior across modes.** Tools that are filtered (by config or by single-repo mode) all return the same `Unknown tool: <name>` response, so prompts that handle that response work everywhere.

Don't filter when you don't have a token-budget problem — a missing tool is a silent capability gap. Start permissive, then trim once you've measured.

---

## Configuration

Add `mcp.disabledTools` to your `.codegraphrc.json`:

```json
{
  "mcp": {
    "disabledTools": [
      "execution_flow",
      "sequence",
      "communities",
      "co_changes",
      "code_owners"
    ]
  }
}
```

Reload your MCP client (or restart `codegraph mcp`) for changes to take effect. The list is read once when the server starts.

### Name normalization

Names are matched after the following normalization, applied to both the config entries and the registered tool names:

1. Trim surrounding whitespace.
2. Lowercase.
3. Strip a leading `codegraph<digits>_` prefix (e.g. `codegraph2_module_map` → `module_map`).

This means all of the following entries are equivalent and disable the same tool:

```json
["module_map", "Module_Map", "  module_map  ", "codegraph2_module_map"]
```

The `codegraph<digits>_` prefix exists because some MCP clients namespace tools per-server when multiple servers are connected — copying a tool name straight from the client UI still works.

### Behavior at runtime

- **`tools/list`** — disabled tools do not appear in the response. The model never sees their schemas.
- **`tools/call`** — invoking a disabled tool returns `{ isError: true, content: [{ type: 'text', text: 'Unknown tool: <name>' }] }`. This is the same response a truly unknown tool name produces.
- **`list_repos` in single-repo mode** — `list_repos` is only registered when the server is started with `--multi-repo` or `--repos`. In single-repo mode it is filtered out by default and produces the same `Unknown tool: list_repos` response, regardless of `disabledTools`.

---

## Tool catalog

All tool names below match the values you put in `disabledTools`. Group descriptions are advisory — disable in any combination you like.

### Navigation & lookup

| Tool | Purpose |
|------|---------|
| `query` | Callers/callees with transitive chain, or shortest path between two symbols. |
| `path` | Shortest call path between two symbols. |
| `where` | Locate where a symbol lives. |
| `file_deps` | Per-file dependency listing. |
| `file_exports` | Per-symbol export consumers. |
| `brief` | Short summary of a symbol. |
| `context` | Source + dependencies + callers for a symbol. |
| `symbol_children` | Sub-declarations (parameters, properties, constants). |
| `list_functions` | Enumerate functions in the graph. |

### Impact & change analysis

| Tool | Purpose |
|------|---------|
| `impact_analysis` | Blast radius for a file. |
| `fn_impact` | Blast radius for a function. |
| `diff_impact` | Impact of a diff (staged, branch, or refs). |
| `branch_compare` | Structural diff between two refs. |

### Structure & health

| Tool | Purpose |
|------|---------|
| `module_map` | Most-connected files / module overview. |
| `structure` | Directory tree with cohesion scores. |
| `find_cycles` | Circular dependency detection. |
| `node_roles` | Classify symbols (core, dead, hub, etc.). |
| `complexity` | Per-function complexity metrics. |
| `audit` | Composite report: structure + impact + health. |
| `triage` | Risk-ranked audit priority queue. |
| `check` | CI gate predicates (cycles, complexity, boundaries). |
| `communities` | Louvain community detection. |
| `co_changes` | Files that historically change together. |
| `code_owners` | CODEOWNERS-based ownership queries. |

### Visualization & export

| Tool | Purpose |
|------|---------|
| `export_graph` | Export the graph (DOT, Mermaid, GraphML, Neo4j). |
| `sequence` | Sequence diagram data (BFS traversal). |
| `execution_flow` | Execution flow data for a function. |
| `cfg` | Control-flow graph for a function. |
| `dataflow` | Intraprocedural dataflow analysis. |

### Search & types

| Tool | Purpose |
|------|---------|
| `semantic_search` | Embedding-backed semantic search (requires `codegraph embed`). |
| `ast_query` | Query the raw AST by node kind. |
| `implementations` | Find implementations of an interface/trait. |
| `interfaces` | Find interfaces/traits a class/struct satisfies. |

### Batching

| Tool | Purpose |
|------|---------|
| `batch_query` | Run multiple queries in one call. |

### Multi-repo only

| Tool | Purpose |
|------|---------|
| `list_repos` | List repositories in the registry. Available only when the server is started with `--multi-repo` or `--repos`. |

---

## Recipes

### Minimal "code-review" toolset

Disable everything except impact and context:

```json
{
  "mcp": {
    "disabledTools": [
      "query", "path", "file_deps", "file_exports", "brief",
      "module_map", "structure", "find_cycles", "node_roles",
      "complexity", "audit", "triage", "check",
      "communities", "co_changes", "code_owners",
      "export_graph", "sequence", "execution_flow", "cfg", "dataflow",
      "semantic_search", "ast_query", "implementations", "interfaces",
      "batch_query", "list_functions", "symbol_children", "branch_compare"
    ]
  }
}
```

The remaining tools — `diff_impact`, `fn_impact`, `impact_analysis`, `context`, `where` — give an agent everything it needs to assess a PR.

### Drop the heavy visualizers

If your agent never produces diagrams, the visualization tools are pure schema overhead:

```json
{
  "mcp": {
    "disabledTools": ["export_graph", "sequence", "execution_flow", "cfg", "dataflow"]
  }
}
```

### Drop semantic search if you haven't run `codegraph embed`

`semantic_search` is wired up unconditionally but only works after embeddings have been built. Disabling it removes a tool that would otherwise return errors:

```json
{
  "mcp": {
    "disabledTools": ["semantic_search"]
  }
}
```

---

## Verifying

After editing `.codegraphrc.json`, restart the server and ask the client to refresh its tool list. Then call `tools/list` from your MCP client and confirm the disabled names are absent — that response is the source of truth for what the model will see.

---

## See also

- [`mcp.disabledTools` in the README](../../README.md#mcp-tool-filtering) — short reference.
- [`src/mcp/tool-registry.ts`](../../src/mcp/tool-registry.ts) — source of truth for tool names and schemas.
