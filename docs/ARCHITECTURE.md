# Architecture

## The constraint that shapes everything

Beeper is Matrix under the hood with end-to-end encryption: **only a device logged into your account can decrypt your messages**. Beeper therefore has no third-party cloud API. The official surface is the **Beeper Client API** — an HTTP + MCP server embedded in a logged-in Beeper client, historically Beeper Desktop (`localhost:23373`) and now also the official headless **Beeper Server** (`beeper setup --server --install`, same API, same port, no GUI).

Consequence: Claude Messenger is a *client* of a Beeper endpoint that must run somewhere logged into your account. Where that endpoint runs is pure configuration (`BEEPER_BASE_URL`); nothing else changes.

> In practice we run **Beeper Desktop** for that endpoint, including on headless hosts (under Xvfb). The headless **Beeper Server** is deliberately unused: [beeper/cli#21](https://github.com/beeper/cli/issues/21) is open and unanswered, and reports it deleting a legacy account's bridge connections across every device. Because the endpoint is pure configuration, this choice touches nothing above `providers/` — which is the property this seam exists to provide.

## Layers

```
Claude (Claude Code / Desktop / claude.ai)
   │  MCP (stdio locally, or Streamable HTTP + bearer token when hosted)
┌──▼──────────────────────────────┐
│ mcp/    curated tools           │   deliberately narrow: no delete/archive
├─────────────────────────────────┤
│ policy/ GuardedMessenger        │   PolicyEngine (pure decisions)
│         + JSONL audit log       │   read filters, send gates, rate limits
├─────────────────────────────────┤
│ core/   Messenger port          │   provider-agnostic domain models
├─────────────────────────────────┤
│ providers/beeper/               │   @beeper/desktop-api adapter
└──┬──────────────────────────────┘
   │  HTTPS + bearer token
Beeper Client API (Desktop app OR headless Beeper Server)
   │
Beeper cloud bridges ⇄ WhatsApp / Signal / Telegram / iMessage / ...
```

### Rules that keep it clean

1. **Nothing above `providers/` imports a provider SDK.** The `Messenger` interface (`core/messenger.ts`) is the seam. Tests run against `FakeMessenger`; a raw-Matrix provider (via Beeper's own `@beeper/pickle` / `@beeper/chat-adapter-matrix`) can be added without touching policy, MCP, or CLI.
2. **The tool layer only ever sees the `GuardedMessenger`.** Policy checks happen in-process *before* any provider call; denials throw `PolicyDeniedError` naming the rule. Read results are filtered so denylisted chats never enter Claude's context.
3. **`PolicyEngine` owns decisions, not I/O.** The clock and the rate-limit store (`RateWindow`) are injected: tests control time with a memory window, while the composition root wires a file-backed window so send limits survive process restarts (each CLI `send` is a fresh process).
4. **Audit content policy**: outbound text is recorded (you must be able to review what was said as you); read message content is never written to the audit log (your history doesn't belong in log files).

## Deployment topologies

| Topology | BEEPER_BASE_URL | Use case |
|---|---|---|
| Local | `http://localhost:23373` | Claude Code/Desktop on the same machine as Beeper Desktop |
| Tunnel | `https://<tunnel-host>` | Remote Claude (web sessions, automations) reaching your desktop via Tailscale/cloudflared |
| Headless server | `http://<vps>:23373` (behind tunnel/VPN) | 24/7 always-on: official Beeper Server on a small VPS (beta as of mid-2026) |
| Always-on desktop | `https://<tunnel-host>` | 24/7 GA fallback: Beeper Desktop + Remote Access on a machine that stays awake |

Beeper Desktop's *Remote Access* setting (Settings → Integrations → Advanced) binds the API to all interfaces and is designed for tunnels; auth stays bearer-token. Beeper ships no TLS — never expose the port raw.

## Extension points (deliberate, not speculative)

- **Streaming/triggers**: the Client API has an experimental WebSocket (`/v1/ws`, `message.upserted` etc.). Streaming will be added to the `Messenger` port together with its first provider implementation *and* a guarded wrapper in the same change, so pushed events pass through the same visibility filtering and audit as pulled reads. Until then, poll `searchChats({unreadOnly: true})`.
- **New providers**: implement `Messenger`, add a branch in `app.ts`.
- **Automations**: build on `GuardedMessenger` only, so every automated action inherits policy + audit for free. Diagnostics get a deliberately narrow `ConnectivityProbe` (checkConnection only) — the unguarded provider is never handed out of the composition root.

## Security notes

- The Beeper token is all-powerful; treat it like a password. It lives in `.env` (gitignored) or the process environment, is never logged, and can be revoked any time in Beeper (Settings → Integrations → Approved connections).
- Policy is enforced in this process, not by Beeper. Anyone with the raw token can bypass it — the layer protects against a confused/overreaching *agent*, not a malicious *human*.
- Defense in depth for reads Claude never needs: `read.chatDenylist` + account allowlists shrink the blast radius of prompt injection from message content (a message can't talk Claude into leaking a chat it cannot see).
