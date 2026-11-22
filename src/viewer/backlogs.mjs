// Per-backlog state for the viewer (TRL0005): reads one repo's main worktree through the
// contained reader and shapes the API records from `readBacklog`.

import { dirname, join, normalize, resolve } from "node:path";
import { buildBacklogJson, loadConfig, paths, readBacklog, resolveEffort } from "../backlog.mjs";
import { preview } from "../ledger.mjs";
import { renderMarkdown } from "../markdown.mjs";
import { createReader } from "./reader.mjs";
import { encodeSegment } from "./segment.mjs";
import { LayoutError, resolveMainWorktree } from "./worktree.mjs";

const STATUS_ORDER = ["removed", "completed", "active"]; // most closed first
const KIND = { active: "active", completed: "completed", removed: "removed" };
export const IMAGE_TYPES = {
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
};

// The reader labels a completed item `completed/<file>`; its folder is `completed/tasks/`.
const realRel = (where) => where.replace(/^completed\/(?!tasks$)/, "completed/tasks/");
const fileIdOf = (item) => item._file.replace(/\.md$/, "");

// The path under `<tasksDir>/assets/` of a configured effort image, or null when the image
// is not an image file under that folder.
// An unpaired surrogate makes encodeURIComponent throw, so such a path is never an asset.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export function assetRelOf(image) {
  if (typeof image !== "string" || LONE_SURROGATE_RE.test(image)) return null;
  const parts = image.split(/[\\/]+/);
  if (parts[0] !== "assets" || parts.length < 2) return null;
  const rest = parts.slice(1);
  if (rest.some((p) => !p || p === "." || p === "..")) return null;
  const ext = /\.[A-Za-z0-9]+$/.exec(rest[rest.length - 1]);
  return ext && IMAGE_TYPES[ext[0].toLowerCase()] ? rest.join("/") : null;
}

const assetUrl = (backlogId, rel) => `/assets/${backlogId}/${rel.split("/").map(encodeURIComponent).join("/")}`;

function effortDisplay(cfg, item, backlogId) {
  const r = resolveEffort(cfg, item.effort);
  if (r.error) return { label: null, value: null, emoji: null, imageUrl: null, text: "" };
  const rel = assetRelOf(r.image);
  return {
    label: r.label,
    value: r.value,
    emoji: r.emoji ?? null,
    imageUrl: rel ? assetUrl(backlogId, rel) : null,
    text: cfg.effortScale.isIdentity ? String(r.value) : `${r.label} · ${r.value}`,
  };
}

function effortScaleOf(cfg, backlogId) {
  return {
    name: cfg.effortScale.isIdentity ? null : cfg.effortScale.name,
    values: cfg.effortValues.map((value) => {
      const e = cfg.effortScale.byNumber.get(value) || { label: String(value) };
      const rel = assetRelOf(e.image);
      return { value, label: e.label, emoji: e.emoji ?? null, imageUrl: rel ? assetUrl(backlogId, rel) : null };
    }),
  };
}

const ZERO = { active: 0, completed: 0, removed: 0 };

