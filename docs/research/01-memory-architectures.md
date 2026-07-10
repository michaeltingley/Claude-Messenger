# Lane 1: Agent memory architectures + offline consolidation (July 2026)

_As researched by a dedicated agent; final report verbatim._

All research phases complete (search fan-out, source fetches, adversarial cross-checks via the benchmark-audit sources, and Anthropic capability verification against the current API reference). Here is the synthesized report.

---

# Memory Architectures for LLM Agents + Offline Consolidation — State of the Art, July 2026

**Context:** single-user personal context engine over all communications; durable models of user/contacts/relationships; retrieval + context assembly; eventual per-relationship voice drafting. No fine-tuning. Claude APIs, open tooling, single-node self-hosting all allowed.

**Confidence labels:** [V] = vendor-reported/self-evaluated, [I] = independently verified or third-party, [P] = paper-only.

---

## 1. The headline findings (read this first)

1. **Every published agent-memory benchmark number is suspect.** LoCoMo has a ~6.4% broken-ground-truth rate (theoretical ceiling ~93.6%); the standard GPT-4o-mini judge accepted 62.8% of intentionally wrong-but-topical answers; LongMemEval-S (~115K tokens) fits inside a single frontier context window, so it measures context management, not memory ([The Benchmark Theatre audit](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)). The Zep-vs-Mem0 dispute went 84% → corrected 75.14% → re-evaluated by Mem0 at 58.44% ([Zep's post](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/), [GitHub issue](https://github.com/getzep/zep-papers/issues/5)). [I]
2. **Dumb baselines beat fancy memory systems at your scale.** A Letta agent with GPT-4o-mini, a flat file, and `grep` scored 74.0% on LoCoMo — beating Mem0's best graph config (~68.5%) ([Letta: "Is a Filesystem All You Need?"](https://www.letta.com/blog/benchmarking-ai-agent-memory/)). Salesforce's ConvoMem benchmark found full-context achieves 70–82% where Mem0-style RAG memory gets 30–45% for histories under ~150 conversations; long context is strictly better for the first ~30 conversations and viable to ~150 ([arXiv:2511.10523](https://arxiv.org/abs/2511.10523)). [I]
3. **Offline "sleep-time" computation is real and quantified.** Letta's sleep-time compute paper shows ~5× reduction in test-time compute at equal accuracy, +13–18% accuracy when scaled, and 2.5× per-query cost amortization when multiple queries share a context ([arXiv:2504.13171](https://arxiv.org/abs/2504.13171), [blog](https://www.letta.com/blog/sleep-time-compute/)). [V/P — but the production two-agent pattern is shipped in Letta]
4. **Temporal knowledge graphs are the best-developed answer to fact evolution** (contact moved cities): Graphiti's bi-temporal edges (`valid_from`/`valid_to`, event time vs ingestion time) with LLM-driven contradiction detection invalidate rather than delete superseded facts ([Zep paper](https://arxiv.org/abs/2501.13956), [Graphiti repo](https://github.com/getzep/graphiti)). [I — open source, production use]
5. **Anthropic's 2025–2026 stack gives you most primitives off the shelf:** file-based memory tool, context editing, server-side compaction, 1M-token context on Opus/Sonnet, 50% Batch API, 90%-off cache reads. Anthropic reports 39% improvement on internal agentic-search evals from memory tool + context editing combined ([Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)). [V]

---

## 2. Named systems, exhaustive map

### 2.1 MemGPT → Letta (+ sleep-time agents)
- **What:** "LLM as OS" — treat context as constrained memory with a hierarchy: in-context *core memory blocks* (self-editable), out-of-context recall/archival storage, paged via function calls ([arXiv:2310.08560](https://arxiv.org/abs/2310.08560), Packer et al., Oct 2023). Letta is the production company/framework.
- **Sleep-time agents (the important part for you):** Letta creates *two* agents sharing memory blocks — a primary (fast model, answers user) and a sleep-time agent (stronger model) with **exclusive rights to edit shared memory**, running asynchronously during idle periods to turn "raw context into learned context" ([Letta blog](https://www.letta.com/blog/sleep-time-compute/)). Configurable frequency = more tokens for better-revised memory.
- **Results:** 5× test-time compute reduction, +13% GSM-Symbolic / +18% AIME at scale, 2.5× amortization across related queries; gains shrink when queries are unpredictable from context ([arXiv:2504.13171](https://arxiv.org/abs/2504.13171)). [P/V]
- **Maturity:** production framework, self-hostable, active.
- **For us:** the single most directly relevant architecture. Your ingest is bursty and idle time is abundant (overnight); "sleep agent rewrites contact/relationship memory blocks, primary agent reads them" maps 1:1 onto the product. Caveat: their evals are math benchmarks, not personal memory — the *pattern* is proven, the *personal-memory payoff* is not.
- Also note **Letta Filesystem** ([blog](https://www.letta.com/blog/letta-filesystem)) — plain files + grep/open tools as memory, which their own benchmarking suggests is a stronger baseline than most memory products.

### 2.2 Mem0
- **What:** extraction pipeline — LLM extracts salient facts from each turn, then an update phase compares against existing memories and chooses ADD/UPDATE/DELETE/NOOP; optional graph variant ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)).
- **Results:** [V] +26% over OpenAI's memory on LoCoMo (LLM-judge), graph variant only ~+2% over base; 91% lower p95 latency (1.44s vs 17.12s) and ~90% token compression (26K → ~1.8K tokens) vs full-context. **But** their own table shows full-context beating Mem0 on accuracy (~73% vs ~68%) — Mem0 buys latency/cost, not quality; and ConvoMem showed it badly losing to full context at small scale. [I]
- **Maturity:** production SaaS + OSS, widely deployed.
- **For us:** the ADD/UPDATE/DELETE conflict-resolution op-set is a good design to copy; the system itself is optimized for the wrong constraint (multi-tenant latency/cost at massive scale, weak per-user quality). Low fit.

### 2.3 Zep / Graphiti (temporal knowledge graph)
- **What:** Graphiti builds a real-time, **bi-temporal** KG from conversations + business data: episodic subgraph (raw messages) → semantic entity subgraph (entities + relations as edges with `valid_from`/`valid_to`, event-time vs ingestion-time) → community subgraph (cluster summaries). New edges are LLM-compared against semantically related existing edges; contradictions **invalidate** (not delete) old edges, preserving history and enabling point-in-time queries ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956), [Graphiti](https://github.com/getzep/graphiti), [Neo4j writeup](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)).
- **Results:** [V] DMR 94.8% vs MemGPT 93.4%; LongMemEval up to +18.5% accuracy with ~90% latency reduction. Treat magnitudes skeptically (see §3), but the *mechanism* is independently regarded as the most principled treatment of fact evolution.
- **Maturity:** Graphiti OSS (production-grade, supports OpenAI/Anthropic/local LLMs, Neo4j or FalkorDB backend); Zep is the hosted service.
- **For us:** highest-fit open component for the *contact/relationship fact layer* — "Sarah moved from Austin to Seattle in March" is exactly a bi-temporal edge invalidation. Cost caution: graph construction is LLM-heavy per episode (an ideal Batch API workload). You'd likely use Graphiti (self-hosted) rather than Zep (their per-user pricing and multi-tenant design are aimed elsewhere).

### 2.4 LangMem (LangChain)
- **What:** SDK formalizing semantic/episodic/procedural memory with two write paths: **hot path** (agent tools during conversation) and a **background Memory Manager** that extracts, consolidates, updates, and *overwrites facts no longer true* outside the conversation flow ([launch post](https://www.langchain.com/blog/langmem-sdk-launch), [tutorial](https://www.digitalocean.com/community/tutorials/langmem-sdk-agent-long-term-memory)). Storage-agnostic core API.
- **Maturity:** OSS, maintained, tied to LangGraph ecosystem.
- **For us:** the hot-path/background split and its Pydantic-schema-driven profile extraction are the right shape; the library itself is thin enough that reimplementing on Claude-native primitives is cheap. Good design reference, optional dependency.

### 2.5 A-MEM
- **What:** Zettelkasten-inspired agentic memory — each memory saved as a structured "note" (context, keywords, tags, embedding); on insert, the LLM links it to related notes and **evolves** existing notes' attributes in response ([arXiv:2502.12110](https://arxiv.org/abs/2502.12110)). [P]
- **For us:** the "new memory can trigger updates to old memories" idea is valuable for relationship models (a new episode reframes past ones); as a system it's research code. Steal the pattern, not the code.

### 2.6 HippoRAG 1/2
- **What:** hippocampus-inspired non-parametric continual learning: offline LLM-built KG over passages + **Personalized PageRank** at query time for multi-hop association; v2 integrates passages more deeply, matching vanilla RAG on simple QA (avoiding the 5–10 F1 penalty other structure-based methods pay) while gaining +7% on associative memory tasks; cheap indexing (9M vs 115M tokens vs GraphRAG on MuSiQue) ([arXiv:2502.14802](https://arxiv.org/abs/2502.14802), ICML 2025). [P/I]
- **For us:** the strongest evidence that graph-structured memory helps *multi-hop association* ("who introduced me to the person who works at X?") without hurting simple recall. OSS research code; medium engineering effort. The PPR-over-entity-graph retrieval idea composes well with a Graphiti-style graph.

### 2.7 MemoryBank
- **What:** early (2023) long-term companion memory with **Ebbinghaus forgetting-curve** memory strength (decay adjusted by time and re-retrieval) + continual user-profile ("portrait") construction ([arXiv:2305.10250](https://arxiv.org/abs/2305.10250)). [P]
- **For us:** historically important — first to combine decay + evolving user profile. Its ideas are subsumed by later systems; the forgetting-curve *scoring* (not deletion) survives as a retrieval-ranking feature.

### 2.8 Generative agents (Park et al. 2023)
- **What:** the canonical memory stream: every observation stored in natural language; retrieval score = **recency (exponential decay) × importance (LLM-scored 1–10 at write time) × relevance (embedding similarity)**; when summed importance of recent events crosses a threshold (~150), a **reflection** pass asks "what high-level questions do recent memories raise?", answers them with citations, and inserts reflections back into the stream — forming a **reflection tree** (observations = leaves, abstractions = upper nodes) ([arXiv:2304.03442](https://arxiv.org/abs/2304.03442), [ACM](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763)). [I — endlessly replicated]
- **For us:** still the cleanest template for your consolidation loop: importance-triggered, citation-grounded, hierarchical reflection is exactly "episodes → beliefs about a relationship." Its weaknesses (no conflict resolution, no temporal invalidation) are what Graphiti-style mechanisms fix.

### 2.9 MemOS / MIRIX / Memp (mid-2025 wave)
- **MemOS** ([arXiv:2507.03724](https://arxiv.org/abs/2507.03724)): "memory operating system" unifying plaintext/activation/parametric memory in a **MemCube** abstraction with provenance, versioning, migration between memory forms. MIT-licensed, ambitious, heavyweight; the parametric/activation legs violate your no-training constraint anyway. Low fit. [P/V]
- **MIRIX** ([arXiv:2507.07957](https://arxiv.org/abs/2507.07957)): six memory types (Core, Episodic, Semantic, Procedural, Resource, Knowledge Vault) each managed by a dedicated agent under a meta-manager, multimodal. Useful taxonomy validation; eight-agent orchestration is over-engineered for single-user. [P]
- **Memp** ([arXiv:2508.06433](https://arxiv.org/abs/2508.06433)): **procedural** memory — distills past agent trajectories into step-level instructions and script-like abstractions, with explicit Build/Retrieve/Update strategies; transfers from strong to weak models. Relevant later, when your agent learns *how* to handle recurring workflows ("how I schedule with this person"). [P]

### 2.10 Late-2025/2026: what's genuinely new
- **Hindsight** (vectorize-io, Dec 2025; ACL 2026 demo): the current open-source flagship. Retain/Recall/Reflect over four networks (world/episodic + entity/opinion "banks"); recall fuses semantic vectors + BM25 + graph entity/temporal links + time-range filtering via reciprocal-rank fusion + cross-encoder rerank. [V] 91.4% LongMemEval with Gemini-3 Pro, 83.6% with a 20B open model; MIT license, Docker, ~13K stars, Fortune 500 production claims ([arXiv:2512.12818](https://arxiv.org/html/2512.12818v1), [GitHub](https://github.com/vectorize-io/hindsight), [VentureBeat](https://venturebeat.com/data/with-91-accuracy-open-source-hindsight-agentic-memory-provides-20-20-vision)). Benchmark numbers carry the usual caveats, but the multi-strategy recall + explicit "opinion" (belief) store is the closest existing OSS to your requirements. **Highest-priority system to evaluate hands-on.**
- **"Memory in the Age of AI Agents" survey** (Dec 2025, [arXiv:2512.13564](https://arxiv.org/abs/2512.13564)): the field's consolidating taxonomy — **forms** (token-level / parametric / latent) × **functions** (factual / experiential / working) × **dynamics** (formation / evolution / retrieval); companion [paper list](https://github.com/Shichun-Liu/Agent-Memory-Paper-List). Best single map of the space.
- **"Position: Episodic Memory is the Missing Piece"** ([arXiv:2502.06975](https://arxiv.org/pdf/2502.06975)) — argues for explicit episodic stores with single-shot encoding + instance-specific grounding; the intellectual case for keeping raw episodes forever.
- **2026 papers worth tracking** (mostly [P], recent, unreplicated): **HiMem** — hierarchical continuous reconsolidation of episodic detail into semantic knowledge; **EverMemOS** ([arXiv:2601.02163](https://arxiv.org/pdf/2601.02163)) — self-organizing memory OS whose 95.96% LoCoMo claim *exceeds the corrupted-ground-truth ceiling*, i.e., a red flag; **MemRL** — runtime RL over episodic memory (2601); **ES-Mem** — event-segmentation-based episode boundaries ([arXiv:2601.07582](https://arxiv.org/pdf/2601.07582)); **MemGuard** — memory contamination/poisoning defenses ([arXiv:2605.28009](https://arxiv.org/pdf/2605.28009)); **SSGM** — governance of evolving memory, stability/safety framing ([arXiv:2603.11768](https://arxiv.org/html/2603.11768v1)); **"Do Language Models Need Sleep?"** (Lee, McLeish, Goldstein, Fanti, May 2026, [arXiv:2605.26099](https://arxiv.org/abs/2605.26099)) — consolidates context into fast weights in SSM blocks during offline passes; conceptually validates sleep-consolidation but is a *training-side* mechanism, not usable under your constraint; **"Same Ranking, Different Winner"** ([arXiv:2605.24060](https://arxiv.org/pdf/2605.24060)) and **"Anatomy of Agentic Memory"** ([arXiv:2602.19320](https://arxiv.org/pdf/2602.19320)) — further benchmark-methodology criticism; **ICLR 2026 MemAgents workshop** ([proposal](https://openreview.net/pdf?id=U51WxL382H)) — the field now has a dedicated venue. New benchmarks to watch: **MemoryBench, AMemGym, MEMTRACK, LoCoMo-Refined, ConvoMem** (on-policy/interactive evaluation).

---

## 3. Benchmark reality check (decision-relevant)

From the [Benchmark Theatre audit](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/) + [ConvoMem](https://arxiv.org/abs/2511.10523) + [Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory/): [I]

- LoCoMo: 99 score-corrupting errors / 1,540 questions (6.4%); ceiling ≈ 93.6%; scores above it imply the judge credited wrong answers.
- GPT-4o-mini judge accepted 62.81% of adversarially wrong-but-topical answers.
- Every vendor runs its own pipeline with its own prompts; the Mem0/Zep dispute spanned a 26-point range for the *same system*.
- MemPalace claimed 100% on LoCoMo via top_k=50 over 32 sessions (retrieval bypass) + hand-tuned questions; later corrected.
- **Practitioner guidance the audit converges on (and I endorse for this project):** ignore leaderboards; build a full-context baseline and a filesystem-grep baseline *on your own data*; require any memory system to beat them by ≥10 points before adopting it.

---

## 4. Taxonomy and mechanisms

**Episodic / semantic / procedural** is now the consensus three-tier framing (CoALA-lineage; [survey 2512.13564](https://arxiv.org/abs/2512.13564); MIRIX; LangMem). Mapped to your product:
- *Episodic*: raw messages/emails/events, immutably archived with source pointers. Cheap, lossless, always keep.
- *Semantic*: extracted durable facts and beliefs — contact profiles, relationship state, preferences. This is where consolidation, conflict resolution, and temporal validity live.
- *Procedural*: how-to knowledge — per-relationship voice/register, scheduling habits, drafting playbooks (Memp; Claude Skills are effectively hand-authored procedural memory).

**Write policies:** three dominant patterns — (a) *write everything, distill later* (generative agents, episodic-memory position paper); (b) *extract-then-reconcile at write time* (Mem0's ADD/UPDATE/DELETE/NOOP; Graphiti's per-episode entity/edge extraction); (c) *agent-decides via tools* (MemGPT/Letta core-memory edits, Anthropic memory tool). Evidence (LongMemEval, [arXiv:2410.10813](https://arxiv.org/abs/2410.10813)) says granularity matters: indexing round-level chunks with **fact-augmented keys** beats whole-session indexing (+9.4% recall@5, +5.4 accuracy), and **time-aware query expansion** adds 7–11% recall on temporal questions. [I]

**Consolidation/reflection loops:** importance-threshold-triggered reflection with citations (generative agents); scheduled background managers (LangMem); dedicated sleep-time agent with exclusive write access (Letta); nightly Retain→Reflect (Hindsight); hierarchical episodic→semantic reconsolidation (HiMem). The 2026 "Memory for Autonomous LLM Agents" review calls the consolidation step the **most underserved part of the stack** — typically "explicit developer rules or periodic LLM summarization, both fragile and hard to validate" ([arXiv:2603.07670](https://arxiv.org/html/2603.07670v1)). Translation: this is where your differentiation lives, and no off-the-shelf system solves it for you.

**Forgetting/decay:** almost nobody hard-deletes. The workable patterns are (a) decay as a *retrieval-ranking* term (recency exponent in generative agents; Ebbinghaus strength in MemoryBank), (b) *invalidation with history* (Graphiti `valid_to`), (c) *compression* of old episodes into summaries (hierarchical consolidation). A 2026 architectural study ("Control-Plane Placement Shapes Forgetting," [arXiv:2606.15903](https://arxiv.org/pdf/2606.15903)) finds forgetting behavior is determined more by *where* memory-management control sits than by the scoring rule. For a single user with modest data volume, aggressive forgetting is unnecessary — decay-in-ranking + archive-never-delete is the right call.

**Conflict resolution (contact moved cities):** the mature options are Graphiti's LLM contradiction check against semantically-related edges + bitemporal invalidation [I], Mem0's UPDATE/DELETE ops [I], LangMem's consolidation overwrite [V], and A-MEM's memory evolution [P]. Graphiti's is the only one that preserves "was true then, not now" — which you need for context assembly ("when I last talked to Sarah she lived in Austin").

---

## 5. Offline/background computation: precompute vs retrieve-raw

The core economic question. Evidence assembled:

- **Sleep-time compute** ([2504.13171](https://arxiv.org/abs/2504.13171)): precomputing inferences over a known context cuts test-time compute ~5× at equal accuracy and amortizes 2.5× across related queries. Gains are largest when future queries are *predictable from the context* — true for you (queries about contacts/threads you already hold) — and shrink for unpredictable queries. [P]
- **ConvoMem** ([2511.10523](https://arxiv.org/abs/2511.10523)): under ~150 conversations, don't retrieve — stuff full context. Beyond that, hybrid. Implication: per-*relationship* context (one contact's history) will often fit in 1M tokens for years; the *global* corpus won't. [I]
- **LongMemEval** ([2410.10813](https://arxiv.org/abs/2410.10813)): when you do retrieve, precomputed fact extraction on the *index side* (fact-augmented keys, round-level values) reliably buys ~5 accuracy points. [I]
- **Context rot** (Chroma, [research](https://www.trychroma.com/research/context-rot)): 18 models degrade well before window limits (visible by ~50K tokens on some tasks); distractors hurt; ironically, coherent structured haystacks degrade attention more than shuffled ones. So "just use 1M context" is not free — quality argues for curated, precomputed context blocks over raw dumps even when raw fits. [I]
- **Personalization literature** (2025–26): retrieval of raw history (LaMP/PEARL-style) remains a strong baseline; precomputed profiles win on latency/cost; the field trend is **both** — a stable profile document *plus* query-conditioned retrieval of raw items, sometimes with bandit-optimized profile content ([arXiv:2601.12078](https://arxiv.org/html/2601.12078), [arXiv:2606.04547](https://arxiv.org/html/2606.04547), [self-supervised profile generation 2606.05336](https://arxiv.org/html/2606.05336)). [P]
- **Anthropic's own agent guidance:** compaction + structured note-taking + progressive disclosure (agent explores raw data on demand) rather than maximal stuffing ([effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). [V]

**Synthesis:** the evidence supports a **three-layer answer**: (1) precomputed profile/relationship documents as always-loaded context (cheap to cache, fixes context rot, powers voice); (2) precomputed *index enrichment* (facts, entities, temporal keys) for retrieval quality; (3) raw episodes retained and retrievable via search tools for anything the summaries lost — with the agent able to grep/read raw history agentically (the Letta-filesystem lesson). Offline consolidation is what builds layers 1–2, and Batch API + prompt caching make it ~4–20× cheaper than online equivalents.

---

## 6. Anthropic capabilities (verified against current platform docs/skill reference, July 2026)

| Capability | Status | What it gives us |
|---|---|---|
| **Memory tool** (`memory_20250818`) | GA on Messages API (launched Sept 29, 2025) | Client-side `/memories` file directory Claude reads/edits via `view/create/str_replace/insert/delete/rename`; you own the storage backend. [docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) |
| **Context editing** | Beta `context-management-2025-06-27`; `clear_tool_uses_20250919`, `clear_thinking_20251015` | Prunes stale tool results; Anthropic reports 84% token savings on a 100-turn eval, +29% alone, **+39% with memory tool** on internal agentic search. [docs](https://platform.claude.com/docs/en/build-with-claude/context-editing) [V] |
| **Server-side compaction** | Beta `compact-2026-01-12` (Fable 5, Opus 4.6+, Sonnet 4.6+); Managed Agents sessions get it automatically | API auto-summarizes older history into a compaction block — effectively unbounded conversations. [docs](https://platform.claude.com/docs/en/build-with-claude/compaction) |
| **Context windows** | Opus 4.8/4.7/4.6, Sonnet 5/4.6, Fable 5: **1M tokens**, 128K output; Haiku 4.5: 200K. Opus 4.8 at $5/$25 per MTok, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 | Whole-relationship histories fit in one call; no long-context surcharge on Opus 4.8. |
| **Prompt caching** | GA; reads **0.1×** input price, writes 1.25× (5-min TTL) / 2× (1-h TTL); 4 breakpoints; min prefix 1024–4096 tokens by model | Precomputed profile documents as cached prefix = near-free repeated context. [docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| **Batch API** | GA; **50% off input and output**, ≤100K requests/256MB per batch, most complete <1h, caching works inside batches | The offline consolidation engine: nightly reflection over new episodes at half price; stacks with cache reads for ~95% savings on repeated-prefix work. [docs](https://platform.claude.com/docs/en/build-with-claude/batch-processing) |
| **Managed Agents memory stores** | Beta (`managed-agents-2026-04-01`): workspace-scoped stores of ≤100KB text memories, FUSE-mounted into sessions, **per-mutation immutable versions**, redaction, sha256 preconditions | If you build on Managed Agents, versioned memory with audit trail comes free; also a good design template for self-hosted storage. |
| **Context rot** | [Chroma research](https://www.trychroma.com/research/context-rot) | Independent reason to prefer curated context blocks over raw stuffing even within the 1M window. [I] |

---

## What I'd bet on for this project

**Architecture bet — a "sleep-time consolidation over a bitemporal fact store + cached profile documents + raw-episode agentic search" hybrid, built on Claude primitives rather than adopting a memory vendor:**

1. **Raw episodic layer:** every message/email/event archived immutably (SQLite/files), indexed with LongMemEval-style enrichment (round-level chunks, fact-augmented keys, timestamps). Never deleted. The online agent gets grep/search/read tools over it — the 74%-with-grep result says agentic search over raw history is a floor you get almost for free.
2. **Semantic layer: Graphiti (self-hosted)** for contact/relationship facts — bitemporal edges solve the moved-cities problem exactly, and it's the most production-proven OSS mechanism for conflict resolution. Run its LLM extraction through the **Batch API on Haiku 4.5/Sonnet** to control cost. Evaluate **Hindsight** head-to-head before committing — its opinion/entity banks + RRF recall may cover both this layer and retrieval with less glue code.
3. **Profile layer (the sleep-time product):** nightly Batch-API reflection jobs — generative-agents-style, importance-triggered, citation-grounded — that rewrite per-contact and per-relationship **markdown profile documents** (facts + open loops + voice/register notes = your procedural memory) stored in the memory-tool directory format and served as **prompt-cached prefixes**. Letta's two-agent insight applies: the consolidator has exclusive write access; the interactive agent only reads and appends observations.
4. **Context assembly at runtime:** profile doc (cached) + Graphiti slice (as-of-now) + top-k enriched episodes + agentic search fallback; context editing/compaction for long sessions.
5. **Evaluation discipline:** ignore published leaderboards; build a full-context baseline and a filesystem-grep baseline on *your own* mailbox/message history first, judge with two independent models, and require the fancy layers to beat those baselines before they earn their complexity.

Economics check: single-user volume (~10²–10³ messages/day) at Batch+cache pricing puts nightly consolidation in the cents-to-few-dollars/day range even on Sonnet — cost is not the binding constraint; consolidation *quality drift* is.

## Top 3 open questions only experimentation can answer

1. **Where is the precompute/retrieve crossover for *this* corpus?** ConvoMem says full context wins early; context rot says curation wins at scale — but nobody has measured the tradeoff on real multi-channel personal communications (short texts + long email threads + calendar). Needs: full-context vs grep-baseline vs profile+retrieval on your own data, per relationship size.
2. **Does iterative profile rewriting drift or converge?** Nightly LLM rewrites of relationship profiles over months risk compounding errors, lost nuance, and self-reinforcing wrong beliefs (the audit literature's "hard to validate" consolidation problem; MemGuard-style contamination). Needs: longitudinal replay of a year of history with periodic ground-truth spot checks — does citation-grounding + append-only episodic backing keep profiles honest?
3. **Does any of this measurably improve *drafting in the user's per-relationship voice*?** Every benchmark measures QA recall; none measures whether a memory system makes generated messages sound right to the user and the relationship. Needs: A/B drafting evals (profile-only vs profile+retrieved-exemplars vs raw-thread-context) judged by the one user who matters — you.

---

**Sources:** [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute/) · [arXiv:2504.13171](https://arxiv.org/abs/2504.13171) · [MemGPT arXiv:2310.08560](https://arxiv.org/abs/2310.08560) · [Letta filesystem benchmark](https://www.letta.com/blog/benchmarking-ai-agent-memory/) · [Zep arXiv:2501.13956](https://arxiv.org/abs/2501.13956) · [Graphiti](https://github.com/getzep/graphiti) · [Mem0 arXiv:2504.19413](https://arxiv.org/abs/2504.19413) · [Zep rebuttal](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) · [Mem0 re-eval issue](https://github.com/getzep/zep-papers/issues/5) · [Benchmark Theatre](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/) · [ConvoMem arXiv:2511.10523](https://arxiv.org/abs/2511.10523) · [LongMemEval arXiv:2410.10813](https://arxiv.org/abs/2410.10813) · [LangMem](https://www.langchain.com/blog/langmem-sdk-launch) · [A-MEM arXiv:2502.12110](https://arxiv.org/abs/2502.12110) · [HippoRAG 2 arXiv:2502.14802](https://arxiv.org/abs/2502.14802) · [Generative agents arXiv:2304.03442](https://arxiv.org/abs/2304.03442) · [MemOS arXiv:2507.03724](https://arxiv.org/abs/2507.03724) · [MIRIX arXiv:2507.07957](https://arxiv.org/abs/2507.07957) · [Memp arXiv:2508.06433](https://arxiv.org/abs/2508.06433) · [Hindsight](https://github.com/vectorize-io/hindsight) / [arXiv:2512.12818](https://arxiv.org/html/2512.12818v1) / [VentureBeat](https://venturebeat.com/data/with-91-accuracy-open-source-hindsight-agentic-memory-provides-20-20-vision) · [Memory survey arXiv:2512.13564](https://arxiv.org/abs/2512.13564) · [Episodic position arXiv:2502.06975](https://arxiv.org/pdf/2502.06975) · [Memory mechanisms review arXiv:2603.07670](https://arxiv.org/html/2603.07670v1) · [LMs Need Sleep arXiv:2605.26099](https://arxiv.org/abs/2605.26099) · [Chroma context rot](https://www.trychroma.com/research/context-rot) · [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) · [Context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing) · [Pricing docs](https://platform.claude.com/docs/en/about-claude/pricing)
