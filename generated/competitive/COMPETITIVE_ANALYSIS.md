# Competitive Analysis — Code Graph / Code Intelligence Tools

**Date:** 2026-08-09 (updated from 2026-08-08)
**Scope:** 140+ code analysis tools evaluated, 89+ ranked against `@optave/codegraph`

> **2026-08-09 refresh:** every star count in this document was re-pulled from the GitHub API today, and a **Last PR** column (days since the most recently *merged* pull request) was added to every ranking table — see the caveat below the Tier 1 table. The Community dimension (1 of 6 scoring axes) was recomputed for all 39 Tier 1 entries using an explicit, stars-anchored band (see Scoring criteria) instead of ad hoc per-project judgment, so the same rule that lowers our own score also raises several competitors'. Net result: **codegraph moves from tied-#4 (4.5) to #6 (4.33)** — four tools now score higher. Features/Depth/Deploy/Lang/Quality were re-verified only for the six tools already covered in the README's quick-comparison table (see `### vs …` sections below); the other 33 Tier 1 entries and all Tier 2/3 entries keep their prior holistic scores on those five axes. Full reasoning in PR history.

---

## Overall Ranking

Ranked by weighted score across 6 dimensions (each 1–5):

### Tier 1: Direct Competitors (score ≥ 3.0)

