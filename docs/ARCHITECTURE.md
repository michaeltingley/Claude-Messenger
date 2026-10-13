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
│ assistant/ @Claude mentions     │   automations: the user's own messages only
├─────────────────────────────────┤
│ policy/ GuardedMessenger        │   PolicyEngine (pure decisions)
│         + JSONL audit log       │   read filters, send gates, rate limits
│         GuardedAccessRequester  │   keeps only credentials it can keep
├─────────────────────────────────┤
│ core/   Messenger port          │   provider-agnostic domain models
│         AccessRequester port    │   how the credential comes to exist
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
2. **The tool layer only ever sees the `GuardedMessenger`.** Policy checks happen in-process *before* any provider call; denials throw `PolicyDeniedError` naming the rule. Read results are filtered so denylisted chats never enter Claude's context. Likewise `connect` only gets the `GuardedAccessRequester`.
3. **`PolicyEngine` owns decisions, not I/O.** The clock and the rate-limit store (`RateWindow`) are injected: tests control time with a memory window, while the composition root wires a file-backed window so send limits survive process restarts (each CLI `send` is a fresh process).
4. **Audit content policy**: outbound text is recorded (you must be able to review what was said as you); read message content is never written to the audit log (your history doesn't belong in log files). A watch records which message it handed on (chat and message IDs), never what it said.

## Deployment topologies

| Topology | BEEPER_BASE_URL | Use case |
|---|---|---|
| Local | `http://localhost:23373` | Claude Code/Desktop on the same machine as Beeper Desktop |
| Tunnel | `https://<tunnel-host>` | Remote Claude (web sessions, automations) reaching your desktop via Tailscale/cloudflared |
| Headless server | `http://<vps>:23373` (behind tunnel/VPN) | 24/7 always-on: official Beeper Server on a small VPS (beta as of mid-2026) |
| Always-on desktop | `https://<tunnel-host>` | 24/7 GA fallback: Beeper Desktop + Remote Access on a machine that stays awake |

Beeper Desktop's *Remote Access* setting (Settings → Integrations → Advanced) binds the API to all interfaces and is designed for tunnels; auth stays bearer-token. Beeper ships no TLS — never expose the port raw.

## Extension points (deliberate, not speculative)

- **Streaming/triggers**: `Messenger.watchMessages` delivers messages as they reach the backend, each once, after a `since` time. It landed with its first consumer (the @Claude listener, `assistant/mentions.ts` and `claude-messenger mentions`), its Beeper implementation and its guarded wrapper in one change, as planned:
  - **Guarded**: `GuardedMessenger.watchMessages` checks the read policy before the provider is asked, hands on only the user's own messages whatever the provider returns, filters every message through the same visibility predicate as reads, and audits like a mutation: intent first (mandatory), a delivery entry before each message is handed on (mandatory; IDs only), the outcome last (best-effort). Idle polls write nothing.
  - **Beeper**: the Client API's WebSocket (`/v1/ws`, `message.upserted`) is experimental, so the provider polls message search instead (`providers/watch-by-polling.ts`, every `BEEPER_POLL_INTERVAL_MS`, default 5 s). Each scan re-reads a 10-minute window behind the previous one, because a message can reach Beeper after its own timestamp (a bridge reconnecting); one that arrives later than that is missed. The window follows the host clock, not message timestamps, so a message dated in the future can't hide later ones; that clock must agree with the network's to within the window, as NTP keeps it. A scan takes at most 50 pages (1,000 messages): a bigger catch-up fails with `BacklogTooLargeError` rather than skip any. A failure ends the watch with its error. Nothing retries, not even the SDK's own retries, whose waits an abort can't cut short, so the caller decides how to resume. A WebSocket or Matrix `/sync` implementation can replace the poller without touching anything above `providers/`.
  - **Only the user's own messages** for now (`sender: 'me'`): the listener never reads anyone else's messages, and only the user's own words can set Claude to work. Other senders join the query with the first watch that needs them.
- **New providers**: implement `Messenger` and `AccessRequester`, add a branch in `app.ts`.
- **Credentials**: `AccessRequester` (`core/access.ts`) is how this app gets its provider credential. A Claude session drives installs and its transcript is readable, so the credential must never pass through a terminal, a chat or a screen: the owner approves in the provider's own window, and the credential travels from the provider straight into `.env` (`claude-messenger connect`). The Beeper implementation (`providers/beeper/access.ts`) drives Beeper Desktop's OAuth approval box (dynamic client registration + PKCE), waiting for sign-in first and re-asking when Beeper closes an unanswered box. It reports the terms the owner approved; whether the app keeps them is decided above every provider, by `GuardedAccessRequester` (`policy/access.ts`). The CLI sees only the port.
- **Automations** (`assistant/`): build on `GuardedMessenger` only, so every automated action inherits policy + audit for free. The first is the @Claude listener: `mentionsClaude` decides whether a message addresses Claude (the user's own words naming `@claude` as a word, not a quote, a reply's copy of another message, a reaction, or a pill naming someone in the chat), and `watchMentions` follows the user's messages for those. It sees a message as it first arrives, so whatever acts on a mention reads it again first. Diagnostics get a deliberately narrow `ConnectivityProbe` (checkConnection only) — the unguarded provider is never handed out of the composition root.

## Security notes

- The Beeper token is all-powerful; treat it like a password. It lives in `.env` (gitignored, owner-only) or the process environment, is never logged or displayed, and can be revoked any time in Beeper (Settings → Integrations → Approved connections).
- `connect` asks for a read-only token unless told otherwise (`--allow-send`). Beeper's approval box lets the owner grant more than was asked; a token with write access nobody asked for, or with an expiry nothing renews, is revoked rather than saved (`GuardedAccessRequester`). Fail closed: an app that can't keep a credential's terms must not leave it working.
- Policy is enforced in this process, not by Beeper. Anyone with the raw token can bypass it — the layer protects against a confused/overreaching *agent*, not a malicious *human*.
- Defense in depth for reads Claude never needs: `read.chatDenylist` + account allowlists shrink the blast radius of prompt injection from message content (a message can't talk Claude into leaking a chat it cannot see).
