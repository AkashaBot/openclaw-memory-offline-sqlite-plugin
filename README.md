# openclaw-memory-offline-sqlite-plugin

External **OpenClaw memory plugin** that connects OpenClaw to the **SQLite offline memory core**.

## Why the plugin matters
The **core** (`@akashabot/openclaw-memory-offline-core`) is a standalone SQLite memory engine.  
Core repo: https://github.com/AkashaBot/openclaw-memory-offline-sqlite
The **plugin** is the bridge that makes it *usable inside OpenClaw*:

- wires the core into OpenClaw's **memory slot**
- exposes the **memory_* tools** to agents
- enables **auto‑recall** before a turn and **auto‑capture** after a turn
- applies **smart filtering** (dedupe, noise controls, context sanitization)

In short: **core = storage + search**, **plugin = integration + automation**.

---

## What it does
- Provides tools:
  - `memory_store(text, importance?, category?)`
  - `memory_recall(query, limit?)`
  - `memory_forget(memoryId?, query?)`
  - `memory_stats()` — get DB stats (counts, size, tags)
  - `memory_gc(retentionDays?, protectTags?)` — cleanup old memories
- Hooks:
  - `before_agent_start`: injects relevant memories + short-term context (last 15 msgs from same session)
  - `agent_end`: auto‑captures user + assistant messages with noise filtering

## Install packages (npm)
```bash
npm install @akashabot/openclaw-memory-offline-core
npm install -g @akashabot/openclaw-mem
npm install -g @akashabot/openclaw-memory-mcp-server
```

## Install (dev / local path)
1) Clone somewhere on the machine running OpenClaw.
2) Add the plugin path to your OpenClaw config:

```json
{
  "plugins": {
    "load": { "paths": ["C:\\path\\to\\openclaw-memory-offline-sqlite-plugin"] },
    "slots": { "memory": "openclaw-memory-offline-sqlite-plugin" },
    "entries": {
      "openclaw-memory-offline-sqlite-plugin": {
        "enabled": true,
        "config": {
          "dbPath": "C:\\Users\\<you>\\.openclaw\\memory\\offline.sqlite",
          "mode": "hybrid",

          // Provider-specific config
          "provider": "ollama",
          "ollamaBaseUrl": "http://127.0.0.1:11434",
          "embeddingModel": "bge-m3",
          "ollamaTimeoutMs": 3000,

          "topK": 5
        }
      }
    }
  }
}
```

Restart OpenClaw after updating the config.

## Embeddings providers

The underlying core library supports two providers:

- `ollama` (default)
- `openai`

Example OpenAI config snippet:

```jsonc
{
  "id": "openclaw-memory-offline-sqlite-plugin",
  "config": {
    "dbPath": "~/.openclaw/memory/offline.sqlite",
    "autoRecall": true,
    "autoCapture": true,
    "mode": "hybrid",
    "topK": 5,
    "candidates": 50,
    "semanticWeight": 0.7,

    // OpenAI-specific
    "provider": "openai",
    "openaiBaseUrl": "https://api.openai.com",
    "openaiApiKey": "sk-...",          // set via env/secret manager in practice
    "openaiModel": "text-embedding-3-small"
  }
}
```

If `provider` is omitted, the core falls back to `"ollama"` with model `bge-m3`.

## Config
See `openclaw.plugin.json` for the full schema.

Notable options:
- `autoRecall`: enable auto-injection of relevant memories (default: true)
- `autoCapture`: enable auto-capture of messages after each turn (default: true)
- `mode`: `lexical` | `hybrid`
- `topK`: number of memories injected / returned
- `ollamaBaseUrl`, `embeddingModel`, `ollamaTimeoutMs`

### Capture noise controls
- `captureMinChars`: minimum message length to capture (default: 16)
- `captureMaxChars`: maximum characters per message (default: 4000)
- `captureMaxPerTurn`: max messages to capture per turn (default: 20)
- `captureDedupeWindowMs`: deduplication window in ms (default: 24h)
- `captureDedupeMaxCheck`: number of recent rows to check for dedup (default: 300)

### Retention (optional)
- `retentionDays`: auto-delete memories older than N days
- `retentionProtectedTags`: tags that should never be deleted (default: ["personal"])

## What's new (v0.3.0)

### Smart deduplication
Messages are now deduplicated using SHA1 hashes over normalized text. The plugin checks recent messages within `captureDedupeWindowMs` (default 24h) to avoid storing duplicates. This dramatically reduces noise in the memory DB.

### Context sanitization
The `sanitizeCaptures()` utility filters out:
- Empty messages
- Injected `<relevant-memories>` context (prevents loops)
- Pure acknowledgment words (`ok`, `thanks`, `👍`, etc.)

### Short-term memory
The `before_agent_start` hook now also injects **short-term context** — the last 15 messages from the same session (capped at 2000 chars). This gives the agent immediate conversation history without full recall.

### Stats & GC
- `memory_stats()`: returns item counts, DB size, and tag breakdown
- `memory_gc()`: bulk delete old items based on retention policy, with protected tags support

## Status
- Core: `@akashabot/openclaw-memory-offline-core@0.5.0`
- Plugin: `openclaw-memory-offline-sqlite-plugin@0.3.0`

## License
MIT