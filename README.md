# Claude Messenger

A policy-guarded bridge between Claude and your [Beeper](https://www.beeper.com) chats — read, search, and (when explicitly allowed) act on your messages across WhatsApp, Signal, Telegram, iMessage, and every other network Beeper bridges.

## Why this exists

Beeper's [Client API](https://developers.beeper.com/desktop-api) gives any token holder **full** access: read everything, message anyone, on all your networks. That's the wrong permission model for handing to an AI agent. Claude Messenger wraps it with:

- **A policy layer** — read-only by default; sending requires opting in *and* allowlisting specific chats; per-hour rate limits; chat denylists that hide conversations from Claude entirely.
- **An append-only audit log** — every action Claude attempts (allowed or denied) is recorded; outbound message text is always logged so you can review exactly what was said as you.
- **A curated MCP server** — a deliberately narrow tool surface (no delete, no archive) instead of the raw API.
- **A provider-agnostic core** — the Beeper Client API is adapter #1; a raw-Matrix provider can slot in behind the same interface later.

## Layout

```
src/
├── core/        domain models + the Messenger and LanguageModel ports (no provider imports)
├── providers/
│   ├── beeper/  adapter for the Beeper Client API (Desktop app or headless Beeper Server)
│   └── claude-code/  the language model: Claude Code's CLI, on your Claude subscription
├── policy/      policy engine, guarded messenger, audit log
├── assistant/   automations on the guarded messenger: the daily digest and the @Claude mention listener
├── mcp/         MCP server exposing curated tools
├── cli/         claude-messenger CLI (doctor, chats, send, serve, mentions, ...)
├── app.ts       composition root
└── config.ts    env-based configuration
```

## Quick start

```sh
npm install && npm run build

cp .env.example .env    # then fill in BEEPER_ACCESS_TOKEN (see docs/SETUP.md)

npx claude-messenger doctor    # verifies config → connectivity → auth → policy
npx claude-messenger chats     # your recent chats
npx claude-messenger digest    # what needs you from the last day, then the rest (needs Claude Code)
npx claude-messenger serve     # MCP server on stdio for Claude Code / Desktop
npx claude-messenger mentions  # follow the messages you send that mention @Claude
```

See **[docs/SETUP.md](docs/SETUP.md)** for creating the Beeper token and connecting Claude locally, **[docs/DEPLOY.md](docs/DEPLOY.md)** for the one-command 24/7 hosted setup (VPS + headless Beeper Desktop + HTTP MCP over Tailscale), and **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for design decisions.

## Permissions model in one paragraph

`policy.json` (create with `claude-messenger policy-init`) is the contract. Out of the box Claude can read and search everything but can change nothing: no sends, no read receipts, no new chats, nothing visible to other people. To let Claude send, set `capabilities.send: true` and list the exact chat IDs in `send.chatAllowlist`; to let it open a direct chat with someone (`start-chat`), set `capabilities.startChat: true` and list their user IDs in `startChat.userAllowlist`. Chats in `read.chatDenylist` never reach Claude at all — they're filtered out of every listing, search, and direct fetch. Every decision is written to `audit/audit-YYYY-MM-DD.jsonl`.
