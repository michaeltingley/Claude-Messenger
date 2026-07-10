# The Personal Context Engine: Design-Space Synthesis

*Synthesized July 2026 from eight parallel deep-research lanes (full reports
with sources in `docs/research/`). Business goal: a single-user context
engine over all communications (messages, email, calendar, more later) that
models the user, their contacts, and each relationship; assembles the right
context at the right time; and eventually drafts/sends in the user's
per-relationship voice. Hard constraint: no fine-tuning of custom LLMs.
This document maps the space of possibilities and states opinionated bets —
it is not a finalized design; the architecture stays flexible and the
experiments in §5 decide.*

---

## 1. Findings that multiple lanes converged on independently

These carry the most weight — separate agents researching different regions
of the literature arrived at the same conclusions.

**C1. Raw communications are ground truth; every derived artifact is a
disposable, rebuildable index.** Dot's biggest architectural reversal
(abandoned aggressive summarization, went back to raw logs as authoritative);
the memory lane's "episodic layer, never deleted"; entity-resolution's
span-grounded provenance; verbatim-beats-extracted research. This ratifies
the event-log-first architecture already planned — and it means every
preprocessing idea we ever try is just another derived store we can throw
away.

**C2. The agent-memory benchmark literature is untrustworthy; evaluate on
our own corpus with dumb baselines first.** LoCoMo has ~6.4% corrupted gold
answers; the standard judge accepts 62.8% of wrong-but-topical answers; the
Mem0-vs-Zep dispute spanned 26 points for the same system; a flat file +
`grep` scored 74% — beating sophisticated memory products. Non-negotiable
discipline: any memory/graph/profile architecture must beat (a) full-context
stuffing and (b) filesystem-grep agentic search on our own data before it
earns its complexity.

**C3. For personal communications, metadata beats embeddings.** Email-search
research (people recall sender + rough time, not keywords) and Shortwave's
production architecture (contact/date feature extraction scopes retrieval
before vectors touch anything) agree: contact and time filters are primary
retrieval keys. Hybrid FTS+dense+rerank is the baseline; fancy retrieval
(GraphRAG, ColBERT, SPLADE) is deferred until an eval demands it.

**C4. Offline preprocessing is real and quantified — the answer to
"precompute vs. retrieve" is a three-layer both.** Sleep-time compute: ~5×
test-time savings, gains largest when future queries are predictable from
held context (true for us). PROSE-style validated profile distillation:
+33–47% over edit-inference baselines. Honcho's "dream-time," Letta's
sleep-agents, Hindsight's nightly Reflect — the industry converged on the
same shape:
  - **Layer A (precomputed, always-in):** per-contact/per-dyad profile
    documents, rewritten offline, served as prompt-cached prefixes.
  - **Layer B (precomputed, index-side):** enriched retrieval keys — topical
    segments with contextual headers, extracted facts, temporal keys
    (+5–9 points retrieval accuracy in LongMemEval-style evals).
  - **Layer C (raw, on-demand):** the untouched event log behind agentic
    search tools (SQL/FTS/vector), because layers A–B always lose something.
  The counterweights: context rot (curated beats stuffed even when raw
  fits), and profile-drift risk (iterative LLM rewrites can compound errors
  — profiles must be citation-grounded and periodically re-anchored to raw).

**C5. The dyad (user↔contact relationship) is the genuinely novel object.**
No published system models it as a first-class artifact. The single most
important negative result found: injecting explicit relationship labels
("this is my mom") into generation *decreased* similarity to real human
messages — models infer register better from the dyad's actual transcript.
So: per-relationship voice comes primarily from retrieved real exemplars of
user→that-contact messages, with a distilled "relationship card" as a
hypothesis to test, not an assumption.

**C6. The killer eval is our own held-out sent replies.** Direct lineage:
Panza's data-playback (golden = the email the user actually wrote), EnronSR,
Smart Compose's offline-metrics discipline, PRELUDE's edit-distance-as-cost.
Two novel extensions we'll build: (1) reply-supervised *context-assembly*
scoring — decompose each real reply into the facts it used, measure whether
the assembler surfaced them (recall-only supervision); (2) the live ledger —
every (draft, final-sent) pair logged as normalized edit distance, the
north-star metric all offline evals must predict.

