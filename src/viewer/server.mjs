// The viewer's HTTP server (TRL0005): read-only JSON API, SSE, assets, the built app and
// the HTML shell. Only node:http; nothing here writes a file, a ref or git state.

import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchItems } from "../search.mjs";
import { decodeSegment } from "./segment.mjs";
import { IMAGE_TYPES, createBacklog, recordOf, searchCorpus, summaryOf, taskDetailOf } from "./backlogs.mjs";
import { ViewerConfigError, canonicalV6, normalizeHost } from "./config.mjs";
import { isInside } from "./reader.mjs";
import { createWatchers } from "./watch.mjs";

// The built app, resolved from this package, never from the working directory.
export const DEFAULT_DIST_DIR = fileURLToPath(new URL("../../viewer/dist/", import.meta.url));
const HEARTBEAT_MS = 25_000;
// A stream whose client stops reading is closed past this many queued bytes; EventSource
// reconnects on its own, and the queue never grows without bound.
export const MAX_STREAM_BUFFER = 64 * 1024;

// Writes one SSE frame. Returns false when the stream was closed for being backed up.
export function pushEvent(res, frame, limit = MAX_STREAM_BUFFER) {
  if (res.writableLength > limit) { res.destroy(); return false; }
  res.write(frame);
  return true;
}

// ------------------------------------------------------------ host check
export function parseHost(header) {
  const h = String(header).trim().toLowerCase();
  const m = /^(\[[0-9a-z:.%_-]+\])(?::(\d+))?$/.exec(h) || /^([a-z0-9._-]+)(?::(\d+))?$/.exec(h);
  if (!m) return null;
  const host = m[1].startsWith("[") ? canonicalV6(m[1]) ?? m[1] : m[1];
  return host ? { host, port: m[2] === undefined ? null : Number(m[2]) } : null;
}

// Pure so the port 80 rule is testable without binding port 80. A Host is allowed when it is
// a loopback or printed host on the listener's port (no port means 80, as browsers omit it),
// or exactly one of `allowedHosts` on any port.
export function hostAllowed(header, { port, printedHost, allowedHosts = [] }) {
  if (typeof header !== "string") return false;
  const h = parseHost(header);
  if (!h) return false;
  if (allowedHosts.includes(h.host)) return true;
  const printed = String(printedHost).toLowerCase();
  const printedKey = printed.startsWith("[") ? canonicalV6(printed) ?? printed : printed;
  if (!["127.0.0.1", "localhost", printedKey].includes(h.host)) return false;
  return h.port === null ? port === 80 : h.port === port;
}

// The host a browser on this machine can use for the listener's address.
export function printedHostFor(bind, address) {
  if (String(bind).toLowerCase() === "localhost") return "localhost";
  if (address === "0.0.0.0") return "127.0.0.1";
  if (address === "::") return "[::1]";
  return address.includes(":") ? canonicalV6(`[${address}]`) ?? `[${address}]` : address;
}

// ------------------------------------------------------------- responses
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ico": "image/x-icon", ...IMAGE_TYPES,
};
const contentTypeOf = (name) => CONTENT_TYPES[extname(name).toLowerCase()] || "application/octet-stream";

// A bundler's hashed name (`app-3f9a2c1d.js`) never changes content, so it caches for a year.
export const cacheControlFor = (name) => (/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(name) ? "public, max-age=31536000, immutable" : "no-cache");

const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}
const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
const notFound = (res) => sendJson(res, 404, { error: "not found" });

const isDot = (s) => s === "." || s === "..";

// Splits the raw request target into decoded segments. Nothing is normalized, so `..` stays
// visible. Returns null for a path that cannot name a route. A dot segment passes here because
// a task id can be `.` or `..` (a scan prefix may match them); the file routes refuse it with
// `hasDot`. A backslash passes
// here because a task id is only a map key on the shell and detail routes (a scan prefix may
// match a filename holding one); the routes that build file paths refuse it with `hasBackslash`.
function parseTarget(raw) {
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q + 1);
  if (!path.startsWith("/")) return null;
  const parts = path.split("/").slice(1);
  if (parts.length === 1 && parts[0] === "") return { segs: [], query };
  const segs = [];
  for (const part of parts) {
    let s;
    try { s = decodeURIComponent(part); } catch { return null; }
    if (!s || /[/\0]/.test(s)) return null;
    segs.push(s);
  }
  return { segs, query };
}

