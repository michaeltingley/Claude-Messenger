# Lane 4: Entity resolution, personal KGs, temporal knowledge (July 2026)

_As researched by a dedicated agent; final report verbatim._

# Research Report: Entity Resolution, Personal Knowledge Graphs & Temporal Knowledge Representation
*(for a single-user, self-hosted personal context engine — current as of July 2026)*

A framing note that shapes every recommendation below: your entity universe is tiny by ER standards (~10²–10⁴ people, ~10⁴–10⁶ messages). Almost all ER tooling and literature is built for 10⁶–10⁹ records. At personal scale, brute-force LLM pairwise comparison is affordable, blocking is nearly trivial, and the hard problems shift from scalability to **precision on sparse records ("Mom", "J"), incremental resolution as new messages arrive, and reversible merges**.

---

## 1. Entity Resolution / Record Linkage

### 1.1 Classical state of the art

- **Fellegi-Sunter probabilistic linkage** remains the dominant classical framework; the best modern treatment is Binette & Steorts, ["(Almost) All of Entity Resolution"](https://arxiv.org/pdf/2008.04443) (survey covering FS, Bayesian ER, blocking, evaluation). Evaluation itself is a research area — entity-centric evaluation frameworks matter because pairwise F1 overstates quality ([arXiv:2404.05622](https://arxiv.org/pdf/2404.05622)).
- The canonical pipeline is unchanged: normalize → block → compare → classify → cluster (transitive closure) → build golden record with survivorship rules ([PuppyGraph ER overview](https://www.puppygraph.com/blog/entity-resolution)).

### 1.2 LLM-assisted ER (2024–2026): do LLMs beat classical on person records?

**Short answer: yes on out-of-distribution and heterogeneous data, and decisively on person-name data; at a per-pair cost that only matters at scale you don't have.**

- **Peeters & Bizer**, ["Entity Matching using Large Language Models"](https://arxiv.org/pdf/2310.11244) (EDBT 2025, [PDF](https://openproceedings.org/2025/conf/edbt/paper-81.pdf)): zero-shot GPT-4 matches or beats PLM matchers (Ditto/RoBERTa) fine-tuned on thousands of pairs; when transferred out-of-distribution, fine-tuned PLMs drop 36–56 F1 points while LLMs stay robust — GPT-4 beat the best transferred PLM by 40–68 F1. Follow-up: [fine-tuning LLMs for EM](https://arxiv.org/html/2409.08185) adds a few more points. Cross-dataset generalization confirmed in [EDBT 2025 deep dive](https://openproceedings.org/2025/conf/edbt/paper-224.pdf).
- **Person-records specifically**: the [OpenSanctions Pairs benchmark](https://arxiv.org/html/2603.11051v1) (2026; 755K labeled pairs, 293 sources, 31 countries, multilingual/cross-script names) shows off-the-shelf LLMs reach **~99% F1 on person/org matching**, substantially beating rule-based baselines. [EnsembleLink](https://arxiv.org/html/2601.21138v1) (2026) shows training-data-free hybrid pipelines (probabilistic core + LLM adjudication of ambiguous pairs) work well on messy person-name tasks (nicknames, suffixes, middle-name variation). Official-statistics agencies are adopting the same hybrid pattern ([SAGE, 2026](https://journals.sagepub.com/doi/10.1177/18747655261422068)).
- **Cost/scaling patterns**: RAG/blocking-based cost reduction for LLM-EM ([arXiv:2602.05708](https://arxiv.org/pdf/2602.05708)), LLM-seeded label propagation ([arXiv:2605.25814](https://arxiv.org/pdf/2605.25814)), design-space studies of match/compare/select prompting ([arXiv:2405.16884](https://arxiv.org/html/2405.16884v3)). Caveats: LLM confidence is poorly calibrated ([arXiv:2509.19557](https://arxiv.org/pdf/2509.19557)) and LLM self-explanations for ER decisions are not fully trustworthy ([arXiv:2606.01210](https://arxiv.org/pdf/2606.01210)) — keep a deterministic-evidence audit trail rather than trusting model rationales.

### 1.3 Production libraries — maturity for single-node

| Library | Maturity | Single-node fit | Human-in-the-loop | Notes |
|---|---|---|---|---|
| [Splink](https://pypi.org/project/splink/) | **High** — MIT (UK Ministry of Justice), Splink 4, active | Excellent (DuckDB backend) | Interactive diagnostics, but **no active-learning/merge-review workflow** | Best transparent Fellegi-Sunter engine; needs structured columns, overkill below ~10⁵ records ([Tilores comparison](https://tilores.io/content/best-open-source-entity-resolution-and-record-linkage-libraries-splink-zingg-dedupe-and-when-to-move-beyond-them/), [Robin Linacre](https://www.robinlinacre.com/introducing_splink/)) |
| [dedupe](https://github.com/dedupeio/dedupe) | Medium — mature but slow-moving (v3.0.2) | Good for small–moderate data | **Active learning is its core design** (console labeling) | Python-native; the classic HITL option ([docs](https://docs.dedupe.io/en/latest/)) |
| [Zingg](https://github.com/zingg/zingg) | Medium | Poor — Spark-native, heavyweight for one node | Active-learning labeling included | Aimed at data-platform teams; OSS/enterprise split unclear ([Tilores](https://tilores.io/content/best-open-source-entity-resolution-and-record-linkage-libraries-splink-zingg-dedupe-and-when-to-move-beyond-them/)) |
| [JedAI](https://github.com/scify/JedAIToolkit) | Medium-low — academic Java toolkit, GUI, batch-oriented | OK | Limited | Strong on schema-agnostic blocking research; awkward as an embedded component |
| [LinkTransformer](https://arxiv.org/pdf/2309.00789) | Medium | Good | No | Transformer-embedding linkage in a pandas-like API |
| Directory of everything: [Awesome-Entity-Resolution](https://github.com/OlivierBinette/Awesome-Entity-Resolution), [data-matching-software list](https://github.com/J535D165/data-matching-software) | | | | |

**Gap finding**: no OSS library ships a good *merge-review UI + reversible merge + survivorship* workflow ([search confirms](https://dl.acm.org/doi/10.1145/3357384.3360316) HITL-ER is mostly academic active-learning work). For a single user you will build a small "proposed merges" queue yourself — that's the industry-standard layered pattern anyway: deterministic exact keys first (email, E.164 phone), then probabilistic/LLM on the residue, human confirms borderline ([WinPure](https://winpure.com/data-matching-identity-resolution/), [Senzing](https://senzing.com/what-is-identity-resolution-defined/), [Dynamics 365 dedup docs](https://learn.microsoft.com/en-us/dynamics365/customer-insights/data/data-unification-duplicates)).

### 1.4 Contact-dedup specifics

- **Normalization keys**: phone → E.164 (`libphonenumber`); email → lowercase, strip plus-tags cautiously; handles are per-network namespaced IDs (never fuzzy-match handles). Deterministic identifier match is the backbone; names are only tie-breakers ([Routine CRM dedup writeup](https://www.routine.co/blog/posts/deduplicate-crm-ai-fuzzy-merge), [Revinate identity resolution](https://www.revinate.com/blog/identity-resolution/)).
- **Nicknames**: mature open lookup tables exist — [carltonnorthern/nicknames](https://github.com/carltonnorthern/nicknames) (~1,100 canonical names, Python/TS/SQL bindings), [diminutives.db](https://github.com/HaJongler/diminutives.db), [nicknames-datasets](https://github.com/FlorianCassayre/nicknames-datasets) (provenance-annotated). These handle "Jon→Jonathan" but **not** relational aliases ("Mom", "J", "the landlord") — that's an LLM-inference problem over conversational evidence (who does the user call Mom?), essentially absent from the ER literature; the closest prior art is an old Google patent on [mining nickname dictionaries from user communications](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8433762). Treat relational aliases as *first-class alias edges with evidence*, not string variants.
- **vCard/CardDAV**: [vCard 4.0 (RFC 6350)](https://datatracker.ietf.org/doc/html/rfc6350) has `RELATED`, `KIND`, `UID` and is the right *interchange/export* format, but real-world interop is notoriously poor — vendors still emit divergent vCard 3.0 dialects ([Rossini, "The sad story of the vCard format"](https://alessandrorossini.org/the-sad-story-of-the-vcard-format-and-its-lack-of-interoperability/), [CalConnect devguide](https://devguide.calconnect.org/vCard/vcard-4/)). Use CardDAV as an ingest source and optional sink; do not make it your canonical store.

**Maturity rating: classical ER = mature; LLM-ER = production-viable in 2026 (with calibration caveats); personal-contact-specific ER = immature, you'll assemble it.**

---

## 2. Personal Knowledge Graphs

### 2.1 Academic PKG literature

- Foundational: **Balog & Kenter, "Personal Knowledge Graphs: A Research Agenda"** (ICTIR 2019) — defines PKG as structured info about entities *personally related to the user*, with the user as root node ([ResearchGate](https://www.researchgate.net/publication/336110714_Personal_Knowledge_Graphs_A_Research_Agenda)).
- **Skjæveland, Balog et al., "An Ecosystem for Personal Knowledge Graphs: A Survey and Research Roadmap"** (2023/2024, AI Open) — the best current map: PKG vs personal data store vs personal knowledge base distinctions, provenance, access control, lifecycle ([arXiv](https://arxiv.org/html/2304.09572v2), [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2666651024000044)). Companion artifact: [PKG API + vocabulary](https://arxiv.org/pdf/2402.07540) (RDF-based, Solid-flavored). Also [Chakraborty et al., comprehensive PKG survey](https://wires.onlinelibrary.wiley.com/doi/abs/10.1002/widm.1513) (WIREs 2023).
- Honest assessment: this literature gives you *vocabulary and requirements* (provenance per assertion, user control, partial/sparse data as the norm) but **no production-tested schema**. The agent-memory world (Section 3) has overtaken it in practical output. Schema pragmatics: start from schema.org `Person`/`Event` and Graphiti-style typed entities rather than FOAF/RDF ontologies.

### 2.2 Storage: property graph vs RDF vs relational-with-graph-queries (single-node, 2026)

- **Kùzu is dead as a safe bet**: Kùzu Inc. archived the repo Oct 10, 2025 (team acqui-hired by Apple); community forks exist — **LadybugDB**, Kineviz's **bighorn**, **RyuGraph** — but none has clearly won, and "maybe six people understand the codebase" ([The Register](https://www.theregister.com/2025/10/14/kuzudb_abandoned/), [HN thread](https://news.ycombinator.com/item?id=45560036), [G.V() landscape post](https://gdotv.com/blog/kuzu-legacy-embedded-graph-database-landscape/)). Graphiti has already marked its Kuzu backend deprecated ([Graphiti README](https://github.com/getzep/graphiti/blob/main/README.md)).
- **DuckDB + DuckPGQ**: SQL/PGQ (SQL:2023) graph pattern matching, shortest-path, persistent property graphs since v0.1.0; still a community extension under active development — good, not yet boring ([DuckDB docs](https://duckdb.org/docs/current/guides/sql_features/graph_queries), [duckpgq.org](https://duckpgq.org/), [DuckDB fraud-analysis walkthrough, Oct 2025](https://duckdb.org/2025/10/22/duckdb-graph-queries-duckpgq)).
- **SQLite + recursive CTEs**: entirely adequate for graphs in the tens-of-thousands-of-nodes range; proven pattern including bi-temporal edges + FTS5 + vector-BLOB fusion in one file ([dev.to writeup + repo](https://dev.to/rohansx/sqlite-as-a-graph-database-recursive-ctes-semantic-search-and-why-we-ditched-neo4j-1ai), [SQLite CTE docs](https://sqlite.org/lang_with.html), [simple-graph HN](https://news.ycombinator.com/item?id=25544397)). Limitation: complex Cypher-style path predicates get painful.
- **Neo4j Community / FalkorDB**: the pragmatic "real graph DB on one node" options — both run in a single Docker container and are Graphiti's recommended backends ([Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)).
- **RDF**: no meaningful 2026 momentum for this use case; the PKG-API line is the exception and is academic ([PKG API](https://arxiv.org/pdf/2402.07540)).

**Pragmatic 2026 call**: relational core (SQLite/Postgres) as source of truth for raw messages + resolved identities, with either (a) recursive-CTE graph queries, or (b) Neo4j/FalkorDB *if* you adopt Graphiti. Avoid betting the canonical store on a young embedded graph engine.

---

## 3. Temporal Knowledge Representation

### 3.1 Graphiti / Zep — the reference implementation

- **Architecture** ([arXiv:2501.13956](https://arxiv.org/html/2501.13956v1), [GitHub](https://github.com/getzep/graphiti)): episodes → LLM extraction of entities + relation edges; each edge carries **four timestamps** (t_valid, t_invalid in world time; t_created, t_expired in system time) — true bi-temporality. New edges are LLM-compared against semantically-related existing edges; temporal contradictions **invalidate** (never delete) old edges, giving point-in-time reconstruction and stale-vs-current disambiguation ([Zep temporal KG explainer](https://www.getzep.com/ai-agents/temporal-knowledge-graph/), [Neo4j blog](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)).
- **Custom entity/edge types via Pydantic models** — directly usable for Person/Relationship/Commitment/LifeEvent schemas ([docs](https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types)).
- **Costs**: ingestion is LLM-heavy (multiple calls per episode; one third-party assessment measured 600K+ tokens for a long conversation, ~300ms retrieval) — fine for batch personal ingest, a real dollar cost at full-history backfill ([Codex assessment, Mar 2026](https://codex.danielvaughan.com/2026/03/30/graphiti-agent-memory-store/)).
- **Maturity: production-grade** (peer-reviewed architecture, wide 2025–26 adoption), but benchmark claims in this space are contested — see the Mem0-vs-Zep LoCoMo dispute below.

### 3.2 The broader agent-memory field (context for build-vs-adopt)

- [Mem0 (ECAI 2025, arXiv:2504.19413)](https://mem0.ai/blog/state-of-ai-agent-memory-2026) — extract-then-update pipeline (ADD/UPDATE/DELETE/NOOP against existing facts); reports 92.5% LoCoMo / 94.4% LongMemEval at ~7K tokens/retrieval. Zep published a rebuttal claiming misconfiguration; independent evals put Letta ~83% on LoCoMo ([comparison roundups](https://www.developersdigest.tech/blog/best-ai-agent-memory-providers-2026), [benchmark overview: LoCoMo/LongMemEval/BEAM](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)). **Treat all vendor numbers as marketing-adjacent**; the durable takeaways are the *mechanisms*: extract→compare→update-or-invalidate, and temporal edges.
- [Chronos](https://arxiv.org/pdf/2603.16862) (2026): structured event retrieval with multi-resolution temporal normalization (NL time → ISO-8601 ranges) — the right pattern for "we're moving in June."

### 3.3 Fact-versioning patterns

- **Valid-time vs transaction-time (bi-temporal) modeling** is a solved database pattern: [XTDB](https://docs.xtdb.com/about/time-in-xtdb.html) is the reference OSS implementation (valid time settable retroactively; transaction time append-only; consistent point-in-time snapshots) ([bitemporality docs](https://v1-docs.xtdb.com/concepts/bitemporality/), [Thoughtworks Radar](https://www.thoughtworks.com/radar/platforms/xtdb)). You don't need XTDB itself — the pattern ports to any store as `(fact, valid_from, valid_to, recorded_at, invalidated_at, source_ref)`, exactly Graphiti's edge shape.
- Personal-context nuance the literature underweights: valid time is usually *stated vaguely* ("since last spring") — store both the normalized interval and the original utterance + confidence.

**Maturity: bi-temporal representation = mature pattern; LLM-driven fact invalidation = works but noisy, needs evidence links and human override.**

---

## 4. Information Extraction from Personal Communications

- **OpenIE lineage vs schema-guided**: consensus has moved decisively to **schema-guided extraction with LLMs**; open extraction errors propagate and amplify downstream ([LLM-empowered KG construction survey, arXiv:2510.20345](https://arxiv.org/html/2510.20345v1)). The best hybrid is **EDC (Extract–Define–Canonicalize)**: open-extract, then define, then normalize into your schema — useful when your fact schema is still evolving ([survey](https://arxiv.org/html/2510.20345v1), [rethinking-KGC position paper](https://arxiv.org/pdf/2601.09069)).
- **Hallucination controls**: the strongest practical control is **span-grounding/provenance** — require every extracted triple to be traceable to a source-text span; untraceable elements are flagged as hallucinations (anchor-constrained extraction with exact/fuzzy/schema/text-search restoration, [MDPI Computers 2026](https://www.mdpi.com/2073-431X/15/3/178); KG-eval with hallucination/omission metrics, [ESWC](https://dl.acm.org/doi/10.1007/978-3-031-81221-7_3)). For a personal engine this doubles as your trust UI: every profile fact links to the message that produced it.
- **Incremental extraction + fact dedup**: the Mem0-style loop (retrieve similar existing facts → LLM decides ADD/UPDATE/DELETE/NOOP) is the de-facto standard for conversational fact streams; Graphiti's edge-invalidation is the graph-native equivalent (Section 3). Episodic segmentation + per-chunk extraction, persona vs event separation: [LD-Agent, NAACL 2025](https://aclanthology.org/2025.naacl-long.272.pdf).
- **Commitments/requests**: a mature pre-LLM literature exists — Microsoft's commitment detection in email ("I'll send it by Friday"), including [domain adaptation](https://www.microsoft.com/en-us/research/publication/domain-adaptation-for-commitment-detection-in-email/) and commitment *lifecycle* (creation/delegation/discharge/cancellation) patents ([US9170993](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9170993), [US10361981](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10361981)); complexity analysis in [Lampert et al.](https://aclanthology.org/U08-1009.pdf); email event/argument extraction benchmark [MAILEX](https://arxiv.org/pdf/2305.13469) (finding: even few-shot GPT-4 struggled vs fine-tuned models on fine-grained email event *arguments* — schema-guided extraction with tight schemas matters). Modern LLMs make the *classification* easy; the lifecycle state machine (created→discharged/cancelled) is the part worth copying.
- **Person-understanding consolidation**: [PersonaTree (2026)](https://arxiv.org/abs/2606.04780) — three-level evidence→claim hierarchy with conservative writes and confidence-guided consolidation; top scores on 12/18 settings across six benchmarks. This "claims supported by evidence paths" shape is exactly right for contact profiles.

**Maturity: schema-guided LLM extraction = production-viable; extracted-fact dedup = emerging-but-converged pattern; conversational commitment lifecycle tracking = old research, no maintained OSS — rebuild with LLMs.**

---

## 5. Relationship (Dyad) Modeling

- **Classic**: [Gilbert & Karahalios 2009, "Predicting Tie Strength With Social Media"](https://dl.acm.org/doi/10.1145/1518701.1518736) — 74+ features over 7 Granovetter dimensions (intensity, intimacy, duration, reciprocal services, structural, emotional support, social distance) predicted strong/weak with ~85% accuracy; extended cross-platform in [2012 CSCW follow-up](https://dl.acm.org/doi/10.1145/2145204.2145360). Its *dimension inventory* is still the best feature checklist for a relationship profile.
- **Modern survey**: ["A Comprehensive Analysis of Social Tie Strength" (arXiv 2024/25)](https://arxiv.org/html/2410.19214v2) — covers definitions, prediction methods (structural, interactional, ML), and open problems; also graph-theoretic [tie strength inference in temporal networks](https://arxiv.org/pdf/2206.11705).
- **Communication-metadata signals — with a big caveat**: call/SMS frequency does predict self-reported closeness in ego-network studies (Saramäki et al.; ["social signatures"](https://link.springer.com/article/10.1007/s42001-019-00054-8), [Dunbar-number call studies](https://www.sciencedirect.com/science/article/pii/S0378873316301095), [smartphone+survey validation](https://pmc.ncbi.nlm.nih.gov/articles/PMC6107109/)), **but** the CSCW result ["You Never Call, You Never Write"](https://dl.acm.org/doi/pdf/10.1145/2675133.2675143) shows logs mislead in both directions: strong ties with zero digital traffic (co-present family) and heavy-traffic weak ties (logistics contacts). Implication: compute cadence/recency/reciprocity/channel-diversity as *features*, but let LLM-extracted content signals (roles: "sister", "my manager"; intimacy of topics; formality of register) dominate the closeness/role estimate.
- **Dyadic state beyond tie strength** (formality, roles, cadence expectations) has essentially **no off-the-shelf computational treatment** — this is one of your genuinely novel components. Nearest neighbors: PersonaTree (individual persona, not dyad) and CRM-world "relationship scores" (proprietary).

**Maturity: tie-strength-from-metadata = well-studied but noisy; dyadic relationship-state modeling = open territory.**

---

## What I'd Bet On for This Project

1. **Identity layer: deterministic-first hybrid, not an ER framework.** Normalized identifier keys (E.164, lowercased email, per-network handle IDs) resolve ~90% of unification for free; LLM pairwise adjudication (with nickname-table features and shared-context evidence) on the small residual; every merge stored as a reversible, evidence-carrying edge with a human-confirm queue for borderline cases. Skip Splink/dedupe/Zingg at this scale — adopt their *concepts* (blocking on identifier+name-key, Fellegi-Sunter-style evidence weights for explainability), not their runtimes.
2. **Temporal facts: Graphiti's data model, whether or not you run Graphiti.** Bi-temporal, invalidate-don't-delete edges with source-span provenance is the correct representation, validated in production. Run Graphiti (Neo4j/FalkorDB backend) if you want speed-to-value and accept LLM ingest cost; reimplement its edge schema over SQLite/Postgres + recursive CTEs if you want a minimal, durable, single-file-backup system. Do **not** build on Kùzu.
3. **Extraction: schema-guided, span-grounded, Mem0-style update loop.** Tight Pydantic schemas per fact class (attribute, relationship, life event, commitment with lifecycle state), mandatory source-span traceability as the hallucination gate, and an extract→compare-to-existing→ADD/UPDATE/INVALIDATE step so facts dedupe at write time. Relationship profiles as PersonaTree-style claims-with-evidence, combining metadata cadence features with content-derived role/closeness signals (weighted toward content, per the "You Never Call" result).

## Top 3 Open Questions Needing Experiments

1. **LLM merge precision on sparse personal records**: on *your* real contact graph, what's the false-merge rate when the only evidence is a display name + shared conversational context (the "J" / "Mom" / two-Jonathans problem)? Experiment: hand-label ~200 candidate pairs from your own data; measure LLM adjudication precision/recall vs a nickname-table + identifier baseline; find the confidence threshold where auto-merge is safe vs queue-for-review. (LLM confidence is known to be miscalibrated — [arXiv:2509.19557](https://arxiv.org/pdf/2509.19557) — so this threshold must be measured, not assumed.)
2. **Fact-invalidation quality at personal-life granularity**: Graphiti's LLM contradiction detection is validated on assistant-dialog benchmarks, not on multi-channel personal history where the same fact arrives in different phrasings across WhatsApp/email/months. Experiment: seed a graph with ~50 evolving facts (moves, jobs, relationships) fed through realistic message sequences; measure wrong-invalidation and missed-invalidation rates, and whether valid-time gets set from utterance time vs message time correctly.
3. **Backfill cost/quality frontier**: full-history LLM extraction can hit 10⁵–10⁶ tokens per long thread ([Codex assessment](https://codex.danielvaughan.com/2026/03/30/graphiti-agent-memory-store/)). Experiment: compare (a) full-episode Graphiti-style ingest, (b) cheap-model triage → strong-model extraction only on fact-bearing messages, (c) daily/thread-level summarize-then-extract — on extraction recall of a hand-built gold fact set from ~1 month of your own history, with dollar cost per 1K messages for each.
