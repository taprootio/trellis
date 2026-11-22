// Thin Lit wiring. Data, filtering and ordering live in the pure modules.
import { LitElement, html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import "@taprootio/espalier/root";
import "@taprootio/espalier/page";
import "@taprootio/espalier/header";
import "@taprootio/espalier/repeater";
import "@taprootio/espalier/pickers/pick-some";
import "@taprootio/espalier/pickers/pick-one";
import "@taprootio/espalier/input";
import "@taprootio/espalier/badge";
import "@taprootio/espalier/info";
import "@taprootio/espalier/details";
import "@taprootio/espalier/button";

import { createStore, connectEvents, backlogViews, attentionItems } from "./state.mjs";
import {
  STATUSES, serializeQuery, listPath, taskPath, visibleRows, milestoneGroups,
  priorityOptions, ownerOptions, pickerEpoch, normalizeOwner, toText, bodyLinkPath, taskFields, carryFiltersInLinks, taskProblems, taskProblemsHeading,
} from "./filters.mjs";
import { effortView } from "./effort.mjs";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, body };
}

const ANY = "";

// Cards render inside esp-repeater's shadow root, which the page's <style> cannot reach.
const CARD_STYLE = html`<style>
  .card { background: var(--esp-color-layer-2); border-radius: var(--esp-size-border-radius); padding: var(--esp-size-padding); margin-block-end: var(--esp-size-small); }
  .card-head, .card-meta { display: flex; flex-wrap: wrap; gap: var(--esp-size-small); align-items: center; }
  .card p { margin: var(--esp-size-tiny) 0; }
  .effort-image { block-size: 1.25em; inline-size: auto; vertical-align: middle; }
  .hit { font-family: var(--esp-font-monospace); }
</style>`;

class TrellisViewer extends LitElement {
  static properties = { snapshot: { state: true } };

  constructor() {
    super();
    this.store = createStore({ fetchJson });
    this.snapshot = this.store.state;
    this.store.subscribe((s) => { this.snapshot = s; });
  }

