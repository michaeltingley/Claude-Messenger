# Setup

Three steps: get a Beeper endpoint + token, point Claude Messenger at it, connect Claude.

## 1. Beeper endpoint + access token

### Option A — Beeper Desktop on your machine (5 minutes, start here)

1. Open Beeper Desktop → **Settings → Developers** → enable **Beeper Desktop API**.
2. **Settings → Developers → Approved connections** → **+** → name it `claude-messenger` → copy the token.
   (Newer builds: **Settings → Integrations** hosts the same controls.)
3. The API is now at `http://localhost:23373` while the app runs.

### Option B — Headless Beeper Server on a VPS (24/7, no GUI)

Official headless server, same Client API on the same port — SDK/MCP clients point at it unchanged. **Beta caveat (July 2026):** `beeper-server` artifacts currently ship only from Beeper's staging environment on the nightly channel (verified in the CLI installer source), with no published system requirements and little community track record. Expect churn; if that's unacceptable, use Option C.

On an always-on Linux box or Mac mini (1–2 GB RAM expected):

```sh
npm install -g beeper-cli               # CLI is MIT; the server binary is proprietary
beeper setup --server --install --email you@example.com
                                        # installs + starts server on http://127.0.0.1:23373
                                        # prompts for the login code Beeper emails you
beeper verify recovery-key              # unlock E2EE (or SAS/QR verify from your phone)
beeper doctor                           # must report the target encrypted-ready
beeper accounts add                     # connect networks (WhatsApp QR, Telegram code, ...)
beeper targets enable                   # persist across reboots (systemd --user unit)
loginctl enable-linger "$USER"          # Linux: let the user unit run without a login session
```

Mint a token for Claude Messenger via the CLI/OAuth flow, then treat `http://127.0.0.1:23373` on that machine as your endpoint. Note: iMessage bridging requires macOS, so an iMessage-heavy setup may prefer a Mac mini as the always-on host.

### Option C — Beeper Desktop on an always-on machine (24/7, GA path)

The officially supported route since Sept 2025: run regular Beeper Desktop on any machine that stays awake (spare desktop, Mac mini, home server), enable **Settings → Integrations → Advanced → Remote Access**, and reach it through a tunnel. Same API, boring and stable; costs you a GUI machine that must stay logged in.

### Making either reachable from elsewhere (tunnels)

The API has bearer-token auth but **no TLS** — never expose the raw port to the internet. Use one of:

- **Tailscale** (recommended): join your desktop/VPS and the machine running Claude Messenger to the same tailnet; use `http://<tailscale-ip>:23373`.
- **Cloudflare Quick Tunnel**: `cloudflared tunnel --url http://localhost:23373` → gives an HTTPS URL.

If connecting from another device to Beeper *Desktop*, also enable **Settings → Integrations → Advanced → Remote Access** (binds beyond localhost, tunnel-aware).

## 2. Configure and verify Claude Messenger

```sh
npm install && npm run build
cp .env.example .env      # set BEEPER_ACCESS_TOKEN and, if not local, BEEPER_BASE_URL
npx claude-messenger doctor
```

`doctor` walks the whole chain — config → connectivity → token → accounts → policy — and tells you exactly which link is broken if any.

Then set up permissions:

```sh
npx claude-messenger policy-init   # writes read-only policy.json
npx claude-messenger chats         # find chat IDs
```

To allow sending to a specific chat, edit `policy.json`:

```json
{
  "capabilities": { "read": true, "send": true, "markRead": false },
  "send": { "chatAllowlist": ["<chat-id-from-chats-command>"], "maxMessagesPerHour": 10 }
}
```

Test the guardrails: `claude-messenger send <allowed-chat> "test"` should work; sending anywhere else must be denied. Check `audit/` for the trail.

## 3. Connect Claude

**Claude Code** (machine that can reach the endpoint):

```sh
claude mcp add claude-messenger -s user -- node /path/to/Claude-Messenger/dist/cli/main.js serve
```

**Claude Desktop** — add to MCP settings:

```json
{
  "mcpServers": {
    "claude-messenger": {
      "command": "node",
      "args": ["/path/to/Claude-Messenger/dist/cli/main.js", "serve"],
      "env": {
        "BEEPER_ACCESS_TOKEN": "…",
        "BEEPER_BASE_URL": "http://localhost:23373",
        "CLAUDE_MESSENGER_POLICY": "/path/to/policy.json",
        "CLAUDE_MESSENGER_AUDIT_DIR": "/path/to/audit"
      }
    }
  }
}
```

Ask Claude: *"Use whoami then search_chats to show my unread chats."*

### Token hygiene

- Revoke any token instantly: Beeper → Settings → Integrations → Approved connections.
- One token per consumer (one for this project, one per experiment) so revocation is surgical.
- Rotate a token you've ever pasted into a chat or shared screen.