// `hooks` go to the reader (test seams); `git` stands in for the git runner of the layout check.
export function createBacklog(entry, { hooks, git } = {}) {
  let layout = null;
  let layoutError = null;
  try {
    layout = resolveMainWorktree(entry.path, git ? { git } : {});
  } catch (e) {
    if (!(e instanceof LayoutError)) throw e;
    layoutError = e.message;
  }
  const root = layout ? layout.mainWorktree : null;
  const reader = root ? createReader(root, hooks) : null;
  const base = { id: entry.id, name: entry.name, path: entry.path, mainWorktree: root ?? entry.path };

  const errorBuild = (errors) => ({
    ...base, status: "error", errors, diagnostics: [], cfg: null, counts: { ...ZERO }, nextId: null, nextIdReason: undefined,
    tasks: new Map(), order: [], assets: new Set(), assetRoot: null, root,
  });

  // Reads the backlog now. Never throws for a repository problem: those become an error build.
  function build() {
    if (layoutError) return errorBuild([layoutError]);
    reader.begin();
    const { cfg, errors: cfgErrors } = loadConfig(root, { readText: reader.readText });
    if (cfgErrors.length) return errorBuild(cfgErrors);

    const p = paths(root, cfg);
    const dirs = [p.active, p.completedTasks, p.removed];
    const seams = { readItem: reader.readItem, listDir: reader.listDir, readText: reader.readText };
    let data = readBacklog(root, cfg, seams);
    // A directory listed for ids can vanish or be swapped before its items are read; redo the
    // pass without it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const bad = dirs.map((d) => [d, reader.listedDirProblem(d)]).filter(([, why]) => why);
      if (!bad.length) break;
      for (const [d, why] of bad) reader.forceSkip(d, why);
      reader.retry();
      data = readBacklog(root, cfg, seams);
    }
    if (data.configErrors.length) return errorBuild(data.configErrors);
    return shape(cfg, data, p);
  }

  function shape(cfg, data, p) {
    const reads = reader.reads();
    const diagnostics = [];
    const syntax = new Set();
    for (const [where, r] of reads) {
      for (const msg of r.syntaxErrors) {
        syntax.add(msg);
        diagnostics.push({ path: realRel(where), message: msg.startsWith(`${where}: `) ? msg.slice(where.length + 2) : msg });
      }
    }
    for (const s of data.skipped) diagnostics.push({ path: realRel(s.path), message: s.reason });

    // Group the parsed copies by filename id and pick the canonical one.
    const copies = new Map(); // id -> [{ status, item, where, read }]
    const byWhere = new Map();
    for (const status of ["active", "completed", "removed"]) {
      for (const item of data[status]) {
        const where = `${KIND[status]}/${item._file}`;
        const copy = { status, item, where, read: reads.get(where), id: fileIdOf(item) };
        byWhere.set(where, copy);
        if (!copies.has(copy.id)) copies.set(copy.id, []);
        copies.get(copy.id).push(copy);
      }
    }
    const canonical = new Map(); // id -> copy
    for (const [id, list] of copies) {
      // An id with no cleanly parsed copy is not a task: its syntax diagnostics stay, but a
      // half-parsed file is never published.
      const pool = list.filter((c) => c.read && c.read.syntaxErrors.length === 0);
      if (!pool.length) continue;
      const pick = STATUS_ORDER.map((s) => pool.find((c) => c.status === s)).find(Boolean);
      canonical.set(id, pick);
      for (const c of list) if (c !== pick) diagnostics.push({ path: realRel(c.where), message: `duplicate of ${id}; the canonical copy is ${realRel(pick.where)}` });
    }

    // Item errors belong to their canonical task; others on a task file are diagnostics.
    const validation = new Map();
    for (const e of data.errors) {
      if (syntax.has(e) || /: duplicate id in /.test(e)) continue;
      const m = /^((?:active|completed|removed)\/.+?\.md): /.exec(e);
      const copy = m && byWhere.get(m[1]);
      if (copy) {
        if (canonical.get(copy.id) === copy) {
          if (!validation.has(copy.where)) validation.set(copy.where, []);
          validation.get(copy.where).push(e);
        }
      } else if (m) diagnostics.push({ path: realRel(m[1]), message: e.slice(m[0].length) });
      else diagnostics.push({ path: "backlog", message: e });
    }

    const picked = { ids: data.ids, active: [], completed: [], removed: [] };
    const order = [];
    for (const status of ["active", "completed", "removed"]) {
      for (const item of data[status]) {
        const c = canonical.get(fileIdOf(item));
        if (!c || c.item !== item) continue;
        picked[status].push({ ...item, id: c.id });
        order.push(c);
      }
    }

    let nextId; // undefined: the scan value
    let nextIdReason;
    if (cfg.idAllocation === "ledger") {
      const pv = preview(root, cfg);
      nextId = pv.nextId;
      if (pv.nextId === null) nextIdReason = pv.note;
    }
    const json = JSON.parse(buildBacklogJson(cfg, picked, { nextIdOverride: nextId }));
    const taskPaths = new Map();
    for (const list of copies.values()) for (const c of list) if (c.read && canonical.has(c.id)) taskPaths.set(normalize(c.read.path), c.id);

    const tasks = new Map();
    json.tasks.forEach((record, i) => {
      const c = order[i];
      const t = { ...record, effortDisplay: effortDisplay(cfg, c.item, entry.id) };
      t.needsAttention = c.status === "active" && !cfg.milestones.includes(c.item.milestone);
      t.validationErrors = validation.get(c.where) ?? [];
      if (c.item.depends_on === undefined) t.dependsOnMissing = true;
      json.tasks[i] = t;
      tasks.set(c.id, { record: t, frontMatter: c.read.fm, body: c.read.body, dir: dirname(c.read.path) });
    });

    const assets = new Set();
    for (const e of cfg.effortScale.byNumber.values()) { const rel = assetRelOf(e.image); if (rel) assets.add(rel); }
    return {
      ...base, status: "ok", errors: [], diagnostics, cfg, counts: json.counts, nextId: json.nextId, nextIdReason,
      prefix: json.prefix, milestones: json.milestones, tasks, order: json.tasks.map((t) => t.id), assets,
      assetRoot: join(root, cfg.tasksDir || "trellis", "assets"), taskPaths, root,
    };
  }

  return {
    id: entry.id, name: entry.name, path: entry.path, reader, build,
    get mainWorktree() { return root; },
    get gitDir() { return layout ? layout.gitDir : null; },
    get layoutError() { return layoutError; },
  };
}

