# Codegraph Performance Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Metrics are normalized per file for cross-version comparability.

| Version | Engine | Date | Files | Build (ms/file) | Query (ms) | Nodes/file | Edges/file | DB (bytes/file) |
|---------|--------|------|------:|----------------:|-----------:|-----------:|-----------:|----------------:|
| 2.4.0 | native | 2026-02-27 | 122 | 1.8 ↓5% | 2.4 ↑60% | 6.4 ↑10% | 10.9 ↑20% | 5238 ↑36% |
| 2.4.0 | wasm | 2026-02-27 | 122 | 9.7 ↑47% | 3.4 ↑62% | 6.4 ↑10% | 10.9 ↑20% | 5506 ↑43% |
| 2.3.0 | native | 2026-02-24 | 99 | 1.9 ~ | 1.5 ↑7% | 5.8 ↑7% | 9.1 ~ | 3848 ~ |
| 2.3.0 | wasm | 2026-02-24 | 99 | 6.6 ~ | 2.1 ↑11% | 5.8 ~ | 9.1 ↑3% | 3848 ~ |
| 2.1.0 | native | 2026-02-23 | 92 | 1.9 ↓24% | 1.4 ↑17% | 5.4 ↑6% | 9.1 ↓47% | 3829 ↓14% |
| 2.1.0 | wasm | 2026-02-23 | 92 | 6.6 ↑32% | 1.9 ↑19% | 5.7 ↑12% | 8.8 ↓46% | 3829 ↓12% |
| 2.0.0 | native | 2026-02-23 | 89 | 2.5 | 1.2 | 5.1 | 17.2 | 4464 |
| 2.0.0 | wasm | 2026-02-23 | 89 | 5 | 1.6 | 5.1 | 16.2 | 4372 |

### Raw totals (latest)

#### Native (Rust)

| Metric | Value |
|--------|-------|
| Build time | 223ms |
| Query time | 2ms |
| Nodes | 778 |
| Edges | 1,333 |
| DB size | 624 KB |
| Files | 122 |

#### WASM

| Metric | Value |
|--------|-------|
| Build time | 1.2s |
| Query time | 3ms |
| Nodes | 778 |
| Edges | 1,333 |
| DB size | 656 KB |
| Files | 122 |

### Build Phase Breakdown (latest)

| Phase | Native | WASM |
|-------|-------:|-----:|
| Parse | 115.2 ms | 684.7 ms |
| Insert nodes | 14.8 ms | 15.1 ms |
| Resolve imports | 9.5 ms | 13.3 ms |
| Build edges | 56.1 ms | 70.6 ms |
| Structure | 4.1 ms | 7.3 ms |
| Roles | 5.3 ms | 5.1 ms |
| Complexity | 4.8 ms | 368 ms |

### Estimated performance at 50,000 files

Extrapolated linearly from per-file metrics above.

| Metric | Native (Rust) | WASM |
|--------|---:|---:|
| Build time | 90.0s | 485.0s |
| DB size | 249.8 MB | 262.5 MB |
| Nodes | 320,000 | 320,000 |
| Edges | 545,000 | 545,000 |

### Incremental Rebuilds

| Version | Engine | No-op (ms) | 1-file (ms) |
|---------|--------|----------:|-----------:|
| 2.4.0 | native | 4 | 87 |
| 2.4.0 | wasm | 4 | 364 |

### Query Latency

| Version | Engine | fn-deps (ms) | fn-impact (ms) | path (ms) | roles (ms) |
|---------|--------|------------:|--------------:|----------:|----------:|
| 2.4.0 | native | 2.2 | 1.6 | 1.2 | 1.1 |
| 2.4.0 | wasm | 2.2 | 1.6 | 1.2 | 1.1 |

<!-- NOTES_START -->
### Notes

**WASM regression (v2.0.0 → v2.1.0, ↑32% — persists in v2.3.0):** The
"v2.1.0" entry was measured after the v2.1.0 tag on main, when `package.json`
still read "2.1.0" but the codebase already included post-release features:
receiver field extraction (`b08c2b2`) and Commander/Express callback extraction
(`2ac24ef`). Both added WASM-to-JS boundary crossings on every
`call_expression` AST node. The native engine was unaffected because its Rust
extractors have zero boundary overhead — and it gained a net 24% speedup from
the ~45% edge reduction introduced by scoped call-resolution fallback
(`3a11191`). For WASM the extra crossings outweighed the edge savings. A
targeted fix in `d4ef6da` gated `extractCallbackDefinition` behind a
`member_expression` type check and eliminated redundant `childForFieldName`
calls, but the v2.3.0 CI benchmark confirms this was **insufficient** — WASM
remains at 6.6 ms/file (vs 5.0 in v2.0.0). The WASM/Native ratio widened from
2.0x to 3.5x. Further optimization of WASM boundary crossings in the JS
extractor is needed to recover the regression.
<!-- NOTES_END -->

