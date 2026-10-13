# Runbook: full setup driven by Claude on the user's home computer

*Audience: a Claude Code session running on the user's own machine (macOS or
Linux, real terminal, real browser nearby). Goal: stand up the always-on
Claude Messenger host on Oracle Cloud end to end, with the user touching
only identity ceremonies. Work top to bottom; each phase is idempotent.
The user's kickoff prompt points here — treat this file as your task list.*

> **⚠ Superseded for the current host. Follow `docs/STATUS.md` instead.**
>
> - Phases 0–2 are Oracle-specific, and Oracle is dead: the home region has
>   a permanent capacity wall.
> - The host is an OVHcloud US VPS that is already running and shared with
>   the automation agent. Host work runs as Claude sessions on the box
>   itself, not over SSH from a home computer.
> - Where Phases 3–4 and `deploy/bootstrap.sh` differ, the script wins.

## What the user does vs. what you do

| Step | User | You (local Claude) |
|---|---|---|
| Oracle account signup | Types card, solves CAPTCHA, taps 3DS | Nothing (or navigate alongside via browser extension) |
| OCI auth | Clicks one browser SSO popup | Everything else |
| VM + network creation | — | OCI CLI |
| Host provisioning | — | cloud-init (already in repo) |
| Tailscale join | Clicks one auth URL | Everything else |
| Beeper login + approval on host | Types emailed code + recovery key into Beeper's own window, presses Approve | Runs `deploy/configure.sh`, relays its link and steps |
| MCP token, service, verification | — | Everything |

## Phase 0 — Preconditions

1. Confirm you're on the user's machine with network + a browser they can
   see. Confirm `git`, `node >= 20`, `ssh` exist; install what's missing
   (Homebrew/apt).
2. Clone this repo if not present: `git clone https://github.com/michaeltingley/Claude-Messenger.git`
3. Ask the user to complete Oracle Cloud signup (oracle.com/cloud/free) if
   they haven't. Recommend: a major US home region with Ampere A1 capacity;
   after signup, upgrade the account to Pay-As-You-Go (Billing → Upgrade)
   — stays $0 within Always Free limits but removes idle-reclamation and
   capacity-lottery problems (see docs/HOSTING-OPTIONS.md).

## Phase 1 — OCI CLI + session auth (no long-lived keys)

1. Install the OCI CLI (`brew install oci-cli` or the official installer).
2. Run `oci session authenticate --region <their-home-region>` — this opens
   a browser SSO page; the user clicks approve. You now have a short-lived
   session; use `--auth security_token` (or the created profile) on every
   subsequent command. Re-run authenticate if the token expires mid-task.

## Phase 2 — Network + instance

1. Discover availability domains and check Ampere A1 capacity. Target
   shape `VM.Standard.A1.Flex`, 2 OCPUs / 8–12 GB RAM, 50 GB boot volume,
   Ubuntu 24.04 (aarch64 image).
2. Create (or reuse) a VCN with an internet gateway and a public subnet.
   Security list: allow inbound 22/tcp only (everything else rides
   Tailscale later; the MCP port stays loopback on the host).
3. Generate a fresh SSH keypair locally (`~/.ssh/claude-messenger-host`)
   for this host.
4. Launch the instance with `deploy/cloud-init.yaml` (this repo) as
   user-data, the new public key, and the shape above. If the AD reports
   "out of host capacity", retry other ADs, then other times of day; PAYG
   accounts rarely hit this.
5. Wait for RUNNING, fetch the public IP, then wait for cloud-init to
   finish (`ssh ubuntu@<ip> cloud-init status --wait`). First boot installs
   Node 22, Tailscale, Beeper Desktop (headless under Xvfb), this repo
   (built), and Claude Code.

## Phase 3 — Finish on the host (you drive over SSH)

SSH in and complete what cloud-init deliberately left to the user's
logins. The software is already installed; what remains is `deploy/bootstrap.sh`
step 3 (Tailscale) and step 6 (`deploy/configure.sh`):

1. `sudo tailscale up` → give the user the printed URL to click.
2. Run `~/claude-messenger/deploy/configure.sh` (it never prompts; run it in
   the background and read its output). **Do not run `beeper setup --server
   --install`** — see the warning in docs/DEPLOY.md; it can delete the user's
   cloud bridge connections across every device.

   cloud-init already has Beeper Desktop running headless under Xvfb, with
   the sign-in surface installed but closed. The script:
   - Writes `.env` (owner-only) with the policy, audit and state paths and a
     generated `CLAUDE_MESSENGER_MCP_TOKEN`.
   - Opens Beeper's screen to the tailnet with `signin-surface.sh up` and
     prints its URL, then the steps for Beeper's approval box. Give the user
     both in one message. The URL carries a one-time viewer password in its
     `#` fragment, which never reaches the server.
   - Waits while the user signs in (emailed code, then recovery key, typed
     into the app, so neither passes through chat) and approves Claude
     Messenger in Beeper's "Approve connection" box. `claude-messenger
     connect` then saves the token straight into `.env`; nobody sees it.
   - Closes the screen and verifies that nothing is left exposed, then runs
     `doctor`, starts the systemd user service, publishes it with
     `tailscale serve`, and adds it to Claude Code on the host.

   If it stops, it says why and what to do; every step is safe to re-run.
   If Tailscale Serve is off for the tailnet, it prints the link that turns
   it on: give the user that link, then run the script again. Leave Beeper's
   Remote Access setting off: Claude Messenger talks to 127.0.0.1:23373.
3. Optionally run `claude` on the host once (user signs in) so the box is
   Claude-operable for all future maintenance — this is the intended end
   state (docs/DEPLOY.md, zero-terminal path).

## Phase 4 — Connect + verify + harden

1. On the user's machine: `claude mcp add claude-messenger --transport http
   https://<magicdns>/mcp --header "Authorization: Bearer <mcp token>"` —
   read the token off the host's `.env`, never echo it into logs.
2. Prove the loop: from a fresh session, `check_connection` + `search_chats`
   against real data.
3. Lock the door you came in through: once Tailscale SSH or the tailnet
   path is confirmed working, remove the public 22/tcp ingress rule (or
   restrict to the user's home IP).
4. Remind the user: policy is read-only until `policy.json` on the host is
   edited; audit trail lives in `~/claude-messenger/audit/`.

## Failure etiquette

Diagnose before retrying; every step here is safe to re-run.

If the VPS order stalls (OVH can hold new orders for ID verification), there
are two fallbacks, both in docs/HOSTING-OPTIONS.md:

- Contabo Cloud VPS 4. Its API takes cloud-init `userData`.
- The user's own always-on machine. Run Phase 3 locally.

Hetzner is no longer a fallback. Its US 4 GB plan is $38/mo, and its EU 4 GB
plans are unavailable.
