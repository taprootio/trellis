// Task search ranking (TRL0005): one owner for how the viewer orders hits.
//
// An exact id ranks first, then a partial id, then title, summary and body. Each task
// yields at most one hit, for its best field.

const RANK = { id: 0, title: 2, summary: 3, body: 4 };

// Front-matter values can be numbers (an unquoted `title: 404`) or missing.
export const toText = (value) => (value === null || value === undefined ? "" : String(value));

// The line on which the first match starts; `lower` and `text` share their newlines.
function lineOf(text, lower, at) {
  const n = lower.slice(0, at).split("\n").length - 1;
  return (text.split("\n")[n] ?? "").replace(/\r$/, "");
}

// `items`: [{ backlog, order, id, title, summary, body }] with `order` the backlog's
// position in the config. Returns [{ backlog, id, field, line }] best first.
export function searchItems(items, query) {
  const q = toText(query).trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const it of items) {
    const title = toText(it.title);
    const id = toText(it.id).toLowerCase();
    let rank = null;
    let field = null;
    let line = "";
    if (id === q) { rank = 0; field = "id"; line = title; }
    else if (id.includes(q)) { rank = 1; field = "id"; line = title; }
    else {
      for (const name of ["title", "summary", "body"]) {
        const text = name === "title" ? title : toText(it[name]);
        const lower = text.toLowerCase();
        const at = lower.indexOf(q);
        if (at === -1) continue;
        rank = RANK[name];
        field = name;
        line = name === "title" ? title : lineOf(text, lower, at);
        break;
      }
    }
    if (rank !== null) scored.push({ rank, order: it.order ?? 0, hit: { backlog: it.backlog, id: it.id, field, line } });
  }
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0));
  return scored.map((s) => s.hit);
}
