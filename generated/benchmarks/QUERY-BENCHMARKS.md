# Codegraph Query Benchmarks

Self-measured on every release by running codegraph queries on its own graph.
Latencies are median over 5 runs. Hub target = most-connected node.

| Version | Engine | fnDeps d1 | fnDeps d3 | fnDeps d5 | fnImpact d1 | fnImpact d3 | fnImpact d5 | diffImpact |
|---------|--------|----------:|----------:|----------:|------------:|------------:|------------:|-----------:|
| 2.5.1 | native | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 5.9ms |
| 2.5.1 | wasm | 0.7 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 5.4ms |

### Latest results

**Version:** 2.5.1 | **Date:** 2026-03-02

#### Native (Rust)

**Targets:** hub=`src/db.js`, mid=`extract_implements_from_node`, leaf=`crates`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 0.6ms |
| fnDeps depth 3 | 0.6ms |
| fnDeps depth 5 | 0.6ms |
| fnImpact depth 1 | 0.6ms |
| fnImpact depth 3 | 0.6ms |
| fnImpact depth 5 | 0.6ms |
| diffImpact latency | 5.9ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

#### WASM

**Targets:** hub=`src/db.js`, mid=`extract_implements_from_node`, leaf=`crates`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 0.7ms |
| fnDeps depth 3 | 0.6ms |
| fnDeps depth 5 | 0.6ms |
| fnImpact depth 1 | 0.6ms |
| fnImpact depth 3 | 0.6ms |
| fnImpact depth 5 | 0.6ms |
| diffImpact latency | 5.4ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

<!-- QUERY_BENCHMARK_DATA
[
  {
    "version": "2.5.1",
    "date": "2026-03-02",
    "wasm": {
      "targets": {
        "hub": "src/db.js",
        "mid": "extract_implements_from_node",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.7,
        "depth3Ms": 0.6,
        "depth5Ms": 0.6
      },
      "fnImpact": {
        "depth1Ms": 0.6,
        "depth3Ms": 0.6,
        "depth5Ms": 0.6
      },
      "diffImpact": {
        "latencyMs": 5.4,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/db.js",
        "mid": "extract_implements_from_node",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.6,
        "depth3Ms": 0.6,
        "depth5Ms": 0.6
      },
      "fnImpact": {
        "depth1Ms": 0.6,
        "depth3Ms": 0.6,
        "depth5Ms": 0.6
      },
      "diffImpact": {
        "latencyMs": 5.9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  }
]
-->