<!-- BENCHMARK_DATA
[
  {
    "version": "2.4.0",
    "date": "2026-02-27",
    "files": 122,
    "wasm": {
      "buildTimeMs": 1189,
      "queryTimeMs": 3.4,
      "nodes": 778,
      "edges": 1333,
      "dbSizeBytes": 671744,
      "perFile": {
        "buildTimeMs": 9.7,
        "nodes": 6.4,
        "edges": 10.9,
        "dbSizeBytes": 5506
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 364,
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 1.6,
        "pathMs": 1.2,
        "rolesMs": 1.1
      },
      "phases": {
        "parseMs": 684.7,
        "insertMs": 15.1,
        "resolveMs": 13.3,
        "edgesMs": 70.6,
        "structureMs": 7.3,
        "rolesMs": 5.1,
        "complexityMs": 368
      }
    },
    "native": {
      "buildTimeMs": 223,
      "queryTimeMs": 2.4,
      "nodes": 778,
      "edges": 1333,
      "dbSizeBytes": 638976,
      "perFile": {
        "buildTimeMs": 1.8,
        "nodes": 6.4,
        "edges": 10.9,
        "dbSizeBytes": 5238
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 87,
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 1.6,
        "pathMs": 1.2,
        "rolesMs": 1.1
      },
      "phases": {
        "parseMs": 115.2,
        "insertMs": 14.8,
        "resolveMs": 9.5,
        "edgesMs": 56.1,
        "structureMs": 4.1,
        "rolesMs": 5.3,
        "complexityMs": 4.8
      }
    }
  },
  {
    "version": "2.3.0",
    "date": "2026-02-24",
    "files": 99,
    "wasm": {
      "buildTimeMs": 649,
      "queryTimeMs": 2.1,
      "nodes": 575,
      "edges": 897,
      "dbSizeBytes": 380928,
      "perFile": {
        "buildTimeMs": 6.6,
        "nodes": 5.8,
        "edges": 9.1,
        "dbSizeBytes": 3848
      }
    },
    "native": {
      "buildTimeMs": 183,
      "queryTimeMs": 1.5,
      "nodes": 575,
      "edges": 897,
      "dbSizeBytes": 380928,
      "perFile": {
        "buildTimeMs": 1.9,
        "nodes": 5.8,
        "edges": 9.1,
        "dbSizeBytes": 3848
      }
    }
  },
  {
    "version": "2.1.0",
    "date": "2026-02-23",
    "files": 92,
    "wasm": {
      "buildTimeMs": 609,
      "queryTimeMs": 1.9,
      "nodes": 527,
      "edges": 814,
      "dbSizeBytes": 352256,
      "perFile": {
        "buildTimeMs": 6.6,
        "nodes": 5.7,
        "edges": 8.8,
        "dbSizeBytes": 3829
      }
    },
    "native": {
      "buildTimeMs": 172,
      "queryTimeMs": 1.4,
      "nodes": 500,
      "edges": 839,
      "dbSizeBytes": 352256,
      "perFile": {
        "buildTimeMs": 1.9,
        "nodes": 5.4,
        "edges": 9.1,
        "dbSizeBytes": 3829
      }
    }
  },
  {
    "version": "2.0.0",
    "date": "2026-02-23",
    "files": 89,
    "wasm": {
      "buildTimeMs": 444,
      "queryTimeMs": 1.6,
      "nodes": 451,
      "edges": 1442,
      "dbSizeBytes": 389120,
      "perFile": {
        "buildTimeMs": 5,
        "nodes": 5.1,
        "edges": 16.2,
        "dbSizeBytes": 4372
      }
    },
    "native": {
      "buildTimeMs": 226,
      "queryTimeMs": 1.2,
      "nodes": 451,
      "edges": 1534,
      "dbSizeBytes": 397312,
      "perFile": {
        "buildTimeMs": 2.5,
        "nodes": 5.1,
        "edges": 17.2,
        "dbSizeBytes": 4464
      }
    }
  }
]
-->
