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
│ assistant/ automations          │   the daily digest: reads through the guard,
│                                 │   writes with the model
├─────────────────────────────────┤
│ policy/ GuardedMessenger        │   PolicyEngine (pure decisions)
│         + JSONL audit log       │   read filters, send gates, rate limits
│         GuardedAccessRequester  │   keeps only credentials it can keep
├─────────────────────────────────┤
│ core/   Messenger port          │   provider-agnostic domain models
│         AccessRequester port    │   how the credential comes to exist
│         LanguageModel port      │   text in, text out: no tools
├─────────────────────────────────┤
│ providers/beeper/               │   @beeper/desktop-api adapter
│ providers/claude-code/          │   `claude -p` on the owner's subscription,
│                                 │   which talks to Anthropic, not Beeper
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
- **New providers**: implement `Messenger` (each message's `plainText` included) and `AccessRequester`, add a branch in `app.ts`.
- **Language model** (`core/model.ts`): `LanguageModel.write({ instructions, input })` is text in, text out, with no tools, so other people's words in its input can at worst change what it writes, never make it act. It landed with its first consumer, the digest. The implementation, `providers/claude-code/model.ts`, runs `claude -p` as installed and signed in on the host, so it runs on the owner's Claude subscription, never an API key (`--bare` would read only API keys). Each run gets the input on stdin, never on a command line; no tools, MCP servers, hooks, plugins or CLAUDE.md (`--tools ""`, `--strict-mcp-config`, `--safe-mode`); nothing attached to the input; no transcript, memory or prompt history; an empty working directory of its own, removed afterwards; and an environment with only sign-in, network and locale variables, so no Beeper token, API key or variable of a calling session reaches it. Nothing attached matters because Claude Code reads a file an @-mention in a prompt names, tools or not, so a message saying `@~/claude-messenger/.env` would put the token in front of the model. Attachments are switched off (`CLAUDE_CODE_DISABLE_ATTACHMENTS`), and every "@" in the input reaches Claude Code as a full-width "＠", which mentions nothing; either alone stops the read. `test/claude-code-binary.integration.test.ts` proves all of this against the installed Claude Code, which CI installs at its latest, as hosts auto-update to it. A Claude Code too old for `--safe-mode` rejects the flag, so the run fails before the model sees anything. `createLanguageModel` in `app.ts` is where an automation gets it.
- **Daily digest** (`assistant/digest/`, `claude-messenger digest`): the first automation that writes. `ActivityCollector` reads, through the `GuardedMessenger`, the main inbox's chats active in the window (not archived or low priority), each only as far back as it needs, keeping what shows in the chat as plain text (`Message.plainText`: each provider turns its own markup into what the chat shows). `renderBriefing` lays them out one line per message, the chats likely to need the owner first (a mention, or a direct chat waiting on them; muted chats last), others' words folded onto one line each so none can pose as the briefing's own lines, and no name passing for the owner's "You". `DigestWriter` has the model write "Needs you" and "Everything else", takes any link or email address out of what it wrote, and adds beneath it a count of what it covers and every gap: chats it couldn't read, chats it read only in part, chats left out for length, more chats than it reads. With nothing new it says so without calling the model. `--since` sets where a digest starts, so each morning can start where the last one did and nothing falls between two days. Delivery is outside the code (`docs/STATUS.md`, Daily digest).
- **Credentials**: `AccessRequester` (`core/access.ts`) is how this app gets its provider credential. A Claude session drives installs and its transcript is readable, so the credential must never pass through a terminal, a chat or a screen: the owner approves in the provider's own window, and the credential travels from the provider straight into `.env` (`claude-messenger connect`). The Beeper implementation (`providers/beeper/access.ts`) drives Beeper Desktop's OAuth approval box (dynamic client registration + PKCE), waiting for sign-in first and re-asking when Beeper closes an unanswered box. It reports the terms the owner approved; whether the app keeps them is decided above every provider, by `GuardedAccessRequester` (`policy/access.ts`). The CLI sees only the port.
- **Automations**: build on `GuardedMessenger` only, so every automated action inherits policy + audit for free. Diagnostics get a deliberately narrow `ConnectivityProbe` (checkConnection only) — the unguarded provider is never handed out of the composition root.

## Security notes

- The Beeper token is all-powerful; treat it like a password. It lives in `.env` (gitignored, owner-only) or the process environment, is never logged or displayed, and can be revoked any time in Beeper (Settings → Integrations → Approved connections).
- `connect` asks for a read-only token unless told otherwise (`--allow-send`). Beeper's approval box lets the owner grant more than was asked; a token with write access nobody asked for, or with an expiry nothing renews, is revoked rather than saved (`GuardedAccessRequester`). Fail closed: an app that can't keep a credential's terms must not leave it working.
- Policy is enforced in this process, not by Beeper. Anyone with the raw token can bypass it — the layer protects against a confused/overreaching *agent*, not a malicious *human*.
- Defense in depth for reads Claude never needs: `read.chatDenylist` + account allowlists shrink the blast radius of prompt injection from message content (a message can't talk Claude into leaking a chat it cannot see).
- The digest's model reads other people's messages, so it has no tools and nothing it can be made to read: a message can at most change what the digest says. The digest goes to the owner as written, so a message can try to mislead the owner through it, as it could when read directly; the instructions tell the model never to repeat links, codes, phone numbers or email addresses, and any link or email address it writes anyway is taken out. The model's input never touches disk, a command line or the audit log. The CLI prints the digest and keeps no copy. Whatever delivers it sees it: a Claude session that carries the digest to the owner holds it in that session's transcript.
