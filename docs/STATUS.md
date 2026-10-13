# Project Status & Session Handoff

_Last updated: 2026-10-13. This file is the pick-up point for any new session,
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
    - `deploy/configure.sh` closes it as soon as the token is saved, however
      the run ends.
  - Systemd units are single-sourced in `deploy/systemd/`.
  - Beeper Server / `beeper-cli` is gone everywhere.
    [beeper/cli#21](https://github.com/beeper/cli/issues/21) wiped a legacy
    account's bridges across all devices.
- **Session-runnable install (#PR)**:
  - `deploy/bootstrap.sh` never prompts, so a Claude session can run it.
    apt runs non-interactively. The tty rebind and the token paste are gone.
  - It ends in `deploy/configure.sh`, which also runs on its own (re-runs,
    `--reconnect`): `.env`, Beeper access, `doctor`, the MCP unit,
    `tailscale serve`, and `claude mcp add` on the host.
  - `claude-messenger connect` gets the Beeper token through Beeper
    Desktop's own approval box (OAuth with PKCE) and writes it straight into
    `.env`, so no person, terminal or transcript ever holds it.
    - It waits for sign-in, and re-asks when Beeper closes an unanswered box.
    - A token with an expiry or with unasked write access is revoked, not
      saved.
    - The port is `core/access.ts`; the Beeper side is
      `providers/beeper/access.ts`.
  - Tests run both scripts with no terminal against a fake host whose
    systemd really starts the built MCP service (`test/fake-host.ts`,
    `test/install.integration.test.ts`).
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

1. **Run the MCP service as a system unit, so its sandbox applies.** Land
   this in the repo before the VPS install.
   - Found on the VPS on 2026-10-13: Ubuntu's AppArmor restriction on
     unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`,
     the default since 24.04) denies the user manager the namespace that
     `ProtectSystem`, `ProtectHome`, `PrivateTmp` and `ReadWritePaths` need.
   - systemd 259 then starts the unit **without** that sandbox, and says
     nothing. A probe there found the home directory, `/run/user` and the
     host's `/tmp` all writable from inside. `NoNewPrivileges` and
     `MemoryMax` did apply.
   - So `deploy/systemd/claude-messenger-mcp.service`'s promise that the rest
     of `$HOME` stays read-only is false on those hosts.
   - The fix: install it in `/etc/systemd/system` with `User=`, where the
     system manager builds the namespace with real privileges. Don't loosen
     AppArmor host-wide; that would be the owner's call.
   - Prove it with a test that starts the real unit under real systemd (CI
     has it) and checks from inside that `$HOME` is read-only, as
     `display-isolation` does for Xvfb. A config grep passed this bug.
2. **Install Claude Messenger on the VPS, once the owner says go.** After
   step 1, a session on the box can run the whole install.
   - **Wait for the owner's go.** On 2026-10-13 the project coordinator
     paused all installs until the owner confirms, after a warning about a
     stale branch's `beeper setup --server` (never use
     `claude/beeper-mcp-integration-ya9zk4`).
   - **Tailscale Serve is off for the tailnet** (2026-10-13). The owner turns
     it on once, from the link the scripts print when they stop for it.
     `agent-surface` in ai-tools needs it too (ai-tools #36).
   - **What the stopped install left**, checked 2026-10-12/13 by a Remote
     Control session on the box:
     - `~/claude-messenger` at a01ba4a, built; no `.env` or `policy.json`.
     - Beeper Desktop 4.3.176 extracted in `/opt/beeper`. The xvfb and
       beeper-desktop user units are enabled and running, and Beeper is
       signed out.
     - The sign-in surface had been left up; it is closed now.
     - `~/.local/share/cm-setup/write-env.sh`, an improvised token helper.
       Read it, then delete it: `connect` replaces it.
     - That session also installed xdotool, xclip, x11-apps and
       imagemagick, which the repo doesn't need. A newer kernel waits for a
       reboot.
   - **Then, on the box:** `git -C ~/claude-messenger pull`, then run
     `~/claude-messenger/deploy/bootstrap.sh` in the background; it skips
     what is already done.
     - It prints the screen link, then the steps for Beeper's approval box.
       Relay both to the owner in one message.
     - It waits up to 60 minutes for sign-in and approval.
     - The owner signs in and approves, nothing else. Decline any Beeper
       prompt that would add, move or re-connect a chat network.
3. **Measure memory after Beeper's first sync,** and write the numbers here.
   - Baseline 2026-10-13 00:04Z, Beeper signed out: system used 2238 MB,
     available 1575 MB, swap in use 625 MB. Beeper's process tree: 7
     processes, PSS 444 MB, RSS 743 MB.
   - Beeper's main process moves itself out of beeper-desktop.service into
     its own `app-Beeper-<pid>.scope`. Count that cgroup too.
4. **Remind the owner to upgrade to VPS-2 once setup is done.** The owner
   asked for this reminder, expecting 4 GB to be too tight for Beeper
   alongside the agent's Chrome and Claude sessions.
   - VPS-2 is 8 GB at $10/mo; OVH upgrades in place.
   - Give the reminder with the numbers from step 3.
5. **Lock down public SSH** once tailnet SSH works. Close port 22 to the
   internet, or restrict it to the owner's IP.
6. **Re-evaluate the session-channel relay** (`docs/SESSION-CHANNEL.md`).
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
- **What the VPS taught the install (2026-10-12/13):**
  - Every apt package name in `bootstrap.sh` resolves on Ubuntu 26.04
    (checked by the first VPS session).
  - needrestart's "Pending kernel upgrade" dialog stalls apt when there is
    no terminal. `bootstrap.sh` now runs apt with
    `DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a`.
  - Beeper Desktop 4.3.176 answers `/v1/info` whether or not it is signed
    in. The sign-in signal is `GET /v1/app/setup` without a token: 200 while
    signed out, 401 once signed in. It flips right after the emailed code,
    before the recovery key.
  - Beeper closes an approval box nobody answered after two minutes.
    Signing out deletes its approved connections; restarts keep them.
  - Beeper's own login token also works as an API token, so its data
    directory is as sensitive as `.env`.
  - While Serve is off, `tailscale serve` prints an enable link and waits
    forever. Both scripts now stop after 20 s and pass the link on.
  - On a fresh install the MCP unit could not have started: its
    `ReadWritePaths` names `state/`, which nothing creates under a read-only
    policy, and systemd refuses to start a unit whose listed path is missing
    (226/NAMESPACE). `configure.sh` creates it.
- **Cloud sessions can't add GitHub deploy keys.** That API path is blocked
  through their proxy. Add deploy keys in the GitHub UI.
- The user wants maximum autonomy ("do everything I can't"). The irreducibly
  human steps are:
  - account signups (card, CAPTCHA, ID checks);
  - relaying the Beeper emailed code and recovery key.