  // Light DOM, so Espalier's tokens from <esp-root> reach our own markup.
  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this.pickerKey = 0;
    this.onPop = () => {
      const before = this.store.state.filters;
      this.store.applyUrl(location.pathname, location.search);
      this.pickerKey = pickerEpoch(this.pickerKey, before, this.store.state.filters);
    };
    window.addEventListener("popstate", this.onPop);
    this.onPop();
    this.store.loadAll();
    this.events = connectEvents(this.store, EventSource);
  }

  // The body's HTML is injected as a string, so its task links get the filters after each render.
  updated() {
    const body = this.querySelector(".body");
    if (body) carryFiltersInLinks(body.querySelectorAll("a[data-task-link]"), location.origin, this.snapshot.filters);
  }

  disconnectedCallback() {
    window.removeEventListener("popstate", this.onPop);
    this.events?.close();
    super.disconnectedCallback();
  }

  navigate(path) {
    history.pushState(null, "", path);
    this.onPop();
  }

  // Keep the filters in the address bar without adding history entries.
  setFilters(next) {
    this.store.setFilters(next);
    history.replaceState(null, "", `/${serializeQuery(next)}`);
  }

  link(path, label) {
    return html`<a href=${path} @click=${(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
      e.preventDefault();
      this.navigate(path);
    }}>${label}</a>`;
  }

  // A task link in the body navigates in-app with the current filters; others behave normally.
  onBodyClick(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    const a = e.target instanceof Element ? e.target.closest("a[data-task-link]") : null;
    if (!a || (a.target && a.target !== "_self") || a.origin !== location.origin) return;
    const path = bodyLinkPath(a.pathname, this.snapshot.filters);
    if (!path) return;
    e.preventDefault();
    this.navigate(path);
  }

  renderFilters(views) {
    const { filters } = this.snapshot;
    const pick = (items, selected) => items.map((i) => ({ ...i, selected: selected.includes(i.value) }));
    const backlogItems = pick(views.map((v) => ({ text: v.name, value: v.id })), filters.backlogs);
    const statusItems = pick(STATUSES.map((s) => ({ text: s, value: s })), filters.statuses);
    const milestoneItems = pick(milestoneGroups(views).flatMap((g) => g.items), filters.milestones);
    const one = (label, items, current) => [{ text: `Any ${label}`, value: ANY, selected: !current }, ...items.map((i) => ({ ...i, selected: i.value === current }))];
    const priorityItems = one("priority", priorityOptions(views).map((p) => ({ text: p, value: p })), filters.priority);
    const ownerItems = one("owner", ownerOptions(views), normalizeOwner(filters.owner));
    const some = (key) => (e) => this.setFilters({ ...filters, [key]: e.detail.map((i) => i.value) });
    const single = (key) => (e) => this.setFilters({ ...filters, [key]: e.detail?.value ?? "" });
    return html`
      <div class="filters">
        <esp-input input-type="search" placeholder="Search tasks" aria-label="Search tasks"
          .value=${filters.q}
          @esp-value-changed=${(e) => this.setFilters({ ...filters, q: e.detail })}></esp-input>
        ${keyed(this.pickerKey, html`<esp-pick-some placeholder="Backlogs" .pickerItems=${backlogItems} @esp-value-changed=${some("backlogs")}></esp-pick-some>`)}
        ${keyed(this.pickerKey, html`<esp-pick-some placeholder="Status" .pickerItems=${statusItems} @esp-value-changed=${some("statuses")}></esp-pick-some>`)}
        ${keyed(this.pickerKey, html`<esp-pick-some placeholder="Milestones" .pickerItems=${milestoneItems} @esp-value-changed=${some("milestones")}></esp-pick-some>`)}
        ${keyed(this.pickerKey, html`<esp-pick-one placeholder="Priority" .pickerItems=${priorityItems} @esp-value-changed=${single("priority")}></esp-pick-one>`)}
        ${keyed(this.pickerKey, html`<esp-pick-one placeholder="Owner" .pickerItems=${ownerItems} @esp-value-changed=${single("owner")}></esp-pick-one>`)}
      </div>`;
  }

  renderEffort(display) {
    const view = effortView(display);
    if (view.kind === "none") return nothing;
    if (view.kind === "image") return html`<span class="effort"><img src=${view.src} alt=${view.alt} class="effort-image" /> ${view.text}</span>`;
    if (view.kind === "emoji") return html`<span class="effort">${view.emoji} ${view.text}</span>`;
    return html`<span class="effort">${view.text}</span>`;
  }

  renderCard(row) {
    const { task } = row;
    const { filters } = this.snapshot;
    return html`
      <article class="card">
        ${CARD_STYLE}
        <header class="card-head">
          <esp-badge>${row.backlogName}</esp-badge>
          ${this.link(taskPath(row.backlogId, task.id, filters), task.id)}
          <strong>${toText(task.title)}</strong>
        </header>
        ${task.summary ? html`<p>${toText(task.summary)}</p>` : nothing}
        ${row.hit ? html`<p class="hit">${row.hit.field}: ${toText(row.hit.line)}</p>` : nothing}
        <footer class="card-meta">
          <esp-badge intent=${task.status === "active" ? "info" : "neutral"}>${task.status}</esp-badge>
          ${task.milestone ? html`<esp-badge>${task.milestone}</esp-badge>` : nothing}
          ${task.priority ? html`<esp-badge>${task.priority}</esp-badge>` : nothing}
          ${task.needsAttention ? html`<esp-badge intent="warning">Needs attention</esp-badge>` : nothing}
          ${this.renderEffort(task.effortDisplay)}
          ${task.owner ? html`<span>${toText(task.owner)}</span>` : nothing}
        </footer>
      </article>`;
  }

  renderBacklogNotices(views) {
    return views.map((v) => {
      const { diagnostics, flagged } = v.status === "ok" ? attentionItems(v) : { diagnostics: [], flagged: [] };
      return html`
        ${v.status === "error" ? html`<esp-info intent="danger"><strong>${v.name}</strong>
          <ul>${(v.errors ?? []).map((e) => html`<li>${toText(e)}</li>`)}</ul></esp-info>` : nothing}
        ${diagnostics.length || flagged.length ? html`<div class="attention">
          ${diagnostics.length ? html`<esp-details summary=${`${v.name}: ${diagnostics.length} ${diagnostics.length === 1 ? "diagnostic" : "diagnostics"}`}>
            <ul>${diagnostics.map((d) => html`<li>${d}</li>`)}</ul>
          </esp-details>` : nothing}
          ${flagged.length ? html`<esp-badge intent="warning">${v.name}: needs attention · ${flagged.length}</esp-badge>
            <esp-details summary=${`${flagged.length} flagged ${flagged.length === 1 ? "task" : "tasks"}`}>
              <ul>${flagged.map((f) => html`<li>${f.id}: ${f.errors.join("; ")}</li>`)}</ul>
            </esp-details>` : nothing}
        </div>` : nothing}`;
    });
  }

  renderList(views) {
    const { filters, search } = this.snapshot;
    const rows = visibleRows(views, filters, search);
    return html`
      ${this.renderFilters(views)}
      ${this.renderBacklogNotices(views)}
      ${search.status === "error" ? html`<esp-info intent="danger">Search failed.</esp-info>` : nothing}
      <esp-repeater scroll-model="page" aria-label="Tasks" .items=${rows} .renderItem=${(row) => this.renderCard(row)}>
        <p slot="empty">${search.status === "pending" ? "Searching…" : "No task matches the filters."}</p>
      </esp-repeater>`;
  }

  renderTask() {
    const { task, filters } = this.snapshot;
    const back = html`<esp-button collapsed label="Back to list" @esp-clicked=${() => this.navigate(listPath(filters))}></esp-button>`;
    if (task.status === "gone") {
      return html`<p>${task.id} is no longer there.</p>${back}`;
    }
    if (task.status === "error") return html`<esp-info intent="danger">Could not load ${task.id}.</esp-info>${back}`;
    if (task.status === "loading" || !task.record) return html`<p>Loading…</p>${back}`;
    const r = task.record;
    const fields = taskFields(r, task.backlog);
    return html`
      ${back}
      <h1>${r.id} · ${toText(r.title)}</h1>
      <dl class="front-matter">
        ${fields.map(([k, v]) => html`<dt>${k}</dt><dd>${toText(v)}</dd>`)}
        ${r.effortDisplay && r.effortDisplay.text ? html`<dt>Effort</dt><dd>${this.renderEffort(r.effortDisplay)}</dd>` : nothing}
        ${(r.depends_on ?? []).length ? html`<dt>Depends on</dt><dd>${r.depends_on.join(", ")}</dd>` : nothing}
      </dl>
      ${taskProblems(r).length ? html`<esp-info intent="warning"><strong>${taskProblemsHeading(r)}</strong>
        <ul>${taskProblems(r).map((e) => html`<li>${e}</li>`)}</ul></esp-info>` : nothing}
      <div class="body" @click=${(e) => this.onBodyClick(e)}>${unsafeHTML(r.bodyHtml ?? "")}</div>`;
  }

  render() {
    const s = this.snapshot;
    const views = backlogViews(s);
    return html`
      <style>
        trellis-viewer .filters { display: grid; gap: var(--esp-size-small); grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); margin-block-end: var(--esp-size-padding); }
        trellis-viewer main { padding: var(--esp-size-padding-page); }
        trellis-viewer .attention { display: flex; flex-wrap: wrap; gap: var(--esp-size-small); align-items: center; }
        trellis-viewer .effort-image { block-size: 1.25em; vertical-align: middle; }
        trellis-viewer .front-matter { display: grid; grid-template-columns: max-content 1fr; gap: var(--esp-size-tiny) var(--esp-size-padding); }
        trellis-viewer .front-matter dd { margin: 0; }
      </style>
      <esp-page>
        <esp-header slot="header" theme-toggle="hidden"><span slot="brand">Trellis</span></esp-header>
        <main>
          ${s.listError ? html`<esp-info intent="danger">${s.listError}</esp-info>` : nothing}
          ${!s.loaded ? html`<p>Loading…</p>` : s.task ? this.renderTask() : this.renderList(views)}
        </main>
      </esp-page>`;
  }
}

customElements.define("trellis-viewer", TrellisViewer);
