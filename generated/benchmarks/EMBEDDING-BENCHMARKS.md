# Codegraph Embedding Benchmarks

Self-measured on every release using auto-generated queries from symbol names.
Each symbol's name is split into words (e.g. `buildGraph` → `"build graph"`) and used as the search query.
Hit@N = expected symbol found in top N results.

| Version | Model | Symbols | Hit@1 | Hit@3 | Hit@5 | Misses | Embed Time |
|---------|-------|--------:|------:|------:|------:|-------:|-----------:|

### Latest results

**Version:** 3.3.0 | **Strategy:** structured | **Symbols:** 0 | **Date:** 2026-03-19

| Model | Dim | Context | Hit@1 | Hit@3 | Hit@5 | Hit@10 | Misses | Embed | Search |
|-------|----:|--------:|------:|------:|------:|-------:|-------:|------:|-------:|

<!-- EMBEDDING_BENCHMARK_DATA
[
  {
    "version": "3.3.0",
    "date": "2026-03-19",
    "strategy": "structured",
    "symbols": 0,
    "models": {}
  },
  {
    "version": "3.1.4",
    "date": "2026-03-16",
    "strategy": "structured",
    "symbols": 1095,
    "models": {}
  }
]
-->
