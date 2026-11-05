// An optional, read-only MCP server so a tool like Claude Code can see what the reader is reading. It is off unless the
// app is started with BOOK_STUDIO_MCP set, binds to the loopback address only, and never writes to the book or the disk.
// The transport is the MCP "Streamable HTTP" one, in its simplest stateless shape: every request is a JSON-RPC POST that
// is answered with a single JSON body. No session, no server-sent events — the tools only ever answer a question.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chapterFiles, type BookConfig } from "../../core/config.ts";
import { listChapters } from "../../core/book.ts";
import { inboxNotes } from "../../core/inbox.ts";
import { searchFiles } from "../../core/search.ts";
import { stripNotes } from "../../core/notes.ts";
import type { ReadingSnapshot } from "../shared/api.ts";

/** What the main process gives the server: the version, the open book, and the latest reading snapshot (with a timestamp). */
export interface McpContext {
  version: string;
  book(): BookConfig | null;
  reading(): ReadingSnapshot & { at: number };
}

const PROTOCOL = "2025-06-18";
const SERVER_NAME = "book-studio";
/** A chapter's text can be long, a selection should not be; a run-away value is clamped before it is ever stored or sent. */
const MAX_TEXT = 400_000;

interface Tool {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: McpContext): unknown;
}

/** The chapter whose path or file name matches `which`, or null when `which` is empty or no chapter matches. */
function resolveChapter(b: BookConfig, which: unknown): string | null {
  const files = chapterFiles(b);
  if (typeof which === "string" && which.trim()) {
    const want = which.trim();
    return files.find((f) => f === want) ?? files.find((f) => path.basename(f) === path.basename(want)) ?? null;
  }
  return null;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const TOOLS: Record<string, Tool> = {
  current_book: {
    description: "The book that is open right now: its title, author, folder and the list of chapters in reading order. Empty when no book is open.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const b = ctx.book();
      if (!b) return { open: false };
      const chapters = listChapters(b, chapterFiles(b)).map((c) => ({ file: c.file, path: c.path, label: c.label, title: c.title, openNotes: c.openNotes, notes: c.notes }));
      return { open: true, root: b.root, title: b.title, author: b.author, output: b.output, chapterCount: chapters.length, chapters };
    },
  },
  reading_now: {
    description: "What the reader is looking at this moment: the open chapter, which view (reading/edit/source), the nearest heading, and any text they have selected. Call this first to ground an answer in what is on their screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const b = ctx.book();
      const r = ctx.reading();
      if (!b || !r.file) return { reading: false, hint: b ? "A book is open but no chapter has been shown yet." : "No book is open." };
      const list = listChapters(b, chapterFiles(b));
      const idx = list.findIndex((c) => c.path === r.file);
      const here = idx >= 0 ? list[idx] : null;
      return {
        reading: true,
        chapter: here ? { file: here.file, path: here.path, label: here.label, title: here.title, index: idx + 1, of: list.length } : { path: r.file, file: r.name },
        view: r.view,
        heading: r.heading,
        line: r.line,
        selection: r.selection,
        capturedSecondsAgo: Math.max(0, Math.round((Date.now() - r.at) / 1000)),
      };
    },
  },
  chapter_text: {
    description: "The markdown of one chapter. Give a chapter's file name, or leave it empty for the one the reader is on. By default the reader's notes are left in; set plain to true to get the clean prose.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "The chapter's file name, e.g. 05-ch05-how-llms-work.md. Empty for the open chapter." },
        plain: { type: "boolean", description: "Strip the reader's notes and leave only the text that prints." },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const b = ctx.book();
      if (!b) return { error: "No book is open." };
      const file = resolveChapter(b, args.file) ?? (!args.file ? ctx.reading().file : null);
      if (!file) return { error: "That is not a chapter of the open book." };
      const raw = readText(file);
      const text = args.plain ? stripNotes(raw).text : raw;
      return { file: path.basename(file), plain: !!args.plain, truncated: text.length > MAX_TEXT, text: text.slice(0, MAX_TEXT) };
    },
  },
  book_notes: {
    description: "Every note the reader has left in the book (questions, change requests and 'lost me' marks), by chapter, with the words each points at and any answers already written under it. This is what the reader wants looked at.",
    inputSchema: { type: "object", properties: { openOnly: { type: "boolean", description: "Only notes with no answer yet." } }, additionalProperties: false },
    run(args, ctx) {
      const b = ctx.book();
      if (!b) return { error: "No book is open." };
      const openOnly = !!args.openOnly;
      const chapters = listChapters(b, chapterFiles(b))
        .map((c) => {
          let notes = inboxNotes(readText(c.path));
          if (openOnly) notes = notes.filter((n) => n.answers.length === 0);
          return { file: c.file, title: c.title, label: c.label, notes };
        })
        .filter((c) => c.notes.length);
      return { chapters, totalNotes: chapters.reduce((n, c) => n + c.notes.length, 0) };
    },
  },
  search_book: {
    description: "Find words across every chapter of the open book, with the surrounding line of each match, so you can point the reader at the right place.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "The words to look for." } }, required: ["query"], additionalProperties: false },
    run(args, ctx) {
      const b = ctx.book();
      if (!b) return { error: "No book is open." };
      const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
      if (!query.trim()) return { error: "Give some words to search for." };
      const files = chapterFiles(b).map((f) => ({ file: f, text: readText(f) }));
      return searchFiles(files, query);
    },
  },
};