| # | Score | Project | Stars | Last PR | Lang | License | Summary |
|---|-------|---------|-------|---------|------|---------|---------|
| 1 | 4.5 | [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus) | 45,206 | 0d ago | TS/JS | PolyForm NC | Zero-server knowledge graph engine with Graph RAG Agent, CLI + MCP + Web UI, tree-sitter native + WASM, LadybugDB (custom graph DB), multi-editor support (Claude Code hooks, Cursor, Codex, Windsurf, OpenCode), auto-generated AGENTS.md/CLAUDE.md. **Non-commercial license. Viral growth (18k stars in ~8 months)** |
| 2 | 4.5 | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 38,234 | 0d ago | C | MIT | Single static C binary, 64 languages (tree-sitter), 14 MCP tools, Cypher-like query language, persistent SQLite knowledge graph, 10-agent auto-installer, 3D graph visualization, HTTP route analysis. **25 days old — fastest-growing new entrant** |
| 3 | 4.5 | [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) | 29,491 | 9d ago | Python | MIT | 40+ languages incl. notebooks/Ansible/SFC/SQL, tree-sitter AST + SQLite, MCP + CLI, GraphML/Neo4j/Obsidian/SVG export, `fail-on-risk` CI gate, dead code detection, SHA-256 incremental (<2.5s on 3k files). Grew 4,309 → 29,491 stars (6.8x), 2,700 forks. Co-change mode currently returns 0 predictions per its own README (2026-08-02) |
| 4 | 4.5 | [postrv/narsil-mcp](https://github.com/postrv/narsil-mcp) | 180 | 197d ago | Rust | Apache-2.0 | 90 MCP tools, 32 languages, taint analysis, SBOM, dead code, neural semantic search, single ~30MB binary, SPA web frontend (added v1.6.0, current v1.6.1) |
| 5 | 4.33 | [joernio/joern](https://github.com/joernio/joern) | 3,401 | 1d ago | Scala | Apache-2.0 | Full CPG analysis platform for vulnerability discovery, Scala query DSL, multi-language, daily releases (v4.0.508), 75 contributors |
| **6** | **4.33** | **[@optave/codegraph](https://github.com/optave/ops-codegraph-tool)** | **86** | **0d ago** | **JS/Rust** | **Apache-2.0** | **Sub-second incremental rebuilds (3-tier change detection), dual engine (native Rust + WASM), 34 languages, 34-tool MCP, 41 CLI commands, qualified call resolution with receiver type tracking, `context`/`audit`/`where` AI-optimized commands, dataflow + CFG + interprocedural dataflow + stored AST across all languages, sequence diagrams, structure/hotspot analysis, node role classification, dead code/export detection, architecture boundary enforcement, zero-cost core + optional LLM enhancement. 86 stars — smallest community of any Tier 1 entrant; competes on depth, not popularity** |
| 7 | 4.17 | [Fraunhofer-AISEC/cpg](https://github.com/Fraunhofer-AISEC/cpg) | 453 | 1d ago | Kotlin | Apache-2.0 | CPG library for 8+ languages with MCP module, Neo4j visualization, formal specs, LLVM IR support |
| 8 | 4.17 | [Anandb71/arbor](https://github.com/Anandb71/arbor) | 151 | 6d ago | Rust | MIT | Native GUI, confidence scoring, architectural role classification, fuzzy search, MCP |
| 9 | 4.0 | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | 65,489 | 1d ago | TypeScript | MIT | Rewrote core in Rust; self-contained binary (no Node.js required), OS-native file-watcher gives real O(changed) incremental rebuilds, ~33 languages, 9 agent-client integrations (Claude Code, Cursor, Codex, opencode, Gemini, Antigravity, Kiro, GitHub Copilot, Hermes), signed/attested npm releases. Grew 308 → 65,489 stars (212x), 4,120 forks. Unrelated tool that shares our name |
| 10 | 4.0 | [vitali87/code-graph-rag](https://github.com/vitali87/code-graph-rag) | 2,632 | 0d ago | Python | MIT | Graph RAG with Memgraph, multi-provider AI, code editing, semantic search, MCP server (added 2026) |
| 11 | 4.0 | [seatedro/glimpse](https://github.com/seatedro/glimpse) | 360 | 220d ago | Rust | MIT | Clipboard-first codebase-to-LLM tool with call graphs, token counting, LSP resolution. **Stagnant since Jan 2026** |
| 12 | 4.0 | [SimplyLiz/CodeMCP (CKB)](https://github.com/SimplyLiz/CodeMCP) | 109 | 11d ago | Go | Custom | SCIP-based indexing, compound operations (83% token savings), CODEOWNERS, secret scanning, impact analysis, architecture mapping (v8.1.0) |
| 13 | 3.83 | [Jakedismo/codegraph-rust](https://github.com/Jakedismo/codegraph-rust) | 861 | 232d ago | Rust | None | 100% Rust GraphRAG, SurrealDB, LSP-powered dataflow analysis, architecture boundary enforcement |
| 14 | 3.83 | [harshkedia177/axon](https://github.com/harshkedia177/axon) | 729 | 136d ago | Python | MIT | 11-phase pipeline, KuzuDB, Leiden community detection, dead code, change coupling, MCP + CLI, hit v1.0 milestone |
| 15 | 3.83 | [ShiftLeftSecurity/codepropertygraph](https://github.com/ShiftLeftSecurity/codepropertygraph) | 592 | 17d ago | Scala | Apache-2.0 | CPG specification + Tinkergraph library, Scala query DSL, protobuf serialization (Joern foundation) |
| 16 | 3.67 | [CodeGraphContext/CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | 4,056 | 0d ago | Python | MIT | Tree-sitter + graph DB (KuzuDB/FalkorDB/Neo4j), 14 languages, CLI + MCP dual mode, interactive HTML viz, pre-indexed `.cgc` bundle registry for popular repos, setup wizard for 10+ IDEs, live file watching. **Grew 2,664 → 4,056 stars, 30 contributors — likely Hacktoberfest-boosted community** |
| 17 | 3.67 | [cs-au-dk/jelly](https://github.com/cs-au-dk/jelly) | 434 | 89d ago | TypeScript | BSD-3 | Academic-grade JS/TS points-to analysis, call graphs, vulnerability exposure, 5 published papers |
| 18 | 3.67 | [Lekssays/codebadger](https://github.com/Lekssays/codebadger) | 151 | 24d ago | Python | GPL-3.0 | Containerized MCP server using Joern CPG, 12+ languages |
| 19 | 3.67 | [er77/code-graph-rag-mcp](https://github.com/er77/code-graph-rag-mcp) | 121 | ARCHIVED | TypeScript | MIT | 26 MCP methods, 11 languages, tree-sitter, semantic search, hotspot analysis, clone detection |
| 20 | 3.67 | [anrgct/autodev-codebase](https://github.com/anrgct/autodev-codebase) | 120 | n/a | TypeScript | None | 40+ languages, 7 embedding providers, Cytoscape.js visualization, LLM reranking. **Stagnant since Jan 2026** |
| 21 | 3.67 | [dundalek/stratify](https://github.com/dundalek/stratify) | 111 | n/a | Clojure | MIT | Multi-backend extraction (LSP/SCIP/Joern), 10 languages, DGML/CodeCharta output, architecture linting |
| 22 | 3.67 | [entrepeneur4lyf/code-graph-mcp](https://github.com/entrepeneur4lyf/code-graph-mcp) | 88 | n/a | Python | MIT | ast-grep for 25+ languages, complexity metrics, code smells, circular dependency detection. **Stagnant since Jul 2025** |
| 23 | 3.67 | [kraklabs/cie](https://github.com/kraklabs/cie) | 17 | 175d ago | Go | AGPL-3.0 | Code Intelligence Engine: 20+ MCP tools, tree-sitter, semantic search (Ollama), Homebrew, single Go binary |
| 24 | 3.67 | [nahisaho/CodeGraphMCPServer](https://github.com/nahisaho/CodeGraphMCPServer) | 12 | n/a | Python | MIT | GraphRAG with Louvain community detection, 16 languages, 14 MCP tools, 334 tests |
| 25 | 3.5 | [DucPhamNgoc08/CodeVisualizer](https://github.com/DucPhamNgoc08/CodeVisualizer) | 657 | 100d ago | TypeScript | MIT | VS Code extension, tree-sitter WASM, flowcharts + dependency graphs, 5 AI providers, 9 themes |
| 26 | 3.5 | [JudiniLabs/mcp-code-graph](https://github.com/JudiniLabs/mcp-code-graph) | 402 | 408d ago | JavaScript | MIT | Cloud-hosted MCP server by CodeGPT, semantic search, dependency links (requires account) |
| 27 | 3.5 | [MikeRecognex/mcp-codebase-index](https://github.com/MikeRecognex/mcp-codebase-index) | 61 | n/a | Python | AGPL-3.0 | 18 MCP tools, zero runtime deps, auto-incremental reindexing via git diff |
| 28 | 3.5 | [NeuralRays/codexray](https://github.com/NeuralRays/codexray) | 7 | n/a | TypeScript | MIT | 16 MCP tools, TF-IDF semantic search (~50MB), dead code, complexity, path finding |
| 29 | 3.33 | [helabenkhalfallah/code-health-meter](https://github.com/helabenkhalfallah/code-health-meter) | 38 | n/a | JavaScript | MIT | Formal health metrics (MI, CC, Louvain modularity), published in ACM TOSEM 2025 |
| 30 | 3.33 | [JohT/code-graph-analysis-pipeline](https://github.com/JohT/code-graph-analysis-pipeline) | 34 | 6d ago | Cypher | GPL-3.0 | 200+ CSV reports, ML anomaly detection, Leiden/HashGNN, jQAssistant + Neo4j for Java |
| 31 | 3.33 | [Vasu014/loregrep](https://github.com/Vasu014/loregrep) | 13 | 17d ago | Rust | Apache-2.0 | In-memory index library, Rust + Python bindings, AI-tool-ready schemas |
| 32 | 3.17 | [Technologicat/pyan](https://github.com/Technologicat/pyan) | 444 | 41d ago | Python | GPL-2.0 | Python 3 call graph generator, module import analysis, cycle detection, interactive HTML |
| 33 | 3.17 | [Durafen/Claude-code-memory](https://github.com/Durafen/Claude-code-memory) | 75 | n/a | Python | None | Memory Guard quality gate, persistent codebase memory, Voyage AI + Qdrant |
| 34 | 3.17 | [anasdayeh/claude-context-local](https://github.com/anasdayeh/claude-context-local) | 0 | n/a | Python | None | 100% local, Merkle DAG incremental indexing, sharded FAISS, hybrid BM25+vector, GPU accel |
| 35 | 3.0 | [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | 12,339 | 26d ago | TypeScript | MIT | MCP semantic code search: hybrid BM25 + dense-vector retrieval via Milvus, AST-aware chunking for 10 languages (text-splitter fallback for the rest), Merkle-DAG incremental re-indexing, VS Code extension + 10 agent-client integrations. Backed by Zilliz (Milvus), Trendshift-featured. **Requires an external Milvus vector DB (self-hosted via Docker Compose, or Zilliz Cloud) plus a separate embedding provider; a fully local, keyless path exists (local Milvus + local Ollama) but is two services to operate. Read-only semantic retrieval, no call graph or structural analysis** |
| 36 | 3.0 | [Adrninistrator/java-all-call-graph](https://github.com/Adrninistrator/java-all-call-graph) | 570 | n/a | Java | Apache-2.0 | Complete Java bytecode call graphs, Spring/MyBatis-aware, SQL-queryable DB |
| 37 | 3.0 | [clouditor/cloud-property-graph](https://github.com/clouditor/cloud-property-graph) | 30 | 1118d ago | Kotlin | Apache-2.0 | Connects code property graphs with cloud runtime security assessment |
| 38 | 3.0 | [al1-nasir/codegraph-cli](https://github.com/al1-nasir/codegraph-cli) | 26 | 122d ago | Python | MIT | CrewAI multi-agent system, 6 LLM providers, browser explorer, DOCX export |

### Tier 2: Niche & Single-Language Tools (score 2.0–2.9)

| # | Score | Project | Stars | Last PR | Lang | License | Summary |
|---|-------|---------|-------|---------|------|---------|---------|
| 39 | 2.9 | [rahulvgmail/CodeInteliMCP](https://github.com/rahulvgmail/CodeInteliMCP) | 8 | n/a | Python | None | DuckDB + ChromaDB (zero Docker), multi-repo, lightweight embedded DBs |
| 40 | 2.83 | [xnuinside/codegraph](https://github.com/xnuinside/codegraph) | 496 | 123d ago | Python | MIT | Python-only interactive HTML dependency diagrams with zoom/pan/search **Demoted from Tier 1 — Community score dropped under the refreshed star-band rubric (496 stars)** |
| 41 | 2.8 | [Aider-AI/aider](https://github.com/Aider-AI/aider) | 48,066 | 78d ago | Python | Apache-2.0 | AI pair programming CLI; tree-sitter repo map with PageRank-style graph ranking for LLM context selection, 100+ languages, multi-provider LLM support, git-integrated auto-commits. Moved to Aider-AI org |
| 42 | 2.8 | [scottrogowski/code2flow](https://github.com/scottrogowski/code2flow) | 4,601 | 1308d ago | Python | MIT | Call graphs for Python/JS/Ruby/PHP via AST, DOT output, 100% test coverage |
| 43 | 2.8 | [ysk8hori/typescript-graph](https://github.com/ysk8hori/typescript-graph) | 212 | 93d ago | TypeScript | None | TypeScript file-level dependency Mermaid diagrams, code metrics (MI, CC), watch mode |
| 44 | 2.8 | [nuanced-dev/nuanced-py](https://github.com/nuanced-dev/nuanced-py) | 128 | ARCHIVED | Python | MIT | Python call graph enrichment designed for AI agent consumption |
| 45 | 2.8 | [ChrisRoyse/CodeGraph](https://github.com/ChrisRoyse/CodeGraph) | 85 | n/a | TypeScript | None | Neo4j + MCP, multi-language, framework detection (React, Tailwind, Supabase) |
| 46 | 2.8 | [sdsrss/code-graph-mcp](https://github.com/sdsrss/code-graph-mcp) | 61 | 9d ago | TypeScript | MIT | AST knowledge graph MCP server with tree-sitter, 10 languages. New entrant |
| 47 | 2.8 | [Symbolk/Code2Graph](https://github.com/Symbolk/Code2Graph) | 49 | 1235d ago | Java | None | Multilingual code → language-agnostic graph representation |
| 48 | 2.8 | [Bikach/codeGraph](https://github.com/Bikach/codeGraph) | 9 | 10d ago | TypeScript | MIT | Neo4j graph, Claude Code slash commands, Kotlin support, 40-50% cost reduction |
| 49 | 2.7 | [davidfraser/pyan](https://github.com/davidfraser/pyan) | 711 | ARCHIVED | Python | GPL-2.0 | Python call graph generator (stable fork), DOT/SVG/HTML output, Sphinx integration |
| 50 | 2.7 | [mamuz/PhpDependencyAnalysis](https://github.com/mamuz/PhpDependencyAnalysis) | 576 | 2613d ago | PHP | MIT | PHP dependency graphs, cycle detection, architecture verification against defined layers |
| 51 | 2.7 | [faraazahmad/graphsense](https://github.com/faraazahmad/graphsense) | 35 | 334d ago | TypeScript | MIT | MCP server providing code intelligence via static analysis |
| 52 | 2.7 | [JonnoC/CodeRAG](https://github.com/JonnoC/CodeRAG) | 27 | n/a | TypeScript | MIT | Enterprise code intelligence with CK metrics, Neo4j, 23 analysis tools, MCP server |
| 53 | 2.7 | [yumeiriowl/repo-graphrag-mcp](https://github.com/yumeiriowl/repo-graphrag-mcp) | 7 | n/a | Python | MIT | LightRAG + tree-sitter, entity merge (code ↔ docs), implementation planning tool |
| 54 | 2.6 | [0xjcf/MCP_CodeAnalysis](https://github.com/0xjcf/MCP_CodeAnalysis) | 7 | n/a | Python/TS | None | Stateful tools (XState), Redis sessions, socio-technical analysis, dual language impl |
| 55 | 2.5 | [koknat/callGraph](https://github.com/koknat/callGraph) | 339 | 1051d ago | Perl | GPL-3.0 | Multi-language (22+) call graph generator via regex, GraphViz output |
| 56 | 2.5 | [league1991/CodeAtlasVsix](https://github.com/league1991/CodeAtlasVsix) | 266 | n/a | C# | GPL-2.0 | Visual Studio plugin, Doxygen-based call graph navigation (VS 2010-2015 era) |
| 57 | 2.5 | [GaloisInc/MATE](https://github.com/GaloisInc/MATE) | 198 | 1379d ago | Python | BSD-3 | DARPA-funded interactive CPG-based bug hunting for C/C++ via LLVM |
| 58 | 2.5 | [beicause/call-graph](https://github.com/beicause/call-graph) | 104 | 621d ago | TypeScript | Apache-2.0 | VS Code extension generating call graphs via LSP call hierarchy API |
| 59 | 2.5 | [julianjensen/ast-flow-graph](https://github.com/julianjensen/ast-flow-graph) | 71 | 2972d ago | JavaScript | Other | JavaScript control flow graphs from AST analysis |
| 60 | 2.5 | [Thibault-Knobloch/codebase-intelligence](https://github.com/Thibault-Knobloch/codebase-intelligence) | 50 | n/a | Python | None | Code indexing + call graph + vector DB + natural language queries (requires OpenAI) |
| 61 | 2.5 | [darkmacheken/wasmati](https://github.com/darkmacheken/wasmati) | 32 | n/a | C++ | Apache-2.0 | CPG infrastructure for scanning vulnerabilities in WebAssembly |
| 62 | 2.5 | [sutragraph/sutracli](https://github.com/sutragraph/sutracli) | 28 | 274d ago | Python | GPL-3.0 | AI-powered cross-repo dependency graphs for coding agents |
| 63 | 2.5 | [yoanbernabeu/grepai-skills](https://github.com/yoanbernabeu/grepai-skills) | 18 | n/a | — | MIT | 27 AI agent skills for semantic code search and call graph analysis |
| 64 | 2.5 | [RaheesAhmed/code-context-mcp](https://github.com/RaheesAhmed/code-context-mcp) | 0 | n/a | Python | MIT | Security pattern detection, auto architecture diagrams, code flow tracing |
| 65 | 2.4 | [shantham/codegraph](https://github.com/shantham/codegraph) | 0 | n/a | TypeScript | MIT | Polished `npx` one-command installer, sqlite-vss, 7 MCP tools |
| 66 | 2.3 | [emad-elsaid/rubrowser](https://github.com/emad-elsaid/rubrowser) | 645 | 1680d ago | Ruby | MIT | Ruby-only interactive D3 force-directed dependency graph |
| 67 | 2.3 | [ozyyshr/RepoGraph](https://github.com/ozyyshr/RepoGraph) | 291 | n/a | Python | Apache-2.0 | SWE-bench code graph research (ctags + networkx for LLM context) |
| 68 | 2.3 | [Fraunhofer-AISEC/codyze](https://github.com/Fraunhofer-AISEC/codyze) | 89 | 575d ago | Kotlin | None | CPG-based analyzer for cryptographic API misuse (archived, merged into cpg repo) |
| 69 | 2.3 | [Chentai-Kao/call-graph-plugin](https://github.com/Chentai-Kao/call-graph-plugin) | 86 | n/a | Kotlin | None | IntelliJ plugin for visualizing call graphs in IDE |
| 70 | 2.3 | [ehabterra/apispec](https://github.com/ehabterra/apispec) | 83 | 1d ago | Go | Apache-2.0 | OpenAPI 3.1 spec generator from Go code via call graph analysis |
| 71 | 2.3 | [huoyo/ko-time](https://github.com/huoyo/ko-time) | 65 | 804d ago | Java | LGPL-2.1 | Spring Boot call graph with runtime durations |
| 72 | 2.3 | [YounesBensafia/DevLens](https://github.com/YounesBensafia/DevLens) | 26 | 66d ago | Python | None | Repo scanner with AI summaries, dead code detection (dep graph not yet implemented) |
| 73 | 2.3 | [CartographAI/mcp-server-codegraph](https://github.com/CartographAI/mcp-server-codegraph) | 22 | n/a | JavaScript | MIT | Lightweight MCP code graph (3 tools only, Python/JS/Rust) |
| 74 | 2.3 | [aryx/codegraph](https://github.com/aryx/codegraph) | 6 | n/a | OCaml | Other | Multi-language source code dependency visualizer (the original "codegraph" name) |
| 75 | 2.3 | [0xd219b/codegraph](https://github.com/0xd219b/codegraph) | 0 | n/a | Rust | None | Pure Rust, HTTP server mode, Java + Go support |
| 76 | 2.2 | [jmarkowski/codeviz](https://github.com/jmarkowski/codeviz) | 147 | 546d ago | Python | MIT | C/C++ `#include` header dependency graph visualization |
| 77 | 2.2 | [juanallo/vscode-dependency-cruiser](https://github.com/juanallo/vscode-dependency-cruiser) | 78 | 2316d ago | JavaScript | MIT | VS Code wrapper for dependency-cruiser (JS/TS) |
| 78 | 2.2 | [hidva/as2cfg](https://github.com/hidva/as2cfg) | 63 | n/a | Rust | GPL-3.0 | Intel assembly → control flow graph |
| 79 | 2.2 | [2015xli/clangd-graph-rag](https://github.com/2015xli/clangd-graph-rag) | 59 | n/a | Python | Apache-2.0 | C/C++ Neo4j GraphRAG via clangd (scales to Linux kernel) |
| 80 | 2.2 | [microsoft/cmd-call-graph](https://github.com/microsoft/cmd-call-graph) | 57 | 274d ago | Python | MIT | Call graphs for Windows CMD batch files |
| 81 | 2.2 | [siggy/gographs](https://github.com/siggy/gographs) | 51 | 1259d ago | Go | MIT | Go package dependency graph generator |
| 82 | 2.2 | [henryhale/depgraph](https://github.com/henryhale/depgraph) | 35 | 38d ago | Go | MIT | Go-focused codebase dependency analysis |
| 83 | 2.1 | [floydw1234/badger-graph](https://github.com/floydw1234/badger-graph) | 0 | n/a | Python | None | Dgraph backend (Docker), C struct field access tracking |
| 84 | 2.0 | [crubier/code-to-graph](https://github.com/crubier/code-to-graph) | 383 | 2337d ago | JavaScript | None | JS code → Mermaid flowchart (single-function, web demo) |
| 85 | 2.0 | [jillesvangurp/spring-depend](https://github.com/jillesvangurp/spring-depend) | 46 | 342d ago | Java | MIT | Spring bean dependency graph extraction |
| 86 | 2.0 | [FalkorDB/code-graph-backend](https://github.com/FalkorDB/code-graph-backend) | 28 | ARCHIVED | Python | MIT | FalkorDB (Redis-based graph) code analysis demo |
| 87 | 2.0 | [ivan-m/SourceGraph](https://github.com/ivan-m/SourceGraph) | 27 | n/a | Haskell | GPL-3.0 | Haskell graph-theoretic code analysis (last updated 2022) |
| 88 | 2.0 | [brutski/go-code-graph](https://github.com/brutski/go-code-graph) | 19 | 319d ago | Go | MIT | Go codebase analyzer with MCP integration |
| 89 | 2.0 | [khushil/code-graph-rag](https://github.com/khushil/code-graph-rag) | 0 | n/a | Python | MIT | Fork of vitali87/code-graph-rag with no modifications |

### Tier 3: Minimal or Inactive (score < 2.0)

| Score | Project | Stars | Last PR | Summary |
|-------|---------|-------|---------|---------|
| 1.8 | [m3et/CodeRAG](https://github.com/m3et/CodeRAG) | 0 | n/a | Iterative RAG with self-reflection, ChromaDB, Azure OpenAI dependent |
| 1.8 | [getyourguide/spmgraph](https://github.com/getyourguide/spmgraph) | 250 | 280d ago | Swift Package Manager dependency graph + architecture linting |
| 1.8 | [mvidner/code-explorer](https://github.com/mvidner/code-explorer) | 53 | 3665d ago | Ruby call graph and class dependency browser |
| 1.8 | [ytsutano/jitana](https://github.com/ytsutano/jitana) | 42 | n/a | Android DEX static+dynamic hybrid analysis |
| 1.8 | [ShiftLeftSecurity/fuzzyc2cpg](https://github.com/ShiftLeftSecurity/fuzzyc2cpg) | 36 | ARCHIVED | [ARCHIVED] Fuzzy C/C++ parser to CPG (Joern ecosystem) |
| 1.8 | [mufasadb/code-grapher](https://github.com/mufasadb/code-grapher) | 11 | n/a | MCP code graph server (early stage) |
| 1.8 | [dtsbourg/codegraph-fmt](https://github.com/dtsbourg/codegraph-fmt) | 8 | 2705d ago | Annotated AST graph representations from Python |
| 1.8 | [mloncode/codegraph](https://github.com/mloncode/codegraph) | 5 | 2585d ago | Git/UAST graph experiments |
| 1.7 | [ashishb/python_dep_generator](https://github.com/ashishb/python_dep_generator) | 22 | 4620d ago | Python dependency graph generator |
| 1.7 | [LaurEars/codegrapher](https://github.com/LaurEars/codegrapher) | 16 | 69d ago | Python call graph visualizer |
| 1.7 | [AdilZouitine/ouakha.rs](https://github.com/AdilZouitine/ouakha.rs) | 7 | n/a | LLM-based Rust code analysis for suspicious code |
| 1.7 | [ensozos/geneci](https://github.com/ensozos/geneci) | 6 | n/a | UML diagrams and call graphs from source |
| 1.7 | [spullara/codegraph](https://github.com/spullara/codegraph) | 5 | n/a | Java JARs → Neo4j loader |
| 1.5 | [z7zmey/codegraph](https://github.com/z7zmey/codegraph) | 11 | n/a | PHP code visualization (last updated 2020) |
| 1.5 | [marcusva/cflow](https://github.com/marcusva/cflow) | 10 | n/a | C/assembler call graph generator |
| 1.5 | [beacoder/call-graph](https://github.com/beacoder/call-graph) | 6 | n/a | Emacs-based C/C++ call graph |

---

## Scoring Breakdown (Tier 1)

| # | Project | Features | Analysis Depth | Deploy Simplicity | Lang Support | Code Quality | Community | Total |
|---|---------|----------|---------------|-------------------|-------------|-------------|-----------|-------|
| 1 | GitNexus | 5 | 5 | 4 | 4 | 4 | 5 | 4.5 |
| 2 | codebase-memory-mcp | 4 | 4 | 5 | 5 | 4 | 5 | 4.5 |
| 3 | code-review-graph | 5 | 3 | 5 | 5 | 4 | 5 | 4.5 |
| 4 | narsil-mcp | 5 | 5 | 5 | 5 | 4 | 3 | 4.5 |
| 5 | joern | 5 | 5 | 3 | 4 | 5 | 4 | 4.33 |
| **6** | **codegraph (us)** | **5** | **5** | **5** | **4** | **5** | **2** | **4.33** |
| 7 | cpg | 5 | 5 | 2 | 5 | 5 | 3 | 4.17 |
| 8 | arbor | 4 | 4 | 5 | 4 | 5 | 3 | 4.17 |
| 9 | colbymchenry/codegraph | 4 | 3 | 5 | 3 | 4 | 5 | 4.0 |
| 10 | code-graph-rag | 5 | 4 | 3 | 4 | 4 | 4 | 4.0 |
| 11 | glimpse | 4 | 4 | 5 | 3 | 5 | 3 | 4.0 |
| 12 | CKB | 5 | 5 | 4 | 3 | 4 | 3 | 4.0 |
| 13 | codegraph-rust | 5 | 5 | 2 | 4 | 4 | 3 | 3.83 |
| 14 | axon | 5 | 5 | 4 | 2 | 4 | 3 | 3.83 |
| 15 | codepropertygraph | 4 | 5 | 2 | 4 | 5 | 3 | 3.83 |
| 16 | CodeGraphContext | 4 | 3 | 4 | 4 | 3 | 4 | 3.67 |
| 17 | jelly | 4 | 5 | 4 | 1 | 5 | 3 | 3.67 |
| 18 | codebadger | 4 | 4 | 3 | 5 | 3 | 3 | 3.67 |
| 19 | code-graph-rag-mcp | 5 | 4 | 3 | 4 | 3 | 3 | 3.67 |
| 20 | autodev-codebase | 5 | 3 | 3 | 5 | 3 | 3 | 3.67 |
| 21 | stratify | 4 | 4 | 2 | 5 | 4 | 3 | 3.67 |
| 22 | code-graph-mcp | 4 | 4 | 4 | 5 | 3 | 2 | 3.67 |
| 23 | cie | 5 | 4 | 4 | 3 | 4 | 2 | 3.67 |
| 24 | CodeGraphMCPServer | 4 | 4 | 4 | 5 | 3 | 2 | 3.67 |
| 25 | CodeVisualizer | 4 | 3 | 5 | 3 | 3 | 3 | 3.5 |
| 26 | mcp-code-graph | 4 | 3 | 4 | 4 | 3 | 3 | 3.5 |
| 27 | mcp-codebase-index | 4 | 3 | 5 | 3 | 4 | 2 | 3.5 |
| 28 | codexray | 5 | 4 | 4 | 4 | 3 | 1 | 3.5 |
| 29 | code-health-meter | 3 | 5 | 5 | 1 | 4 | 2 | 3.33 |
| 30 | code-graph-analysis-pipeline | 5 | 5 | 1 | 2 | 5 | 2 | 3.33 |
| 31 | loregrep | 3 | 3 | 4 | 3 | 5 | 2 | 3.33 |
| 32 | pyan | 3 | 3 | 5 | 1 | 4 | 3 | 3.17 |
| 33 | Claude-code-memory | 4 | 3 | 3 | 3 | 4 | 2 | 3.17 |
| 34 | claude-context-local | 4 | 3 | 3 | 4 | 4 | 1 | 3.17 |
| 35 | claude-context | 3 | 1 | 2 | 3 | 4 | 5 | 3.0 |
| 36 | java-all-call-graph | 4 | 4 | 3 | 1 | 3 | 3 | 3.0 |
| 37 | cloud-property-graph | 4 | 4 | 2 | 2 | 4 | 2 | 3.0 |
| 38 | codegraph-cli | 5 | 3 | 3 | 2 | 3 | 2 | 3.0 |
| 39 | xnuinside/codegraph (demoted from Tier 1 below) | 3 | 2 | 5 | 1 | 3 | 3 | 2.83 |
**Scoring criteria:**
- **Features** (1-5): breadth of tools, MCP integration, search, visualization, export
- **Analysis Depth** (1-5): how deep the code analysis goes (dead code, complexity, flow tracing, coupling)
- **Deploy Simplicity** (1-5): ease of setup — zero Docker = 5, requires Docker = 3, complex multi-service = 1
- **Lang Support** (1-5): number of well-supported programming languages
- **Code Quality** (1-5): architecture, performance characteristics, engineering rigor
- **Community** (1-5): stars-anchored band — 5 = 10,000+ stars, 4 = 1,000–9,999, 3 = 100–999, 2 = 10–99, 1 = 0–9. Applied uniformly across all 39 Tier 1 entries as of 2026-08-09 (previously ad hoc per-project judgment)

**Last PR column:** days since the most recently *merged* pull request (GitHub API, 2026-08-09). `n/a` = no merged PRs found; `ARCHIVED` = repo is archived. Caveat: this measures PR-based collaboration, not raw activity — a solo maintainer who pushes directly to `main` (e.g. narsil-mcp: last direct push 88 days ago vs last merged PR 197 days ago) will show a larger, more stale-looking number here than their actual pace of work.

---

## Where Codegraph Wins

| Strength | Details |
|----------|---------|
| **Always-fresh graph (incremental rebuilds)** | Three-tier change detection (journal → mtime+size → hash) means only changed files are re-parsed. Change 1 file in a 3,000-file project → rebuild in under a second. Per-file incremental indexing is no longer unique to us — code-review-graph (SHA-256 diffing), narsil-mcp (Merkle tree), colbymchenry/codegraph (OS file watcher), and claude-context (Merkle DAG) all reach O(changed) as of August 2026. What still separates us is that the incremental path is entirely local and synchronous: no embedding round-trip, no external vector DB, no daemon — so it stays viable inside commit hooks, watch mode, and agent-driven loops. Native Rust engine achieves ~4-6 ms/file on cold builds |
| **Qualified call resolution** | Import-aware resolution distinguishes method calls (`obj.method()`) from standalone function calls, filters 28+ built-in receivers (`console`, `Math`, `JSON`, `Array`, `Promise`, etc.), deduplicates edges, and respects import scope. A call to `foo()` only resolves to functions actually imported or in-scope — eliminating the false positives that plague tree-sitter-based tools. Confidence scoring (1.0 → 0.5) on every edge lets agents trust the graph |
| **AI-optimized compound commands** | `context` returns source + deps + callers + signature + related tests for a function in one call. `explain` gives structural summaries of files (public API, internals, data flow) or functions without reading the source. These save AI agents 50-80% of the token budget they'd otherwise spend navigating code. No competitor offers purpose-built compound context commands |
| **Zero-cost core, LLM-enhanced when you choose** | The full graph pipeline (parse, resolve, query, impact analysis) runs with no API keys, no cloud, no cost. LLM features (richer embeddings, semantic search) are an optional layer on top — using whichever provider the user already works with. Competitors either require cloud APIs for core features (code-graph-rag, autodev-codebase, mcp-code-graph) or offer no AI enhancement at all (CKB, axon). Nobody else offers both modes in one tool |
| **Data goes only where you send it** | Your code reaches exactly one place: the AI agent you already chose (via MCP). No additional third-party services, no surprise cloud calls. Competitors like code-graph-rag, autodev-codebase, mcp-code-graph, and Claude-code-memory send your code to additional AI providers beyond the agent you're using |
| **Dual engine architecture** | Only project with native Rust (napi-rs) + automatic WASM fallback. Others are pure Rust (narsil-mcp, codegraph-rust, codebase-memory-mcp) OR pure JS/Python — never both |
| **Standalone CLI + MCP** | Full 41-command CLI experience (`context`, `audit`, `where`, `fn-impact`, `diff-impact`, `map`, `deps`, `search`, `structure`, `sequence`, `roles`, `dataflow`, `cfg`, `ast`) alongside 32-tool MCP server. Many competitors are MCP-only (narsil-mcp, codebase-memory-mcp, code-graph-mcp, CodeGraphMCPServer) with no standalone query interface |
| **Single-repo MCP isolation** | Security-conscious default: tools have no `repo` property unless `--multi-repo` is explicitly enabled. Most competitors default to exposing everything |
| **Zero-dependency deployment** | `npm install` and done. No Docker, no external databases, no Python, no SCIP toolchains, no JVM. Published platform-specific binaries (`@optave/codegraph-{platform}-{arch}`) resolve automatically. Joern requires JDK 21, cpg requires Gradle + language-specific deps, codegraph-rust requires SurrealDB + LSP servers |
| **Structure & quality analysis** | `structure` shows directory cohesion scores, `hotspots` finds files with extreme fan-in/fan-out/density, `stats` includes a graph quality score (0-100) with false-positive warnings. These give agents architectural awareness without requiring external tools |
| **Node role classification** | Every symbol is auto-tagged as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` based on fan-in/fan-out patterns with adaptive median thresholds. Agents instantly know a function's architectural role without reading surrounding code. Inspired by arbor's role classification — but we compute roles automatically during graph build rather than requiring manual tagging, and we surface roles across all query commands (`where`, `explain`, `context`, `stats`, `list-functions`). Dead code detection comes free as a byproduct |
| **Callback pattern extraction** | Extracts symbols from Commander `.command().action()` (as `command:build`), Express route handlers (as `route:GET /api/users`), and event emitter listeners (as `event:data`). No competitor extracts symbols from framework callback patterns |

---

## Where Codegraph Loses

**We are #6 in Tier 1 (4.33), not #4.** Four tools now score higher — GitNexus, codebase-memory-mcp, code-review-graph, and narsil-mcp (all 4.50) — and we're tied with joern (4.33, ahead of us only on the star tiebreak). Two of those four — code-review-graph and codebase-memory-mcp — passed us specifically because their communities grew fast enough to cross into the top Community band (6.8x–48x in under five months: code-review-graph 4,309→29,491; codebase-memory-mcp 793→38,234) while ours grew 32→86 (2.7x). GitNexus and narsil-mcp were already tied with us at 4.5 before this refresh — their score didn't move, ours did, once our own Community score was corrected down. (For scale, colbymchenry/codegraph — an unrelated tool further down the table at #9, not one of the four — grew even faster over the same window: 308→65,489, 212x.) We still lead or tie every Tier 1 entrant on Analysis Depth (dataflow, CFG, interprocedural dataflow, complexity, architecture boundaries, CI gates) — that axis alone no longer decides the top ranks in this space.

### vs GitNexus (#1, 45,206 stars)
- **Community, at scale**: 45,206 stars (2.4x growth since March) — orders of magnitude more traction. Discord community, TrendShift badge, npm package (`gitnexus`)
- **Multi-editor integration**: Auto-configures Claude Code (with hooks), Cursor, Codex, Windsurf, OpenCode via `gitnexus setup`. We only support Claude Code MCP config
- **Auto-generated context files**: Creates AGENTS.md/CLAUDE.md from the knowledge graph — agents get codebase context automatically
- **Web UI + CLI + MCP**: Three access modes including a hosted web explorer at gitnexus.vercel.app. We have CLI + MCP + interactive HTML viewer but no hosted web UI
- **Bridge mode**: `gitnexus serve` connects CLI-indexed repos to the web UI — seamless local-to-browser workflow
- **PDG + taint analysis**: opt-in `--pdg` index adds per-function CFG/PDG and source→sink taint tracking, currently TypeScript/JavaScript only
- **Where we win**: Non-commercial license (PolyForm NC) blocks enterprise adoption. Incremental indexing is coarser than ours — cache-keyed byte-budgeted chunks plus per-branch index updates on checkout, not per-file hashing. LadybugDB is custom/unproven vs our SQLite. Our analysis depth is comparable (both score 5) but ours applies uniformly across all 34 languages, not TS/JS-only. **Net score: they're ahead of us (4.50 vs 4.33) — almost entirely on Community**

### vs codebase-memory-mcp (#2, 38,234 stars — no longer "immature")
- **Explosive growth, now sustained**: 793 → 38,234 stars (48x) since our last check, 3,044 forks, 427 open issues, 163 subscribers — genuine large-scale engagement, not a star-farm blip. Single-developer C project, created 2026-02-24
- **64 languages**: nearly 2x our 34, via vendored tree-sitter grammars compiled into a single static C binary
- **Zero-dependency binary**: no Node.js/JVM/runtime. Auto-installer configures 10 different AI agents in one command
- **Cypher-like query language**: hand-built Cypher subset in C for arbitrary graph traversals — we have no query DSL
- **HTTP route analysis**: first-class Route nodes and cross-service HTTP call linking with confidence scoring — unique capability
- **3D graph visualization**: built-in web-based 3D graph viewer
- **Where we win**: MCP-only (no standalone CLI), no semantic search/embeddings, no complexity metrics, no cycle detection, no export formats (DOT/Mermaid/GraphML), no architecture boundaries, no CI gates, no programmatic API, limited Cypher subset (no WITH/COLLECT/OPTIONAL MATCH). Our analysis depth is still greater (5 vs 4). **Net score: they're now tied with GitNexus at the top (4.50) — the "very immature" framing from our March review no longer holds; this is a real, fast-maturing competitor**

### vs code-review-graph (#3, 29,491 stars)
- **Massive, fast-growing community**: 4,309 → 29,491 stars (6.8x), 2,700 forks — now one of the largest communities in this space
- **Graph export**: added GraphML (Gephi/yEd), Neo4j Cypher, Obsidian vault (wikilinks), and SVG export since our last review — a gap we previously listed in our favor is now closed
- **CI merge gate**: added an optional `fail-on-risk` GitHub Action that turns risk-scored review into a merge gate — another gap closed
- **Notebook + config-format coverage**: its 40+ parsed surfaces include Jupyter/Databricks notebooks (`.ipynb`), Ansible playbooks, Vue/Svelte/Astro SFCs, SQL, and Terraform — surfaces we don't parse at all
- **Multi-editor auto-installer**: Auto-configures MCP for Claude Code, Cursor, Windsurf, Zed, Continue, OpenCode via `code-review-graph install`
- **Fast incremental builds**: SHA-256 hash diffing, ~2.5s for a 2-file edit on a 3,000-file repo — comparable to our approach
- **pip/pipx/uvx install**: Python ecosystem reach — accessible to a different audience than our npm install
- **Where we win**: still no dataflow, no CFG, no complexity metrics, no architecture boundary *rules* (their gate is risk-scored, not layering-based), no node role classification, no confidence-scored edges. Its own README (2026-08-02 benchmark capture) reports the co-change evaluation mode returns 0 predicted files on every graded commit — "not yet a usable measurement," by their own admission. Our dual engine (native Rust + WASM) is faster; Python-only ecosystem limits their reach in Node.js/TypeScript shops. **Net score: tied with GitNexus/codebase-memory-mcp at 4.50 — ahead of us, driven by the export/CI-gate additions plus a community that's now 340x ours**

### vs narsil-mcp (#4, 180 stars)
- **Feature breadth**: 90 MCP tools vs our 34; covers taint analysis, SBOM, license compliance, control flow graphs, data flow analysis, SPARQL/RDF queries
- **Security analysis**: vulnerability scanning with OWASP/CWE coverage, 147+ rules — we have no security features
- **SPA web frontend**: full web UI with file tree sidebar, syntax-highlighted code viewer, dashboard, per-repo overview, CFG visualization
- **Single-binary deployment**: ~30MB Rust binary via brew/scoop/cargo/npm — as easy as ours
- **Note on activity**: last *merged PR* was 197 days ago, but the maintainer pushes directly to `main` — the last direct commit was 88 days ago, and recent PRs (#19, #24, #25) were closed rather than merged. Read "197 days since a merged PR" as a collaboration-workflow signal, not evidence of abandonment
- **Where we win**: still the closest peer on raw scoring (tied 4.50, same as GitNexus/codebase-memory-mcp/code-review-graph) — narsil-mcp's Community score (180 stars) stayed in the same 100–999 band as before, so it didn't need a Community-driven correction the way we did. It is ahead of us on Features (90 tools) and tied on Depth; we're ahead on Deploy/Lang by a hair. **This is the most direct apples-to-apples comparison in the list: similar community size, similar depth, and we're behind mainly because their Features count is larger**

### vs joern (#5, 3,401 stars)
- **Full Code Property Graph**: AST + CFG + PDG combined for deep vulnerability analysis; our tree-sitter extraction captures structure but not the same interprocedural control/data flow rigor
- **Scala query DSL**: purpose-built query language for arbitrary graph traversals vs our fixed CLI commands
- **Binary analysis**: Ghidra frontend can analyze compiled binaries — we're source-only
- **Enterprise backing**: ShiftLeft/Fraunhofer support, daily automated releases (v4.0.508), 75 contributors, professional documentation at joern.io
- **Where we win**: joern's Community score also dropped under the refreshed star-band rubric (3,401 stars falls under 10,000 → band 4, not 5), so it moved from 4.50 to 4.33 alongside us — **we're now tied**, distinguished only by the star-count tiebreak

### vs cpg (#7, 453 stars)
- **Formal CPG specification**: academic-grade graph representation (AST + CFG + PDG + DFG) with published specs
- **MCP module**: built-in MCP support now, matching our integration
- **LLVM IR support**: extends language coverage to any LLVM-compiled language (Rust, Swift, etc.)
- **Type inference**: can analyze incomplete/partial code — our tree-sitter requires syntactically valid input

### vs arbor (#8, 151 stars)
- **Native Rust GUI**: Built-in desktop interface for interactive graph exploration — we have HTML viewer but no native GUI
- **Fuzzy symbol search**: Levenshtein-scored symbol matching tolerates typos and partial names — our search requires exact or substring matches
- **Architectural role classification**: Automatic labeling of nodes by architectural role — *(Gap closed: our `roles` command now classifies nodes as entry, core, utility, adapter, dead, leaf)*

### vs colbymchenry/codegraph (#9, 65,489 stars — 212x growth, Rust rewrite)
- **Explosive, sustained growth**: 308 → 65,489 stars (212x) since March — now the single most-starred tool in this entire 89-project list, ahead of GitNexus, codebase-memory-mcp, and code-review-graph
- **Rewrote its core in Rust**: no longer a thin Node.js wrapper. Self-contained binary (no Node.js required), OS-native file-watcher (FSEvents/inotify/ReadDirectoryChangesW) gives real `O(changed)` incremental rebuilds — a gap we used to hold alone
- **9 agent-client integrations**: Claude Code, Cursor, Codex, opencode, Hermes Agent, Gemini, Antigravity, Kiro, GitHub Copilot — we only support Claude Code MCP config
- **Signed, attested releases**: npm provenance + signed/attested builds — a real engineering-rigor signal we didn't have visibility into before
- **~33 languages** (self-reported headline is "20+"; the README's architecture section enumerates 34 names across a tiered native-grammar + fallback-engine pipeline) — comparable to our 34
- **Where we win**: still MCP-only surfaced tooling by default (their own CLI/MCP tools beyond `explore` are present but unlisted unless re-enabled), no dataflow/CFG/interprocedural analysis, no complexity metrics, no architecture boundary rules, no cycle detection, no dead code/export detection, no community detection, no CI gates, no confidence-scored edges. **Net score: 4.00, still behind our 4.33 — but the gap has closed from 3.7-vs-4.5 in March to 4.00-vs-4.33 now, driven entirely by real engineering investment (Rust rewrite, real incrementality, signed releases), not just stars. Same-name marketplace confusion keeps increasing as their growth accelerates**

### vs code-graph-rag (#10, 2,632 stars)
- **Graph query expressiveness**: Memgraph + Cypher enables arbitrary graph traversals; our CLI commands are more rigid
- **AI-powered code editing**: they can surgically edit functions via AST targeting with visual diffs
- **Provider flexibility**: they support Gemini/OpenAI/Claude/Ollama and can mix providers per task

### vs glimpse (#11, 360 stars — stagnant)
- **LLM workflow optimization**: clipboard-first output + token counting + XML output mode — purpose-built for "code → LLM context"
- **LSP-based call resolution**: compiler-grade accuracy vs our tree-sitter heuristic approach

### vs CKB (#12, 109 stars)
- **Indexing accuracy**: SCIP provides compiler-grade cross-file references (type-aware), fundamentally more accurate than tree-sitter for supported languages
- **Now claims impact analysis and architecture mapping**: feature convergence with v8.1.0 — they're moving into our territory
- **Secret scanning**: enterprise feature we lack

### vs codegraph-rust (#13, 861 stars)
- **LSP-powered analysis**: compiler-grade cross-file references via rust-analyzer, pyright, gopls vs our tree-sitter heuristics
- **Tiered indexing**: fast/balanced/full modes for different use cases — we have one mode
- **Note**: last merged PR was 232 days ago — the slowest-moving tool in Tier 1 by that measure

### vs axon (#14, 729 stars)
- **Leiden community detection**: more sophisticated clustering than our Louvain
- **KuzuDB with native Cypher**: more expressive for complex graph queries than our SQLite
- **Where we win**: co-change *(Gap closed: we now have `co-change`)* and branch structural diff *(Gap closed: `branch-compare`)*. Still no LICENSE file in the repo despite claiming MIT in `pyproject.toml`

### vs CodeGraphContext (#16, 4,056 stars)
- **Community traction**: 4,056 stars, higher visibility than us (likely Hacktoberfest/social-coding-event-boosted, but a real, larger community)
- **Multiple graph DB backends**: KuzuDB (embedded), FalkorDB Lite, FalkorDB Remote, Neo4j — native graph traversal and raw Cypher queries. Our SQLite is simpler but less expressive for graph queries
- **Pre-indexed bundle registry**: download `.cgc` bundles for popular open-source repos — instant context without indexing. Unique in this space
- **IDE setup wizard**: auto-configures MCP for 10+ IDEs. We only support Claude Code MCP config
- **Where we win**: significantly deeper analysis — qualified call resolution, dataflow, CFG, interprocedural dataflow, stored ASTs, architecture boundaries, community detection, diff-impact, role classification, semantic search, sequence diagrams, complexity metrics, CI gates. Dual engine (native Rust + WASM) is much faster

### vs jelly (#17, 434 stars)
- **Points-to analysis**: flow-insensitive analysis with access paths for JS/TS — fundamentally more precise than our tree-sitter-based call resolution for that language pair
- **Academic rigor**: 5 published papers backing the methodology (Aarhus University)

### vs claude-context (#35, 12,339 stars — viral, Zilliz-backed)
- **Explosive popularity + real engineering backing**: 12,339 stars, 906 forks, Trendshift-featured, built by Zilliz (the company behind the Milvus vector database). VS Code extension alongside the MCP server, setup docs for 10+ agent clients
- **AST-aware chunking**: splits code along syntactic boundaries for 10 languages, falling back to a generic text splitter for the rest. Published evaluation claims ~40% token reduction at equivalent retrieval quality vs naive full-file context
- **Hybrid BM25 + dense-vector search**: combines lexical and semantic retrieval in one query, backed by a real vector database (Milvus)
- **Merkle-DAG incremental re-indexing**: a genuine `O(changed)` mechanism, comparable to our own hash-based tiering
- **Where we win**: retrieval-only — no call graph, no impact analysis, no dead code detection, no complexity metrics, no CI gates, no dataflow/CFG, no architecture boundary enforcement. It answers "what looks similar to this query?", not "what breaks if I change this?" Requires an external Milvus vector database plus an embedding provider — a fully local, keyless path exists (self-hosted Milvus + local Ollama) but is two services to operate, and the managed alternative (Zilliz Cloud + OpenAI/VoyageAI/Gemini) adds a hosted dependency and per-token cost. **Despite 143x our star count, still ranks well below us (3.00 vs 4.33) — this is the clearest case in the whole list where Community and Depth diverge sharply: massive popularity, minimal structural depth**

### vs aider (Tier 2, #41, 48,066 stars)
- **Different product category**: Aider is an AI pair programming CLI, not a code graph tool — but its tree-sitter repo map with PageRank-style graph ranking is a lightweight alternative to our full graph for LLM context selection
- **Massive community**: 48,066 stars — orders of magnitude more traction than any tool in this list, us included. Aider *is* the category leader for AI-assisted coding in the terminal
- **100+ languages**: tree-sitter parsing covers far more languages than our 34, though only for identifier extraction (not full symbol/call resolution)
- **Where we win**: Aider's repo map is shallow — file-level dependency graph with identifier ranking, no function-level call resolution, no impact analysis, no dead code detection, no MCP server. It answers "what's relevant?" but not "what breaks if I change this?" Its Tier 2 score (2.8, unchanged) reflects that category difference, not a depth gap on our terms

---

## Features to Adopt — Priority Roadmap

### Tier 1: High impact, low effort
| Feature | Inspired by | Why | Status |
|---------|------------|-----|--------|
| ~~**Dead code detection**~~ | narsil-mcp, axon, codexray, CKB | ~~We have the graph — find nodes with zero incoming edges (minus entry points/exports). Agents constantly ask "is this used?"~~ | **DONE** — Delivered via node classification. `roles --role dead` lists all unreferenced, non-exported symbols |
| ~~**Fuzzy symbol search**~~ | arbor | ~~Add Levenshtein/Jaro-Winkler to `fn` command. Currently requires exact match~~ | **DONE** — `fn` now has relevance scoring (exact > prefix > word-boundary > substring) with fan-in tiebreaker, plus `--file` and `--kind` filters |
| ~~**Expose confidence scores**~~ | arbor | ~~Already computed internally in import resolution — just surface them~~ | **DONE** — confidence scores stored on every call edge, surfaced in `stats` graph quality score |
| ~~**Shortest path A→B**~~ | codexray, arbor | ~~BFS on existing edges table~~ | **DONE** — `codegraph path <from> <to>` with BFS on call graph edges |

### Tier 2: High impact, medium effort
| Feature | Inspired by | Why | Status |
|---------|------------|-----|--------|
| **Optional LLM provider integration** | code-graph-rag, autodev-codebase | Bring-your-own provider (OpenAI, etc.) for richer embeddings and AI-powered search. Enhancement layer only — core graph never depends on it. No other tool offers both zero-cost local and LLM-enhanced modes in one package | TODO |
| ~~**Compound MCP tools**~~ | CKB, colbymchenry/codegraph | ~~`explore`/`understand` meta-tools that batch deps + fn + map into single responses~~ | **DONE** — `context` returns source + deps + callers + signature + tests in one call; `explain` returns structural summaries of files or functions |
| **Token counting on responses** | glimpse, arbor | tiktoken-based counts so agents know context budget consumed | TODO |
| ~~**Node classification**~~ | arbor | ~~Auto-tag Entry Point / Core / Utility / Adapter from in-degree/out-degree patterns~~ | **DONE** — `classifyNodeRoles()` tags every symbol as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf`. New `roles` CLI command, `node_roles` MCP tool, `--role`/`--file` filters. Roles surfaced in `where`/`context`/`stats`/`list-functions` |
| **TF-IDF lightweight search** | codexray | SQLite FTS5 + TF-IDF as a middle tier (~50MB) between "no search" and full transformers (~500MB) | TODO |
| **OWASP/CWE pattern detection** | narsil-mcp, CKB | Security pattern scanning on the existing AST — hardcoded secrets, SQL injection patterns, XSS | TODO |
| ~~**Formal code health metrics**~~ | code-health-meter | ~~Cyclomatic complexity, Maintainability Index, Halstead metrics per function~~ | **DONE** — `codegraph complexity` delivers cognitive, cyclomatic (CFG-derived), Halstead, MI, nesting depth per function across all 34 languages |

### Tier 3: High impact, high effort
| Feature | Inspired by | Why | Status |
|---------|------------|-----|--------|
| ~~**Interactive HTML visualization**~~ | autodev-codebase, CodeVisualizer | ~~`codegraph viz` → opens interactive graph in browser~~ | **DONE** — `codegraph plot` opens interactive vis-network HTML viewer with physics, clustering, drill-down |
| ~~**Git change coupling**~~ | axon | ~~Analyze git history for files that always change together~~ | **DONE** — `codegraph co-change` analyzes git history for temporal file coupling |
| ~~**Community detection**~~ | axon, GitNexus, CodeGraphMCPServer | ~~Louvain algorithm to discover natural module boundaries~~ | **DONE** — `codegraph communities` with Louvain clustering and drift analysis |
| ~~**Execution flow tracing**~~ | axon, GitNexus, code-context-mcp | ~~Framework-aware entry point detection + BFS flow tracing~~ | **DONE** — `codegraph flow` traces from entry points (routes, commands, events) through callees to leaves |
| ~~**Dataflow analysis**~~ | codegraph-rust | ~~Define/use chains and flows_to/returns/mutates edges~~ | **DONE** — `codegraph dataflow` with `flows_to`/`returns`/`mutates` edges across all 34 languages |
| ~~**Architecture boundary rules**~~ | codegraph-rust, stratify | ~~User-defined rules for allowed/forbidden dependencies between modules~~ | **DONE** — `codegraph check` with configurable boundary rules and onion/hexagonal/layered/clean presets |

### Paid Solutions

#### Sourcegraph (sourcegraph.com)

**What it is:** Enterprise code intelligence platform. Cloud-hosted and self-hosted. Proprietary, paid per user (free tier for individuals).

**Core features:**

| Feature | Description | Codegraph equivalent | Gap |
|---------|-------------|---------------------|-----|
| **Code Search** | Full-text regex search across all repos, branches, commits, and diffs. RE2 engine with boolean operators (`AND`/`OR`/`NOT`), compound filters (`repo:`, `file:`, `lang:`, `author:`, `before:`/`after:`), output shaping (`select:repo`, `select:symbol.function`, `select:file.owners`), and `rev:at.time()` for historical point-in-time search. Search Contexts define reusable named scopes | `codegraph search` (hybrid BM25+semantic), `where`, `list-functions` with `-f`/`-k`/`-T` filters | **Partial** — we have semantic+keyword search but lack boolean compound queries, diff/commit content search, output reshaping, and named search contexts. Backlog IDs 75, 79 |
| **Deep Search** | Agentic natural-language search: an AI agent iteratively uses Code Search + Code Navigation tools, refining its understanding each loop until confident. Returns markdown answers with source citations. Conversational follow-ups | `codegraph search` (semantic mode) finds conceptual matches but returns raw results, not synthesized answers | **Yes** — we do semantic search but not agentic iterative search with synthesized answers. This is an LLM-layer feature — could be built on top of our MCP tools by an orchestrating agent rather than built into codegraph itself |
| **Code Navigation** | Go-to-definition, find-references, find-implementations across repositories. Two tiers: search-based (heuristic, instant) and precise (SCIP compiler-accurate indexers). Popover type signatures and docs inline | `codegraph where` (search-based), `codegraph query` (callers/callees), `codegraph context` (full context). No find-implementations | **Partial** — we have search-based navigation and caller/callee chains. We lack interface→implementation tracking (backlog ID 74) and cross-repo reference resolution (backlog ID 78) |
| **Code Monitoring** | Persistent watch rules on `type:diff`/`type:commit` queries. Fires email, Slack webhook, or custom HTTP webhook when new commits match. No limit on monitor count or monitored code volume | `codegraph build --watch` (incremental rebuild), `codegraph check --staged` (CI predicates) | **Partial** — we have watch-mode rebuilds and CI predicates but no persistent query-based commit monitors with notification actions. Backlog ID 76 |
| **Code Ownership** | CODEOWNERS as a first-class search dimension: `file:has.owner()`, `select:file.owners`, owner-scoped queries. Resolves CODEOWNERS entries against user profiles | `codegraph owners` with `--owner`, `--boundary` filters. Integrated into `diff-impact` (affected owners + suggested reviewers). `code_owners` MCP tool | **No gap** — feature parity. We parse CODEOWNERS, match patterns, integrate into impact analysis, and expose via CLI + MCP. They have richer owner-as-search-filter syntax; our backlog ID 79 (advanced query language) would close this |
| **Code Insights** | Track any search query as a time-series metric on dashboards. Automatic historical backfill from git history — years of data immediately. Migration progress, tech debt trends, codebase composition over time | `codegraph stats` (point-in-time), `codegraph snapshot` (manual checkpoints) | **Yes** — we have point-in-time metrics and manual snapshots but no automated historical trend tracking. Backlog ID 77 |
| **Batch Changes** | Declarative YAML spec → automated code changes across hundreds of repos. Creates PRs on all affected repos, tracks merge status, CI checks, review approvals. Burndown charts for migration progress | None — codegraph is read-only by design (Foundation P8: we don't edit code or make decisions) | **By design** — we're a graph query tool, not a code modification tool. This is out of scope per Foundation principles |
| **CLI (`src`)** | Terminal search, batch change creation, SBOM generation, repo/user/team admin, code intelligence ops, CODEOWNERS management | `codegraph` CLI with 41 commands, 32-tool MCP server | **Partial** — our CLI is richer for graph queries; theirs is richer for admin/batch/SBOM operations. Different focus areas |

**Where Sourcegraph wins over codegraph:**

| Advantage | Details |
|-----------|---------|
| **Scale** | Designed for 100,000+ repo enterprises. Indexed search across all repos, branches, and history simultaneously. Our multi-repo mode works but is designed for tens of repos, not thousands |
| **Precise navigation (SCIP)** | Compiler-accurate go-to-definition and find-references via language-specific SCIP indexers. Our tree-sitter resolution is heuristic — good enough for most cases but fundamentally less accurate for typed languages |
| **Diff/commit content search** | First-class search within git diffs and commit messages with author/date filters. We have `co-change` (statistical correlation) but can't search actual diff content |
| **Code monitoring** | Persistent query-based alerts on new commits with webhook/Slack/email actions. Our `--watch` mode rebuilds the graph but doesn't evaluate persistent query triggers |
| **Historical insights** | Automatic time-series tracking of any metric over git history with dashboard visualization. We have manual snapshots but no automated trend tracking |
| **Enterprise ecosystem** | SSO, RBAC, audit logs, IDE extensions (VS Code, JetBrains, Neovim), browser extension for GitHub/GitLab code review. We're a CLI + MCP tool |
| **Boolean query language** | Rich boolean operators, compound filters, output reshaping, and named search contexts. Our search is either semantic (fuzzy) or exact-name (`where`) |

**Where codegraph wins over Sourcegraph:**

| Advantage | Details |
|-----------|---------|
| **Zero infrastructure** | `npm install` and done. No server, no Docker, no cloud, no accounts. Sourcegraph requires either a cloud subscription or a self-hosted instance (Kubernetes/Docker Compose) |
| **Function-level graph** | We build and query at function/method/class granularity with call edges, dataflow, CFG, and impact analysis. Sourcegraph operates at file/symbol level — search finds symbols but doesn't build a persistent dependency graph with blast radius analysis |
| **Impact analysis** | `diff-impact`, `fn-impact`, `branch-compare` trace transitive blast radius through the call graph. Sourcegraph's `find-references` shows direct references but not transitive impact chains |
| **Complexity & health metrics** | Cognitive, cyclomatic, Halstead, MI per function with CI gates. Sourcegraph has no built-in code health metrics |
| **Community detection & drift** | Louvain clustering reveals architectural drift between directory structure and actual dependencies. Sourcegraph has no equivalent |
| **Dataflow analysis** | `flows_to`/`returns`/`mutates` edges track how data moves through functions across all 34 languages. Sourcegraph doesn't do dataflow analysis |
| **Control flow graphs** | Per-function CFG with basic blocks stored in the graph; cyclomatic complexity derived from CFG structure (E - N + 2). Sourcegraph doesn't build CFGs |
| **Sequence diagrams** | `sequence <name>` generates Mermaid sequence diagrams from call graph edges. Sourcegraph has no diagram generation |
| **Node role classification** | Every symbol auto-tagged as entry/core/utility/adapter/dead/leaf. Sourcegraph has no architectural role concept |
| **Cost** | Completely free and open source (Apache-2.0). Sourcegraph's paid plans start at $49/user/month for enterprise features |
| **Privacy** | Your code never leaves your machine (unless you choose to connect an LLM). Sourcegraph Cloud processes your code on their infrastructure; self-hosted requires significant ops investment |
| **AI-optimized output** | `context`, `audit`, `triage`, `batch`, `sequence` commands are purpose-built for AI agent consumption with structured JSON. Sourcegraph's output is designed for human developers in a web UI |

### Not worth copying
| Feature | Why skip |
|---------|----------|
| Memgraph/Neo4j/KuzuDB/SurrealDB/LadybugDB | Our SQLite = zero Docker, simpler deployment. Query gap matters less than simplicity. codegraph-rust's SurrealDB requirement is its biggest weakness. GitNexus's LadybugDB is custom/unproven |
| SCIP indexing | Would require maintaining SCIP toolchains per language. Tree-sitter + native Rust is the right bet |
| Full CPG (AST+CFG+PDG) | Joern/cpg's approach requires fundamentally different parsing — we'd be rebuilding Joern. Tree-sitter gives us AST-level graphs; adding lightweight dataflow on top is the pragmatic path |
| Points-to analysis | Academic-grade JS analysis (jelly) — overkill for our use case and limited to JS/TS |
| Cloud-hosted graph service | mcp-code-graph (CodeGPT) requires accounts and cloud dependency — goes against our local-first philosophy |
| CrewAI multi-agent | Overengineered for a code analysis tool. Keep the scope focused |
| Clipboard/LLM-dump mode | Different product category (glimpse). We're a graph tool, not a context-packer |

