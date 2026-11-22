import { decodeSegment, encodeSegment } from "../src/viewer/segment.mjs";

// Pure list logic: filters in the query string, row building, sort and search order.

export const STATUSES = ["active", "completed", "removed"];
export const DEFAULT_STATUSES = ["active"];

export function defaultFilters() {
  return { backlogs: [], statuses: [...DEFAULT_STATUSES], milestones: [], priority: "", owner: "", q: "" };
}

// Owners compare trimmed and case-folded, like the roster's handle lookup.
export function normalizeOwner(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// A milestone value is "<backlogId>:<milestone>"; backlog ids never hold a colon.
export function milestoneKey(backlogId, milestone) {
  return `${backlogId}:${milestone}`;
}

function values(params, key) {
  return params.getAll(key).filter((v) => v !== "");
}

export function parseQuery(search = "") {
  const params = new URLSearchParams(search);
  const f = defaultFilters();
  f.backlogs = values(params, "backlog");
  if (params.has("status")) f.statuses = values(params, "status").filter((s) => STATUSES.includes(s));
  f.milestones = values(params, "milestone");
  f.priority = params.get("priority") ?? "";
  f.owner = params.get("owner") ?? "";
  f.q = params.get("q") ?? "";
  return f;
}

export function serializeQuery(filters) {
  const f = { ...defaultFilters(), ...filters };
  const params = new URLSearchParams();
  for (const id of f.backlogs) params.append("backlog", id);
  const sameStatuses = f.statuses.length === DEFAULT_STATUSES.length && f.statuses.every((s, i) => s === DEFAULT_STATUSES[i]);
  if (!sameStatuses) {
    if (f.statuses.length === 0) params.append("status", "");
    for (const s of f.statuses) params.append("status", s);
  }
  for (const m of f.milestones) params.append("milestone", m);
  if (f.priority) params.set("priority", f.priority);
  if (f.owner) params.set("owner", f.owner);
  if (f.q) params.set("q", f.q);
  const text = params.toString();
  return text ? `?${text}` : "";
}

// The pickers keep their own selection once the user has touched them, so a filter change that
// came from the URL (Back, Forward, a link) needs fresh pickers. This counter is the picker key:
// it moves only when navigation changed the filters, never when a picker itself edited them.
export function pickerEpoch(epoch, before, after) {
  return serializeQuery(before) === serializeQuery(after) ? epoch : epoch + 1;
}

// Routes: "/", "/b/<id>" (presets the backlog filter) and "/b/<id>/task/<ID>".
export function parseLocation(pathname = "/", search = "") {
  const filters = parseQuery(search);
  const parts = pathname.split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts[0] === "b" && parts[1]) {
    if (parts[2] === "task" && parts[3] && parts.length === 4) {
      return { view: "task", filters, task: { backlog: parts[1], id: decodeSegment(parts[3]) } };
    }
    if (parts.length === 2) {
      if (!new URLSearchParams(search).has("backlog")) filters.backlogs = [parts[1]];
      return { view: "list", filters, task: null };
    }
  }
  return { view: "list", filters, task: null };
}

export function listPath(filters) {
  return `/${serializeQuery(filters)}`;
}

export function taskPath(backlogId, id, filters) {
  return `/b/${encodeURIComponent(backlogId)}/task/${encodeSegment(id)}${serializeQuery(filters)}`;
}

// The in-app path for a task link in a rendered body (`/b/<id>/task/<ID>`), carrying the
// current filters so Back reaches the filtered list. Null for any other path.
export function bodyLinkPath(pathname, filters) {
  const { task } = parseLocation(pathname);
  return task ? taskPath(task.backlog, task.id, filters) : null;
}

// Only links the server built from repository paths carry `data-task-link`; an authored link
// to this origin keeps its own query and fragment. Rewrites each such link under `anchors` so a new tab or a copied link keeps the filters.
// The link's own path is read, so running it again with newer filters just replaces the query.
export function carryFiltersInLinks(anchors, origin, filters) {
  for (const a of anchors) {
    if (!a.hasAttribute("data-task-link") || a.origin !== origin) continue;
    const path = bodyLinkPath(a.pathname, filters);
    if (path) a.setAttribute("href", path);
  }
}

// The task's own validation problems as text. They come from the shared validator, so a label
// retired from the config stays quiet on a closed task.
export const taskProblems = (record) => (Array.isArray(record.validationErrors) ? record.validationErrors.map(toText).filter(Boolean) : []);

