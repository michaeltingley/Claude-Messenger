# Project Status & Session Handoff

_Last updated: 2026-10-12. This file is the pick-up point for any new session,
cloud or local. Read `CLAUDE.md` first, then this, then `docs/SHARED-HOST.md`
and `docs/HOSTING-OPTIONS.md`._

## What's done and merged (`main`)

- **Foundation**:
  - Provider-agnostic core and the Beeper Client API adapter.
  - Policy + audit layer: read-only default, fail-closed rate limiting,
    intent/outcome audit.
  - Curated MCP server.
  - CLI: `doctor`, read, `send`, `serve`.
  - 100 tests.
- **Hosted mode**:
  - HTTP MCP transport with bearer auth (`serve --http`).
  - `deploy/bootstrap.sh` and `deploy/cloud-init.yaml`.
  - Hardened systemd unit.
  - `docs/DEPLOY.md`.
- **Safe install path (#8, #9)**:
  - Every install path runs **Beeper Desktop headless under Xvfb**, with
    noVNC on loopback.
  - The one-time sign-in surface is opened and closed only by
    `deploy/signin-surface.sh`, published to the tailnet only.
    - It is never enabled at boot.
    - Bootstrap closes it once `doctor` passes.
  - Systemd units are single-sourced in `deploy/systemd/`.
  - Beeper Server / `beeper-cli` is gone everywhere.
    [beeper/cli#21](https://github.com/beeper/cli/issues/21) wiped a legacy
    account's bridges across all devices.
- **Working agreement (#6)**: `CLAUDE.md`, which carries the user's standing
  directives verbatim.
- **Session channel plan (#10, #11)**: `docs/SESSION-CHANNEL.md`.
  - Destination: a presence-aware WebSocket relay on the host.
  - Bootstrap: a GitHub mailbox.
- **Research**:
  - Context engine: `docs/CONTEXT-ENGINE-RESEARCH.md` and `docs/research/`.
  - Hosting: `docs/HOSTING-OPTIONS.md`, re-verified 2026-10-08.

## VERIFIED LIVE (2026-07-10)

On the user's laptop, against real Beeper Desktop, `claude-messenger doctor`
passed end to end: config → connection → auth → policy.

- **10 real accounts** were visible under the read-only default policy:
  WhatsApp, Signal, Instagram, Discord, LinkedIn, Facebook, Google
  Messages/Chat/Voice, and Matrix.
- The stack works against real data.

## Decided (2026-10-12): Claude Messenger runs on the automation VPS

- **The host exists.**
  - OVHcloud US VPS-1: 2 vCore / 4 GB / 40 GB NVMe, in Vint Hill, VA.
  - Ubuntu 26.04 LTS, $5.35/mo, no commitment. Ordered 2026-10-09.
  - It runs the automation host from `michaeltingley/ai-tools`
    (`automation-host/`).
  - It is connected to Claude as a Remote Control **bridge environment**. Find
    it with `list_environments`; its kind is `bridge`.
- **Host work runs as sessions on that environment, not over SSH.**
  - Cloud sessions can't SSH: their only egress is an HTTPS proxy that
    re-terminates TLS.
  - So the orchestrator starts sessions on the bridge with `create_session`
    and that `environment_id`. Those sessions run on the box itself.
- **Owner decision: same Unix user, risk accepted.**
  - Claude Messenger runs as the same user as the agent and every other
    Claude session on the box.
  - Any of those sessions can read the Beeper token and bypass the policy
    layer. The owner accepted this.
  - Policy and audit still govern everything that reaches Beeper only through
    MCP.
  - `docs/SHARED-HOST.md` rules 1–2 (separate users, no general sudo) are
    therefore waived. The display and VNC hardening from #17 stays.
- **Memory.**
  - 4 GB plus swap; Chrome and other Claude sessions already run there.
  - Preflight on 2026-10-12, before any Beeper install: 3.8 GB total, about
    2 GB available, 560 MB of the 4 GB swap in use.
  - Measure after Beeper's first sync. Upgrade in place to VPS-2 (8 GB,
    $10/mo) if it's tight; that keeps the data and IP.
- **Who uses the MCP.** Claude sessions on the VPS, via
  `http://127.0.0.1:8484/mcp`. claude.ai's cloud can't reach a tailnet-only
  endpoint.
- **Command center: a Claude Code Project (beta).** The owner runs this work
  from one project, whose threads start from `CLAUDE.md` and this file. Host
  work goes either way:
  - in a project thread that runs on the VPS through Remote Control (the box
    already runs `claude remote-control` in its work folder);
  - in a session started on the VPS's bridge environment.

  Anything that checks the box, such as a scheduled health check, has to run
  on the box too. A cloud thread can't reach it.

## NEXT ACTION (for the picking-up session)

1. **Install Claude Messenger on the VPS.** A first VPS session ran
   preflight on 2026-10-12. It was then stopped partway through the install,
   when the owner moved the work into a Project. Its last status line read
   "Installing X helpers and writing token-capture script".
   - Check what it left before redoing anything:
     - `~/claude-messenger`, `/opt/beeper`, and the user units from
       `deploy/systemd/`;
     - `deploy/signin-surface.sh status`; close the surface if it's up;
     - any token-capture script it wrote. Read it, then delete it; the next
       bullet replaces it.
   - **First, make the install runnable from a session, in the repo.**
     `deploy/bootstrap.sh` expects a person at its terminal. It prompts there
     for Enter once Beeper has synced, and for the token.
     - Run by a Claude session, it exits before step 1. It rebinds stdin to
       `/dev/tty`, and the session's shell has no terminal. (Checked in a
       cloud session on 2026-10-12.)
     - The token is the hard part. It must reach `.env` without passing
       through chat; the plan is a terminal on the Beeper screen, where the
       owner types it.
     - Land this in `deploy/` with a test. Improvised on the box, it would be
       improvised again on every reinstall.
   - Then install, following `deploy/bootstrap.sh`:
     - Beeper Desktop under Xvfb on :99.
     - The owner signs in through `deploy/signin-surface.sh`'s tailnet link,
       then enters the token on that same screen.
     - Then `doctor` green, the surface closed, and the MCP service up.
     - Then `claude mcp add` for sessions on the box.
2. **Land the repo fixes it reports.** Expect apt package names that differ on
   26.04, because bootstrap's list was written for 24.04.
3. **Remind the owner to upgrade to VPS-2 once setup is done.** The owner
   asked for this reminder, expecting 4 GB to be too tight for Beeper
   alongside the agent's Chrome and Claude sessions.
   - VPS-2 is 8 GB at $10/mo; OVH upgrades in place.
   - Record memory after Beeper's first sync, so the reminder carries real
     numbers.
4. **Lock down public SSH** once tailnet SSH works. Close port 22 to the
   internet, or restrict it to the owner's IP.
5. **Re-evaluate the session-channel relay** (`docs/SESSION-CHANNEL.md`).
   Orchestrator-started sessions on the VPS may make it unnecessary.

### Hosting history (kept short)

- Oracle Always Free is dead: the home region `us-sanjose-1` has a permanent
  capacity wall, and the owner rejected PAYG because it has no hard cap.
  - Leftover network there (VCN, gateway, subnet) is free and can be deleted.
- Hetzner is out: US 4 GB is $38/mo, and its EU 4 GB plans are unavailable.
- Full comparison: `docs/HOSTING-OPTIONS.md`.

## Notes / gotchas

- **Cloud containers are ephemeral.** A container reset on 2026-10-08 wiped
  the scratchpad and `~/.ssh`. That took an uncommitted provisioning script
  and the host SSH key with it.
  - Anything a later session needs must be committed.
  - Keys belong with the user or on the host, never only in a container.
- **Never install Beeper Server.** See above.
- **Cloud sessions can't add GitHub deploy keys.** That API path is blocked
  through their proxy. Add deploy keys in the GitHub UI.
- The user wants maximum autonomy ("do everything I can't"). The irreducibly
  human steps are:
  - account signups (card, CAPTCHA, ID checks);
  - relaying the Beeper emailed code and recovery key.
