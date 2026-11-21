// Thin Lit wiring. Data, filtering and ordering live in the pure modules.
import { LitElement, html, nothing } from "lit";
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
  priorityOptions, ownerOptions, normalizeOwner, toText,
} from "./filters.mjs";
import { effortView } from "./effort.mjs";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, body };
}

const ANY = "";

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
    this.onPop = () => this.store.applyUrl(location.pathname, location.search);
    window.addEventListener("popstate", this.onPop);
    this.onPop();
    this.store.loadAll();
    this.events = connectEvents(this.store, EventSource);
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

  renderFilters(views) {
    const { filters } = this.snapshot;
    const pick = (items, selected) => items.map((i) => ({ ...i, selected: selected.includes(i.value) }));
    const backlogItems = pick(views.map((v) => ({ text: v.name, value: v.id })), filters.backlogs);
    const statusItems = pick(STATUSES.map((s) => ({ text: s, value: s })), filters.statuses);
    const milestoneItems = pick(milestoneGroups(views).flatMap((g) => g.items), filters.milestones);
    const one = (items, current) => [{ text: "Any", value: ANY, selected: !current }, ...items.map((i) => ({ ...i, selected: i.value === current }))];
    const priorityItems = one(priorityOptions(views).map((p) => ({ text: p, value: p })), filters.priority);
    const ownerItems = one(ownerOptions(views), normalizeOwner(filters.owner));
    const some = (key) => (e) => this.setFilters({ ...filters, [key]: e.detail.map((i) => i.value) });
    const single = (key) => (e) => this.setFilters({ ...filters, [key]: e.detail?.value ?? "" });
    return html`
      <div class="filters">
        <esp-input input-type="search" placeholder="Search tasks" aria-label="Search tasks"
          .value=${filters.q}
          @esp-value-changed=${(e) => this.setFilters({ ...filters, q: e.detail })}></esp-input>
        <esp-pick-some placeholder="Backlogs" .pickerItems=${backlogItems} @esp-value-changed=${some("backlogs")}></esp-pick-some>
        <esp-pick-some placeholder="Status" .pickerItems=${statusItems} @esp-value-changed=${some("statuses")}></esp-pick-some>
        <esp-pick-some placeholder="Milestones" .pickerItems=${milestoneItems} @esp-value-changed=${some("milestones")}></esp-pick-some>
        <esp-pick-one placeholder="Priority" .pickerItems=${priorityItems} @esp-value-changed=${single("priority")}></esp-pick-one>
        <esp-pick-one placeholder="Owner" .pickerItems=${ownerItems} @esp-value-changed=${single("owner")}></esp-pick-one>
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
        <header class="card-head">
          <esp-badge>${row.backlogName}</esp-badge>
          <a class="task-id" href=${taskPath(row.backlogId, task.id, filters)}
            @click=${(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); this.navigate(taskPath(row.backlogId, task.id, filters)); }}>${task.id}</a>
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
      const items = v.status === "ok" ? attentionItems(v) : [];
      return html`
        ${v.status === "error" ? html`<esp-info intent="danger"><strong>${v.name}</strong>
          <ul>${(v.errors ?? []).map((e) => html`<li>${toText(e)}</li>`)}</ul></esp-info>` : nothing}
        ${items.length ? html`<div class="attention">
          <esp-badge intent="warning">Needs attention · ${items.length}</esp-badge>
          <esp-details summary=${`${v.name}: ${items.length} ${items.length === 1 ? "problem" : "problems"}`}>
            <ul>${items.map((i) => html`<li>${i}</li>`)}</ul>
          </esp-details></div>` : nothing}`;
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
    const back = html`<esp-button @esp-clicked=${() => this.navigate(listPath(filters))}>Back to list</esp-button>`;
    if (task.status === "gone") {
      return html`<p>${task.id} is no longer there.</p>${back}`;
    }
    if (task.status === "error") return html`<esp-info intent="danger">Could not load ${task.id}.</esp-info>${back}`;
    if (task.status === "loading" || !task.record) return html`<p>Loading…</p>${back}`;
    const r = task.record;
    const fm = Object.entries(r.frontMatter ?? {});
    return html`
      ${back}
      <h1>${toText(r.title)}</h1>
      <dl class="front-matter">
        ${fm.map(([k, v]) => html`<dt>${k}</dt><dd>${typeof v === "object" ? JSON.stringify(v) : toText(v)}</dd>`)}
      </dl>
      ${this.renderEffort(r.effortDisplay)}
      <div class="body">${unsafeHTML(r.bodyHtml ?? "")}</div>`;
  }

  render() {
    const s = this.snapshot;
    const views = backlogViews(s);
    return html`
      <style>
        trellis-viewer .filters { display: grid; gap: var(--esp-size-small); grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); margin-block-end: var(--esp-size-padding); }
        trellis-viewer main { padding: var(--esp-size-padding-page); }
        trellis-viewer .card { background: var(--esp-color-layer-2); border-radius: var(--esp-size-border-radius); padding: var(--esp-size-padding); margin-block-end: var(--esp-size-small); }
        trellis-viewer .card-head, trellis-viewer .card-meta, trellis-viewer .attention { display: flex; flex-wrap: wrap; gap: var(--esp-size-small); align-items: center; }
        trellis-viewer .card p { margin: var(--esp-size-tiny) 0; }
        trellis-viewer .effort-image { block-size: 1.25em; vertical-align: middle; }
        trellis-viewer .hit { font-family: var(--esp-font-monospace); }
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
