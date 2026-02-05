import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";

import {
  openDb,
  initSchema,
  addItem,
  searchItems,
  hybridSearch,
  type MemConfig,
  type LexicalResult,
  type HybridResult,
} from "@akasha/openclaw-memory-offline-core";

function defaultDbPath() {
  // Keep within OpenClaw state dir by default when available, fallback to ~/.openclaw/memory
  const base = path.join(os.homedir(), ".openclaw", "memory");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {}
  return path.join(base, "offline.sqlite");
}

function getCfg(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as any;
  return {
    dbPath: String(cfg.dbPath ?? defaultDbPath()),
    autoRecall: cfg.autoRecall !== false,
    autoCapture: cfg.autoCapture !== false,

    // Recall
    topK: Math.max(1, Math.min(20, Number(cfg.topK ?? 5))),
    mode: (cfg.mode === "hybrid" ? "hybrid" : "lexical") as "lexical" | "hybrid",
    candidates: Math.max(10, Math.min(500, Number(cfg.candidates ?? 50))),
    semanticWeight: Math.max(0, Math.min(1, Number(cfg.semanticWeight ?? 0.7))),
    ollamaBaseUrl: String(cfg.ollamaBaseUrl ?? "http://127.0.0.1:11434"),
    embeddingModel: String(cfg.embeddingModel ?? "bge-m3"),
    ollamaTimeoutMs: Math.max(250, Math.min(60000, Number(cfg.ollamaTimeoutMs ?? 3000))),

    // Capture noise controls
    captureMaxPerTurn: Math.max(1, Math.min(50, Number(cfg.captureMaxPerTurn ?? 20))),
    captureMinChars: Math.max(0, Math.min(500, Number(cfg.captureMinChars ?? 16))),
    captureMaxChars: Math.max(200, Math.min(20000, Number(cfg.captureMaxChars ?? 4000))),
    captureDedupeWindowMs: Math.max(0, Math.min(1000 * 60 * 60 * 24 * 30, Number(cfg.captureDedupeWindowMs ?? 1000 * 60 * 60 * 24))),
    captureDedupeMaxCheck: Math.max(10, Math.min(2000, Number(cfg.captureDedupeMaxCheck ?? 300))),
  };
}

