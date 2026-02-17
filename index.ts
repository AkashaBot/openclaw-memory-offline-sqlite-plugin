import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";

import { sanitizeCaptures } from "./capture-utils.js";

import {
  openDb,
  initSchema,
  runMigrations,
  addItem,
  searchItems,
  hybridSearch,
  hybridSearchFiltered,
  // Phase 2: Facts
  insertFact,
  searchFacts,
  getFactsBySubject,
  getAllFacts,
  extractFactsSimple,
  // Phase 3: Knowledge Graph
  getEntityGraph,
  getRelatedEntities,
  getGraphStats,
  type MemConfig,
  type LexicalResult,
  type HybridResult,
  type FilterOpts,
} from "@akashabot/openclaw-memory-offline-core";

function defaultDbPath() {
  // Keep within OpenClaw state dir by default when available, fallback to ~/.openclaw/memory
  const base = path.join(os.homedir(), ".openclaw", "memory");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {}
  return path.join(base, "offline.sqlite");
}

// Some runtimes expect a plain JSON-schema object (no prototypes/symbols).
// TypeBox outputs plain objects, but this forces safe JSON serialization.
function asJsonSchema<T>(schema: T): T {
  return JSON.parse(JSON.stringify(schema)) as T;
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

    // Retention (optional)
    retentionDays: cfg.retentionDays === undefined || cfg.retentionDays === null ? null : Math.max(1, Math.min(3650, Number(cfg.retentionDays))),
    retentionProtectedTags: Array.isArray(cfg.retentionProtectedTags) ? cfg.retentionProtectedTags.map(String) : ["personal"],
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

let lastHybridDegradedLogTs = 0;

function maybeLogHybridDegraded(api: OpenClawPluginApi, reason: string) {
  const now = Date.now();
  const intervalMs = 1000 * 60 * 60; // 1h
  if (now - lastHybridDegradedLogTs < intervalMs) return;
  lastHybridDegradedLogTs = now;
  api.logger?.warn?.(`memory-offline-sqlite: hybrid degraded to lexical (${reason})`);
}

async function recall(api: OpenClawPluginApi, query: string, limit?: number, filter?: FilterOpts) {
  const cfg = getCfg(api);
  const topK = Math.max(1, Math.min(20, limit ?? cfg.topK));

  const db = openDb(cfg.dbPath);
  initSchema(db);
  runMigrations(db); // Phase 1: ensure attribution columns exist

  if (cfg.mode === "hybrid") {
    const memCfg: MemConfig = {
      dbPath: cfg.dbPath,
      ollamaBaseUrl: cfg.ollamaBaseUrl,
      embeddingModel: cfg.embeddingModel,
      ollamaTimeoutMs: cfg.ollamaTimeoutMs,
    };

    // Proactive check: if Ollama embeddings endpoint is down/slow, avoid doing
    // hybridSearch work and fall back to lexical immediately.
    try {
      const base = cfg.ollamaBaseUrl.replace(/\/$/, "");
      const timeoutMs = Math.min(cfg.ollamaTimeoutMs, 800);
      const res = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.embeddingModel, input: query }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    } catch (err) {
      maybeLogHybridDegraded(api, String(err));
      return searchItems(db, query, topK).results as LexicalResult[];
    }

    // Use core helper to escape query once, then pass escaped query into hybridSearch.
    const escapedQuery = searchItems(db, query, 1).escapedQuery;
    
    // Phase 1: Use hybridSearchFiltered if filters are provided
    if (filter && (filter.entity_id || filter.process_id || filter.session_id)) {
      const results = await hybridSearchFiltered(db, memCfg, escapedQuery, {
        topK,
        candidates: cfg.candidates,
        semanticWeight: cfg.semanticWeight,
        filter,
      });
      return results as HybridResult[];
    }

    const results = await hybridSearch(db, memCfg, escapedQuery, {
      topK,
      candidates: cfg.candidates,
      semanticWeight: cfg.semanticWeight,
    });

    return results as HybridResult[];
  }

  return searchItems(db, query, topK).results as LexicalResult[];
}

