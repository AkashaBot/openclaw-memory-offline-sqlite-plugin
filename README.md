# openclaw-memory-offline-sqlite-plugin

External **OpenClaw memory plugin** backed by **SQLite (FTS5)** with optional **Ollama embeddings rerank** (hybrid search).

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
          "ollamaBaseUrl": "http://127.0.0.1:11434",
          "embeddingModel": "bge-m3",
          "topK": 5
        }
      }
    }
  }
}
```

Restart OpenClaw after updating the config.

## Config
See `openclaw.plugin.json` for the full schema.

Notable options:
- `mode`: `lexical` | `hybrid`
- `topK`: number of memories injected / returned
- `ollamaBaseUrl`, `embeddingModel`, `ollamaTimeoutMs`
- Capture noise controls:
  - `captureMinChars`, `captureMaxPerTurn`, `captureMaxChars`
  - `captureDedupeWindowMs`, `captureDedupeMaxCheck`

## License
MIT
