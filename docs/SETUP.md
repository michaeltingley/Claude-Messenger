# Setup

Three steps: get a Beeper endpoint + token, point Claude Messenger at it, connect Claude.

## 1. Beeper endpoint + access token

### Option A — Beeper Desktop on your machine (5 minutes, start here)

1. Open Beeper Desktop → **Settings → Developers** → enable **Beeper Desktop API**.
2. **Settings → Developers → Approved connections** → **+** → name it `claude-messenger` → copy the token.
   (Newer builds: **Settings → Integrations** hosts the same controls.)
3. The API is now at `http://localhost:23373` while the app runs.

### Option B — Headless Beeper Server on a VPS (24/7, no GUI)

Official headless server, same API. On an always-on Linux box (2 GB RAM is plenty):

```sh
npm install -g beeper-cli
beeper setup --server --install   # installs + starts server on http://127.0.0.1:23373
beeper targets enable             # start on boot
beeper accounts add               # log in (email code) and connect networks
```

Mint a token for Claude Messenger via the CLI/OAuth flow, then treat `http://127.0.0.1:23373` on that machine as your endpoint. Note: iMessage bridging requires macOS, so an iMessage-heavy setup may prefer a Mac mini as the always-on host.

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
