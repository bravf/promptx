# PromptX

[中文 README](README.md)

PromptX is a local-first workspace for AI coding agents. It keeps working directories, agent conversations, execution timelines, replies, file browsing, and Git diffs in one interface, with encrypted remote access through Relay.

The V2 data model is:

```text
Workspace -> Agent conversation -> Turn -> Timeline
```

Each workspace maps to a real directory and may contain multiple Codex, Claude, or Kimi conversations. PromptX resumes native provider sessions and reconciles their histories into one local timeline format.

## Features

- Codex, Claude Code, and Kimi Code providers.
- Import existing local sessions from all three providers.
- Live user messages, reasoning, tool activity, and final replies.
- In-memory drafts per conversation; drafts survive switching conversations but not a page reload.
- Workspace file browsing and staged, unstaged, or untracked Git diffs.
- One responsive desktop and mobile UI with browser-back navigation on mobile pages and dialogs.
- End-to-end encryption between the browser and Daemon; the public Relay only forwards ciphertext.

## Quick Start

Requirements:

- Node 22 LTS is recommended. Node 20.19+, 22.13+, and 24.x are supported.
- Install at least one supported provider CLI: `codex`, `claude`, or `kimi`.

```bash
npm install -g @muyichengshayu/promptx
promptx doctor
promptx start
```

Open `http://127.0.0.1:3001`.

```bash
promptx status
promptx restart
promptx stop
```

Runtime data is stored under `~/.promptx/`. PromptX currently targets a local single-user workflow and does not include accounts or team authorization.

## Development

```bash
pnpm install
pnpm dev
```

Development defaults:

- Web: `http://127.0.0.1:5174`
- Daemon: `http://127.0.0.1:3001`

```bash
pnpm test
pnpm build
pnpm test:e2e
pnpm release:check
```

Workspace layout:

- `apps/web`: Vue 3 and Vite frontend.
- `apps/daemon`: Fastify Daemon that owns providers, timelines, SQLite, and filesystem access.
- `apps/android`: Android WebView shell for the remote H5 app.
- `packages/protocol`: shared API schemas and timeline projection.
- `packages/relay`: E2EE, pairing protocol, and the public Relay Server.
- `packages/shared`: cross-module utilities.

V2 does not read or migrate V1 data and no longer includes the old Server/Runner split. See the [V2 architecture baseline](docs/v2-architecture-baseline.md).

## Remote Access

After starting PromptX, open Settings -> Remote Access and scan the QR code. Treat the full pairing URL as a credential and do not share it publicly.

- [Relay quick start](docs/relay-quickstart.md)
- [E2EE Relay architecture](docs/relay-e2ee-architecture.md)

The repository also includes the Aliyun deployment script:

```bash
pnpm deploy:relay:aliyun
```

## License

PromptX is licensed under Apache-2.0. See [LICENSE](LICENSE).
