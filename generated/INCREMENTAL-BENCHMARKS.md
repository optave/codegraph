# Codegraph Incremental Build Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Build tiers: full (cold), no-op (nothing changed), 1-file (single file modified).
Import resolution: native batch vs JS fallback throughput.

| Version | Engine | Files | Full Build | No-op | 1-File | Resolve (native) | Resolve (JS) |
|---------|--------|------:|-----------:|------:|-------:|------------------:|-------------:|
| 2.5.1 | native | 132 | 242ms | 4ms | 106ms | 2ms | 3ms |
| 2.5.1 | wasm | 132 | 835ms | 5ms | 313ms | 2ms | 3ms |

### Latest results

**Version:** 2.5.1 | **Files:** 132 | **Date:** 2026-03-02

#### Native (Rust)

| Metric | Value |
|--------|------:|
| Full build | 242ms |
| No-op rebuild | 4ms |
| 1-file rebuild | 106ms |

#### WASM

| Metric | Value |
|--------|------:|
| Full build | 835ms |
| No-op rebuild | 5ms |
| 1-file rebuild | 313ms |

#### Import Resolution

| Metric | Value |
|--------|------:|
| Import pairs | 139 |
| Native batch | 2ms |
| JS fallback | 3ms |
| Per-import (native) | 0ms |
| Per-import (JS) | 0ms |
| Speedup ratio | 1.1x |

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "2.5.1",
    "date": "2026-03-02",
    "files": 132,
    "wasm": {
      "fullBuildMs": 835,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 313
    },
    "native": {
      "fullBuildMs": 242,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 106
    },
    "resolve": {
      "imports": 139,
      "nativeBatchMs": 2.3,
      "jsFallbackMs": 2.5,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  }
]
-->
