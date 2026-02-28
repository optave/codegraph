# Codegraph Performance Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Metrics are normalized per file for cross-version comparability.

| Version | Engine | Date | Files | Build (ms/file) | Query (ms) | Nodes/file | Edges/file | DB (bytes/file) |
|---------|--------|------|------:|----------------:|-----------:|-----------:|-----------:|----------------:|
| 2.4.0 | native | 2026-02-28 | 122 | 2.1 ↑11% | 2.5 ↑67% | 6.5 ↑12% | 11 ↑21% | 5573 ↑45% |
| 2.4.0 | wasm | 2026-02-28 | 122 | 9.2 ↑39% | 3.6 ↑71% | 6.5 ↑12% | 11 ↑21% | 5573 ↑45% |
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
| Build time | 250ms |
| Query time | 3ms |
| Nodes | 790 |
| Edges | 1,348 |
| DB size | 664 KB |
| Files | 122 |

#### WASM

| Metric | Value |
|--------|-------|
| Build time | 1.1s |
| Query time | 4ms |
| Nodes | 790 |
| Edges | 1,348 |
| DB size | 664 KB |
| Files | 122 |

### Build Phase Breakdown (latest)

| Phase | Native | WASM |
|-------|-------:|-----:|
| Parse | 138.4 ms | 735.2 ms |
| Insert nodes | 13.4 ms | 19.7 ms |
| Resolve imports | 9.7 ms | 13.5 ms |
| Build edges | 58.9 ms | 61.6 ms |
| Structure | 4 ms | 7.6 ms |
| Roles | 4.9 ms | 5.3 ms |
| Complexity | 5.2 ms | 246.8 ms |

### Estimated performance at 50,000 files

Extrapolated linearly from per-file metrics above.

| Metric | Native (Rust) | WASM |
|--------|---:|---:|
| Build time | 105.0s | 460.0s |
| DB size | 265.7 MB | 265.7 MB |
| Nodes | 325,000 | 325,000 |
| Edges | 550,000 | 550,000 |

### Incremental Rebuilds

| Version | Engine | No-op (ms) | 1-file (ms) |
|---------|--------|----------:|-----------:|
| 2.4.0 | native | 4 | 100 |
| 2.4.0 | wasm | 5 | 324 |

### Query Latency

| Version | Engine | fn-deps (ms) | fn-impact (ms) | path (ms) | roles (ms) |
|---------|--------|------------:|--------------:|----------:|----------:|
| 2.4.0 | native | 2.2 | 1.6 | 1.2 | 1.2 |
| 2.4.0 | wasm | 2.2 | 1.6 | 1.3 | 1.2 |

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
    "date": "2026-02-28",
    "files": 122,
    "wasm": {
      "buildTimeMs": 1121,
      "queryTimeMs": 3.6,
      "nodes": 790,
      "edges": 1348,
      "dbSizeBytes": 679936,
      "perFile": {
        "buildTimeMs": 9.2,
        "nodes": 6.5,
        "edges": 11,
        "dbSizeBytes": 5573
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 324,
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 1.6,
        "pathMs": 1.3,
        "rolesMs": 1.2
      },
      "phases": {
        "parseMs": 735.2,
        "insertMs": 19.7,
        "resolveMs": 13.5,
        "edgesMs": 61.6,
        "structureMs": 7.6,
        "rolesMs": 5.3,
        "complexityMs": 246.8
      }
    },
    "native": {
      "buildTimeMs": 250,
      "queryTimeMs": 2.5,
      "nodes": 790,
      "edges": 1348,
      "dbSizeBytes": 679936,
      "perFile": {
        "buildTimeMs": 2.1,
        "nodes": 6.5,
        "edges": 11,
        "dbSizeBytes": 5573
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 100,
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 1.6,
        "pathMs": 1.2,
        "rolesMs": 1.2
      },
      "phases": {
        "parseMs": 138.4,
        "insertMs": 13.4,
        "resolveMs": 9.7,
        "edgesMs": 58.9,
        "structureMs": 4,
        "rolesMs": 4.9,
        "complexityMs": 5.2
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
