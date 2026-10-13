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
- **Session-runnable install (#22)**:
  - `deploy/bootstrap.sh` never prompts, so a Claude session can run it.
    apt runs non-interactively. The tty rebind and the token paste are gone.
  - It ends in `deploy/configure.sh`, which also runs on its own (re-runs,
    `--reconnect`): `.env`, Beeper access, `doctor`, the MCP unit,
    `tailscale serve`, and `claude mcp add` on the host.
  - `claude-messenger connect` gets the Beeper token through Beeper
    Desktop's own approval box (OAuth with PKCE) and writes it straight into
    `.env`, so no person, terminal or transcript ever holds it.
    - It waits for the Desktop API to be switched on and for sign-in, and
      re-asks when Beeper closes an unanswered box.
    - A token with an expiry or with unasked write access is revoked, not
      saved. That call is `GuardedAccessRequester`'s (`policy/access.ts`),
      the only requester `connect` gets.
    - The port is `core/access.ts`; the Beeper side is
      `providers/beeper/access.ts`.
  - `configure.sh` closes the sign-in screen on every run, and on any exit
    but `kill -9` (after one, run it again). Claude Code sessions on the host
    get Claude Messenger over stdio, so no token sits on a command line.
  - Tests run both scripts with no terminal against a fake host whose
    systemd really starts the built MCP service (`test/fake-host.ts`,
    `test/install.integration.test.ts`).
- **MCP service sandbox (#23)**: the MCP service is a system unit run as the
  install's owner (`User=`), not a user unit, whose sandbox Ubuntu 24.04+
  silently drops (see Notes).
  - Through the filesystem it sees nothing of the home directories or
    `/run/user` but the install, read-only. So a compromised server can't
    read SSH keys, other tools' credentials, Beeper's own data or the
    sign-in screen's secrets that way.
  - It also gets its own PID namespace (`PrivatePIDs`) and IPC namespace
    (`PrivateIPC`), so it can't step around the mount sandbox through the
    owner's other processes' `/proc/<pid>/root` and `/proc/<pid>/environ`,
    nor reach the host's SysV IPC or message queues. `PrivatePIDs` needs
    systemd 257 (the VPS has 259); on 255/256 that one protection is absent
    and `configure.sh` warns. See the residual risks in Notes.
  - It can change only its audit trail and rate window. `configure.sh`
    stops first if `.env` keeps the policy, audit trail or rate window
    anywhere else.
  - `test/mcp-sandbox.integration.test.ts` proves all of this on GitHub's
    runners, under real systemd with Ubuntu's restriction on, across both
    24.04 (systemd 255) and 26.04 (259): the /proc escape closed on 259 and
    still open on 255, each asserted in turn.
- **Working agreement (#6)**: `CLAUDE.md`, which carries the user's standing
  directives verbatim.
- **Session channel plan (#10, #11)**: `docs/SESSION-CHANNEL.md`.
  - Destination: a presence-aware WebSocket relay on the host.
  - Bootstrap: a GitHub mailbox.
- **Research**:
  - Context engine: `docs/CONTEXT-ENGINE-RESEARCH.md` and `docs/research/`.
  - Hosting: `docs/HOSTING-OPTIONS.md`, re-verified 2026-10-08.
- **Daily digest**: `claude-messenger digest` reads a window of the main
  inbox (the last 24 hours unless `--since` says where it starts) through
  the policy layer and has Claude Code write what needs the owner first,
  then the rest. It runs on the owner's Claude subscription (Claude Code
  signed in on the host), never an API key, and its model has no tools and
  can't be made to read a file. Design: `docs/ARCHITECTURE.md` (Language
  model, Daily digest). How it is to run and reach the owner: "Daily
  digest" below.

## VERIFIED LIVE

- **2026-07-10, the user's laptop.** Against real Beeper Desktop,
  `claude-messenger doctor` passed end to end: config → connection → auth →
  policy. **10 real accounts** were visible under the read-only default
  policy: WhatsApp, Signal, Instagram, Discord, LinkedIn, Facebook, Google
  Messages/Chat/Voice, and Matrix.
- **2026-10-13, the VPS.** Beeper Desktop was signed in on the box and
  `connect` (built from #22) got a read-only token that never expires
  through Beeper's own box. `doctor` passes with **11 accounts**, all
  Beeper Cloud: Beeper, Discord, Facebook, Google Messages, Google Chat,
  Google Voice, Instagram, LinkedIn, Signal, Telegram, WhatsApp.
  - Google Voice and Telegram were missing at first: they were Beeper
    On-Device connections on the owner's other devices, and an on-device
    connection runs per device, so a new device doesn't get it. The owner
    re-added both as Cloud connections the same night; each reached the host
    within minutes and runs nothing there. His first try at Telegram set it
    up on-device on his laptop instead, so check where a re-added network
    lands.

## Daily digest (project thread "Daily message digest")

- **Not on the VPS yet**: the box's checkout predates it. Once `main` is
  pulled and built there, with Claude Code signed in to the owner's Max
  plan, each morning's run is:
  `cd ~/claude-messenger && node dist/cli/main.js digest --since "$(TZ=America/Los_Angeles date -d 'yesterday 07:46' -Iseconds)" --time-zone America/Los_Angeles`.
  - `--since` starts it where the day before's run started, so a late run
    leaves nothing out between two days.
  - It writes with Sonnet (`--model` to change), which spends less of the
    plan's usage limits than Opus.
  - It needs a Claude Code new enough for `--safe-mode` (the box has
    2.1.295). One too old, such as 2.1.42, rejects the flag, so the digest
    fails with `model_failed` before Claude sees anything.
  - It prints the digest and keeps no copy. The audit log gets its reads,
    never the words. The text is in the transcripts of the sessions that
    carry it: the Remote Control session that runs it and the project
    thread that posts it.
  - Failing, it prints the reason and no digest: `model_failed` with Claude
    Code's own words (signed out: run `claude`, then `/login`; usage limit
    reached), or Beeper's checklist when Beeper is unreachable.
- **Delivery, being set up 2026-10-13:** each morning at 7:46 AM Pacific a
  routine wakes the thread's session, which starts a Remote Control session
  on the VPS to run the command and send the text back, and then posts it
  in the thread. Nothing is written to Beeper, so the read-only token stays
  read-only.

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

1. **Finish the VPS install.** Beeper is signed in and the token is in
   place, so what is left is unattended.
   - **Where it stands** (2026-10-13, done by a Remote Control session on
     the box, with the owner's go):
     - Beeper Desktop 4.3.176 in `/opt/beeper`, its xvfb and beeper-desktop
       user units running, **signed in** since 02:11Z.
     - `~/claude-messenger/.env` (mode 600) holds the MCP token and a
       read-only Beeper token that never expires, saved by `connect` from a
       build of #22 in the worktree `~/cm-pr22`. No `policy.json` and no MCP
       unit yet; `doctor` passes.
     - The sign-in surface is closed.
     - Still there from the July attempt: `~/.local/share/cm-setup/write-env.sh`,
       an improvised token helper (read it, then delete it: `connect`
       replaces it), and xdotool, xclip, x11-apps and imagemagick, which the
       repo doesn't need. A newer kernel waits for a reboot.
   - **Then, on the box:** `git worktree remove ~/cm-pr22`, put
     `~/claude-messenger` on `main` and pull, `npm ci && npm run build`, then
     run `deploy/configure.sh` in the background. It keeps the token (no
     approval needed), writes `policy.json`, runs `doctor`, installs the MCP
     service as a system unit and publishes it, and registers it with Claude
     Code on the box.
     - The system unit needs sudo without a password prompt (nobody can
       type one into a background run); check `sudo -n true` first.
     - It stops first if `.env` keeps the policy, audit trail or rate window
       outside `~/claude-messenger`, as a `.env` written for `~/cm-pr22`
       might: `grep -E '^CLAUDE_MESSENGER_(POLICY|AUDIT_DIR|STATE_DIR)=' .env`
       shows them.
   - **Then check it on the box.** CI proves the sandbox on both systemd 255
     and 259; the box has 259, so `PrivatePIDs` applies and the /proc escape
     must be closed.
     - `systemctl show -p User --value claude-messenger-mcp` is the owner,
       and `systemctl is-enabled claude-messenger-mcp` says `enabled`.
     - One authenticated MCP call (`list_accounts`) answers, and today's
       file in `audit/` grows.
     - From inside the service, writing to the home or the install fails
       with "Read-only file system", and `~/.ssh` isn't there:
       `sudo nsenter -t "$(systemctl show -p MainPID --value claude-messenger-mcp)" -m -S "$(id -u)" -G "$(id -g)" -- sh -c 'touch "$1/probe"; touch "$1/claude-messenger/probe"; ls "$1/.ssh"' sh "$HOME"`
     - And the /proc escape is closed: from inside, another of the owner's
       processes (e.g. a Beeper pid) is not visible, so its root is
       unreachable. With `bpid` a Beeper Desktop pid,
       `sudo nsenter -t "$(systemctl show -p MainPID --value claude-messenger-mcp)" -m -S "$(id -u)" -G "$(id -g)" -- sh -c 'ls /proc/'"$bpid"'/root'$HOME'/.ssh'` must fail (no such process / path).
   - Whatever runs `configure.sh` or `bootstrap.sh` in the background must
     allow more than their 60-minute wait for sign-in and approval. Claude
     Code's Bash tool stops background commands after 30 minutes unless
     given a longer timeout (at most 120): pass at least 65.
   - Decline any Beeper prompt that would add, move or re-connect a chat
     network, or sign out another device, unless the owner asked for it.
2. **Memory after Beeper's first sync: measured 2026-10-13.** Signed in at
   02:11Z, settled by 02:25Z (Beeper's PSS flat within 4% for 9 minutes,
   CPU about 2%). Against the signed-out baseline at 00:04Z:

   | | Signed out (00:04Z) | Synced (02:25Z) |
   |---|---|---|
   | Beeper, whole tree (7 processes), PSS | 444 MB | 664 MB |
   | Beeper, whole tree, RSS | 743 MB | 951 MB |
   | Beeper's two cgroups (service + `app-Beeper-*.scope`) | 592 MB | 900 MB |
   | System used / available (`free -m`) | 2238 / 1575 MB | 1901 / 1913 MB |
   | Swap in use | 625 MB | 1351 MB |

   - The first sync peaked right after sign-in at 829 MB PSS (1067 MB of
     cgroup), then settled.
   - "Used" fell only because that peak pushed about 730 MB of idle pages
     (the agent's Chrome, Claude sessions) into swap.
   - Xvfb adds about 16 MB PSS. The MCP service isn't running yet. Google
     Voice and Telegram arrived later, as Cloud connections, which add no
     bridge on the host.
   - Beeper's main process moves itself out of beeper-desktop.service into
     its own `app-Beeper-<pid>.scope`. Count that cgroup too.
3. **Remind the owner to upgrade to VPS-2 once setup is done.** The owner
   asked for this reminder, expecting 4 GB to be too tight for Beeper
   alongside the agent's Chrome and Claude sessions.
   - VPS-2 is 8 GB at $10/mo; OVH upgrades in place.
   - Give the reminder with the numbers from step 2: Beeper settles at
     about 0.66 GB, and the box keeps 1.9 GB available only by holding
     1.35 GB in swap.
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
- **What the VPS taught the install (2026-10-12/13):**
  - Every apt package name in `bootstrap.sh` resolves on Ubuntu 26.04
    (checked by the first VPS session).
  - needrestart's "Pending kernel upgrade" dialog stalls apt when there is
    no terminal. `bootstrap.sh` now runs apt with
    `DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a`.
  - Beeper Desktop 4.3.176 answers `/v1/info` whether or not it is signed
    in. The sign-in signal is `GET /v1/app/setup` without a token: 200 while
    signed out, 401 once signed in. It flips right after the emailed code,
    before the recovery key, so an unattended `connect` asks for approval
    while Beeper may still want the key. Read from Beeper's code: the box
    then opens at once, over the key step (nothing gates it on sign-in
    state), and Approve works before the key is in. So `connect`'s steps say
    to approve, then enter the key. No signal without a token flips when the
    key goes in.
  - After the emailed code, Beeper first offers to verify with another
    device. "Try another way", then "Enter Recovery Key", gets the key box,
    which has a "Paste from Clipboard" button: the owner pastes the key into
    noVNC's clipboard panel, then presses it. It took him about 3 minutes.
  - Beeper closes an approval box nobody answered after two minutes.
    Signing out deletes its approved connections; restarts keep them.
  - Beeper's own login token also works as an API token, so its data
    directory is as sensitive as `.env`.
  - On a tailnet that hasn't allowed Serve, `tailscale serve` prints an
    enable link and waits forever. Both scripts now stop after 20 s and pass the link on.
  - On a fresh install the MCP unit could not have started: its
    `ReadWritePaths` names `state/`, which nothing creates under a read-only
    policy, and systemd refuses to start a unit whose listed path is missing
    (226/NAMESPACE). `configure.sh` creates it.
  - Ubuntu's AppArmor restriction on unprivileged user namespaces
    (`kernel.apparmor_restrict_unprivileged_userns=1`, the default since
    24.04) denies a user manager the namespace that `ProtectSystem`,
    `ProtectHome`, `PrivateTmp` and `ReadWritePaths` need. systemd 259 then
    starts a user unit without that sandbox and says nothing: a probe from
    inside one found the home directory, `/run/user` and the host's `/tmp`
    writable. `NoNewPrivileges` and `MemoryMax` did apply. The unit file
    reads the same either way, so only a probe from inside can tell; a
    config grep passed this bug. Hence the system unit (#23). Loosening
    AppArmor host-wide would be the owner's call.
  - Even where it applied, `ProtectHome=read-only` let the service read the
    whole home: SSH keys, Claude's and Beeper's credentials (Beeper's login
    token is a full API token) and, in `/run/user`, the sign-in screen's X
    cookie and VNC password. So the unit now hides the home directories
    and binds back only the install, read-only, plus `audit/` and `state/`.
  - It hides them with `TemporaryFileSystem=…:ro`, not `ProtectHome=tmpfs`.
    systemd 255 and 256 copy only the path and mode of that setting's
    built-in mounts (`append_static_mounts` in `src/core/namespace.c`), so
    their tmpfs stand-ins come up writable, with tmpfs's default mode 1777.
    CI caught it on Ubuntu 24.04's 255; 257 fixed it.
  - Hiding files is not enough on its own: the service runs as the owner, so
    if it shared the owner's PID namespace a compromised server could reach
    around the mount sandbox through the owner's other processes — reading
    their files under `/proc/<pid>/root` (SSH keys, Beeper's token) and their
    `/proc/<pid>/environ`, all with `PTRACE_MODE_READ_FSCREDS`, which Yama's
    `ptrace_scope` does not gate (it gates only ATTACH). Confirmed by
    experiment, read and write both. `PrivatePIDs=yes` gives the service its
    own PID namespace, where it sees only itself, and closes this. It needs
    systemd **257** (the VPS has 259); 255 and 256 ignore the key with a log
    warning and start the service without it, so on Ubuntu 24.04 the escape
    stays open — `configure.sh` warns at install time, and the sandbox test
    asserts it closed on 259 and open on 255. `PrivateIPC=yes` (systemd 248+)
    gives it private SysV IPC and POSIX message queues.
  - `PrivatePIDs` makes the service **PID 1** in its namespace, and the
    kernel delivers PID 1 only the signals it has installed a handler for.
    `node` installs none for SIGTERM (verified: unhandled → ignored as PID 1;
    a handler → clean exit), so `serve --http` now installs one and shuts the
    listener down on SIGTERM/SIGINT. Without it, `systemctl stop`/restart
    would hang to `TimeoutStopSec` (90s) and SIGKILL every time. Don't remove
    that handler while the unit keeps `PrivatePIDs`. Proven two ways:
    `serve --http` exits 0 on SIGTERM (`install.integration`), and
    `systemctl stop` returns promptly with the unit inactive under real
    systemd (`mcp-sandbox.integration`).
  - **Residual risks, by design, even with the full sandbox:**
    - It shares the host **network** namespace, so it can reach any service
      on loopback; a local port with no auth of its own is reachable from a
      compromised server. (Abstract and `AF_UNIX` sockets follow the network
      namespace too, so `PrivateIPC` does not cover them.)
    - The **stdio** servers each Claude Code session on the box starts
      (`claude mcp add`, over stdio) run **unsandboxed**, as the owner: the
      sandbox is the HTTP system unit's only. So it guards against an attack
      that arrives over HTTP, not against a session on the box that is
      already the owner. This matches the accepted same-user risk above.
    - Anyone holding the raw Beeper token bypasses the policy layer entirely
      (CLAUDE.md). The sandbox protects the token at rest from a compromised
      *server*; it is not a boundary against the owner.
- **Cloud sessions can't add GitHub deploy keys.** That API path is blocked
  through their proxy. Add deploy keys in the GitHub UI.
- The user wants maximum autonomy ("do everything I can't"). The irreducibly
  human steps are:
  - account signups (card, CAPTCHA, ID checks);
  - Beeper's recovery key, and its emailed code unless the owner lets Claude
    read it from his Gmail (he did on 2026-10-13);
  - moving a network Beeper runs on-device to Beeper Cloud, in Beeper on
    the owner's own devices (he did Google Voice and Telegram on
    2026-10-13).
