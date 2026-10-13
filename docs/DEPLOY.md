# Hosting Claude Messenger 24/7

The end state: a small always-on Linux machine runs **Beeper Desktop**
(headless under Xvfb, logged into your account, holding your E2EE keys) and
**Claude Messenger** (policy + audit + HTTP MCP) side by side. Remote Claude
clients reach the MCP endpoint over your private tailnet. Nothing listens on
the public internet; the Beeper token never leaves the host.

```
┌─ always-on host ─────────────────────────────────────┐
│ Beeper Desktop ◄ localhost:23373 ─ Claude Messenger  │◄─ Tailscale ─ claude.ai /
│ (Xvfb, your account, E2EE keys)    (MCP :8484, auth) │               Claude Code
└──────────────────────────────────────────────────────┘
```

> **Beeper Server (`beeper setup --server --install`) is deliberately not
> used.** [beeper/cli#21](https://github.com/beeper/cli/issues/21) is open and
> unanswered: installing it on a legacy cloud-bridge account deleted every
> bridge connection — WhatsApp, Telegram, Google Messages — **across all
> devices, including the phone**, and its chats API returned empty results,
> making it useless for automation regardless. `beeper-cli` is still 0.6.2
> from 2026-05-18, so this is not quietly fixed. Beeper Desktop serves the
> identical Client API on the same port, so nothing above the provider seam
> changes (`docs/ARCHITECTURE.md`).

## What you need (the only human parts)

1. **A machine that stays on.** A small VPS (Ubuntu 24.04 or 26.04, ~$4–8/mo) or any
   home box. Size for **4 GB RAM**: Beeper Desktop is Electron, measured at
   about 0.66 GB once synced and 1.07 GB at the first sync's peak (many
   accounts push it higher), so 2 GB hosts are out. iMessage bridging needs
   macOS — use a Mac mini if that matters.
2. **A few minutes in a browser** to sign Beeper in and approve Claude
   Messenger. The app runs headless, and `deploy/signin-surface.sh` opens its
   screen to your tailnet only, just long enough for that.
   - You type the emailed code and your recovery key straight into the app;
     they are never relayed through a chat transcript.
   - You press Approve in Beeper's own "Approve connection" box, which opens
     right after the code, even before the recovery key. The token goes from
     Beeper straight into `.env`; nobody types or sees it.
   - The screen closes again as soon as the token is saved.
3. A free [Tailscale](https://tailscale.com) account (the script logs the
   host into your tailnet), with **Tailscale Serve** allowed once for the
   tailnet. If it isn't, the script stops and prints the link that allows it.

## The zero-terminal path (recommended)

Paste `deploy/cloud-init.yaml` into the VM-creation form's user-data box.
It is usually labeled "user data" or "cloud-init". OVHcloud VPS has no such
field, so use the one-command path below instead.

First boot installs everything:

- Node
- Tailscale
- Beeper Desktop (headless under Xvfb)
- Claude Messenger (built)
- **Claude Code**

Then connect once (SSH or the cloud console), run `claude`, sign in, and say
*"Finish setting up Claude Messenger on this machine."* The on-box Claude
session:

1. joins your tailnet;
2. runs `deploy/configure.sh`, which opens Beeper's screen to you over the
   tailnet. You sign in there (the emailed code and your recovery key go
   into the app yourself) and approve Claude Messenger;
3. lets the script save the token, close the screen, and start the service.

From then on, all operations (upgrades, policy edits, diagnostics) are
Claude sessions on the host, not terminal work.

## The one command (manual alternative)

