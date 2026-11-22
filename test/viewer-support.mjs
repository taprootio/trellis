// Shared helpers for the viewer server tests: temporary repos, raw HTTP, an SSE reader, and the
// checker that matches a response against a variant of test/fixtures/viewer-api/.

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { composeFile } from "../src/backlog.mjs";
import { initRefFormat } from "./git-support.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIST = join(here, "fixtures", "viewer-dist");
export const PACKAGE_ROOT = join(here, "..");

export const tmp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `trellis-viewer-${name}-`)));
export const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const BASE_CFG = {
  specVersion: "2.5", idPrefix: "DEMO", idWidth: 4, milestones: ["Alpha", "Beta"], priorities: ["High", "Low"], effort: [1, 2, 3, 5, 8],
};
export const FISH_CFG = {
  ...BASE_CFG,
  effort: {
    values: [1, 2, 3, 5, 8],
    scale: "fish",
    scales: {
      fish: {
        1: { label: "Minnow", emoji: "🐟" }, 2: { label: "Goldfish", emoji: "🐠" }, 3: { label: "Trout", emoji: "🐡" },
        5: { label: "Tuna", image: "assets/effort/tuna.svg" }, 8: { label: "Swordfish" },
      },
    },
  },
};
export const TUNA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>';

const FOLDERS = { active: ["active"], completed: ["completed", "tasks"], removed: ["removed"] };

// The default front matter for an item in a status; `fm` overrides it.
export function itemFm(status, id, fm = {}) {
  const base = { id, title: `Title ${id}`, status, milestone: "Alpha", priority: "High", effort: 3, depends_on: [], summary: "S." };
  if (status === "completed") base.completed_on = "2026-01-01";
  if (status === "removed") { base.removed_on = "2026-02-01"; base.removed_reason = "Superseded."; }
  return { ...base, ...fm };
}

// A committed git repo with a Trellis config and the given items.
// items: [{ status, id, fm?, body? }]. `rawConfig` writes the config file text as given.
export function makeRepo({ cfg = BASE_CFG, rawConfig, items = [], files = {} } = {}) {
  const dir = tmp("repo");
  const root = join(dir, "repo");
  mkdirSync(root);
  git(root, "init", "-q", ...initRefFormat, "-b", "main");
  git(root, "config", "user.name", "Tester");
  git(root, "config", "user.email", "tester@example.com");
  mkdirSync(join(root, "trellis"), { recursive: true });
  writeFileSync(join(root, "trellis", "backlog.config.json"), rawConfig ?? JSON.stringify(cfg, null, 2));
  const repo = {
    dir, root, cfg,
    tasksDir: cfg && cfg.tasksDir ? cfg.tasksDir : "trellis",
    folder(status) { return join(root, repo.tasksDir, ...FOLDERS[status]); },
    itemPath(status, id) { return join(repo.folder(status), `${id}.md`); },
    add(status, id, fm = {}, body = "Body.\n") {
      mkdirSync(repo.folder(status), { recursive: true });
      writeFileSync(repo.itemPath(status, id), composeFile(itemFm(status, id, fm), body));
    },
    write(rel, content) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    },
    commit() { git(root, "add", "-A"); git(root, "commit", "-q", "-m", "snapshot", "--allow-empty"); },
    lane(name) { const p = join(dir, name); git(root, "worktree", "add", "-q", "-b", name, p); return p; },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
  for (const it of items) repo.add(it.status, it.id, it.fm, it.body);
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  repo.commit();
  return repo;
}

// ------------------------------------------------------------------ HTTP
// A raw request: `path` is sent exactly as given (no normalization), `host` overrides Host.
export function request(port, { method = "GET", path = "/", host, hostname = "127.0.0.1", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, method, path, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export async function getJson(port, path, opts = {}) {
  const r = await request(port, { path, ...opts });
  return { ...r, json: r.headers["content-type"]?.includes("json") ? JSON.parse(r.text) : null };
}

const DEADLINE_MS = 10_000;

// Opens /events and resolves once the stream is live. `next(id)` resolves with the next unconsumed
// message naming that backlog (any backlog when omitted) and rejects at the deadline; `seen`
// lists every message so far.
export function openEvents(port, { hostname = "127.0.0.1", host } = {}) {
  return new Promise((resolve, reject) => {
    const seen = []; // every message, in order
    const pending = []; // messages nobody has consumed yet
    const waiters = [];
    let buffer = "";
    const req = httpRequest({ hostname, port, path: "/events", headers: { Host: host ?? `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const msg = JSON.parse(data.slice(6));
          seen.push(msg);
          const w = waiters.find((x) => !x.id || x.id === msg.backlog);
          if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } else pending.push(msg);
        }
      });
      resolve({
        seen,
        next(id) {
          const i = pending.findIndex((m) => !id || m.backlog === id);
          if (i !== -1) return Promise.resolve(pending.splice(i, 1)[0]);
          return new Promise((res2, rej2) => {
            const w = { id, resolve: (m) => { clearTimeout(w.timer); res2(m); } };
            w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej2(new Error(`no SSE message${id ? ` for ${id}` : ""} before the deadline`)); }, DEADLINE_MS);
            waiters.push(w);
          });
        },
        // Forgets queued messages nobody read, e.g. a warm-up probe's.
        drain() { pending.length = 0; },
        close() { req.destroy(); },
      });
    });
    req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
    req.end();
  });
}

// ------------------------------------------------------------- shape checks
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function loadVariant(file, name) {
  const all = JSON.parse(readFileSync(join(here, "fixtures", "viewer-api", `${file}.json`), "utf8")).variants;
  if (!all[name]) throw new Error(`no variant ${name} in ${file}.json`);
  return all[name];
}

// Problems matching `value` against a variant ({ optional, nullable, freeForm, response }).
// An empty example array accepts any elements.
export function shapeProblems(value, variant) {
  const optional = new Set(variant.optional || []);
  const nullable = new Set(variant.nullable || []);
  const freeForm = new Set(variant.freeForm || []);
  const problems = [];
  const walk = (v, ex, p) => {
    if (v === null && nullable.has(p)) return;
    // A null example on a nullable path stands for "null or a value of any type".
    if (ex === null && nullable.has(p)) return;
    if (typeOf(v) !== typeOf(ex)) { problems.push(`${p || "(root)"}: expected ${typeOf(ex)}, got ${typeOf(v)}`); return; }
    if (Array.isArray(ex)) {
      if (ex.length) v.forEach((el) => walk(el, ex[0], `${p}[]`));
      return;
    }
    if (ex === null || typeof ex !== "object" || freeForm.has(p)) return;
    const at = (k) => (p ? `${p}.${k}` : k);
    for (const k of Object.keys(ex)) {
      if (!Object.hasOwn(v, k)) { if (!optional.has(at(k))) problems.push(`${at(k)}: missing`); } else walk(v[k], ex[k], at(k));
    }
    for (const k of Object.keys(v)) if (!Object.hasOwn(ex, k) && !optional.has(at(k))) problems.push(`${at(k)}: not in the fixture`);
  };
  walk(value, variant.response, "");
  return problems;
}