// ------------------------------------------------------------ API shapes
export const summaryOf = (b) => ({
  id: b.id, name: b.name, path: b.path, mainWorktree: b.mainWorktree, status: b.status, errors: b.errors, counts: b.counts, nextId: b.nextId,
});

export function recordOf(b) {
  if (b.status !== "ok") return { id: b.id, name: b.name, status: "error", errors: b.errors, diagnostics: b.diagnostics };
  const out = {
    id: b.id, name: b.name, status: "ok", errors: [], prefix: b.prefix, milestones: b.milestones, nextId: b.nextId, counts: b.counts,
    tasks: b.order.map((id) => b.tasks.get(id).record),
    config: { idPrefix: b.cfg.idPrefix, milestones: b.cfg.milestones, priorities: b.cfg.priorities, effortScale: effortScaleOf(b.cfg, b.id) },
    diagnostics: b.diagnostics,
  };
  if (b.nextId === null && b.nextIdReason) out.nextIdReason = b.nextIdReason;
  return out;
}

// One task's record with its front matter and rendered body, or null when there is none.
// The id is looked up in the parsed set (so every listed task has a detail, whatever the scan
// prefix); it never becomes a path.
export function taskDetailOf(b, id) {
  if (b.status !== "ok") return null;
  const t = b.tasks.get(id);
  if (!t) return null;
  const resolveRepoPath = (target) => {
    let path = target.replace(/[?#].*$/, "");
    try { path = decodeURIComponent(path); } catch { return null; }
    if (!path || path.startsWith("/")) return null;
    const known = b.taskPaths.get(normalize(resolve(t.dir, path)));
    return known ? `/b/${encodeURIComponent(b.id)}/task/${encodeSegment(known)}` : null;
  };
  return { ...t.record, frontMatter: t.frontMatter, bodyHtml: renderMarkdown(t.body, { resolveRepoPath }) };
}

// The search corpus for one built backlog, in id order within its status groups.
export function searchCorpus(b, order) {
  if (b.status !== "ok") return [];
  return b.order.map((id) => {
    const t = b.tasks.get(id);
    return { backlog: b.id, order, id, title: t.frontMatter ? t.frontMatter.title : undefined, summary: t.frontMatter ? t.frontMatter.summary : undefined, body: t.body };
  });
}