SSH into the fresh machine and run:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/michaeltingley/Claude-Messenger/main/deploy/bootstrap.sh)"
```

It never prompts, so a Claude session on the host can run it just as well,
given a sudo there that needs no password (as cloud images' default user
has), in the background with a timeout above its 60-minute wait for you (Claude
Code's Bash tool stops background commands after 30 minutes by default, so
give it at least 65). It prints two links and waits for you at each:

- the Tailscale login, on the first run only;
- Beeper's screen, where you sign in and press Approve. The steps for the
  approval box are printed with the link.

What the script does:

1. Installs Node 22 and Tailscale, then clones and builds Claude Messenger.
   apt runs non-interactively, so no package prompt can stall it.
2. Installs Beeper Desktop (headless under Xvfb) with the systemd units from
   `deploy/systemd/`, and waits for it to answer.
3. Runs `deploy/configure.sh`, which does the rest and is safe to run on its
   own:
   1. Writes `.env` with a freshly generated MCP bearer token.
   2. Opens Beeper's screen to your tailnet and runs `claude-messenger
      connect`. It waits for you to sign in and approve, then saves the
      Beeper token to `.env` without displaying it.
   3. Closes the screen again. It refuses to go on while anything is still
      exposed, and it closes the screen on any exit but `kill -9` (after
      one of those, run it again).
   4. Runs `doctor` end to end.
   5. Installs and restarts the MCP service: a boot-persistent system unit
      that runs as you, sandboxed. It sees nothing of your home directory
      but the install, which it can't change, and it can write only its
      audit trail and rate window. So `.env` must keep the policy, audit
      trail and rate window in the install, as it does by default; the
      script stops before anything else if it doesn't.
   6. Exposes the MCP endpoint on your tailnet over HTTPS via
      `tailscale serve`.
   7. If `claude` is installed, registers Claude Messenger with Claude Code
      on the host over stdio: each session starts its own server from the
      checkout, which reads `.env`, so no token goes on a command line.

Re-running the script is safe: completed steps are skipped, and a token
already in `.env` is kept.

At the end it prints the MCP URL, where its bearer token is
(`CLAUDE_MESSENGER_MCP_TOKEN` in `.env`), and the `claude mcp add` command
for Claude Code on another device in your tailnet. Claude Desktop takes the
same URL and header. claude.ai's own connectors can't reach a tailnet-only
endpoint.

## Security model of the hosted setup

- The **MCP token** (generated by the script) is what Claude clients hold.
  Rotate/revoke it by editing `.env` and restarting the service — the
  Beeper token is untouched and never leaves the host.
- The **Beeper token** comes from Beeper's own approval box
  (`claude-messenger connect`). It travels from Beeper straight into `.env`
  (owner-only), so it never appears on a terminal, a screen or a chat
  transcript.
  - It is read-only unless you ask for more with `connect --allow-send`: a
    second lock that holds even if the policy layer is bypassed.
  - A token approved on other terms, with an expiry or with write access
    nobody asked for, is revoked instead of saved.
- The MCP port binds `127.0.0.1`; only `tailscale serve` (tailnet-only
  HTTPS) makes it reachable, and only to devices in your tailnet.
- Policy starts **read-only**. Enable sends by editing `policy.json` on the
  host (per-chat allowlist), same as local setups. Every action lands in
  `audit/`.

## Operations

```sh
systemctl status claude-messenger-mcp            # service state
sudo journalctl -u claude-messenger-mcp -f       # logs
systemctl --user status beeper-desktop xvfb      # Beeper Desktop health
curl -fsS localhost:23373/v1/info                # Client API is answering
cd ~/claude-messenger && git pull && npm ci && npm run build \
  && sudo systemctl restart claude-messenger-mcp     # upgrade
```

Re-running `deploy/bootstrap.sh` is the full upgrade: it also refreshes the
systemd units from `deploy/systemd/`. It does not restart a display that is
already running. A host provisioned before 2026-10-09 picks up the display's
X cookie only after `systemctl --user restart xvfb.service` (Beeper restarts
with it) or a reboot.

To re-authenticate Beeper later (signing out deletes its approvals, so the
token stops working), get a new token the same way:

```sh
~/claude-messenger/deploy/configure.sh --reconnect
```

It opens the screen, waits for you to sign in and approve, saves the new
token, closes the screen, and restarts the service. To open Beeper's screen
for anything else, use the surface script directly:

```sh
~/claude-messenger/deploy/signin-surface.sh up      # prints the tailnet-only URL, with a fresh password
~/claude-messenger/deploy/signin-surface.sh down    # verifies nothing is left exposed
~/claude-messenger/deploy/signin-surface.sh status  # exit 1 = fully closed
```

## Known caveats

- **Plan for 4 GB RAM.** Beeper Desktop is an Electron app.
  - Measured under Xvfb on 2026-10-13 with 9 cloud networks: about 0.66 GB
    PSS once synced (0.9 GB counting its cgroups' page cache), peaking near
    1.07 GB during the first sync. Many accounts and long uptimes push it
    higher.
  - Add Claude Messenger's own footprint on top.
  - 2 GB hosts are not viable for this topology.
- **Beeper Desktop must stay signed in.** If the account is signed out or the
  E2EE device is invalidated, the Client API keeps answering but returns no
  decryptable history — `doctor` catches this, so run it after any incident.
  Signing out also deletes Beeper's approvals; `configure.sh --reconnect`
  gets a new token.
- The sign-in surface (x11vnc + noVNC) is loopback-bound and never enabled
  at boot. It is open only between `signin-surface.sh up` and `down`, and
  `signin-surface.sh status` checks its state. A VNC view of a signed-in
  Beeper is equivalent to holding the account.
- **The host is safe to share** with other local users, such as the
  automation agent in `SHARED-HOST.md`:
  - The Xvfb display admits only clients holding its X cookie, which is
    owner-only in `/run/user/UID`.
  - While the surface is up, VNC demands a password. Each `up` mints a fresh
    one and `down` deletes it.
  - `bootstrap.sh` and `configure.sh` make the home directory, and with it
    `.env`, unreadable to other users.
- One Beeper account per host.
- **Only Beeper Cloud connections come along.** A network you connected
  On-Device runs on each device separately, so the host doesn't get it.
  Either re-add it in Beeper as a Cloud connection, which then reaches every
  device and runs nothing on the host, or set it up on the host itself: its
  Beeper lists such networks under Settings → Accounts → "On Other
  Devices", each with a Connect button, so open the sign-in surface, press
  it, and sign in to that network there.
