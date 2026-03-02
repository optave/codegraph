# Codegraph Incremental Build Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Build tiers: full (cold), no-op (nothing changed), 1-file (single file modified).
Import resolution: native batch vs JS fallback throughput.

| Version | Engine | Files | Full Build | No-op | 1-File | Resolve (native) | Resolve (JS) |
|---------|--------|------:|-----------:|------:|-------:|------------------:|-------------:|
| 2.6.0 | native | 146 | 282ms ~ | 4ms ↓33% | 132ms ↑2% | 3ms ~ | 4ms ↑6% |
| 2.6.0 | wasm | 146 | 924ms ↑4% | 5ms ~ | 504ms ↑37% | 3ms ~ | 4ms ↑6% |
| 2.5.1 | native | 142 | 277ms | 6ms | 129ms | 3ms | 3ms |
| 2.5.1 | wasm | 142 | 888ms | 5ms | 368ms | 3ms | 3ms |

### Latest results

**Version:** 2.6.0 | **Files:** 146 | **Date:** 2026-03-02

#### Native (Rust)

| Metric | Value |
|--------|------:|
| Full build | 282ms |
| No-op rebuild | 4ms |
| 1-file rebuild | 132ms |

#### WASM

| Metric | Value |
|--------|------:|
| Full build | 924ms |
| No-op rebuild | 5ms |
| 1-file rebuild | 504ms |

#### Import Resolution

| Metric | Value |
|--------|------:|
| Import pairs | 171 |
| Native batch | 3ms |
| JS fallback | 4ms |
| Per-import (native) | 0ms |
| Per-import (JS) | 0ms |
| Speedup ratio | 1.2x |

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "2.6.0",
    "date": "2026-03-02",
    "files": 146,
    "wasm": {
      "fullBuildMs": 924,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 504
    },
    "native": {
      "fullBuildMs": 282,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 132
    },
    "resolve": {
      "imports": 171,
      "nativeBatchMs": 2.9,
      "jsFallbackMs": 3.6,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "2.5.1",
    "date": "2026-03-02",
    "files": 142,
    "wasm": {
      "fullBuildMs": 888,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 368
    },
    "native": {
      "fullBuildMs": 277,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 129
    },
    "resolve": {
      "imports": 171,
      "nativeBatchMs": 2.9,
      "jsFallbackMs": 3.4,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  }
]
-->