function normalizeForDedupe(text: string) {
  return text
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function textHash(text: string) {
  return createHash("sha1").update(text).digest("hex");
}

function shouldSkipCapture(text: string, minChars: number) {
  const t = text.trim();
  if (!t) return true;
  if (minChars > 0 && t.length < minChars) return true;
  // Skip messages with no letter/number (mostly punctuation/emojis)
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  // Skip pure acknowledgements / ultra-common noise
  if (/^(ok|okay|kk|merci|thanks|thx|oui|non|yep|nope|👍|👌|✅|ok\.)$/iu.test(t)) return true;
  return false;
}

async function recall(api: OpenClawPluginApi, query: string, limit?: number) {
  const cfg = getCfg(api);
  const topK = Math.max(1, Math.min(20, limit ?? cfg.topK));

  const db = openDb(cfg.dbPath);
  initSchema(db);

  if (cfg.mode === "hybrid") {
    const memCfg: MemConfig = {
      dbPath: cfg.dbPath,
      ollamaBaseUrl: cfg.ollamaBaseUrl,
      embeddingModel: cfg.embeddingModel,
      ollamaTimeoutMs: cfg.ollamaTimeoutMs,
    };

    // Use core helper to escape query once, then pass escaped query into hybridSearch.
    const escapedQuery = searchItems(db, query, 1).escapedQuery;
    const results = await hybridSearch(
      db,
      memCfg,
      escapedQuery,
      { topK, candidates: cfg.candidates, semanticWeight: cfg.semanticWeight }
    );

    return results as HybridResult[];
  }

  return searchItems(db, query, topK).results as LexicalResult[];
}

export default {
  id: "memory-offline-sqlite",
  kind: "memory",
  register(api: OpenClawPluginApi) {
    // Tool: memory_store
    api.registerTool({
      name: "memory_store",
      description: "Store a memory item in offline SQLite memory.",
      schema: Type.Object({
        text: Type.String({ minLength: 1 }),
        importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        category: Type.Optional(Type.String()),
      }),
      async run({ text, importance, category }) {
        const cfg = getCfg(api);
        const db = openDb(cfg.dbPath);
        initSchema(db);

        const id = randomUUID();
        const meta = { importance: importance ?? null, category: category ?? "other" };
        const item = addItem(db, {
          id,
          title: null,
          text,
          tags: category ? String(category) : null,
          source: "openclaw",
          source_id: null,
          meta,
        });

        return { ok: true, id: item.id };
      },
    });

    // Tool: memory_recall
    api.registerTool({
      name: "memory_recall",
      description: "Recall relevant memories from offline SQLite memory.",
      schema: Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      async run({ query, limit }) {
        const results = await recall(api, query, limit);

        // Normalize to a compact, agent-friendly payload.
        const items = results.map((r: any) => {
          const item = r.item ?? r;
          return {
            id: item.id,
            created_at: item.created_at,
            title: item.title,
            text: item.text,
            tags: item.tags,
            source: item.source,
            source_id: item.source_id,
            score: (r.score ?? r.lexicalScore ?? null) as number | null,
            lexicalScore: (r.lexicalScore ?? null) as number | null,
            semanticScore: (r.semanticScore ?? null) as number | null,
          };
        });

        return { ok: true, query, items };
      },
    });

    // Tool: memory_forget
    api.registerTool({
      name: "memory_forget",
      description: "Delete a memory item from offline SQLite memory.",
      schema: Type.Object({
        memoryId: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
      }),
      async run({ memoryId, query }) {
        const cfg = getCfg(api);
        const db = openDb(cfg.dbPath);
        initSchema(db);

        const id = memoryId ?? null;
        if (!id && !query) {
          return { ok: false, error: "Provide memoryId or query" };
        }

        let deleteId = id;
        if (!deleteId && query) {
          const results = await recall(api, query, 5);
          const first = (results as any[])[0];
          deleteId = first?.item?.id ?? null;
          if (!deleteId) {
            return { ok: true, deleted: 0 };
          }
        }

        const stmt = db.prepare("DELETE FROM items WHERE id = ?");
        const info = stmt.run(deleteId);
        return { ok: true, deleted: Number(info.changes ?? 0), id: deleteId };
      },
    });

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (getCfg(api).autoRecall) {
      api.on("before_agent_start", async (event: any) => {
        const prompt = String(event?.prompt ?? "").trim();
        if (prompt.length < 5) return;

        try {
          const results = await recall(api, prompt, 3);
          if (!results.length) return;

          const lines = results
            .slice(0, 3)
            .map((r: any) => {
              const item = r.item ?? r;
              const text = String(item.text ?? "").replace(/\s+/g, " ").trim();
              const snippet = text.length > 220 ? text.slice(0, 220) + "…" : text;
              return `- ${snippet}`;
            })
            .join("\n");

          api.logger?.info?.(`memory-offline-sqlite: injecting memories (n=${Math.min(3, results.length)})`);

          return {
            prependContext:
              `<relevant-memories>\n` +
              `The following memories may be relevant to this conversation:\n` +
              `${lines}\n` +
              `</relevant-memories>`,
          };
        } catch (err) {
          api.logger?.warn?.(`memory-offline-sqlite: autoRecall failed: ${String(err)}`);
        }
      });
    }

    if (getCfg(api).autoCapture) {
      api.on("agent_end", async (event: any) => {
        if (!event?.success || !Array.isArray(event?.messages) || event.messages.length === 0) return;

        const cfg = getCfg(api);
        const db = openDb(cfg.dbPath);
        initSchema(db);

        // Extract user+assistant texts (capture ALL, but with sane caps)
        const captures: Array<{ role: "user" | "assistant"; text: string }> = [];

        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          const role = (msg as any).role;
          if (role !== "user" && role !== "assistant") continue;

          const content = (msg as any).content;
          if (typeof content === "string") {
            captures.push({ role, text: content });
            continue;
          }
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
                captures.push({ role, text: (block as any).text });
              }
            }
          }
        }

        // Basic hygiene: drop injected context + empty, trim, cap length
        const cleaned = captures
          .map((c) => ({
            role: c.role,
            text: String(c.text ?? "").trim(),
          }))
          .filter((c) => c.text.length > 0)
          .filter((c) => !c.text.includes("<relevant-memories>"));

        if (!cleaned.length) return;

        const maxPerTurn = cfg.captureMaxPerTurn;
        const now = Date.now();
        const cutoff = now - cfg.captureDedupeWindowMs;

        // Dedupe: compute hashes for candidate texts; check recent window for existing hashes.
        // We keep this cheap: query only recent N rows.
        const recent = db
          .prepare(
            `SELECT meta FROM items
             WHERE created_at >= ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(cutoff, cfg.captureDedupeMaxCheck) as any[];

        const recentHashes = new Set<string>();
        for (const r of recent) {
          const m = r?.meta;
          if (typeof m !== "string" || !m) continue;
          // meta is JSON string from addItem; look for "h":"..."
          const match = m.match(/"h"\s*:\s*"([a-f0-9]{40})"/i);
          if (match?.[1]) recentHashes.add(match[1].toLowerCase());
        }

        let stored = 0;

        for (let i = 0; i < Math.min(maxPerTurn, cleaned.length); i++) {
          const { role, text } = cleaned[i]!;

          if (shouldSkipCapture(text, cfg.captureMinChars)) continue;

          const normalized = normalizeForDedupe(text);
          const h = textHash(normalized);
          if (cfg.captureDedupeWindowMs > 0 && recentHashes.has(h)) continue;
          recentHashes.add(h);

          const clipped = text.length > cfg.captureMaxChars ? text.slice(0, cfg.captureMaxChars) + "…" : text;

          const meta = {
            role,
            sessionKey: event?.sessionKey ?? null,
            channel: event?.channel ?? null,
            ts: now,
            h,
          };

          addItem(db, {
            id: randomUUID(),
            title: null,
            text: clipped,
            tags: role,
            source: "openclaw",
            source_id: null,
            meta,
          });
          stored++;
        }

        if (stored > 0) {
          api.logger?.info?.(`memory-offline-sqlite: auto-captured ${stored} messages`);
        }
      });
    }
  },
};
