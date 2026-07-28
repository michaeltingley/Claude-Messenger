# Runbook: full setup driven by Claude on the user's home computer

*Audience: a Claude Code session running on the user's own machine (macOS or
Linux, real terminal, real browser nearby). Goal: stand up the always-on
Claude Messenger host on Oracle Cloud end to end, with the user touching
only identity ceremonies. Work top to bottom; each phase is idempotent.
The user's kickoff prompt points here — treat this file as your task list.*

## What the user does vs. what you do

| Step | User | You (local Claude) |
|---|---|---|
| Oracle account signup | Types card, solves CAPTCHA, taps 3DS | Nothing (or navigate alongside via browser extension) |
| OCI auth | Clicks one browser SSO popup | Everything else |
| VM + network creation | — | OCI CLI |
| Host provisioning | — | cloud-init (already in repo) |
| Tailscale join | Clicks one auth URL | Everything else |
| Beeper login on host | Pastes emailed code + recovery key when prompted | Drives the prompts over SSH |
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
   Node 22, Tailscale, beeper-cli, this repo (built), and Claude Code.

## Phase 3 — Finish on the host (you drive over SSH)

SSH in and complete what cloud-init deliberately left interactive. Follow
`deploy/bootstrap.sh` steps 3–7 semantics (the software is already
installed — you are doing configuration and logins):

1. `sudo tailscale up` → give the user the printed URL to click.
2. Sign Beeper Desktop in. **Do not run `beeper setup --server --install`** —
   see the warning in docs/DEPLOY.md; it can delete the user's cloud bridge
   connections across every device. cloud-init already has Beeper Desktop
   running headless under Xvfb with noVNC on loopback, so:
   - `sudo tailscale serve --bg --https 8443 http://127.0.0.1:6080`
   - Give the user the resulting tailnet HTTPS URL. They open it in a
     browser, see the Beeper window, and sign in themselves — relaying
     nothing. The emailed login code and the recovery key are typed by them,
     directly into the app, and never pass through chat.
   - Confirm with them when the account list has finished syncing.
3. Mint the Beeper access token in that same browser session: Beeper
   Settings → Integrations → "+" next to Approved connections. Have the user
   paste it to you, or read it off the screen. Then turn Remote Access on
   (Settings → Integrations → Advanced) only if the endpoint must be reached
   from off-box; for this topology Claude Messenger talks to 127.0.0.1:23373,
   so leave it off.
4. In `~/claude-messenger`: write `.env` (umask 077) with the token,
   `BEEPER_BASE_URL=http://127.0.0.1:23373`, absolute policy/audit/state
   paths, and a generated `CLAUDE_MESSENGER_MCP_TOKEN` (`openssl rand -hex 32`).
   Run `node dist/cli/main.js policy-init` then `doctor` — must be green.
5. Now that `doctor` is green, tear the sign-in surface back down — it exists
   only for that one login, and a VNC view of a logged-in Beeper is exactly
   what you don't want left running:
   `sudo tailscale serve --https 8443 off` and
   `systemctl --user disable --now novnc.service x11vnc.service`
   (Re-enable them the same way if the account ever needs re-authenticating.)
6. Install the systemd user unit (see bootstrap.sh's sed line for the
   `__NODE__`/`__INSTALL_DIR__`/`__PORT__` substitutions), enable + start,
   verify `/healthz`, then `sudo tailscale serve --bg http://127.0.0.1:8484`.
7. Optionally run `claude` on the host once (user signs in) so the box is
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

Diagnose before retrying; every step here is safe to re-run. If Oracle
capacity blocks Phase 2 for more than a day, the fallback is Hetzner CAX11
(~€4/mo, same phases, skip the capacity dance) or the user's own always-on
machine (skip Phases 1–2 entirely; run Phase 3 locally). Both documented in
docs/HOSTING-OPTIONS.md.
