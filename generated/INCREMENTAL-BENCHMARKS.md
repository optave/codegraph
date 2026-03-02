# Codegraph Incremental Build Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Build tiers: full (cold), no-op (nothing changed), 1-file (single file modified).
Import resolution: native batch vs JS fallback throughput.

| Version | Engine | Files | Full Build | No-op | 1-File | Resolve (native) | Resolve (JS) |
|---------|--------|------:|-----------:|------:|-------:|------------------:|-------------:|
| 2.5.1 | native | 132 | 254ms | 4ms | 107ms | 2ms | 3ms |
| 2.5.1 | wasm | 132 | 844ms | 4ms | 326ms | 2ms | 3ms |

### Latest results

**Version:** 2.5.1 | **Files:** 132 | **Date:** 2026-03-02

#### Native (Rust)

| Metric | Value |
|--------|------:|
| Full build | 254ms |
| No-op rebuild | 4ms |
| 1-file rebuild | 107ms |

#### WASM

| Metric | Value |
|--------|------:|
| Full build | 844ms |
| No-op rebuild | 4ms |
| 1-file rebuild | 326ms |

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
      "fullBuildMs": 844,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 326
    },
    "native": {
      "fullBuildMs": 254,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 107
    },
    "resolve": {
      "imports": 139,
      "nativeBatchMs": 2.2,
      "jsFallbackMs": 2.5,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  }
]
-->
