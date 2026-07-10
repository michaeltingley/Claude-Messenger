# Lane 2: Retrieval state of the art beyond vanilla RAG (July 2026)

_As researched by a dedicated agent; final report verbatim._

All research complete. Here is the full report.

---

# Retrieval State of the Art, Beyond Vanilla RAG — Deep Research Pass (July 2026)

**Scope:** retrieval architecture options for a single-user, self-hosted personal context engine over messages/email/calendar. No fine-tuning; frontier APIs allowed. Maturity ratings: **[Production]** = boring and safe; **[Solid-young]** = works, some rough edges; **[Research]** = paper-grade, expect integration work; **[Contested]** = claims don't survive scrutiny.

---

## 1. Hybrid retrieval, late interaction, sparse, and rerankers

### 1.1 Hybrid (BM25/FTS + dense + fusion) — [Production]
Hybrid retrieval fused with Reciprocal Rank Fusion (RRF) is the uncontested 2026 baseline. RRF is rank-only, sidestepping score-incompatibility between BM25 and cosine scores ([Weaviate explainer](https://weaviate.io/blog/hybrid-search-explained), [Laforge 2026 walkthrough](https://glaforge.dev/posts/2026/02/10/advanced-rag-understanding-reciprocal-rank-fusion-in-hybrid-search/)). Representative evidence: on the WANDS benchmark a tuned hybrid reaches 0.7497 NDCG vs ~0.698 for either BM25 or dense alone (~7.4% lift), and two-stage hybrid+rerank pipelines hit Recall@5 ≈ 0.82 on messy mixed documents ([2026 reference guide](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026)). For personal comms, BM25/FTS is not optional: names, nicknames, addresses, flight numbers, and inside-joke tokens are exactly what dense embeddings miss.

### 1.2 Learned sparse (SPLADE) — [Solid-young, low priority here]
SPLADE learns sparse expansions compatible with inverted indexes; SPLADE-doc variants need zero query-time GPU ([overview](https://www.emergentmind.com/topics/splade-doc), [Wikipedia LSR](https://en.wikipedia.org/wiki/Learned_sparse_retrieval), [SPLADE vs BM25 practitioner writeup](https://suhasbhairav.com/blog/splade-vs-bm25-learned-sparse-retrieval-vs-traditional-keyword-scoring)). Honest read: at single-user scale the marginal gain over BM25+dense+reranker rarely justifies a third index and tuning of regularization/posting-list pruning. Skip unless an eval shows lexical recall gaps.

### 1.3 Late interaction / multi-vector (ColBERT family) — [Solid-young]
Multi-vector retrieval demonstrably beats single-vector on out-of-domain, long-context, and reasoning-heavy retrieval ([PyLate paper](https://arxiv.org/html/2508.03555v1), [ColBERT repo](https://github.com/stanford-futuredata/ColBERT)). Current small-model SOTA line: answerai-colbert-small (2024) → **GTE-ModernColBERT** trained with [PyLate](https://arxiv.org/html/2508.03555v1) → **mxbai-edge-colbert** ([tech report](https://arxiv.org/pdf/2510.14880)) — all locally runnable. Serving has been de-risked: [PLAID](https://arxiv.org/abs/2205.09707) (7–45× speedup) and especially Google's **MUVERA**, which collapses multi-vector scoring into single-vector MIPS via Fixed Dimensional Encodings — ~10% higher recall at 90% lower latency vs PLAID ([Google Research blog](https://research.google/blog/muvera-making-multi-vector-retrieval-as-fast-as-single-vector-search/), [NeurIPS paper](https://arxiv.org/abs/2405.19504)); MUVERA is now implemented in Weaviate/Qdrant/LanceDB. Verdict for this project: a strong option for the *reranking-free local* path, but a cross-encoder reranker over hybrid candidates achieves similar quality with less machinery.

### 1.4 Rerankers, mid-2026 state — [Production; highest single ROI]
Adding a reranker is the best quality-per-effort move in retrieval (Anthropic measured it as the biggest single jump — see §3). Current landscape ([Agentset leaderboard](https://agentset.ai/rerankers), [ZeroEntropy guide](https://zeroentropy.dev/articles/ultimate-guide-to-choosing-the-best-reranking-model-in-2025/), [FutureAGI comparison](https://futureagi.com/blog/best-rerankers-for-rag-2026/), [AIMultiple benchmark](https://aimultiple.com/rerankers)):

| Model | Type | Notes |
|---|---|---|
| **zerank-2** (ZeroEntropy) | API | Tops ELO-style leaderboards (~1638) |
| **Cohere Rerank 4 / 4 Pro** | API | ~1629 ELO; multi-cloud |
| **Voyage rerank-2.5** | API | Fastest tier (~600ms) |
| **jina-reranker-v3** | Open | Listwise, 64 docs at once, 131k ctx, 61.94 nDCG@10 BEIR |
| **Qwen3-Reranker 0.6B/4B/8B** | Open (Apache-2.0) | Strong, 32k ctx — best local pick |
| **bge-reranker-v2-m3**, **mxbai-rerank-v2** | Open | Light, solid baselines |

For a privacy-sensitive corpus, Qwen3-Reranker-0.6B/4B locally is the pragmatic choice; reranking 50–100 candidates on a single GPU/CPU at personal-query volumes is trivial.

---

## 2. Structure-aware and temporal retrieval

### 2.1 GraphRAG → LazyGraphRAG — [Research→Solid-young]
Full [Microsoft GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/) (entity extraction + community summaries) has prohibitive indexing costs. **LazyGraphRAG** ([MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)) defers all LLM work to query time: indexing cost equals vector RAG (0.1% of GraphRAG), and in Microsoft's BenchmarkQED evals it beat all competitors on both local and global queries — *including 1M-token-context vector RAG* — at ~4% of GraphRAG global-search query cost. Industry writeups document 70–97% cost reductions in deployments ([cost-cliff analysis](https://medium.com/graph-praxis/the-graphrag-cost-cliff-how-33-000-became-33-in-eighteen-months-be1b0fbe37e4)). Caveat: it's benchmarked on corpora of documents, not personal chat logs; still Microsoft-library-grade, not turnkey.

### 2.2 RAPTOR (hierarchical summary trees) — [Research, but the *idea* is production-relevant]
[RAPTOR](https://arxiv.org/html/2401.18059v1) recursively clusters and summarizes chunks into a tree; querying can hit any abstraction level. Beat SBERT/BM25/DPR across NarrativeQA/QASPER/QuALITY, +20% absolute on QuALITY with GPT-4; 2025 follow-ups improve it with semantic segmentation and adaptive graph clustering ([Frontiers 2025](https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2025.1710121/full)). No hardened library exists, but the pattern — *pre-computed rollup summaries at multiple granularities (per-thread → per-contact-per-month → per-relationship)* — is exactly what "what was going on with Alice in March" needs, and is cheap to hand-roll for a personal corpus.

### 2.3 KG-augmented retrieval: HippoRAG 2 — [Research]
[HippoRAG 2](https://arxiv.org/abs/2502.14802) (ICML 2025): passage+phrase KG with Personalized PageRank; +7 F1 over NV-Embed-v2 on associative/multi-hop tasks with far cheaper indexing than GraphRAG/RAPTOR/LightRAG ([repo](https://github.com/osu-nlp-group/hipporag)). Relevant if multi-hop ("which friend of Alice's recommended that dentist?") turns out to matter.

### 2.4 Temporal retrieval — who has actually solved time?
The honest answer: **almost nobody, except the bi-temporal knowledge-graph camp, plus boring metadata filtering.**

- **Zep/Graphiti is the clear leader for first-class time.** [Graphiti](https://github.com/getzep/graphiti) (open source, 20k+ stars, Neo4j/FalkorDB backends) maintains a bi-temporal model — four timestamps per fact: event validity (t_valid/t_invalid) and system ingestion (t_created/t_expired). Contradiction closes a fact's validity window instead of deleting it, so *"what was the user's plan in January?"* is directly answerable ([Zep paper, arXiv 2501.13956](https://arxiv.org/abs/2501.13956), [temporal KG explainer](https://www.getzep.com/ai-agents/temporal-knowledge-graph/), [Neo4j writeup](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)). This is the only production-grade system purpose-built for evolving personal facts. **[Solid-young]**
- **Academic temporal IR is still immature.** The 2025 survey ["It's High Time"](https://arxiv.org/html/2505.20243v2) catalogs temporal QA/IR and concludes temporal signals remain poorly integrated into neural retrieval. Point solutions: simple **recency priors** fused with similarity work well and are the documented pragmatic fix ([arXiv 2509.19376](https://arxiv.org/html/2509.19376)); [Ragie ships recency bias as a product knob](https://docs.ragie.ai/docs/retrievals-recency-bias); per-time-span independent retrieval for as-of queries ([construction-docs RAG paper](https://arxiv.org/pdf/2604.14169)); temporal Matryoshka adaptation ([arXiv 2601.05549](https://arxiv.org/pdf/2601.05549)); TimeR4 / TimeRAG iterative temporal decomposition (surveyed in the above). **[Research]**
- **The unglamorous 80% solution:** for "Alice in March," the winning move is structured metadata — every chunk carries contact IDs + timestamps in a real database, and temporal queries become *filter (contact=Alice, ts∈March) → semantic rank within the slice*. No published system beats this for explicit point-in-time questions; the fancy machinery matters for *implicit* time ("does she still work at Figma?" = knowledge-update/fact-invalidation, which is Graphiti's territory).
- **Benchmark warning:** memory-vendor temporal claims are unreliable. Zep reports LongMemEval 63.8% vs Mem0's 49% ([comparison](https://atlan.com/know/zep-vs-mem0/)); Mem0 replicated Zep at 58.44%, Zep countered 75.14% citing misconfiguration ([Zep's rebuttal post](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)); an independent audit found broken ground truth and lenient LLM judges across LoCoMo/LongMemEval vendor runs ([Benchmark Theatre essay](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/)). Treat all these numbers as **[Contested]**.

---

## 3. Contextual retrieval and chunking for conversational data

### 3.1 Anthropic contextual retrieval — [Production technique]
From the [primary source](https://www.anthropic.com/news/contextual-retrieval): prepend a 50–100-token LLM-generated situating context to each chunk before embedding *and* BM25 indexing. Top-20 retrieval failure rate: 5.7% → 3.7% (−35%) with contextual embeddings; → 2.9% (−49%) adding contextual BM25; → **1.9% (−67%) adding a reranker**. Indexing cost ~$1.02 per million document tokens with prompt caching. Also from the same doc: retrieve top-20 (beat top-5/10), and **if the corpus is under ~200k tokens, skip retrieval and stuff the context**. Still winning on 2026 benchmark revisits ([independent 2026 revisit](https://callsphere.ai/blog/vw6g-anthropic-contextual-retrieval-2026-revisit)).

### 3.2 The 2026 successor: contextualized chunk embeddings — [Solid-young]
Voyage's **voyage-context-3** (Jul 2025) encodes chunks *with full document context in the encoder*, no LLM preprocessing: beats OpenAI-v3-large by ~14%, Cohere-v4 by ~8%, Jina-v3 late chunking by ~24%, and Anthropic-style contextual retrieval augmentation by up to 20% on chunk-level tasks ([announcement](https://blog.voyageai.com/2025/07/23/voyage-context-3/), [MongoDB technical blog](https://www.mongodb.com/company/blog/technical/contextualized-chunk-embeddings-combining-local-detail-with-global-context)). **voyage-context-4** (June 29, 2026) adds an MoE backbone, built-in auto-chunking, >32k-token documents, overlapping chunks, at $0.12/M tokens ([announcement](https://blog.voyageai.com/2026/06/29/voyage-context-4/)). This essentially deletes the chunking problem — *if* you accept sending your corpus to MongoDB/Voyage. Open-weight alternative: Jina late chunking (weaker per Voyage's own evals, but local).

### 3.3 Chunking conversational data specifically
The best directly-on-point research is **SeCom** ([ICLR'25, arXiv 2502.05589](https://arxiv.org/pdf/2502.05589)), which compared turn-level, session-level, and summary-based memory granularity for conversation history and found all three lose to **topically coherent segments** (a conversation-topic segmentation model splits sessions); it also found prompt compression (LLMLingua-2) works as retrieval *denoising*. Corroborating practitioner evidence: thread-aware chunking of Slack (chunk by thread, split by tokens within thread) gave +5–6% accuracy over naive chunking ([Slack RAG writeup](https://dev.to/criscmd/how-i-boosted-slack-rag-accuracy-by-5-6-with-smarter-chunking-1kf9)); timestamp-gap grouping for non-threaded chats and sliding windows for chat logs are standard guidance ([Cohere chunking guide](https://docs.cohere.com/page/chunking-strategies), [F22 Labs survey](https://www.f22labs.com/blogs/7-chunking-strategies-in-rag-you-need-to-know/)).

**Synthesis for your data:** message ≠ chunk. Retrieval unit = topic segment (chat) / thread node with quotes stripped (email), each carrying a generated contextual header (participants, date, thread subject, what's being discussed) à la Anthropic — this combines the two strongest results above and is what I'd implement. **[Technique: production-grade; conversational-specific evidence: thin but consistent]**

---

## 4. Long context vs retrieval; one-shot vs agentic (2026)

### 4.1 Context rot is real and measured — [Production-grade evidence]
Chroma's [Context Rot report](https://www.trychroma.com/research/context-rot) tested 18 models (Claude Opus/Sonnet 4, GPT-4.1/4o, Gemini 2.5, Qwen3): performance degrades non-uniformly with input length even on trivial tasks; degradation is *steeper when query–evidence similarity is low* (i.e., real questions, not NIAH); and on LongMemEval, **focused ~300-token prompts dramatically beat full ~113k-token prompts** even with reasoning enabled. Practitioner corpus agrees: models get unreliable at 30–40% below claimed limits ([Redis summary](https://redis.io/blog/context-rot/), [architecture guide](https://glasp.co/articles/context-rot-rag-long-context-hybrid)). Academic side: [Long Context vs. RAG evaluation](https://arxiv.org/pdf/2501.01880). NIAH is misleading: ~99.7% needle recall coexists with ~60% realistic multi-fact recall ([production decision framework](https://tianpan.co/blog/2026-04-09-long-context-vs-rag-production-decision-framework)).

### 4.2 Economics
1–2M-token windows are normal in 2026 and caching cuts repeated-context input cost ~90% ([Gemini long-context docs](https://ai.google.dev/gemini-api/docs/long-context), [caching cost analysis](https://eastondev.com/blog/en/posts/ai/20260227-gemini-long-context-guide/), [prompt-caching guide](https://devtoollab.com/blog/prompt-caching-guide)). But stuffing a whole archive still pays for every token every query (~300× vs retrieving 3k relevant tokens), and a lifetime of messages+email is tens of millions of tokens — it *cannot* fit regardless. The stable 2026 consensus: **long context replaces retrieval below ~200k tokens** (Anthropic's own threshold) **and complements it above** — retrieval/filters select a slice, long context reasons over the slice. For you: a *per-contact dossier* (all Alice history + summaries, often <200k tokens) is a legitimately stuffable, cacheable unit; the whole corpus is not.

### 4.3 Agentic retrieval vs one-shot — [Strong directional evidence]
- Anthropic reportedly dropped embedding search in Claude Code for pure agentic grep/glob/read in May 2025 ("outperformed everything, by a lot" — Boris Cherny), and Windsurf/Cline/Devin/Amp followed ([analysis](https://vadim.blog/claude-code-no-indexing/), [cost-curve argument](https://harrisonsec.com/blog/agent-retrieval-cost-curve-claude-code-grep-vs-rag/)); an Amazon paper at AAAI 2026 measured agentic keyword search at ~94.5% of RAG faithfulness with zero vector store ([reported here](https://buzzgrewal.medium.com/ai-agents-dont-need-vector-search-anymore-inside-the-agentic-search-stack-replacing-rag-in-2026-58efcabe4f6f)). Counter-argument: grep-only loops burn many more tokens per query ([Milvus rebuttal](https://milvus.io/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens.md)).
- Controlled comparison: ["Fishing for Answers"](https://arxiv.org/pdf/2509.04820) — **iterative/agentic retrieval consistently wins on hard multi-hop/indirect questions and loses on easy ones**, at 3–10× token cost ([agentic RAG control-loop overview](https://towardsdatascience.com/agentic-rag-vs-classic-rag-from-a-pipeline-to-a-control-loop/)). Anthropic's multi-agent research system beat single-agent Opus 4 by 90.2% on internal research evals.
- **Implication:** the code-domain lesson transfers because personal comms, like code, live in a *structured, greppable substrate*. The equivalent of "Claude Code + ripgrep" is **an agent with SQL/FTS5/vector-search tools over a message database** (filter by contact, date, thread; then read). Route: one-shot hybrid+rerank for simple/latency-bound lookups; agentic loop for "what's the story with X" questions and drafting-context assembly.

---

## 5. Embedding models and single-node vector infra (2026)

### 5.1 Models
API leaders ([Milvus 2026 comparison](https://milvus.io/blog/choose-embedding-model-rag-2026.md), [2026 benchmark roundup](https://app.ailog.fr/en/blog/news/embedding-models-2026)): **voyage-4 family** (Jan 2026 — first MoE embedding model; voyage-4-large SOTA; all sizes share one embedding space, so you can index with `lite` and query with `large`: [announcement](https://blog.voyageai.com/2026/01/15/voyage-4/)); **voyage-context-4** for contextualized chunks; **Gemini Embedding 2** (best all-rounder per Milvus); **Cohere embed-v4**; OpenAI text-embedding-3-large is now mid-pack. Open/local: **Qwen3-Embedding** (0.6B/4B/8B, Apache-2.0, tops open MTEB v2 ~75 at 8B), **BGE-M3** (most-deployed in production per framework telemetry), and **EmbeddingGemma-308M** for constrained/on-device — best open multilingual model under 500M, <200MB RAM ([Google announcement](https://developers.googleblog.com/en/introducing-embeddinggemma/), [paper](https://arxiv.org/abs/2509.20354)). Matryoshka dims are now table stakes across all of the above (truncate 1024→256 with minor loss, big brute-force-search wins). Privacy tradeoff, honestly: API embeddings mean shipping every message body to Voyage/Google; Qwen3-Embedding-0.6B/4B locally gives up maybe a few nDCG points — at a 10⁵–10⁶-chunk personal corpus with a reranker behind it, that delta likely doesn't matter, but it's unmeasured on your data (see open questions). Caveat: MTEB is single-language public-text retrieval; it does not test SMS-register text ([Mixpeek critique](https://mixpeek.com/curated-lists/best-embedding-models)).

### 5.2 Single-node vector infra
- **sqlite-vec** — brute-force only (fine to ~1M vectors, especially at Matryoshka-256), everything in one SQLite file next to FTS5. Maintenance wobbled in 2025 (repo stale, community forks appeared: [issue #226](https://github.com/asg017/sqlite-vec/issues/226)); releases resumed, latest March 2026 ([PyPI](https://pypi.org/project/sqlite-vec/)); Mozilla Builders-backed ([repo](https://github.com/asg017/sqlite-vec)). **[Solid-young, single-maintainer risk]**
- **LanceDB** — embedded, columnar, zero-copy, native multivector/MUVERA support, versioned data; younger ecosystem, multi-process concurrency limitations ([comparison](https://encore.dev/articles/best-vector-databases), [Go-ecosystem comparison](https://shaharia.com/blog/choosing-embeddable-vector-database-go-application/)). **[Solid-young — best embedded feature set]**
- **DuckDB VSS** — officially experimental; HNSW persistence gated behind an "experimental, not recommended for production" flag; index doesn't compose with WHERE filters ([DuckDB docs](https://duckdb.org/docs/current/core_extensions/vss)). **[Research — not your primary store]**
- **Qdrant** — most mature (Series B 2026, big-name deployments: [benchmarks post](https://callsphere.ai/blog/vector-database-benchmarks-2026-pgvector-qdrant-weaviate-milvus-lancedb)), but a server to run; overkill for one user. **[Production]**

Recommendation: **SQLite (FTS5 + sqlite-vec) as the system of record** — messages, contacts, threads, timestamps, and vectors in one transactional file — with LanceDB as the alternative if you want ANN/multivector headroom. Brute force over ~500k×256d vectors is ~tens of ms; you don't need a vector *server*.

---

## 6. Personal-communications-specific retrieval

- **Email search research (mature but pre-LLM):** Microsoft/Google SIGIR-era work established that email search is dominated by *known-item finding* — people remember sender + rough time, not content keywords — and that time/sender features rival relevance features in ranking ([Characterizing Email Search](https://www.researchgate.net/publication/315873007_Characterizing_Email_Search_using_Large-scale_Behavioral_Logs_and_Surveys), [Understanding Success in Email Search](https://dl.acm.org/doi/10.1145/3077136.3080837), [personalized email search via user history, WWW'21](https://arxiv.org/pdf/2102.07279), [domain adaptation for enterprise email search](https://arxiv.org/pdf/1906.07897), [Search & Discovery in Personal Email Collections, WSDM'22](https://dl.acm.org/doi/10.1145/3488560.3501393)). Design consequence: contact and time filters are *primary* retrieval keys, not metadata afterthoughts.
- **Conversational memory benchmarks:** [LoCoMo](https://www.emergentmind.com/topics/locomo) (1,540 QA over multi-session chats; includes 321 temporal-reasoning questions; humans F1≈88 vs LLM baselines ≈37–42) and [LongMemEval](https://arxiv.org/abs/2410.10813)-style setups (500 questions incl. temporal-reasoning and *knowledge-update* categories over ~115k-token histories) are the closest public proxies for your workload — useful as templates for building your own eval, but vendor numbers on them are unreliable (§2.4).
- **Products:** Rewind → Limitless (local-first life recorder, EFF-audited) was acquired by Meta Dec 2025 and shut down ([Crunchbase](https://www.crunchbase.com/organization/rewind-53b3), [status](https://ucstrategies.com/news/rewind-ai-mac-memory-search-tool-specs-privacy-pricing-2026/)) — validating the category and vacating the self-hosted niche. Memory-layer frameworks (Mem0, Zep, Letta, Cognee) are compared in [independent 2026 tests](https://particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026); Graphiti is the standout piece worth borrowing rather than adopting wholesale.
- No published research solves "retrieval over one person's full multi-channel communications" end-to-end. This is genuinely open territory; the closest assembled pieces are Graphiti (facts over time) + SeCom (conversation chunking) + email-search findings (sender/time-first ranking).

---

## What I'd bet on for this project

1. **One SQLite file as the spine**: raw messages normalized into (message, thread/segment, contact, timestamp) tables; FTS5 for BM25; sqlite-vec (Matryoshka-256/512) for dense; RRF fusion; local **Qwen3-Reranker** on top-50. Contact + time-range filters as first-class query parameters — email-search research says these carry more weight than semantics for personal recall.
2. **Retrieval unit = topical segment / cleaned email-thread node with an LLM-generated contextual header** (participants, date, topic, situating sentence) — the Anthropic contextual-retrieval + SeCom combination; header generation ≈ $1/M tokens with caching. Embeddings: local Qwen3-Embedding by default; voyage-context-4 only if you decide the privacy tradeoff is acceptable.
3. **Time = three cheap layers, not one clever one**: (a) hard time-range filtering for explicit temporal queries; (b) exponential recency prior fused into default ranking; (c) a Graphiti-style bi-temporal *fact* layer only for the extracted profile/relationship facts ("works at", "dating", "planning trip") — never for raw messages. Plus RAPTOR-lite rolling summaries per contact-month, which directly answer "what was going on with Alice in March" and double as draftable dossier material.
4. **Two-speed retrieval**: one-shot hybrid+rerank for lookups; an **agentic loop with SQL/FTS/vector tools over the same store** for hard questions and drafting-context assembly — this is where all the 2026 evidence (Claude Code, Fishing-for-Answers, Chroma's focused-context result) converges. Skip GraphRAG/LazyGraphRAG/SPLADE/ColBERT initially; keep long-context stuffing for sub-200k per-contact dossiers with prompt caching, never for the corpus.

## Top 3 open questions needing experiments

1. **Does contextual augmentation pay off on chat-register text?** Build a 100-query gold eval from your own history (include temporal, knowledge-update, and known-item queries à la LongMemEval/LoCoMo), then A/B: plain hybrid vs +contextual headers vs voyage-context-4 vs +reranker. All published numbers are on documents/wiki text; nobody has measured this on SMS-length noisy threads.
2. **Segmentation boundaries for bursty chat:** topic-segmentation (SeCom-style) vs time-gap heuristics vs whole-thread chunks — measure retrieval accuracy *and* downstream answer quality; the +5–6% Slack result and SeCom both suggest wins, but neither used personal SMS/iMessage-style data.
3. **How far does vector-free agentic search get?** Run the agentic loop with *only* SQL+FTS5 tools vs the full hybrid index, on the hard slice of your eval — measuring quality, latency, and tokens/query. If the Claude Code lesson transfers to personal comms, you may be able to delete half the embedding pipeline; if not, you'll know exactly which query classes need vectors.
