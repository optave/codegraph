# Codegraph Query Benchmarks

Self-measured on every release by running codegraph queries on its own graph.
Latencies are median over 5 runs. Hub target = most-connected node.

| Version | Engine | fnDeps d1 | fnDeps d3 | fnDeps d5 | fnImpact d1 | fnImpact d3 | fnImpact d5 | diffImpact |
|---------|--------|----------:|----------:|----------:|------------:|------------:|------------:|-----------:|
| 2.6.0 | native | 1 ↑67% | 1 ↑67% | 1 ↑67% | 0.9 ↑50% | 1 ↑67% | 1 ↑67% | 4.9ms ↓17% |
| 2.6.0 | wasm | 1.1 ↑57% | 1.1 ↑83% | 1.1 ↑83% | 1 ↑67% | 1 ↑67% | 1 ↑67% | 5.5ms ~ |
| 2.5.1 | native | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 5.9ms |
| 2.5.1 | wasm | 0.7 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 5.4ms |

### Latest results

**Version:** 2.6.0 | **Date:** 2026-03-02

#### Native (Rust)

**Targets:** hub=`startMCPServer`, mid=`extract_implements_from_node`, leaf=`crates`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 1ms |
| fnDeps depth 3 | 1ms |
| fnDeps depth 5 | 1ms |
| fnImpact depth 1 | 0.9ms |
| fnImpact depth 3 | 1ms |
| fnImpact depth 5 | 1ms |
| diffImpact latency | 4.9ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

#### WASM

**Targets:** hub=`startMCPServer`, mid=`extract_implements_from_node`, leaf=`crates`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 1.1ms |
| fnDeps depth 3 | 1.1ms |
| fnDeps depth 5 | 1.1ms |
| fnImpact depth 1 | 1ms |
| fnImpact depth 3 | 1ms |
| fnImpact depth 5 | 1ms |
| diffImpact latency | 5.5ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

<!-- QUERY_BENCHMARK_DATA
[
  {
    "version": "2.6.0",
    "date": "2026-03-02",
    "wasm": {
      "targets": {
        "hub": "startMCPServer",
        "mid": "extract_implements_from_node",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 1.1,
        "depth3Ms": 1.1,
        "depth5Ms": 1.1
      },
      "fnImpact": {
        "depth1Ms": 1,
        "depth3Ms": 1,
        "depth5Ms": 1
      },
      "diffImpact": {
        "latencyMs": 5.5,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "startMCPServer",
        "mid": "extract_implements_from_node",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 1,
        "depth3Ms": 1,
        "depth5Ms": 1
      },
      "fnImpact": {
        "depth1Ms": 0.9,
        "depth3Ms": 1,
        "depth5Ms": 1
      },
      "diffImpact": {
        "latencyMs": 4.9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
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
