# Lane 5: Prior art — products, OSS, published architectures (July 2026)

_As researched by a dedicated agent; final report verbatim._

All research complete. Here is the full prior-art map.

# Prior Art Map: Personal Context Engines over Communications (as of July 2026)

Scope: every significant product, OSS project, and published architecture attacking "model the user + their contacts from their communications, surface context, act on their behalf." For each: ingestion, storage/index, memory representation, privacy architecture, and the single most transferable lesson.

---

## Category 1 — Personal AI Memory Products

### Rewind → Limitless → Meta (acquired Dec 2025)
- **History**: Rewind (2022) pioneered local-first Mac screen+audio capture with on-device OCR/ASR into a local searchable store; $350M-valuation Series A in 2023. Pivoted in April 2024 to the Limitless Pendant ($99 wearable, 100-hr battery) and moved the Mac app to a cloud-connected architecture. Meta acquired Limitless Dec 2025, killed Pendant sales, and disabled Rewind's screen/audio capture on Dec 19, 2025 ([TechCrunch pivot coverage](https://techcrunch.com/2024/04/17/a16z-backed-rewind-pivots-to-build-ai-powered-pendant-to-record-your-conversations/), [WinBuzzer on the Meta acquisition/sunset](https://winbuzzer.com/2025/12/05/meta-acquires-ai-wearables-startup-limitless-kills-pendant-sales-and-sunsets-rewind-app-xcxwbn/), [rewind.ai timeline page](https://rewind.ai/what-happened-to-rewind/)).
- **Privacy architecture**: Limitless "Confidential Cloud" — encryption at rest with HSM-held keys, plus optional per-meeting end-to-end-encrypted "Lockdown" mode ([Limitless privacy doc](https://help.limitless.ai/en/articles/9130680-privacy-with-limitless)).
- **Lesson (negative)**: Local-first capture was the identity of the product; the cloud pivot alienated the earliest privacy-motivated users ([early-adopter critique](https://andrewschreiber.substack.com/p/an-early-adopters-thoughts-on-rewindais)), and the acquisition-then-sunset stranded everyone's "lifetime memory." **A personal memory product dies when its host company does — self-hosting is a genuine structural advantage, not just a preference.**

### Microsoft Recall — the security saga
- **v1 (May 2024)**: snapshots + OCR text in an effectively **plaintext SQLite DB readable by any user process**; Alexander Hagenah's [TotalRecall](https://github.com/xaitax/TotalRecall) trivially dumped it; Microsoft pulled the feature.
- **v2 (April 2025 relaunch)**: rebuilt on VBS enclaves, AES-256-GCM, Windows Hello, Protected Process Light for keys.
- **v2 broken anyway (March 2026)**: "TotalRecall Reloaded" injects a DLL into `AIXHost.exe` and calls Recall's **legitimate COM interfaces after enclave decryption** — the crypto held; the *rendering/consumption path* leaked. Microsoft closed the case as "by design" ([GovInfoSecurity](https://www.govinfosecurity.com/microsoft-recall-again-spills-secrets-a-31083), [iTnews](https://www.itnews.com.au/news/microsoft-says-new-windows-recall-bypass-isnt-a-vulnerability-624918)).
- **Lesson (negative, twofold)**: (1) An index over everything you've ever seen is a *concentrated target* that changes your threat model — encrypt at rest from day one and assume the DB will be found. (2) **The decrypted-consumption path is the real attack surface**: whatever process serves context to the LLM/UI holds the crown jewels, no matter how good the vault is.

### Personal.ai
- **Architecture**: "Memory Stack" of user-controlled "Memory Blocks" (time, source, scope, text) built from everyday communications; a per-user "Personal Language Model" (small models: BERT/BART/RAG/GPT-style composites) retrained continuously in minutes, with a ranker scoring relevancy/fluency/style and a "Personal Score" ([personal.ai memory page](https://www.personal.ai/memory), [PLM vs LLM](https://www.personal.ai/plm-personal-and-large-language-models)).
- **Trajectory**: pivoted hard from consumer "digital twin" to enterprise/branded personas.
- **Lesson (negative)**: Per-user *model training* is the tar pit — expensive, opaque, hard to edit/delete from, and consumers didn't want to hand-curate memory blocks. **Retrieval over an editable store beats training a user model; keep the profile inspectable and deletable.**

### New Computer's Dot (shut down Oct 5, 2025)
- The most instructive architecture in this whole category. Sam Whitmore's published breakdown ([Leverage interview](https://www.leverage.to/learn/dev/ai_memory/sam), [memory talk](https://x.com/sjwhitmore/status/1856328757180567675)) describes **four parallel memory systems queried simultaneously**:
  1. **Holistic theory-of-mind** ("who am I, what matters to me, what am I working on") — *always in context*;
  2. **Episodic** (daily/weekly time-based summaries);
  3. **Entity** (people/places/concepts) — they **stripped out elaborate JSON schemas because structure didn't improve retrieval**; moved to hybrid BM25 + semantic + keyword;
  4. **Procedural** (learned behaviors triggered by *situational*, not semantic, similarity).
- **Evolution**: as 1M-token contexts got cheap they **abandoned aggressive compression/summarization and query raw conversation logs as the authoritative source**; summaries became a routing layer. Whitmore's forward claim: the most valuable memory is *the AI's own interpretive analysis of the user*, not raw recall.
- **Fate**: shut down because founders' visions diverged; users got a data-export window ([TechCrunch](https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down/)).
- **Lesson (positive)**: **Separate memory types by function (identity / episodic / entity / procedural), keep the identity model always-in-context, and treat raw logs — not extracted facts — as ground truth.** Premature schema-heavy extraction destroys nuance.

### Wearable memory backends: Bee (→ Amazon), Omi, Friend
- **Bee** ($50 bracelet + $19/mo): continuous ASR → cloud; builds user knowledge from recordings **fused with Gmail, Google Calendar, and phone contacts**; acquired by Amazon July 2025, relaunched Jan 2026 ([TechCrunch acquisition](https://techcrunch.com/2025/07/22/amazon-acquires-bee-the-ai-wearable-that-records-everything-you-say/), [why Amazon bought it](https://techcrunch.com/2026/01/12/why-amazon-bought-bee-an-ai-wearable/)). Notably it deletes raw audio and keeps derived text/facts.
- **Omi** (Based Hardware, formerly their "Friend"): fully **open-source** wearable stack — BLE audio → FastAPI cloud backend → transcripts → structured "memories," action items, chat ([GitHub](https://github.com/BasedHardware/omi), [architecture overview](https://deepwiki.com/BasedHardware/omi)). Best open reference implementation of audio→memory pipelines.
- **Friend.com** (Avi Schiffmann, ex-"Tab"): always-listening companion pendant; drew the strongest consent backlash of the group.
- **Lesson**: **Keep derived artifacts (transcripts, facts, summaries) and aggressively discard raw capture** — Bee's audio-deletion policy is the pattern that survived acquisition diligence; and bystander/counterparty consent is the unsolved social problem for anything that models *other people*.

---

## Category 2 — AI Email/Comms Assistants & "Chief of Staff" Agents

### Shortwave — the best-published architecture in the space
Sources: [their deep-dive blog post](https://www.shortwave.com/blog/deep-dive-into-worlds-smartest-email-ai/) (fetched in full), [Pinecone RAG Brag](https://www.pinecone.io/blog/rag-brag-with-shortwave/), [ZenML LLMOps case study](https://www.zenml.io/llmops-database/building-a-production-grade-email-ai-assistant-using-rag-and-multi-stage-retrieval).
- **Pipeline**: 4 stages — (1) LLM **tool selection** (CurrentThread / EmailHistory / Calendar / Compose / none), (2) parallel retrieval, (3) **one single big question-answering LLM call**, (4) post-processing with citations. They explicitly rejected long LLM chains: "data loss and errors at each stage."
- **Retrieval**: LLM **query reformulation** ("What about Jonny?" → standalone query) → parallel **feature extraction** (date ranges with confidence, contact names, keywords, labels) → embedding search (Instructor model, self-hosted GPUs) in **Pinecone with per-user namespaces**, scoped by extracted metadata → **heuristic rerank** (Gaussian temporal filter, contact-mention boost, label match, recency, demote Promotions) → **cross-encoder rerank** (MS Marco MiniLM on GPU) → assemble. ElasticSearch handles full-text. 3–5s end-to-end via concurrency/streaming.
- **Memory**: user-taught "AI Memories" — natural-language standing instructions ("remember I prefer short replies") applied to behavior/drafting ([docs](https://www.shortwave.com/docs/guides/ai-assistant/)).
- **Lesson (positive, load-bearing)**: **Email RAG is a hybrid-retrieval problem, not a vector-search problem.** Metadata (contacts, dates, labels) does more work than embeddings; a rerank cascade (cheap heuristics → cross-encoder) is the proven shape; and one well-fed LLM call beats agentic chains for QA quality.

### Superhuman (+ Grammarly merger)
- **Auto Drafts**: monitors inbox, detects reply-needed emails, and pre-writes replies **in the user's voice, learned from sent mail**, enriched with CRM/tool context ([Superhuman/Grammarly](https://www.grammarly.com/blog/company/introducing-new-superhuman/), [TechCrunch on rebrand + Superhuman Go](https://techcrunch.com/2025/10/29/grammarly-rebrands-to-superhuman-launches-a-new-ai-assistant/)).
- **Lesson (positive)**: The winning UX for "send on my behalf" is **pre-drafted, human-approved** — drafts appear ready in the drafts folder; the user's send click is the permission gate. Nobody successful auto-sends.

### Gmail lineage: Smart Reply → Smart Compose → Gemini Personal Intelligence
- Smart Reply: seq2seq over a curated whitelist. Smart Compose: large shared LM **plus a light per-user LM adapted to personal mail for style** ([Smart Compose paper](https://arxiv.org/pdf/1906.00080)). Jan 2026 "Personal Intelligence": opt-in Gemini grounding across Gmail/Photos/YouTube/Search, personalized suggested replies matching your tone, explicit "no training on your data" ([Google blog](https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/), [Gmail Gemini-era post](https://blog.google/products-and-platforms/products/gmail/gmail-is-entering-the-gemini-era/)).
- **Lesson**: A decade of Google iteration converged on **shared reasoning model + thin per-user style/context layer + opt-in per-source grounding** — exactly the no-custom-training stance; also, constrained suggestions (Smart Reply chips) shipped years before free generation because precision-over-coverage wins trust.

### Notion AI / Beeper / Clay
- Notion 3.0 agents: memory via **human-readable "agent instruction pages"** inside the workspace itself ([Notion AI](https://www.notion.com/product/ai)) — memory as editable documents, not opaque state.
- **Beeper (Automattic)**: July 2025 relaunch moved bridge connections **on-device** (restoring E2EE boundaries), with an explicit roadmap of **local, opt-in AI** (summarization, classification, "BeepMate") and the **Clay personal-CRM acquisition** to fuse message history into contact profiles — "with Beeper, Clay can ingest more interactions… 2x to 10x better" ([TechCrunch](https://techcrunch.com/2025/07/16/beepers-all-in-one-messaging-app-relaunches-with-an-on-device-model-and-premium-upgrades/), [TMCnet on the AI roadmap](https://blog.tmcnet.com/blog/rich-tehrani/unified-communications/beeper-relaunches-with-on-device-messaging-premium-features-and-a-privacy-first-ai-roadmap.html)).
- **Lesson**: Beeper+Clay is the closest commercial convergence to this exact build (unified messaging → contact-centric context engine). Their bet: **the contact/person is the organizing unit, not the message**, and privacy boundary = on-device bridges.

### Chief-of-staff agents: Lindy, Martin, Ohai, Zapier/Relay
- **Lindy**: two-tier memory (session working memory + persistent vector-DB memory); email drafting from **user-written instructions stacked on top of auto-"Learned instructions"** (phrases, sign-offs, habits mined from your writing, visible and editable); knowledge bank answering "what did Sarah say about pricing?" ([Lindy email drafting docs](https://docs.lindy.ai/features/inbox-management/email-drafting), [Zapier's Lindy review](https://zapier.com/blog/lindy-review/)).
- **Martin** ("JARVIS"): custom memory architecture, reachable by text/call/email, sends texts/calls on your behalf ([Product Hunt](https://www.producthunt.com/products/martin)). **Ohai.ai**: household chief-of-staff, calendar-centric, daily briefs ([ohai.ai](https://www.ohai.ai/)).
- **Zapier Agents / Relay.app**: both converged on first-class **human-in-the-loop approval steps** (pause run, approve/revise via email/Slack) as the safety mechanism for acting on someone's behalf ([Zapier HITL](https://zapier.com/blog/human-in-the-loop-guide/), [Relay.app](https://www.relay.app/)).
- **Lesson (positive)**: Lindy's **two-layer instruction model — explicit user rules always outranking mined behavioral patterns, both visible and editable** — is the cleanest published design for "drafts in my voice without creepiness." And every actor converged on approval gates before send.

---

## Category 3 — OSS Personal Assistants & Memory Engines

### Khoj
Self-hostable "second brain": indexes Markdown/org/PDF/GitHub/Notion, classic RAG (semantic top-k → LLM), scales personal→cloud ([khoj explained](https://hoangyell.com/khoj-explained/)). **Lesson**: proof that self-hosted personal RAG is commoditized — the moat is ingestion breadth and person-modeling, not the RAG loop.

### Letta (MemGPT)
OS-inspired memory hierarchy: context window = registers; **agent-editable labeled memory blocks** (core memory) + recall + archival (Postgres/pgvector); the agent itself pages memory in/out via tools ([Letta walkthrough](https://sureprompts.com/blog/letta-memgpt-walkthrough), [research notes](https://lin-guanguo.github.io/llm-memory-research/letta.research/)). **Lesson**: *self-editing* memory blocks (the agent rewrites its own user-profile block) is the strongest OSS pattern for a continuously-updated user model — and Postgres+pgvector is a perfectly adequate substrate.

### Mem0
Two-stage LLM pipeline: extract candidate facts → **UPDATE/ADD/DELETE/NOOP conflict resolution** against existing memories; optional graph memory (entity nodes, relation triplets, embedding-matched node dedup, BM25-reranked graph retrieval). Apache 2.0 ([paper](https://arxiv.org/abs/2504.19413), [DeepWiki graph memory](https://deepwiki.com/mem0ai/mem0/4-graph-memory)). **Lesson**: memory writes are a **reconciliation problem** (new fact vs. existing beliefs), not an append problem — steal the ADD/UPDATE/DELETE resolution step; but note the emerging research counterpoint that [verbatim chunks can beat extracted artifacts](https://arxiv.org/pdf/2601.00821).

### Honcho (Plastic Labs)
Purpose-built **theory-of-mind user-modeling layer**: peer-based data model; ingest-time small model updates the user representation per message; background **"dream-time" process re-reasons over history to draw new deductions**; "Dialectic API" lets your app *ask questions of the user model* in natural language ([docs](https://docs.honcho.to/), [GitHub](https://github.com/plastic-labs/honcho)). **Lesson**: the two-speed pattern — cheap synchronous updates + periodic offline "consolidation/dreaming" — is the right compute shape for a person-model that improves without blocking chat.

### Personal data warehouse lineage (the ingestion gold mine)
- **Dogsheep / Datasette** (Simon Willison): everything → SQLite via per-source `x-to-sqlite` CLIs; explore with Datasette ([dogsheep.github.io](https://dogsheep.github.io/), [Personal Data Warehouses talk](https://simonwillison.net/2020/Nov/14/personal-data-warehouses/)).
- **HPI** (karlicoss): your life as a Python package — adapters normalize each source, hide parsing/caching, expose typed streams ([GitHub](https://github.com/karlicoss/HPI), [design doc](https://github.com/karlicoss/HPI/blob/master/doc/DESIGN.org)).
- **Timelinize** (Matt Holt): all sources → one SQLite timeline, **entity-aware** (people/places as first-class rows with attributes like phone numbers/emails that unify identities across sources) ([GitHub](https://github.com/timelinize/timelinize), [HN thread](https://news.ycombinator.com/item?id=45504973)). Perkeep remains the content-addressed storage ancestor.
- **Lesson (positive, big)**: a decade of quantified-self work converged on: **one local SQLite store; one small importer per source; importers idempotent over full re-exports; normalize to a common item schema with cross-source entity/identity resolution**. Timelinize's entity-attribute identity model (one person = many handles) is exactly the contact-unification schema this project needs.

### Message-ingestion projects with traction
- **screenpipe** (YC S26): open-source Rewind successor — event-triggered capture, accessibility-tree-first with OCR fallback, local Whisper, all in local SQLite ([GitHub](https://github.com/screenpipe/screenpipe)); OpenRecall similar.
- **OpenClaw** (2026's viral self-hosted assistant, ex-Clawdbot): channel/brain/body architecture bridging WhatsApp/Telegram/iMessage to an autonomous agent with shell/file/email powers — and 2026's first agent security crisis: a 512-finding audit, CVE-2026-25253 (RCE via link, CVSS 8.8), malicious "skills" silently exfiltrating via curl + prompt injection ([Acronis architecture analysis](https://www.acronis.com/en/tru/posts/openclaw-agentic-ai-in-the-wild-architecture-adoption-and-emerging-security-risks/), [Reco](https://www.reco.ai/blog/openclaw-the-ai-agent-security-crisis-unfolding-right-now), [Cisco](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare)).
- Long tail: [imessage MCP servers / paranoid iMessage+DuckDB+LlamaIndex analysis](https://simon-aubury.medium.com/my-data-your-llm-paranoid-analysis-of-imessage-chats-with-openai-llamaindex-duckdb-60e5eb9e23e3), [whatsapp2llm](https://github.com/m13v/whatsapp2llm), [WhatsApp-Llama fine-tuning](https://github.com/Ads97/WhatsApp-Llama), Reor (local Electron notes, llama.cpp + Transformers.js + **LanceDB embedded vector store** — [GitHub](https://github.com/reorproject/reor)), Charlie Mnemonic (GoodAI LTM/STM/episodic assistant — [GitHub](https://github.com/GoodAI/charlie-mnemonic)).
- **Lesson (negative, critical)**: **OpenClaw is the cautionary tale for our "eventually acts on your behalf" phase.** Inbound messages are untrusted input hitting an agent holding your credentials; prompt injection via a received text/email is the #1 threat; capability boundaries (read-context vs. act) must be separate trust domains from day one.

---

## Category 4 — Personal Data Platform Lineage & Digital-Legacy Person-Models

### Solid / Inrupt, HAT, digi.me — why PDSes stalled
- Solid pods (Berners-Lee, 2017–): technically sound decoupled data/apps; Inrupt drifted B2B/gov wallets; community devs found the stack too hard ("developers don't want to implement security protocols themselves") ([Schneier](https://www.schneier.com/blog/archives/2020/02/inrupt_tim_bern.html), [Noel De Martin's "Why Solid?"](https://noeldemartin.com/blog/why-solid), [Fast Company](https://www.fastcompany.com/91231379/tim-berners-lee-solid-inrupt-pod-digital-wallet)). HAT/Dataswift and digi.me pursued "own and monetize your data"; neither found consumer pull. The academic post-mortems ([PDS review, Sensors 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC9921726/), [PIMS analysis](https://policyreview.info/articles/analysis/personal-information-management-systems-user-centric-privacy-utopia)) converge: network effects favor incumbents, two-sided-market cold start, setup/key-management friction, and *no tangible day-one experience*.
- **Lesson (negative, existential)**: **"Your data, unified and private" is not a product; it's plumbing.** Every venture selling the container died or pivoted. The survivors sell an *experience* (memory, drafting, briefings) and deliver sovereignty as a property. For a single-user self-hosted build this de-risks to a personal-tool framing — which is exactly where Dogsheep/HPI/Timelinize quietly succeeded while the platforms failed.

### Digital legacy / person-models from message history
- **Roman bot → Replika**: Eugenia Kuyda built a bot from her dead best friend's message history (2015–16) — the founding proof that message corpora encode a recognizable person; it became Replika (30M+ users). Kuyda left in 2025 to found Wabi ([CBC](https://www.cbc.ca/documentaries/the-nature-of-things/after-her-best-friend-died-this-programmer-created-an-ai-chatbot-from-his-texts-to-talk-to-him-again-1.6252286), [MindSite News interview](https://mindsitenews.org/2026/02/09/replikas-eugenia-kuyda-doesnt-believe-in-regulation/)).
- **StoryFile**: scripted Q&A video clones (Shatner); Chapter 11 May 2024 ($1.5M assets / $10.5M liabilities), assets bought by Key 7, relaunched 2025 ([AI Business](https://aibusiness.com/verticals/startup-behind-ai-william-shatner-files-for-bankruptcy), [AV Magazine](https://www.avinteractive.com/territories-news/us-canada/conversational-ai-video-pioneer-emerges-from-chapter-11-03-03-2025/)). **HereAfter AI**: interview-based legacy avatars, still niche ([MIT Tech Review](https://www.technologyreview.com/2022/10/18/1061320/digital-clones-of-dead-people/)).
- **Kin (mykin.ai)**: live self-sovereign personal AI — **local-first on-device storage, auto-constructed personal knowledge graph, E2EE multi-device sync, TEE/confidential-compute only for inference** ([privacy architecture post](https://mykin.ai/resources/building-privacy-into-kin-and-personal-ai)); positioned itself as the data-safe alternative when Dot stranded users.
- **Lesson**: Kuyda's Roman proved the corpus is sufficient to model a person's voice; StoryFile's bankruptcy proved hand-curated capture doesn't scale as a business. **Passively accumulated communications beat interview-style capture; and Kin's "local store + KG + confidential compute only for inference" is a directly reusable privacy blueprint.**

---

## Top 10 transferable lessons for this project, ranked

1. **Raw logs are ground truth; derived memory is a disposable index** (Dot's biggest architectural reversal; corroborated by verbatim-vs-extracted research). Never let extracted facts become the only copy — store messages immutably, rebuild profiles/summaries at will as models improve.
2. **Hybrid retrieval with metadata-first scoping is the proven email/comms shape** (Shortwave): LLM query reformulation → contact/date/label feature extraction → scoped vector + BM25 → heuristic rerank → cross-encoder. Contacts and time do more work than embeddings.
3. **Structure memory as four typed stores** (Dot, echoed by Letta/Honcho): always-in-context identity/theory-of-mind profile; episodic timeline; entity/person records; procedural behaviors. And resist heavy JSON schemas — they didn't improve retrieval and made memory un-gardenable.
4. **Memory writes are reconciliation, not appending** (Mem0): every new fact runs ADD/UPDATE/DELETE/NOOP against existing beliefs; pair cheap synchronous updates with a background "dream-time" consolidation pass (Honcho).
5. **The person/contact is the organizing unit, not the message** (Beeper+Clay, Timelinize's entity model, Bee's contact fusion): build identity resolution (one human = many handles across iMessage/WhatsApp/email) into the core schema on day one.
6. **Acting on behalf = draft-then-approve, with explicit rules outranking mined patterns** (Superhuman Auto Drafts, Lindy's two-layer instructions, Zapier/Relay HITL): pre-write in the user's voice, make learned style visible and editable, and gate every send on a human click until trust is earned.
7. **Treat inbound messages as hostile input** (OpenClaw crisis, Recall's consumption-path bypass): prompt injection arrives via the very messages you ingest; separate the read/context plane from the action plane with different credentials and trust boundaries, and remember the decrypted serving path — not storage — is where breaches happen.
8. **Self-hosting is a survival feature, not a preference** (Rewind/Limitless sunset, Dot shutdown, StoryFile bankruptcy — three dead memory products in 18 months): a personal memory that lives in someone else's company dies with it. Local SQLite/Postgres + per-source idempotent importers (Dogsheep/HPI/Timelinize pattern) is the battle-tested substrate.
9. **Don't train per-user models; retrieve + thin style adaptation** (Personal.ai's tar pit vs. Gmail's shared-model-plus-personal-layer and every 2025-6 survivor): editable, deletable, inspectable context beats opaque weights — which also keeps "delete this memory" trivially honest.
10. **Sell the experience, not the data vault** (Solid/HAT/digi.me post-mortems): infrastructure-first personal-data projects failed for a decade; the daily payoff (morning brief, perfect recall before a call, a ready draft) must come first, with privacy as a property — and encrypt the store from day one, because a total-context index is the most valuable single file on the machine (Recall's lesson).

All category-level claims above are sourced inline; the highest-value primary sources to keep on file are Shortwave's [AI deep-dive](https://www.shortwave.com/blog/deep-dive-into-worlds-smartest-email-ai/), the [Dot memory-architecture interview](https://www.leverage.to/learn/dev/ai_memory/sam), the [Mem0 paper](https://arxiv.org/abs/2504.19413), [Honcho docs](https://docs.honcho.to/), [Timelinize](https://github.com/timelinize/timelinize), and the [OpenClaw security analyses](https://www.acronis.com/en/tru/posts/openclaw-agentic-ai-in-the-wild-architecture-adoption-and-emerging-security-risks/).