export default {
  id: "openclaw-memory-offline-sqlite-plugin",
  kind: "memory",
  register(api: OpenClawPluginApi) {
    try {
      api.logger?.info?.(`memory-offline-sqlite loaded ${new Date().toISOString()}`);
    } catch {}
    // Tool: memory_store
    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description: "Store a memory item in offline SQLite memory.",
        parameters: asJsonSchema(
          Type.Object({
            text: Type.String({ minLength: 1 }),
            importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
            category: Type.Optional(Type.String()),
            entityId: Type.Optional(Type.String({ description: "Who said/wrote this (e.g., 'loic', 'system')" })),
            processId: Type.Optional(Type.String({ description: "Which agent/process captured this (e.g., 'akasha')" })),
            sessionId: Type.Optional(Type.String({ description: "Session/conversation grouping" })),
          }),
        ),
        async execute(_toolCallId, params) {
          const { text, importance, category, entityId, processId, sessionId } = params as any;

          const cfg = getCfg(api);
          const db = openDb(cfg.dbPath);
          initSchema(db);
          runMigrations(db);

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
            entity_id: entityId ?? null,
            process_id: processId ?? "akasha",
            session_id: sessionId ?? null,
          });

          return {
            content: [{ type: "text", text: `Stored memory (${item.id})` }],
            details: { ok: true, id: item.id, entity_id: item.entity_id, process_id: item.process_id, session_id: item.session_id },
          };
        },
      },
      { name: "memory_store" },
    );

    // Tool: memory_recall
    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description: "Recall relevant memories from offline SQLite memory.",
        parameters: asJsonSchema(
          Type.Object({
            query: Type.String({ minLength: 1 }),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
            entityId: Type.Optional(Type.String({ description: "Filter by who said/wrote this" })),
            processId: Type.Optional(Type.String({ description: "Filter by which agent captured this" })),
            sessionId: Type.Optional(Type.String({ description: "Filter by session/conversation" })),
          }),
        ),
        async execute(_toolCallId, params) {
          const { query, limit, entityId, processId, sessionId } = params as any;
          
          const filter: FilterOpts | undefined = (entityId || processId || sessionId)
            ? { entity_id: entityId ?? null, process_id: processId ?? null, session_id: sessionId ?? null }
            : undefined;
          
          const results = await recall(api, query, limit, filter);

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
              entity_id: item.entity_id ?? null,
              process_id: item.process_id ?? null,
              session_id: item.session_id ?? null,
              score: (r.score ?? r.lexicalScore ?? null) as number | null,
              lexicalScore: (r.lexicalScore ?? null) as number | null,
              semanticScore: (r.semanticScore ?? null) as number | null,
            };
          });

          const preview = items
            .slice(0, Math.min(5, items.length))
            .map((it: any, i: number) => `${i + 1}. ${String(it.text ?? "").slice(0, 160)}`)
            .join("\n");

          return {
            content: [{ type: "text", text: items.length ? `Found ${items.length} memories:\n${preview}` : "No relevant memories found." }],
            details: { ok: true, query, items, filter },
          };
        },
      },
      { name: "memory_recall" },
    );

    // Tool: memory_forget
    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete a memory item from offline SQLite memory.",
        parameters: asJsonSchema(
          Type.Object({
            memoryId: Type.Optional(Type.String()),
            query: Type.Optional(Type.String()),
          }),
        ),
        async execute(_toolCallId, params) {
          const { memoryId, query } = params as any;

          const cfg = getCfg(api);
          const db = openDb(cfg.dbPath);
          initSchema(db);
          runMigrations(db);

          const id = memoryId ?? null;
          if (!id && !query) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { ok: false, error: "Provide memoryId or query" },
            };
          }

          let deleteId = id;
          if (!deleteId && query) {
            const results = await recall(api, query, 5);
            const first = (results as any[])[0];
            deleteId = first?.item?.id ?? null;
            if (!deleteId) {
              return { content: [{ type: "text", text: "No matches." }], details: { ok: true, deleted: 0 } };
            }
          }

          const stmt = db.prepare("DELETE FROM items WHERE id = ?");
          const info = stmt.run(deleteId);
          const deleted = Number((info as any).changes ?? 0);

          return {
            content: [{ type: "text", text: deleted ? `Deleted memory ${deleteId}` : `No deletion for ${deleteId}` }],
            details: { ok: true, deleted, id: deleteId },
          };
        },
      },
      { name: "memory_forget" },
    );

    // Tool: memory_stats
    api.registerTool(
      {
        name: "memory_stats",
        label: "Memory Stats",
        description: "Get basic stats about the offline SQLite memory DB (counts, size, tags breakdown).",
        parameters: asJsonSchema(
          Type.Object({
            includeTags: Type.Optional(Type.Boolean({ default: true })),
            topTags: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
          }),
        ),
        async execute(_toolCallId, params) {
          const { includeTags, topTags } = params as any;

          const cfg = getCfg(api);
          const db = openDb(cfg.dbPath);
          initSchema(db);
          runMigrations(db);

          const items = (db.prepare("SELECT COUNT(*) as c FROM items").get() as any).c as number;
          const embeddings = (db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as any).c as number;
          const range = db.prepare("SELECT MIN(created_at) as min, MAX(created_at) as max FROM items").get() as any;

          let dbBytes: number | null = null;
          try {
            dbBytes = fs.statSync(cfg.dbPath).size;
          } catch {}

          let tags: Array<{ tag: string | null; count: number }> | undefined;
          if (includeTags !== false) {
            const limit = Math.max(1, Math.min(50, Number(topTags ?? 10)));
            const rows = db
              .prepare("SELECT tags as tag, COUNT(*) as c FROM items GROUP BY tags ORDER BY c DESC LIMIT ?")
              .all(limit) as any[];
            tags = rows.map((r) => ({ tag: r.tag ?? null, count: Number(r.c ?? 0) }));
          }

          // Phase 1: Count entities
          let entities: string[] = [];
          try {
            entities = db.prepare("SELECT DISTINCT entity_id FROM items WHERE entity_id IS NOT NULL").pluck().all() as string[];
          } catch {}

          const out = {
            ok: true,
            dbPath: cfg.dbPath,
            dbBytes,
            items,
            embeddings,
            createdAt: { min: range?.min ?? null, max: range?.max ?? null },
            tags,
            entities,
            retention: { retentionDays: cfg.retentionDays, protectedTags: cfg.retentionProtectedTags },
          };

          return {
            content: [{ type: "text", text: `items=${items}, embeddings=${embeddings}, dbBytes=${dbBytes ?? "?"}, entities=${entities.length}` }],
            details: out,
          };
        },
      },
      { name: "memory_stats" },
    );

    // Tool: memory_gc
    api.registerTool(
      {
        name: "memory_gc",
        label: "Memory GC",
        description:
          "Garbage-collect old memory items based on retentionDays (optional). Protected tags are never deleted.",
        parameters: asJsonSchema(
          Type.Object({
            dryRun: Type.Optional(Type.Boolean({ default: true })),
            retentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
            protectTags: Type.Optional(Type.Array(Type.String())),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 1000 })),
          }),
        ),
        async execute(_toolCallId, params) {
          const { dryRun, retentionDays, protectTags, limit } = params as any;

          const cfg = getCfg(api);
          const db = openDb(cfg.dbPath);
          initSchema(db);
          runMigrations(db);

          const days = retentionDays ?? cfg.retentionDays;
          if (days === null || days === undefined) {
            return { content: [{ type: "text", text: "GC skipped (retentionDays not set)." }], details: { ok: true, skipped: true, reason: "retentionDays not set" } };
          }

          const protectedTags = (protectTags ?? cfg.retentionProtectedTags ?? ["personal"]).map(String);
          const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
          const lim = Math.max(1, Math.min(5000, Number(limit ?? 1000)));

          const placeholders = protectedTags.map(() => "?").join(",");
          const whereProtect = protectedTags.length ? `AND (tags IS NULL OR tags NOT IN (${placeholders}))` : "";

          const sql =
            `SELECT id, created_at, tags FROM items ` +
            `WHERE created_at < ? ${whereProtect} ` +
            `ORDER BY created_at ASC LIMIT ?`;

          const rows = db.prepare(sql).all(cutoff, ...(protectedTags.length ? protectedTags : []), lim) as any[];
          const ids = rows.map((r) => String(r.id));

          if (dryRun !== false) {
            return {
              content: [{ type: "text", text: `GC dry-run: candidates=${ids.length} (retentionDays=${days})` }],
              details: { ok: true, dryRun: true, cutoff, retentionDays: Number(days), protectedTags, candidates: ids.length, sample: rows.slice(0, 20) },
            };
          }

          const tx = db.transaction(() => {
            if (ids.length === 0) return { deletedItems: 0, deletedEmbeddings: 0 };
            const inPlaceholders = ids.map(() => "?").join(",");
            const delEmb = db.prepare(`DELETE FROM embeddings WHERE item_id IN (${inPlaceholders})`).run(...ids);
            const delItems = db.prepare(`DELETE FROM items WHERE id IN (${inPlaceholders})`).run(...ids);
            return {
              deletedItems: Number((delItems as any).changes ?? 0),
              deletedEmbeddings: Number((delEmb as any).changes ?? 0),
            };
          });

          const res = tx();
          try {
            db.exec("VACUUM");
          } catch {}

          return {
            content: [{ type: "text", text: `GC deleted items=${res.deletedItems}, embeddings=${res.deletedEmbeddings}` }],
            details: { ok: true, dryRun: false, cutoff, retentionDays: Number(days), protectedTags, deleted: res },
          };
        },
      },
      { name: "memory_gc" },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (getCfg(api).autoRecall) {
      api.on("before_agent_start", async (event: any) => {
        const prompt = String(event?.prompt ?? "").trim();
        if (prompt.length < 5) return;

        try {
          const cfg = getCfg(api);
          const db = openDb(cfg.dbPath);
          initSchema(db);
          runMigrations(db);

          // Short-term memory: last N messages from same session (bounded by chars)
          const sessionId = event?.sessionKey ?? null;
          let shortTermBlock = "";
          if (sessionId) {
            const rows = db.prepare(
              `SELECT created_at, text, tags
               FROM items
               WHERE session_id = ? AND tags IN ('user','assistant')
               ORDER BY created_at DESC
               LIMIT 50`
            ).all(sessionId) as any[];

            const maxMsgs = 15;
            const maxChars = 2000;
            let count = 0;
            let chars = 0;
            const lines: string[] = [];

            for (const r of rows.reverse()) {
              if (count >= maxMsgs || chars >= maxChars) break;
              const role = r.tags === 'assistant' ? 'assistant' : 'user';
              const text = String(r.text ?? "").replace(/\s+/g, " ").trim();
              if (!text) continue;
              const snippet = text.length > 300 ? text.slice(0, 300) + "…" : text;
              const line = `[role: ${role}] ${snippet}`;
              if (chars + line.length > maxChars) break;
              lines.push(line);
              chars += line.length;
              count++;
            }

            if (lines.length) {
              shortTermBlock = `<short-term-memory>\n` +
                `Recent messages (same session):\n` +
                lines.join("\n") +
                `\n</short-term-memory>`;
            }
          }

          const results = await recall(api, prompt, 3);
          let recallBlock = "";
          if (results.length) {
            const lines = results
              .slice(0, 3)
              .map((r: any) => {
                const item = r.item ?? r;
                const text = String(item.text ?? "").replace(/\s+/g, " ").trim();
                const snippet = text.length > 200 ? text.slice(0, 200) + "…" : text;

                const tag = String(item.tags ?? "").trim();
                const source = String(item.source ?? "").trim();
                const date = item.created_at ? new Date(Number(item.created_at)).toISOString().slice(0, 10) : "";

                const bits = [tag && `tag:${tag}`, source && `src:${source}`, date && `date:${date}`].filter(Boolean).join(" ");
                return bits ? `- ${snippet} (${bits})` : `- ${snippet}`;
              })
              .join("\n");

            api.logger?.info?.(`memory-offline-sqlite: injecting memories (n=${Math.min(3, results.length)})`);

            recallBlock = `<relevant-memories>\n` +
              `The following memories may be relevant to this conversation:\n` +
              `${lines}\n` +
              `</relevant-memories>`;
          }

          if (!shortTermBlock && !recallBlock) return;

          return {
            prependContext: [shortTermBlock, recallBlock].filter(Boolean).join("\n\n"),
          };
        } catch (err) {
          api.logger?.warn?.(`memory-offline-sqlite: autoRecall failed: ${String(err)}`);
        }
      });
    }

    if (getCfg(api).autoCapture) {
      api.on("agent_end", async (event: any) => {
        try {
          if (!event?.success) return;
          const msgs = event?.messages;
          if (!Array.isArray(msgs)) {
            api.logger?.warn?.(`memory-offline-sqlite: agent_end missing messages (type=${typeof msgs})`);
            return;
          }
          if (msgs.length === 0) return;

          const cfg = getCfg(api);
          const db = openDb(cfg.dbPath);
          initSchema(db);
          runMigrations(db); // Phase 1: ensure attribution columns exist

          // Extract user+assistant texts (capture ALL, but with sane caps)
          const captures: Array<{ role: "user" | "assistant"; text: string }> = [];

          for (const msg of msgs) {
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
          const cleaned = sanitizeCaptures(captures);

          if (!Array.isArray(cleaned) || cleaned.length === 0) return;

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

          // Phase 1: Set attribution fields
          const entity_id = role === "user" ? "user" : "agent";
          const process_id = "akasha";
          const session_id = event?.sessionKey ?? null;

          addItem(db, {
            id: randomUUID(),
            title: null,
            text: clipped,
            tags: role,
            source: "openclaw",
            source_id: null,
            meta,
            entity_id,
            process_id,
            session_id,
          });
          stored++;
        }

        if (stored > 0) {
          api.logger?.info?.(`memory-offline-sqlite: auto-captured ${stored} messages`);
        }

        // Phase 2: Auto-extract facts from captured messages
        if (cfg.autoExtractFacts !== false) {
          let factsExtracted = 0;
          for (let i = 0; i < Math.min(maxPerTurn, cleaned.length); i++) {
            const { text } = cleaned[i]!;
            const extracted = extractFactsSimple(text) ?? [];
            
            for (const f of extracted) {
              // Only store facts with reasonable confidence
              if (f.confidence < 0.6) continue;
              
              try {
                insertFact(db, {
                  id: randomUUID(),
                  subject: f.subject,
                  predicate: f.predicate,
                  object: f.object,
                  confidence: f.confidence,
                  source_item_id: null,
                  entity_id: "auto-extracted",
                });
                factsExtracted++;
              } catch {
                // Ignore duplicate/insert errors
              }
            }
          }
          
          if (factsExtracted > 0) {
            api.logger?.info?.(`memory-offline-sqlite: auto-extracted ${factsExtracted} facts`);
          }
        }
        } catch (err: any) {
          const msg = `memory-offline-sqlite: agent_end failed: ${err?.stack ?? String(err)}`;
          api.logger?.error?.(msg);
          try { console.error(msg); } catch {}
        }
      });
    }
  },
};