// The heading over the problems: only a task the list flags (needsAttention) says "Needs
// attention"; a legacy closed task with an invalid field just lists its validation errors.
export const taskProblemsHeading = (record) => (record.needsAttention ? "Needs attention" : "Validation errors");

// The task view's text fields as [label, text] pairs, empty ones left out. The authored id is
// not here (the heading shows the record id), and effort has its own rendering.
export function taskFields(record, backlogName) {
  const collaborators = Array.isArray(record.collaborators) ? record.collaborators.join(", ") : "";
  return [
    ["Backlog", backlogName], ["Status", record.status], ["Milestone", record.milestone], ["Priority", record.priority],
    ["Owner", record.owner], ["Collaborators", collaborators], ["Summary", record.summary],
    ["Completed on", record.completed_on], ["Removed on", record.removed_on], ["Removed reason", record.removed_reason],
  ].map(([k, v]) => [k, toText(v)]).filter(([, v]) => v !== "");
}

const collator = new Intl.Collator("en", { numeric: true });

// One row per task across every loaded backlog, tagged with its sort position.
export function buildRows(backlogViews) {
  const rows = [];
  backlogViews.forEach((view, backlogIndex) => {
    if (view.status !== "ok" || !Array.isArray(view.tasks)) return;
    const milestones = Array.isArray(view.milestones) ? view.milestones : [];
    for (const task of view.tasks) {
      const at = typeof task.milestone === "string" ? milestones.indexOf(task.milestone) : -1;
      rows.push({
        key: `${view.id}/${task.id}`,
        backlogId: view.id,
        backlogName: view.name,
        backlogIndex,
        milestoneIndex: at < 0 ? Number.MAX_SAFE_INTEGER : at,
        task,
      });
    }
  });
  return rows;
}

export function compareRows(a, b) {
  return a.backlogIndex - b.backlogIndex
    || a.milestoneIndex - b.milestoneIndex
    || collator.compare(a.task.id, b.task.id);
}

export function sortRows(rows) {
  return [...rows].sort(compareRows);
}

export function filterRows(rows, filters) {
  const ownerWanted = normalizeOwner(filters.owner);
  return rows.filter(({ backlogId, task }) => {
    if (filters.backlogs.length && !filters.backlogs.includes(backlogId)) return false;
    if (filters.statuses.length && !filters.statuses.includes(task.status)) return false;
    if (filters.milestones.length && !filters.milestones.includes(milestoneKey(backlogId, task.milestone))) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (ownerWanted && normalizeOwner(task.owner) !== ownerWanted) return false;
    return true;
  });
}

// Search hits replace the default sort and add the matching line to each card.
export function orderByHits(rows, hits) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const ordered = [];
  for (const hit of hits) {
    const row = byKey.get(`${hit.backlog}/${hit.id}`);
    if (row) ordered.push({ ...row, hit });
  }
  return ordered;
}

// Rows to show: default sort, or hit order while a search term is set.
export function visibleRows(backlogViews, filters, search) {
  const filtered = filterRows(buildRows(backlogViews), filters);
  if (!filters.q.trim()) return sortRows(filtered);
  return search.status === "ready" ? orderByHits(filtered, search.hits) : [];
}

export function milestoneGroups(backlogViews) {
  return backlogViews
    .filter((v) => v.status === "ok" && Array.isArray(v.milestones) && v.milestones.length)
    .map((v) => ({
      backlogId: v.id,
      backlogName: v.name,
      items: v.milestones.map((m) => ({ text: `${v.name} · ${m}`, value: milestoneKey(v.id, m) })),
    }));
}

export function priorityOptions(backlogViews) {
  const seen = new Set();
  for (const v of backlogViews) {
    for (const p of v.config?.priorities ?? []) seen.add(p);
  }
  return [...seen];
}

// One entry per normalized owner, shown as first written.
export function ownerOptions(backlogViews) {
  const seen = new Map();
  for (const row of buildRows(backlogViews)) {
    const key = normalizeOwner(row.task.owner);
    if (key && !seen.has(key)) seen.set(key, row.task.owner.trim());
  }
  return [...seen].map(([value, text]) => ({ value, text })).sort((a, b) => collator.compare(a.text, b.text));
}

export function toText(value) {
  return value === null || value === undefined ? "" : String(value);
}
