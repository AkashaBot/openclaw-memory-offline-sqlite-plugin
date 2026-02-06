# openclaw-memory-offline-sqlite-plugin

External **OpenClaw memory plugin** backed by **SQLite (FTS5)** with optional **embeddings rerank** (hybrid search).

## What it does
- Provides tools:
  - `memory_store(text, importance?, category?)`
  - `memory_recall(query, limit?)`
  - `memory_forget(memoryId?, query?)`
- Hooks:
  - `before_agent_start`: injects relevant memories
  - `agent_end`: auto-captures user + assistant messages (with noise controls)

## Install (dev / local path)
1) Clone somewhere on the machine running OpenClaw.
2) Add the plugin path to your OpenClaw config:

```json
{
  "plugins": {
    "load": { "paths": ["C:\\path\\to\\openclaw-memory-offline-sqlite-plugin"] },
    "slots": { "memory": "memory-offline-sqlite" },
    "entries": {
      "memory-offline-sqlite": {
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
  "id": "memory-offline-sqlite",
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
- `mode`: `lexical` | `hybrid`
- `topK`: number of memories injected / returned
- `ollamaBaseUrl`, `embeddingModel`, `ollamaTimeoutMs`
- Capture noise controls:
  - `captureMinChars`, `captureMaxPerTurn`, `captureMaxChars`
  - `captureDedupeWindowMs`, `captureDedupeMaxCheck`

## Status
- Core: `@akashabot/openclaw-memory-offline-core@0.1.0`
- CLI: `@akashabot/openclaw-mem@0.1.0`
- Plugin: `@akasha/memory-offline-sqlite` (this repo)

## License
MIT
