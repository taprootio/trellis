// The viewer's data store. It owns every fetch so stale responses can be
// dropped in one place: each kind of request has a counter, and a response
// applies only while its number is still the latest.
import { defaultFilters, parseLocation } from "./filters.mjs";
import { encodeSegment } from "../src/viewer/segment.mjs";

export const SEARCH_DEBOUNCE_MS = 250;

export function searchUrl(filters) {
  const params = new URLSearchParams({ q: filters.q.trim() });
  for (const id of filters.backlogs) params.append("backlog", id);
  return `/api/search?${params}`;
}

export function createStore({
  fetchJson,
  debounceMs = SEARCH_DEBOUNCE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let state = {
    loaded: false,
    listError: "",
    backlogs: [], // /api/backlogs entries, config order
    details: {}, // backlog id -> /api/backlogs/<id>
    filters: defaultFilters(),
    search: { status: "idle", hits: [], skipped: [] },
    task: null, // { backlog, id, status: loading|ready|gone|error, record }
  };
  const listeners = new Set();
  const seq = new Map();
  let timer = null;

  const emit = () => listeners.forEach((fn) => fn(state));
  const set = (patch) => { state = { ...state, ...patch }; emit(); };
  const bump = (key) => { const n = (seq.get(key) ?? 0) + 1; seq.set(key, n); return n; };
  const isLatest = (key, n) => seq.get(key) === n;

  async function request(key, url, apply) {
    const n = bump(key);
    let res;
    try { res = await fetchJson(url); } catch (err) { res = { status: 0, body: null, error: err }; }
    if (isLatest(key, n)) apply(res);
  }

  function loadBacklog(id) {
    return request(`backlog:${id}`, `/api/backlogs/${encodeURIComponent(id)}`, (res) => {
      if (res.status === 200) set({ details: { ...state.details, [id]: res.body } });
    });
  }

  async function loadAll() {
    await request("backlogs", "/api/backlogs", (res) => {
      if (res.status === 200 && Array.isArray(res.body)) set({ backlogs: res.body, loaded: true, listError: "" });
      else set({ listError: "Could not load the backlogs.", loaded: true });
    });
    await Promise.all(state.backlogs.map((b) => loadBacklog(b.id)));
  }

  function runSearch() {
    clearTimer(timer);
    timer = null;
    const { filters } = state;
    if (!filters.q.trim()) { bump("search"); set({ search: { status: "idle", hits: [], skipped: [] } }); return Promise.resolve(); }
    return request("search", searchUrl(filters), (res) => {
      if (res.status === 200 && res.body && Array.isArray(res.body.hits)) {
        set({ search: { status: "ready", hits: res.body.hits, skipped: res.body.skipped ?? [] } });
      } else {
        set({ search: { status: "error", hits: [], skipped: [] } });
      }
    });
  }

  // The old term's results are dropped now, before the new request exists.
  function invalidateSearch() {
    clearTimer(timer);
    timer = null;
    bump("search");
    if (!state.filters.q.trim()) { set({ search: { status: "idle", hits: [], skipped: [] } }); return; }
    set({ search: { status: "pending", hits: [], skipped: [] } });
    timer = setTimer(runSearch, debounceMs);
  }

  function loadTask() {
    const open = state.task;
    if (!open) return Promise.resolve();
    const url = `/api/backlogs/${encodeURIComponent(open.backlog)}/tasks/${encodeSegment(open.id)}`;
    return request("task", url, (res) => {
      if (res.status === 200) set({ task: { ...open, status: "ready", record: res.body } });
      else if (res.status === 404) set({ task: { ...open, status: "gone", record: null } });
      else set({ task: { ...open, status: "error", record: null } });
    });
  }

  function openTask(backlog, id) {
    const same = state.task && state.task.backlog === backlog && state.task.id === id;
    if (same) return Promise.resolve();
    bump("task");
    set({ task: { backlog, id, status: "loading", record: null } });
    return loadTask();
  }

  function closeTask() {
    bump("task");
    if (state.task) set({ task: null });
  }

  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    loadAll,

    // Apply a parsed location (see parseLocation) from the address bar.
    applyLocation(loc) {
      const prev = state.filters;
      const searchChanged = prev.q !== loc.filters.q || prev.backlogs.join() !== loc.filters.backlogs.join();
      state = { ...state, filters: loc.filters };
      if (loc.task) openTask(loc.task.backlog, loc.task.id);
      else closeTask();
      if (searchChanged || state.search.status === "idle" && loc.filters.q.trim()) invalidateSearch();
      emit();
    },
    applyUrl(pathname, search) { this.applyLocation(parseLocation(pathname, search)); },

    // Filter edits from the controls; the caller also pushes the URL.
    setFilters(next) {
      const prev = state.filters;
      set({ filters: next });
      if (prev.q !== next.q || prev.backlogs.join() !== next.backlogs.join()) invalidateSearch();
    },

    // /events: a change names one backlog. Re-run what depends on it.
    onEvent(message) {
      const id = message && message.backlog;
      if (typeof id !== "string") return Promise.resolve();
      const jobs = [loadBacklog(id)];
      if (state.filters.q.trim()) jobs.push(runSearch());
      if (state.task) jobs.push(loadTask());
      return Promise.all(jobs);
    },

    // Every open, the first included, refetches everything on screen.
    onStreamOpen() {
      const jobs = [loadAll()];
      if (state.filters.q.trim()) jobs.push(runSearch());
      if (state.task) jobs.push(loadTask());
      return Promise.all(jobs);
    },
  };
}

// EventSource reconnects by itself and fires onopen again, which refetches.
export function connectEvents(store, EventSourceCtor, url = "/events") {
  const source = new EventSourceCtor(url);
  source.onopen = () => { store.onStreamOpen(); };
  source.onmessage = (event) => {
    let message = null;
    try { message = JSON.parse(event.data); } catch { /* ignore keep-alives */ }
    if (message) store.onEvent(message);
  };
  return source;
}

// Backlog list entry merged with its detail once loaded; error state wins.
export function backlogViews(state) {
  return state.backlogs.map((entry) => ({ ...entry, ...(state.details[entry.id] ?? {}) }));
}

// A backlog's diagnostics, and its flagged tasks with their validation errors.
export function attentionItems(view) {
  return {
    diagnostics: (view.diagnostics ?? []).map((d) => `${d.path}: ${d.message}`),
    flagged: (view.tasks ?? []).filter((t) => t.needsAttention).map((t) => ({ id: t.id, errors: t.validationErrors ?? [] })),
  };
}
