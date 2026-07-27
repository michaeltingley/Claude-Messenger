# Project Status & Session Handoff

_Last updated: 2026-07-10. This file is the pick-up point for any new session
(cloud or local). Read it first, then `docs/HOSTING-OPTIONS.md` and
`docs/RUNBOOK-HOME-SETUP.md`._

## What's done and merged (`main`, PRs #1–#5)

- **Foundation**: provider-agnostic core, Beeper Client API adapter, policy +
  audit layer (read-only default, fail-closed rate limiting, intent/outcome
  audit), curated MCP server, CLI (`doctor`/read/`send`/`serve`), 79 tests.
- **Hosted mode**: HTTP MCP transport with bearer auth (`serve --http`),
  one-command `deploy/bootstrap.sh`, `deploy/cloud-init.yaml` (zero-terminal
  provisioning), hardened systemd unit, `docs/DEPLOY.md`.
- **Research**: `docs/CONTEXT-ENGINE-RESEARCH.md` + `docs/research/` (8 lanes),
  `docs/HOSTING-OPTIONS.md`.

## VERIFIED LIVE (2026-07-10)

On the user's laptop, against real Beeper Desktop, `claude-messenger doctor`
passed end-to-end: config → connection (Beeper 4.2.977) → auth → policy, with
**10 real accounts** visible under the read-only default policy (WhatsApp,
Signal, Instagram, Discord, LinkedIn, Facebook, Google Messages/Chat/Voice,
Matrix). The stack works against real data. The token used was a throwaway
24h OAuth token minted locally — NOT needed for the host.

## Current goal: stand up the always-on host

**Oracle Cloud Always Free was attempted and abandoned.** Two blocking
free-tier problems (both predicted in `docs/HOSTING-OPTIONS.md`):
1. **ARM capacity**: `us-sanjose-1` returned "Out of host capacity" on every
   attempt (35 min / 7 retries). Single-AD region, no PAYG priority.
2. **Idle reclamation**: pure-free instances get reclaimed when idle — a
   low-traffic message bridge trips all three (CPU/net/mem <20%) thresholds.
   Unacceptable for an always-on service.

### DECISION: pivot off pure-free Oracle. Recommended → **Hetzner**.

- **Hetzner (~€4/mo, recommended)**: simple API token (no browser-SSO/MFA),
  so fully provisionable from a cloud session with zero laptop dependency; no
  capacity lottery; no reclamation; 4 GB+ RAM. This is the teleport-friendly,
  reliable choice.
- **Oracle PAYG (still ~$0)**: exempts from reclamation AND gets capacity
  priority, but needs the billing upgrade and Oracle's interactive login
  (harder to drive from a cloud session).

## NEXT ACTION (for the picking-up session)

1. Get a Hetzner Cloud **read/write API token** from the user (Console →
   project → Security → API Tokens). [Or confirm Oracle PAYG instead.]
2. Provision from wherever you're running (no laptop needed): create a server
   (Ubuntu 24.04, ARM `CAX` or x86, ≥4 GB), apply `deploy/cloud-init.yaml` as
   user-data, boot.
3. Finish on the host per `docs/RUNBOOK-HOME-SETUP.md` Phase 3: Tailscale
   join, headless Beeper Server login (**user relays the emailed code +
   recovery key** — these are the only irreducibly-human steps, doable from
   phone), mint the host's own Beeper token on-box, write `.env`, start the
   systemd service, expose tailnet-only via `tailscale serve`, run `doctor`.
4. Lock down: remove public 22/tcp ingress once Tailscale works.

## Notes / gotchas

- **Nothing depends on the user's laptop.** All tooling is in this repo;
  Hetzner needs only the API token. A fresh cloud session loses nothing.
- Oracle leftovers: an empty VCN (`cm-vcn`) + subnet in `us-sanjose-1`, free,
  deletable later.
- Beeper CLI installs the **nightly** server channel (data-loss risk
  beeper/cli#21). Stable alternative: Beeper Desktop + Remote Access on the
  host. Decide with the user before the Beeper login step.
- The user wants maximum autonomy ("do everything I can't"). The irreducible
  human steps are: account signups (card/CAPTCHA), and relaying the Beeper
  emailed code + recovery key. Everything else is automatable.
