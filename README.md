# Antigravity Proxy

![Antigravity Proxy Dashboard](screenshots/screenshot.png)

Antigravity Proxy is a high-performance gateway that exposes Google's internal Gemini and Claude APIs through an **OpenAI-compatible interface**. It enables seamless integration between advanced models (like Claude Opus 5.5, Gemini 3, and GPT-OSS) and agents that speak the OpenAI API (such as **OpenCode**), as well as any application supporting the OpenAI API standard.

This project is strongly inspired by [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth).

## Features

- **OpenAI API Compatibility**: Full support for `v1/chat/completions` with streaming (SSE).
- **Multi-Agent Support**: Works with **OpenCode** and other agentic frameworks that accept an OpenAI-compatible provider.
- **Account Rotation & Health Scoring**: Automatically rotates multiple Google accounts, penalizing those with errors and favoring healthy ones.
- **Quota Management**: Real-time monitoring and automatic cooldowns (backoff) on `429 Too Many Requests` errors.
- **Dual-Pool Routing**:
  - **CLI Pool**: Routes to production endpoints (Gemini 2.5/3 Flash & Pro).
  - **Sandbox Pool**: Accesses internal/experimental models (Claude 3.5 Sonnet, Thinking models, GPT-equivalent).
- **Integrated Dashboard**: Manage accounts, monitor health, and view real-time logs via a built-in web interface.
- **Automatic Project Discovery**: Auto-detects Google Cloud Project IDs via Cloud SDK impersonation.

## Deployment Options

### Bunx (Recommended)
You can run the proxy instantly using `bunx`:
```bash
bunx antigravity-proxy@0.7.0
```

### Docker Hub
```bash
docker run -d -p 3000:3000 -e BASE_URL=http://localhost:3000 --name antigravity-proxy frieserpaldi/antigravity-proxy:0.7.0
```

### Local Execution (Bun)
Requirements: Bun (v1.0.0 or higher).
```bash
bun install
bun run start
```
The server listens on `http://127.0.0.1:3333` (this machine only). Set `PORT` to change the port, or `HOST=0.0.0.0` to accept connections from other machines.

On Windows, `bun run start` can fail with `interpreter executable "/bin/sh" not found`; run `bun src/server.ts` instead.

Open `http://127.0.0.1:3333/` for the dashboard, and `http://127.0.0.1:3333/oauth/start` to add a Google account.

## OpenAI-Compatible API

Base URL: `http://127.0.0.1:3333/v1`. No API key is checked, so clients that require one can use any placeholder.

| Endpoint | Description |
|---|---|
| `GET /v1/models` | Models available to your accounts |
| `POST /v1/chat/completions` | Chat completions, streaming (`stream: true`) or not, with `tools`, `temperature`, `max_tokens`, `top_p`, `stop`, and `thinking_budget` / `thinking.budget_tokens` |

```bash
curl http://127.0.0.1:3333/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-5-5-low", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Choosing a model

- Use the IDs returned by `GET /v1/models`; they depend on your account.
- Plain `gemini-2.5-*` and Gemini 3 Pro IDs are routed to the Gemini CLI endpoint, which needs a Gemini Code Assist license. Prefix them with `antigravity-` (e.g. `antigravity-gemini-2.5-flash`) to use the Antigravity endpoint instead.
- Google keeps advertising some models it is retiring (tagged "Leaving Soon"), such as Gemini 3.1 Pro and Gemini 3.6 Flash; these can return `404 model_not_found`. `gemini-3.8-flash-tiered` works but is not listed by `/v1/models`.

## Integration Guides

### Claude Code
Claude Code talks to the Anthropic Messages API, not the OpenAI API, so it cannot use this proxy directly. Put a translation layer that exposes an Anthropic-compatible endpoint (for example LiteLLM or claude-code-router) in front of the proxy, or use an OpenAI-compatible agent such as OpenCode.

### OpenCode Configuration
Add the following provider to your `~/.config/opencode/opencode.json` under the `"provider"` key:

```json
"provider": {
    "antigravity-proxy": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Antigravity Proxy",
        "options": {
            "baseURL": "http://localhost:3333/v1"
        },
        "models": {
            "claude-opus-5-5-high": {
                "name": "Claude Opus 5.5 High (Antigravity)",
                "limit": { "context": 1000000, "output": 128000 }
            },
            "claude-opus-5-5-medium": {
                "name": "Claude Opus 5.5 Medium (Antigravity)",
                "limit": { "context": 1000000, "output": 128000 }
            },
            "claude-opus-5-5-low": {
                "name": "Claude Opus 5.5 Low (Antigravity)",
                "limit": { "context": 1000000, "output": 128000 }
            },
            "claude-sonnet-5-5-high": {
                "name": "Claude Sonnet 5.5 High (Antigravity)",
                "limit": { "context": 1000000, "output": 128000 }
            },
            "claude-sonnet-5-5-medium": {
                "name": "Claude Sonnet 5.5 Medium (Antigravity)",
                "limit": { "context": 1000000, "output": 128000 }
            },
            "claude-sonnet-5-5-low": {
                "name": "Claude Sonnet 5.5 Low (Antigravity)",
                "limit": { "context": 1000000, "output": 128000 }
            },
            "gemini-3.8-flash-tiered": {
                "name": "Gemini 3.8 Flash (Antigravity)",
                "limit": { "context": 1048576, "output": 65536 }
            },
            "gemini-3-flash": {
                "name": "Gemini 3 Flash (Antigravity)",
                "limit": { "context": 1048576, "output": 65536 }
            },
            "gemini-3.1-flash-lite": {
                "name": "Gemini 3.1 Flash Lite (Antigravity)",
                "limit": { "context": 1048576, "output": 65535 }
            },
            "antigravity-gemini-2.5-flash": {
                "name": "Gemini 2.5 Flash (Antigravity)",
                "limit": { "context": 1048576, "output": 65535 }
            },
            "gpt-oss-120b-medium": {
                "name": "GPT-OSS 120B Medium (Antigravity)",
                "limit": { "context": 131072, "output": 32768 }
            }
        }
    }
}
```

## How It Works

Antigravity Proxy acts as a sophisticated bridge that translates OpenAI-formatted requests into Google's internal RPC protocols. It manages the complexities of authentication, session handling, and response streaming, allowing you to use high-tier models with your favorite tools.

### Account Selection Strategy
- **Hybrid (Default)**: Ranks accounts based on `(Health Score × 2) + (Idle Time × 0.1)`.
- **Sticky**: Keeps a client session tied to the same account for consistency.
- **Round-Robin**: Cycles through all available accounts evenly.

## Security Notes
- **Safety Filters**: Controlled via `SAFETY_THRESHOLD` (default: `BLOCK_NONE`).
- **Credentials**: OAuth tokens are stored locally in `antigravity-accounts.json`. Do not share or commit this file.

