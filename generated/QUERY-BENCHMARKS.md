# Codegraph Query Benchmarks

Self-measured on every release by running codegraph queries on its own graph.
Latencies are median over 5 runs. Hub target = most-connected node.

| Version | Engine | fnDeps d1 | fnDeps d3 | fnDeps d5 | fnImpact d1 | fnImpact d3 | fnImpact d5 | diffImpact |
|---------|--------|----------:|----------:|----------:|------------:|------------:|------------:|-----------:|
| 2.5.1 | native | 1.3 | 2.3 | 2.6 | 1.2 | 1.7 | 2 | 8.4ms |
| 2.5.1 | wasm | 1.5 | 2.4 | 2.7 | 1.2 | 1.8 | 2 | 7.6ms |

### Latest results

**Version:** 2.5.1 | **Date:** 2026-03-02

#### Native (Rust)

**Targets:** hub=`buildGraph`, mid=`scan_import_names`, leaf=`crates`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 1.3ms |
| fnDeps depth 3 | 2.3ms |
| fnDeps depth 5 | 2.6ms |
| fnImpact depth 1 | 1.2ms |
| fnImpact depth 3 | 1.7ms |
| fnImpact depth 5 | 2ms |
| diffImpact latency | 8.4ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

#### WASM

**Targets:** hub=`buildGraph`, mid=`scan_import_names`, leaf=`crates`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 1.5ms |
| fnDeps depth 3 | 2.4ms |
| fnDeps depth 5 | 2.7ms |
| fnImpact depth 1 | 1.2ms |
| fnImpact depth 3 | 1.8ms |
| fnImpact depth 5 | 2ms |
| diffImpact latency | 7.6ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

<!-- QUERY_BENCHMARK_DATA
[
  {
    "version": "2.5.1",
    "date": "2026-03-02",
    "wasm": {
      "targets": {
        "hub": "buildGraph",
        "mid": "scan_import_names",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 1.5,
        "depth3Ms": 2.4,
        "depth5Ms": 2.7
      },
      "fnImpact": {
        "depth1Ms": 1.2,
        "depth3Ms": 1.8,
        "depth5Ms": 2
      },
      "diffImpact": {
        "latencyMs": 7.6,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "buildGraph",
        "mid": "scan_import_names",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 1.3,
        "depth3Ms": 2.3,
        "depth5Ms": 2.6
      },
      "fnImpact": {
        "depth1Ms": 1.2,
        "depth3Ms": 1.7,
        "depth5Ms": 2
      },
      "diffImpact": {
        "latencyMs": 8.4,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  }
]
-->