type RpcId = string | number | null;
interface RpcRequest {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Answer one JSON-RPC message. Returns null for a notification (nothing is sent back). */
function handleRpc(msg: RpcRequest, ctx: McpContext): object | null {
  const id = msg.id ?? null;
  const method = msg.method;
  if (!method) return err(id, -32600, "no method");
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: ctx.version },
        instructions: "Read-only view of the book the reader has open in Book Studio. Start with reading_now to see where they are.",
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS[name];
      if (!tool) return err(id, -32602, `no such tool: ${name}`);
      try {
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
        const result = tool.run(args, ctx);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      // Notifications (no id) we do not act on are simply accepted; a request to an unknown method is an error.
      if (id === null) return null;
      return err(id, -32601, `method not found: ${method}`);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Start the server. Returns a stop function. Binds to 127.0.0.1 only; a port already in use is logged, not fatal. */
export function startMcpServer(ctx: McpContext, port: number): () => void {
  const server = http.createServer((req, res) => {
    const send = (status: number, body?: object) => {
      const text = body === undefined ? "" : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, mcp-protocol-version", "access-control-allow-methods": "POST, OPTIONS" });
      res.end(text);
    };
    if (req.method === "OPTIONS") return send(204);
    // Only POST carries JSON-RPC; a GET would be for a server-opened stream, which this server does not offer.
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST, OPTIONS" });
      return res.end(JSON.stringify(err(null, -32000, "use POST")));
    }
    void readBody(req)
      .then((raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return send(400, err(null, -32700, "parse error"));
        }
        if (Array.isArray(parsed)) {
          const out = parsed.map((m) => handleRpc(m as RpcRequest, ctx)).filter((r): r is object => r !== null);
          return send(out.length ? 200 : 202, out.length ? (out as unknown as object) : undefined);
        }
        const answer = handleRpc(parsed as RpcRequest, ctx);
        return send(answer ? 200 : 202, answer ?? undefined);
      })
      .catch(() => send(400, err(null, -32700, "bad request")));
  });
  server.on("error", (e) => console.error(`[mcp] not started: ${(e as Error).message}`));
  server.listen(port, "127.0.0.1", () => console.log(`[mcp] reading server on http://127.0.0.1:${port}/  (connect: claude mcp add --transport http book-studio http://127.0.0.1:${port}/)`));
  return () => server.close();
}