**C7. Acting on behalf demands structural, not behavioral, safety.** The
Replit incident (explicit instructions ignored), EchoLeak (zero-click
injection via one email), OpenClaw's CVE catalog, and Air Canada (an agent's
commitments legally bind the principal) all point one way: deterministic
gates outside the LLM. The policy/audit layer already built is the send
gate this literature prescribes. The full prescription: autonomy ladder per
recipient×topic (L4 "full autonomy" reserved as never for cold outreach,
conflict, boss/lawyer/ex); inbound messages as quarantined data that may
shape content but never control flow (CaMeL pattern); retrieval firewall
per recipient enforced in code; outbound commitment detector as automatic
escalation; immutable provenance-tagged audit log.

**C8. Identity resolution: deterministic-first, LLM on the residue, human
merge queue, reversible merges.** Normalized identifiers (E.164, lowercased
email, per-network handles) resolve ~90% for free; LLMs now hit ~99% F1 on
person matching for the residue but with miscalibrated confidence; no OSS
library ships the merge-review workflow — we build a small one. Relational
aliases ("Mom", "J") are LLM inference over conversational evidence, stored
as alias edges with provenance.

**C9. Single-node SQLite spine; no memory-vendor middleware.** Retrieval,
prior-art, and memory lanes all landed here: one SQLite file (FTS5 +
sqlite-vec, Matryoshka-truncated local embeddings) as system of record; the
Dogsheep/HPI/Timelinize pattern (idempotent per-source importers) for
ingestion; Graphiti's bi-temporal *data model* (valid/invalid × created/
expired timestamps, invalidate-never-delete) for the fact layer whether or
not we run Graphiti itself; Claude-native primitives (memory tool, Batch API
at 50%, prompt caching at 0.1× reads) over Mem0/Zep-class middleware whose
benchmarks are contested and whose designs optimize multi-tenant cost, not
single-user quality.

**C10. Self-hosting is a survival property.** Rewind/Limitless (acquired,
sunset), Dot (shut down), StoryFile (bankrupt) — three personal-memory
products died in 18 months, stranding users' accumulated context. Also:
Recall's lesson that a total-context index is the most valuable file on the
machine (encrypt at rest; the decrypted serving path is the real attack
surface), and the PDS graveyard's lesson that the product is the daily
experience (briefs, recall, drafts), with sovereignty as a property.

## 2. The design space, mapped

The system decomposes into seven mostly-independent subsystems, each with a
menu (details + sources in `docs/research/`):

1. **Ingestion** — per-source idempotent connectors with resumable cursors →
   append-only normalized event log. (Settled pattern; Beeper connector
   exists; Gmail/Calendar next.)
2. **Identity graph** — deterministic keys → LLM adjudication → human merge
   queue; reversible, evidence-carrying merges. (Settled shape; precision
   thresholds need measurement.)
3. **Fact/knowledge layer** — schema-guided, span-grounded LLM extraction;
   bi-temporal facts; Mem0-style ADD/UPDATE/INVALIDATE reconciliation;
   commitment lifecycle tracking. (Options: Graphiti runtime vs. its schema
   on SQLite; extraction granularity/cost frontier open.)
4. **Profile layer** — offline (nightly, Batch API) consolidation into
   per-contact and per-dyad documents: facts + open loops + style/register
   notes, citation-grounded, PROSE-validated against held-out data.
   (The "significant offline preprocessing" hypothesis lives here —
   supported by evidence, guarded by drift experiments.)
5. **Retrieval & context assembly** — hybrid FTS+vector+rerank over topical
   segments with contextual headers; contact/time filters first-class;
   two-speed: one-shot for lookups, agentic SQL/grep loop for hard
   questions; layered context budget well under ~50K tokens per call.
6. **Proactive runtime** — cheap deterministic gate → one frontier
   "attention director" call → Horvitz-style delivery policy (drafts and
   digests over pings); externalized trigger predicates; durable
   queue+cursor+idempotency daemon (DBOS-class or hand-rolled).