// The build's own list of what it emitted, or null when files.json is missing or unreadable.
// The /app/ route and the start-up check share this one parse.
export function readBuiltFiles(distDir) {
  try {
    const list = JSON.parse(readFileSync(join(distDir, "files.json"), "utf8"));
    return new Set(Array.isArray(list) ? list.filter((f) => typeof f === "string" && f !== "files.json") : []);
  } catch { return null; }
}

// The real path of `file` when it is a regular file strictly inside `root` after symlinks, else
// null. The /app/ route and the start-up check share it, so a symlink out of dist fails both.
export function regularFileInside(file, root) {
  try {
    const real = realpathSync.native(file);
    const rootReal = realpathSync.native(root);
    return isInside(rootReal, real) && real !== rootReal && statSync(real).isFile() ? real : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- server
// Starts the viewer. `entries` are config backlogs ({ id, name, path }). Resolves to a handle
// { server, url, port, host, backlogs, close() }. `watch: false` skips the live-reload watchers.
export async function startViewer({
  entries, port = 4747, bind = "127.0.0.1", allowedHosts = [], distDir = DEFAULT_DIST_DIR, watch = true,
  hooks, git, debounceMs, onError = (e) => process.stderr.write(`error: ${e && e.stack ? e.stack : e}\n`),
}) {
  const backlogs = entries.map((e) => createBacklog(e, { hooks, git }));
  const byId = new Map(backlogs.map((b) => [b.id, b]));
  const allowed = allowedHosts.map((h) => normalizeHost(h)).filter(Boolean);
  const clients = new Set();
  const handle = { port: null, host: null };

  const pushAll = (frame) => { for (const res of [...clients]) if (!pushEvent(res, frame)) clients.delete(res); };
  const broadcast = (id) => pushAll(`data: ${JSON.stringify({ backlog: id })}\n\n`);
  const watchers = watch ? createWatchers(backlogs, broadcast, { debounceMs }) : null;
  const built = (b) => { const out = b.build(); if (watchers) watchers.reconcile(b); return out; };

  function serveFile(res, req, file, root, { name, immutableCheck = true }) {
    const real = regularFileInside(file, root);
    if (!real) return notFound(res);
    const data = readFileSync(real);
    res.writeHead(200, {
      ...BASE_HEADERS, "Content-Type": contentTypeOf(name), "Content-Length": data.length,
      "Cache-Control": immutableCheck ? cacheControlFor(name) : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  const builtFiles = () => readBuiltFiles(distDir) ?? new Set();

  function shell(res, req) {
    const file = join(distDir, "index.html");
    if (!existsSync(file)) return send(res, 503, "viewer is not built", { "Content-Type": "text/plain; charset=utf-8" });
    const data = readFileSync(file);
    res.writeHead(200, {
      ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length,
      "Cache-Control": "no-cache", "Content-Security-Policy": "frame-ancestors 'none'",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  function search(res, query) {
    const params = new URLSearchParams(query);
    const named = params.getAll("backlog");
    for (const id of named) if (!byId.has(id)) return notFound(res);
    const q = params.get("q") ?? "";
    if (!q.trim()) return sendJson(res, 200, { hits: [], skipped: [] });
    const want = new Set(named.length ? named : backlogs.map((b) => b.id));
    const corpus = [];
    const skipped = [];
    backlogs.forEach((b, order) => {
      if (!want.has(b.id)) return;
      const out = built(b);
      if (out.status !== "ok") skipped.push(b.id); else for (const doc of searchCorpus(out, order)) corpus.push(doc); // not a spread: a huge backlog would overflow the stack
    });
    sendJson(res, 200, { hits: searchItems(corpus, q), skipped });
  }

  function route(req, res) {
    const target = parseTarget(req.url || "");
    if (!target) return notFound(res);
    const { segs, query } = target;
    const [a, b, c, d, e] = segs;
    const hasBackslash = segs.some((s) => s.includes("\\"));
    const hasDot = segs.some(isDot);

    if (segs.length === 0 || (a === "b" && ((segs.length === 2 && !isDot(b)) || (segs.length === 4 && c === "task" && !isDot(b))))) return shell(res, req);
    if (a === "api") {
      if (b === "backlogs" && segs.length === 2) return sendJson(res, 200, backlogs.map((x) => summaryOf(built(x))));
      if (b === "backlogs" && (segs.length === 3 || (segs.length === 5 && d === "tasks"))) {
        const backlog = byId.get(c);
        if (!backlog) return notFound(res);
        const out = built(backlog);
        if (segs.length === 3) return sendJson(res, 200, recordOf(out));
        const detail = taskDetailOf(out, decodeSegment(e));
        return detail ? sendJson(res, 200, detail) : notFound(res);
      }
      if (b === "search" && segs.length === 2) return search(res, query);
      return notFound(res);
    }
    if (a === "events" && segs.length === 1) {
      res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      if (req.method === "HEAD") return res.end();
      res.write(": connected\n\n");
      clients.add(res);
      res.on("close", () => clients.delete(res));
      return undefined;
    }
    if (a === "assets" && segs.length >= 3) {
      if (hasBackslash || hasDot) return notFound(res);
      const backlog = byId.get(b);
      const out = backlog && built(backlog);
      const rest = segs.slice(2);
      if (!out || out.status !== "ok" || !out.assets.has(rest.join("/"))) return notFound(res);
      const data = backlog.reader.readBinary(join(out.assetRoot, ...rest), out.assetRoot);
      if (!data) return notFound(res);
      const type = contentTypeOf(rest[rest.length - 1]);
      return send(res, 200, data, {
        "Content-Type": type, "Cache-Control": "no-cache",
        ...(type === "image/svg+xml" ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
      });
    }
    if (a === "app" && segs.length >= 2) {
      if (hasBackslash || hasDot) return notFound(res);
      if (!builtFiles().has(segs.slice(1).join("/"))) return notFound(res);
      return serveFile(res, req, join(distDir, ...segs.slice(1)), distDir, { name: segs[segs.length - 1] });
    }
    return notFound(res);
  }

  const server = createServer((req, res) => {
    try {
      // The Host check runs first, so a DNS-rebinding page gets nothing from any route.
      if (!hostAllowed(req.headers.host, { port: handle.port, printedHost: handle.host, allowedHosts: allowed })) {
        return send(res, 403, "forbidden host", { "Content-Type": "text/plain; charset=utf-8" });
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return send(res, 405, "read-only", { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      }
      return route(req, res);
    } catch (err) {
      onError(err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
      return undefined;
    }
  });

  // A scoped address (fe80::1%lo0) has no URL host form and no canonical Host spelling, so
  // the Host check could not match it. It is refused, before and after binding.
  const SCOPED = "a scoped IPv6 address (with a % zone id) cannot be served; bind its unscoped form or a name";
  if (String(bind).includes("%")) throw new ViewerConfigError(`bind ${bind}: ${SCOPED}`);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: bind }, () => { server.off("error", reject); resolve(); });
  });
  const addr = server.address();
  if (addr.address.includes("%")) {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    watchers?.close();
    throw new ViewerConfigError(`bind ${bind} resolved to ${addr.address}: ${SCOPED}`);
  }
  handle.port = addr.port;
  handle.host = printedHostFor(bind, addr.address);
  if (watchers) watchers.start();
  const heartbeat = setInterval(() => pushAll(": keepalive\n\n"), HEARTBEAT_MS);
  heartbeat.unref();

  return {
    server, backlogs, watchers, broadcast,
    port: handle.port,
    host: handle.host,
    url: `http://${handle.host}:${handle.port}`,
    async close() {
      clearInterval(heartbeat);
      if (watchers) watchers.close();
      for (const res of clients) res.end();
      clients.clear();
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    },
  };
}
