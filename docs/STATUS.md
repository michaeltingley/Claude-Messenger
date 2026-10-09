# Project Status & Session Handoff

_Last updated: 2026-10-09. This file is the pick-up point for any new session,
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

## Current goal: stand up the always-on host

- **Oracle Always Free: dead.**
  - The home region `us-sanjose-1` reports `OUT_OF_HOST_CAPACITY` for every
    free shape (A1.Flex at both sizes, and E2.1.Micro). Both the Compute
    Capacity Report API and real launches confirmed it.
  - Always Free exists only in the home region, and the home region is
    permanent.
  - The user rejected PAYG because its budgets only alert; there is no hard
    cap.
  - Leftovers: the network in `us-sanjose-1` (VCN, internet gateway,
    subnet). It is free and can be deleted.
- **Hetzner: out.**
  - US CPX21 is now $38.09/mo after two 2026 price rises.
  - Its ~€4 EU plans are "currently unavailable".
- **One host for two jobs (2026-10-09).** The same server also runs the
  user's personal automation agent: Claude Code with Remote Control and a
  signed-in headful Chrome (`michaeltingley/ai-tools`, `automation-host/`).
  `docs/SHARED-HOST.md` is the contract between the two, and its isolation
  rules protect this project's policy guarantees from the agent.
- **Recommended: OVHcloud US VPS-2 in Vint Hill, VA, at $10.00/mo month to
  month** ($8.50 on a 12-month term).
  - 4 vCPU / 8 GB / 75 GB NVMe; IPv4 and traffic included.
  - VPS-1 (4 GB) fit Beeper alone, but Chrome and Claude sessions push the
    shared host to ~4–5 GB.
  - US East because Beeper's own backend is in the EU (Hetzner + AWS
    Frankfurt). See `docs/HOSTING-OPTIONS.md`.
  - **Waiting on the user's go-ahead.** The order, payment, and any OVH ID
    verification are theirs.

## NEXT ACTION (for the picking-up session)

Follow the provisioning sequence in `docs/SHARED-HOST.md`:

1. **Claude: land the isolation prerequisites in `deploy/` first** (rule 3).
   - Verified: Xvfb without `-auth` accepts X clients from any local user.
   - x11vnc (`-nopw`, 5900) and websockify (6080) are reachable by any local
     user while the surface is up.
   - Fix both, with tests, before a second user exists on the host.
2. **The user** orders VPS-2 (Virginia, Ubuntu 24.04, monthly billing) and
   installs the Tailscale app on their phone.
   - The VPS has no cloud-init user-data. Put an SSH public key on it with the
     OVH control panel's reinstall, or with the API's `rebuild`, which also
     takes `postInstallScript`.
   - Generate a fresh keypair for this. Keys in a cloud container die with
     the container (see gotchas).
3. Over SSH, run the `deploy/bootstrap.sh` flow:
   - Join Tailscale (the user clicks the URL).
   - Install Beeper Desktop and serve noVNC on the tailnet.
   - Sign in to Beeper Desktop. **The user types the emailed code and the
     recovery key.**
   - Mint the token in-app and write `.env`.
   - Run `doctor`; it must be green.
   - Start the systemd service.
   - Expose it on the tailnet with `tailscale serve`.
   - Tear down the sign-in surface.
4. Lock down public SSH once tailnet SSH works.
5. Install the agent layer from `ai-tools/automation-host`, then run its
   server-day test. Both are owned there, not here.
6. Re-evaluate the session-channel relay before building it. The agent on the
   host may make it unnecessary (`docs/SHARED-HOST.md`).

## Notes / gotchas

- **Cloud containers are ephemeral.** A container reset on 2026-10-08 wiped
  the scratchpad and `~/.ssh`. That took an uncommitted provisioning script
  and the host SSH key with it.
  - Anything a later session needs must be committed.
  - Keys belong with the user or on the host, never only in a container.
- **Never install Beeper Server.** See above.
- The user wants maximum autonomy ("do everything I can't"). The irreducibly
  human steps are:
  - account signups (card, CAPTCHA, ID checks);
  - relaying the Beeper emailed code and recovery key.
