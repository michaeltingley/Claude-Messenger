# Lane 6: Proactive assistance, context assembly, event-driven runtimes (July 2026)

Scope: single-user personal context engine; event-driven daemon + frontier APIs, no custom training. Maturity scale: **Mature** (production-proven), **Emerging** (usable, active development), **Research** (papers only, adapt ideas not code).

## 1. Proactive LLM Agents: WHEN to act

### Classic foundations (Mature — still the best design theory)
- **Horvitz, "Principles of Mixed-Initiative User Interfaces" (CHI 1999)**: act only when expected utility of action exceeds utility of inaction; scale intervention to confidence (do it / suggest it / stay silent); consider cost of interruption *and* cost of deferral; graceful degradation and easy dismissal. http://erichorvitz.com/chi99horvitz.pdf
- **Attention-Sensitive Alerting (UAI 1999)**: utility-directed mediation of alerts — expected cost of interruption vs. expected cost of delayed review. https://arxiv.org/abs/1301.6707
- **Priorities system (Microsoft, 1998)**: first email-by-urgency system; "expected cost of delayed review" per message. Ancestor of Outlook Focused Inbox. https://www.microsoft.com/en-us/research/publication/attention-sensitive-alerting/

### Modern LLM incarnations (Research → Emerging)
- **Proactive Agent / ProactiveBench (THU, 2024)**: 6,790 events; best system ~66.5% F1 — frontier models are mediocre at deciding when to help. https://arxiv.org/abs/2410.12361
- **ProAgentBench (2026)**: 28K+ events from 500+ hours of real sessions; decomposes proactivity into **(1) timing prediction and (2) assist-content generation** — adopt this decomposition architecturally. Long-term memory + historical context significantly improve timing accuracy. https://arxiv.org/abs/2602.04482
- **"Do Proactive Agents Really Need an LLM to Decide When to Wake?" (2026)**: small temporal-graph model over structured events beats LLM triggering by +16.7 F1 avg, ~11ms/event, ~220 MiB. Cheap structured gating first, LLM only after trigger. https://arxiv.org/abs/2605.30152
- **ContextAgent (NeurIPS 2025)**: predicts "necessity of proactive service" from context + persona. https://arxiv.org/abs/2505.14668
- **Inner Thoughts (CHI 2025)**: agent forms covert "thoughts", speaks only when a thought crosses a motivation threshold — "evaluate silently, interject rarely." https://arxiv.org/html/2501.00383
- **PARE (2026)**: simulated users for evaluating proactive assistants (useful since we can't A/B on one user). https://arxiv.org/pdf/2604.00842
- **CHI 2025 studies**: timing dominates content quality; one deployed study: timing ≈ 40% of variance in acceptance — identical suggestions accepted ~3x more often at appropriate moments (https://arxiv.org/pdf/2602.00880). Also ProActor (RL timing) https://arxiv.org/pdf/2605.24900

### Interruption science (Mature, pre-LLM)
- **Iqbal & Bailey (CHI 2008; OASIS TOCHI 2010)**: defer notifications to task breakpoints; measurably reduces resumption lag/frustration/errors. https://interruptions.net/literature/Iqbal-CHI08.pdf
- Notification-systems survey (deferral vs mitigation taxonomy): https://arxiv.org/pdf/1711.10171

**Takeaway:** converged three-stage pipeline — cheap gate → LLM judgment → delivery policy. No off-the-shelf implementation; assemble it.

## 2. Context Assembly / Context Engineering

- **Anthropic, "Effective Context Engineering for AI Agents" (Sept 2025)**: smallest set of high-signal tokens; just-in-time retrieval via tools over pre-stuffing; compaction; structured note-taking; subagent context isolation. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **Anthropic, long-running harnesses**: multi-window workflows, compaction. https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- **LangChain write/select/compress/isolate taxonomy**: https://www.langchain.com/blog/context-engineering-for-agents ; Lance Martin essay https://rlancemartin.github.io/2025/06/23/context_engineering/
- **Drew Breunig failure taxonomy**: context poisoning / distraction / confusion / clash. https://www.dbreunig.com/
- **12-Factor Agents, Factor 3 ("own your context window")**: recall degrades past ~40% window fill (100K-session analysis). https://paddo.dev/blog/12-factor-agents/
- **Chroma "Context Rot" (2025)**: 18 models; degradation non-uniform with length even on trivial tasks; distractors actively mislead; 200K windows show real loss by ~50K. https://research.trychroma.com/context-rot
- **Context engineering survey (1,400 papers)**: https://arxiv.org/abs/2507.13334
- **Memory middleware** (Mem0 / Zep-Graphiti / Letta): vendor LoCoMo numbers actively disputed (Zep rebuttal of Mem0's comparison; Letta ~83% independent). Treat all benchmark claims skeptically. https://mem0.ai/blog/ai-memory-benchmarks-in-2026 , https://www.developersdigest.tech/blog/best-ai-agent-memory-providers-2026

**No published "context assembly engine" product exists.** Consensus layered design: stable profile card (always in) + just-in-time retrieved episodes (tools) + verbatim recent thread + structured facts/commitments store + compaction summaries.

## 3. Trigger / Importance Classification

- **Horvitz Priorities**: "expected cost of delayed review" is still the right objective.
- **Gmail Priority Inbox (Aberdeen 2010)**: per-user models on social/content/thread/label features.
- **Request/commitment detection**: NAACL 2010 https://aclanthology.org/N10-1142.pdf ; email speech-acts (Cohen/Carvalho). Human annotation of commitments is itself hard. Microsoft patents exist on task detection (US11704552).
- **Reply-necessity prediction**: Yang et al. SIGIR 2017 (request/commitment presence = top feature). https://dl.acm.org/doi/10.1145/3077136.3080782
- **LLM-era**: zero-shot LLM classification competitive with fine-tuned BERT for email tasks; pairwise-ranking urgency beats absolute scoring (https://arxiv.org/pdf/2601.13178).
- **Products**: Superhuman Instant Reply, Shortwave Ghostwriter, Fyxer (78M+ drafts). Market split: "assisted triage" vs "autonomous triage."

**Takeaway:** two-tier triage (cheap features/heuristics → frontier LLM with sender history, outputting {urgency, needs-reply, commitments, suggested action}); relative judgments + calibration vs user feedback beat absolute scores.

## 4. Event-Driven Agent Runtime Patterns

- **Durable execution**: persist step boundaries; replay-safe. Temporal (heavy, overkill single-node), Restate (single binary, durable timers), **DBOS (library over Postgres — 2026 consensus best-fit for single-tenant)**, Inngest (cloud-oriented). https://zylos.ai/research/2026-04-24-durable-execution-agent-runtimes/ , https://www.tiarebalbi.com/en/blog/dbos-vs-temporal-postgres-durable-execution
- Honest single-node alternative: queue + resumable per-source cursor (e.g. Gmail historyId) + idempotency keys on outbound, in SQLite/Postgres.
- **LangGraph "ambient agents"** (their name for exactly this product shape) + OSS Gmail assistant reference: https://www.langchain.com/blog/introducing-ambient-agents , https://github.com/langchain-ai/agents-from-scratch
- **Letta sleep-time agents**: background agents share memory with primary, consolidate while idle — pre-compute context before events arrive. https://www.letta.com/blog/sleep-time-compute/
- **Claude Agent SDK / Managed Agents (April 2026)**: reasoning harness with compaction/subagents/hooks; no native cron/event triggers — you supply the daemon. https://platform.claude.com/docs/en/managed-agents/overview

**Failure-semantics checklist**: resumable cursors (never miss), transactional outbox/idempotency (never double-send), durable timers (never forget), replay-safe steps (LLM calls retryable; sends are not — separate them).

## 5. Scheduling & Temporal Reasoning

- **TriggerBench (2026)**: prospective memory much harder than retrospective; proactive recall decays sharply with context length; models overfit to "always-remind." **Externalize standing triggers into a structured store the daemon evaluates per event.** https://arxiv.org/pdf/2606.23459
- Pre-meeting briefs are commodity (Gemini Daily Brief, Workspace Studio, Copilot meeting prep); LookOut (1999) did it first.
- Durable timers = time-based prospective memory; stored trigger predicates matched by the gate = event-based.

## Lane verdict (agent's bets)

1. Three-stage decision pipeline: deterministic gate → single frontier "attention director" call returning {act|draft|nudge|silent, confidence, rationale} → Horvitz-style delivery policy with breakpoint-aware deferral/digests. Don't ask the LLM whether to wake; ask what to do once woken.
2. Hand-built layered context assembly, <40–50K tokens per judgment call; skip memory-vendor middleware for one user.
3. DBOS or plain queue+cursor+idempotency over Temporal/Inngest; Claude Agent SDK as reasoning harness; steal Letta's sleep-time pattern for idle-time consolidation and pre-computed briefs.
4. Externalized prospective memory (standing rules in DB, matched by gate — never implicit in context).
5. Bias to drafts and digests over pings; interruption only for high-confidence high-urgency.

## Open questions needing experiments (N=1)

1. Gate calibration on real traffic: shadow-mode week, score gate+judge against the user's own labels.
2. Context-composition ablation on a fixed event-replay set: which layers change decisions/draft quality; where does added context hurt.
3. Interjection tolerance: acceptance rate per (confidence band × delivery mode); tune utility thresholds live.