7. **Actuation & safety** — the existing policy/audit gate, extended with
   the autonomy ladder, per-recipient context firewall, quarantined inbound
   handling, commitment detector, and the (draft, sent) ledger.

## 3. Opinionated bets (what I'd build, pending experiments)

- Event log in SQLite; derived stores rebuildable; schema is the contract
  (any language can own a stage — the TS-spine decision stands).
- Graphiti's bi-temporal data model, initially as tables + recursive CTEs
  rather than a graph server; revisit if multi-hop queries matter.
- Profile documents in the Claude memory-tool file format, consolidated
  nightly via Batch API by a sleep-time process with exclusive write access;
  interactive agents read-only + append observations.
- Per-dyad drafting = retrieved real exemplars first, relationship card
  second (subject to the §5 ablation); GEPA/DSPy as the offline
  prompt-optimization loop scored by the ensemble judge (style embeddings +
  authorship verifier + cross-family rubric judge).
- Local embeddings (Qwen3-class) + local reranker by default — message
  bodies don't leave the box for indexing; frontier APIs see only assembled
  context at act time.
- Evals before architecture: baselines (C2), then the reply-supervised
  assembly eval, then counterfactual drafting — promptfoo-class harness,
  frozen corpus snapshots, pinned cross-family judges, multi-seed.

## 4. What this does NOT change

- **No fine-tuning** — ratified independently by three lanes (Personal.ai's
  tar pit; Gmail's shared-model-plus-thin-personal-layer convergence;
  retrieval+ICL competitive with PEFT on personalization benchmarks).
  Inspectable, deletable context beats opaque weights, and "delete this
  memory" stays trivially honest.
- **Language/hosting choices** — TS spine + storage-as-contract unaffected;
  hosting needs (RAM headroom, existential backups, encryption at rest)
  already reflected in HOSTING-OPTIONS.md.
- **The built foundation** — the guarded messenger/policy/audit layer is
  precisely the deterministic actuation gate the safety literature demands.

## 5. The experiment agenda (architecture decided here, not in this doc)

Ordered by information-per-dollar:

1. **Baselines-first** (C2): full-context vs. grep-agentic vs. hybrid index
   on ~100 hand-labeled queries over the real corpus. Decides how much
   retrieval machinery to build at all.
2. **Reply-supervised context assembly** (C6): fact-recall@k of the
   assembler against facts real replies used. The backbone regression suite.
3. **Dyad ablation** (C5): exemplars-only vs. +relationship-card vs.
   +explicit-labels, scored by the ensemble judge on held-out sent replies.
   Decides the profile layer's generation role.
4. **ER merge precision** (C8): ~200 hand-labeled candidate pairs; find the
   auto-merge confidence threshold vs. review-queue boundary.
5. **Extraction cost/quality frontier**: full-episode vs. triage-then-
   extract vs. summarize-then-extract on a gold month of history ($ per 1K
   messages vs. fact recall).
6. **Profile drift longitudinal** (C4): replay a year of history with
   nightly consolidation; spot-check profiles against ground truth monthly.
7. **Gate calibration** (proactive lane): silent shadow week; precision/
   recall of needs-reply/urgency/commitment detection vs. own judgments.
8. **Segmentation ablation**: topic-segments vs. time-gap vs. whole-thread
   chunking on retrieval + downstream draft quality.

## 6. Honest unknowns

- Whether relationship cards help or hurt generation (the field's negative
  result vs. PROSE's positive one — directly contradictory priors).
- Whether nightly profile rewriting converges or drifts over months.
- Whether any offline metric predicts the live edit-distance ledger.
- Whether paraphrased cross-contact leakage can be caught mechanically
  (retrieval firewalls stop verbatim leakage; blended knowledge is an open
  research problem).
- The social question no experiment answers cheaply: disclosure of assistant
  use within close relationships (the "Replicant Effect" — suspicion of
  selective AI use corrodes trust retroactively). Policy decision, not
  engineering.
