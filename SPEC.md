# Trellis Backlog Spec

**Version:** 2.5.0 · **Status:** stable

Trellis is a tool-agnostic convention for running a software backlog as plain
files in a git repository. Work items are Markdown files with YAML front-matter;
a generator validates them and produces a human index and a machine-readable
`backlog.json`; CI gates the repo so the index can never drift. This document is
the canonical specification, intended to be vendored into any repository
unchanged.

This spec describes the backlog **format and artifacts** — the data, the
generated outputs, and the tooling contract. It does not prescribe a *process*
for working items (planning, review, branching); those layer on top and are
specified separately.

## 1. Concepts

- **Item** — one unit of tracked work, stored as a single Markdown file.
- **Status** — `active`, `completed`, or `removed`. An item has exactly one,
  reflected by which directory it lives in.
- **Generator** — a program that validates items and regenerates the derived
  artifacts (`README.md` tables and `backlog.json`).
- **Config** — `backlog.config.json`, the per-repo vocabulary (id prefix,
  milestones, priorities, effort scale) that lets the same generator serve any
  repo.

The per-item files are the single source of truth. The index and `backlog.json`
are derived and must never be hand-edited.

## 2. Repository layout

```
<repo>/
  trellis/
    backlog.config.json            # per-repo configuration (§7)
    team.json                      # optional team roster (§7.2)
    active/<ID>.md                 # open items (§5)
    completed/
      tasks/<ID>.md                # finished items, history preserved
      index.md                     # GENERATED list of completed items (§8.1)
    removed/<ID>.md                # abandoned items, archived
    removed/index.md               # GENERATED list of removed items (§8.1)
    README.md                      # GENERATED human index (§8.1)
    backlog.json                   # GENERATED machine index (§8.2)
    assets/effort/                 # optional effort-scale images (§6.3)
```

That is the default, committed layout. With `generatedArtifacts: "local"` (§7,
§8.5) nothing generated is committed: `README.md`, `completed/index.md` and
`removed/index.md` are author-owned, and the generator writes the index and
`backlog.json` to an ignored folder instead:

```
<repo>/
  trellis/
    .generated/                    # GENERATED, git-ignored (§8.5)
      index.md                     #   milestone tables
      completed.md                 #   completed items
      removed.md                   #   removed items
      backlog.json                 #   machine index (§8.2)
```

The **backlog root** defaults to `trellis/` at the repo root and is configurable
per repo via the `tasksDir` key (§7) — a repo whose static-site generator
publishes one directory (e.g. Eleventy over `docs/`) can repoint it elsewhere.
The **config file** is always `trellis/backlog.config.json`, a fixed location
independent of `tasksDir`: tooling must be able to find the config before it
knows where the task tree lives. Above, `tasksDir` is its default (`trellis/`),
so the config and the task tree share one folder. Everything inside an item
file's body is free-form Markdown.

## 3. Identifiers

An id is a configured **prefix** followed by a zero-padded **number** of a
configured width — e.g. with prefix `AB` and width 4, `AB0042`.

- The id MUST match the item's filename (`AB0042` ⇄ `AB0042.md`).
- Ids are assigned monotonically from the `nextId` published in the generated
  `backlog.json` (§8.2); `nextId` is `max(highest-existing + 1, nextIdFloor)` when a
  `nextIdFloor` is configured (§7). In ledger mode (`idAllocation: "ledger"`, §3.1),
  `trellis claim` and the MCP claim path hand out ids instead; the published
  `nextId` stays the scan value. With `generatedArtifacts: "local"` (§8.5) the
  uncommitted `backlog.json` carries the ledger preview in ledger mode, or `null`
  when the ledger ref is missing or unusable.
- An id is permanent and globally unique across all three directories. It MUST
  NOT be reused, even after an item is removed.

### 3.1 Id ledger (optional)

Scan allocation (`nextId`) lets two branches or worktrees read the same highest id
and both claim the next one. A repo can opt into a **local id ledger** with
`"idAllocation": "ledger"` (§7) so every worktree of one clone hands out each id
exactly once. Nothing is pushed: the ledger is local to the clone.

**Format.** The ledger is a git ref (default `refs/trellis/ids`, configurable with
`idLedgerRef`, always under `refs/trellis/`) pointing at a commit on an orphan
history. The tip tree holds exactly one file, `claims.tsv`. Its first line is
`id<TAB>date<TAB>kind<TAB>branch<TAB>title`. Each later line has the same five
fields:

- `id` matches `idPrefix` and `idWidth`;
- `date` is an ISO date;
- `kind` is `seed`, `claim` or `through`;
- `branch` is the worktree's branch, or `-` when detached or for `through`;
- `title` is one line with no tabs or control characters (`-` when unknown) and at
  most 200 characters, counted as Unicode code points. Seeding cuts a longer item
  title at a code-point boundary.

A reader validates every row and treats any bad row as "not a ledger"; it never
skips a row. Lines are only appended, each in one commit whose parent is the
previous tip. Only `claim` lines whose id has no item file are open claims. The
ledger never holds story text.

**Claim.** The next id is `max(highest id in the ledger or in any worktree's task
tree + 1, nextIdFloor)`. The tip moves with a compare-and-swap (`git update-ref`
with the old value), so concurrent claims retry and each id is issued once. An id
above `10^idWidth - 1` fails with no write. Ids are never reused; a claim that is
never written leaves a gap, which is allowed.

**Seed and through.** `trellis claim --seed` creates the ledger with one `seed`
line per id found in any worktree's task tree. `--seed --through <ID>` also records
a `through` line, a high-water mark for ids held on branches that are not checked
out anywhere. `trellis claim --through <ID>` appends one to an existing ledger.
Pause other writers while reserving a range, and check `trellis claim --list` for
claims in that range first: a claim that won the swap earlier may already have
issued one of those ids.

**Scope.** The guarantee holds among writers that use ledger mode with the same
ref and compatible `idPrefix`, `idWidth` and `tasksDir`. Ledger mode needs a plain
prefix (letters and digits) and an `idWidth` of at most 9. Sparse checkouts,
symlinked task folders and a served root that is not the worktree root are refused.
Import is unsupported in ledger mode: import first, then switch and seed. Ledger
operations need git 2.45.1 or later (`rev-parse --show-ref-format` first
appears in 2.45, and 2.45.0 ignores `GIT_NO_LAZY_FETCH`), with the `files` ref format; `check` never runs git.

**Threat model.** The ledger protects id allocation among cooperating writers (CLI and MCP sessions across the worktrees of one clone) against races, crashes and ordinary layout mistakes. It trusts the local filesystem and git configuration of the repository it runs in. It does not defend against a deliberately hostile layout of that repository, such as hard links from generated artifacts into git metadata, symlinked folders aimed into .git, or forged worktree registrations; anyone who can create those can edit the ledger ref directly.

**Cutover.** Upgrade and restart every CLI and MCP writer first, since an older
Trellis ignores `idAllocation` and keeps scanning. Pause scan-mode writers until
every open worktree has merged the ledger config and the seed has run. A lane still
in scan mode can pick an open claim's id until it rebases.

**Recovery.** If the ref is deleted, re-seed with `--through` set to a confirmed
upper bound on every id ever allocated, claims and `through` reservations alike. A
plain re-seed sees only ids that have files and could hand out a lost claim again.

**Concurrency.** The ledger is safe across worktrees. Run one file-writing Trellis
command per worktree at a time, since concurrent regeneration in one worktree is
not serialized.

**`check`.** `check` never reads the ledger: it must not depend on local state
(§8.3), and ids claimed in another clone would arrive above this clone's ledger. The
existing duplicate-id rule still catches collisions.

## 4. Status lifecycle

```
          create
            │
            ▼
        [ active ] ──── ship ────▶ [ completed ]   → completed/tasks/
            │
            └──────── drop ───────▶ [ removed ]     → removed/  (with reason)
```

- There is **no on-hold status.** Park low-priority work as a low-priority
  `active` item, or remove it with a `removed_reason` that names the trigger to
  revisit.
- Transitions are a file **move** plus front-matter edits (§5), made in the same
  change that ships or drops the work, followed by a generator run.
- History is preserved: completing or removing an item moves the file (keeping
  its git history); it is never deleted.

## 5. Item file format

An item file is YAML front-matter delimited by `---`, followed by a Markdown
body.

### 5.1 Front-matter schema

| field | active | completed | removed | rule |
| --- | :-: | :-: | :-: | --- |
| `id` | ✓ | ✓ | ✓ | matches the filename |
| `title` | ✓ | ✓ | ✓ | one line |
| `status` | ✓ | ✓ | ✓ | matches the directory |
| `summary` | ✓ | ✓ | ✓ | one sentence; feeds the README table |
| `milestone` | ✓ | ✓ | ✓ | a configured milestone (§7.1); historical on closed items |
| `priority` | ✓ | ✓ | ✓ | a configured priority (§7); historical on closed items |
| `effort` | ✓ | ✓ | ✓ | a configured effort value (§6); historical on closed items |
| `depends_on` | ✓ | ✓ | ✓ | list of existing ids (`[]` if none) |
| `owner` | ○ | ○ | ○ | a roster handle (§7.2); active → an active member; historical on closed |
| `collaborators` | ○ | ○ | ○ | list of roster handles; active → active members; historical on closed |
| `completed_on` | – | ✓ | – | ISO date (`YYYY-MM-DD`) |
| `removed_on` | – | – | ✓ | ISO date |
| `removed_reason` | – | – | ✓ | one line; why, and any trigger to revisit |

(○ = optional.) `owner` and `collaborators` are optional everywhere and reference
the team roster (§7.2); no item need carry them, and no backfill is required.

On close (completed or removed), the descriptive metadata — `milestone`,
`summary`, `priority`, `effort`, `depends_on` — is carried over from the active
item as a historical snapshot, and the close fields are added (`completed_on`,
or `removed_on`/`removed_reason`). These retained enum values are **historical**:
tooling records them as-was and does not re-validate them against the current
config (§8.3), so milestones and scales can evolve without breaking the archive.
`owner`/`collaborators` are likewise historical on closed items, so a member who
has since gone `inactive` (or left the roster) does not invalidate the archive —
though the stored value must still be a syntactically valid handle (§7.2).

**Closed items from before adoption (optional).** A repo that adopts Trellis in place
may have an archive older than these rules. When the config sets `legacy` (§7), a
completed or removed item **qualifies** when its id is at or below `legacy.through`
and its close date is a real calendar date strictly before `legacy.closedBefore`. A
qualifying item may omit `summary`, `milestone`, `priority` and `effort`. Everything
else is still required: `id`, `title`, `status`, `depends_on` and the close date, and
on a removed item `removed_reason` (it is required only on removed items, as the
table above says). In a repo with `legacy`, a blank value (an empty or whitespace-only
string, quoted or not) in `summary`, `milestone`, `priority` or `effort` counts as
missing on every completed and removed item, so a non-qualifying item with a blank
value there fails as if the field were absent. `removed_reason` keeps its usual rule. A qualifying item may omit or blank `summary`,
but a present, non-blank, falsy value (the number `0`) is still rejected as missing,
as in a repo without `legacy`. Active items are validated as always. A repo without `legacy` is unchanged.

### 5.2 Body

The body is free-form. Recommended sections are **Scope**, **Notes**, and
**Risks** for active items, plus a **Completed** section prepended on closeout
that summarizes what shipped and any follow-ups.

### 5.3 Dependencies

`depends_on` may reference `active` or `completed` ids (every referenced id MUST
exist somewhere), but an item SHOULD NOT be *worked* until its dependencies are
`completed`.

## 6. Effort

`effort` is **relative complexity, not time.** Canonical effort values are a
Fibonacci-like set (default `1, 2, 3, 5, 8, 13, 21`), configurable per repo. The
non-linear gaps are intentional: reaching the top of the scale is the signal to
split an item.

The number is always the stored, canonical value. Teams MAY skin it with a
custom **effort scale** for display.

### 6.1 Effort-scale config

```json
"effort": {
  "values": [1, 2, 3, 5, 8, 13, 21],
  "scale": "fish",
  "scales": {
    "fish": {
      "1":  { "label": "Minnow",    "emoji": "🐟" },
      "2":  { "label": "Goldfish",  "emoji": "🐠" },
      "3":  { "label": "Trout",     "emoji": "🐡" },
      "5":  { "label": "Tuna",      "image": "assets/effort/tuna.svg" },
      "8":  { "label": "Swordfish" },
      "13": { "label": "Shark",     "emoji": "🦈" },
      "21": { "label": "Whale",     "emoji": "🐋" }
    }
  }
}
```

- `values` (required) — the canonical effort set.
- `scales` (optional) — named display scales. Each maps **every** value in
  `values` (string keys) to an entry; a value missing from the active scale is an
  error.
- `scale` (optional) — the active scale name. Absent or `"fibonacci"` selects the
  identity scale (label = the number, no emoji/image).
- Each entry: `label` (required, unique within the scale), `emoji` (optional),
  and `image` (optional, a path relative to the backlog root — `tasksDir`, default
  `trellis/` — so it resolves the same way the artifacts do, and in both
  `generatedArtifacts` modes: it stays relative to `tasksDir`, never to the
  folder holding the generated `backlog.json`). The Tuna/Swordfish
  entries above show the image-only and label-only cases.

### 6.2 Authoring and resolution

- In front-matter, `effort` MAY be the canonical number **or** a case-insensitive
  `label` from the active scale (e.g. `effort: Goldfish`). The generator resolves
  a label to its number; an unresolvable or ambiguous value is an error.
- `backlog.json` ALWAYS carries the resolved canonical number plus the resolved
  `effortLabel`, and `effortEmoji`/`effortImage` when present — so consumers
  render without reading the config. Three cases differ: (1) an identity scale emits
  no display fields; (2) a closed item whose historical `effort` no longer resolves
  keeps its original value and type as written (a retired `8` stays the number 8, a
  retired label stays a string); (3) a qualifying closed item under `legacy` (§5.1)
  whose `effort` is missing or blank has `null` in `backlog.json` and no label,
  emoji or image (§8.2). Under `legacy`, any stored `_effort*` key on a qualifying
  item is cleared; on any other item a stored display key passes through as today.

### 6.3 Rendering

- The generated README shows `label · N` (label and number together) when a
  non-identity scale is active, and just `N` otherwise — keeping the number
  legible for velocity and rollup math.
- `label` doubles as the accessible text/alt for any `image`. SVG or emoji are
  preferred; images are optional and live under `<tasksDir>/assets/effort/`
  (default `trellis/assets/effort/`).
- A qualifying closed item under `legacy` (§5.1) may omit any of `summary`,
  `milestone`, `priority` and `effort`. The completed and removed tables have no
  milestone, priority or effort column, so the Summary cell is empty only when `summary`
  is missing or blank (an item that omits effort but keeps its summary still shows it); the four
  nullable fields belong to the `backlog.json` contract (§8.2).
- The array form `effort: [1, 2, 3, 5, 8, 13, 21]` is shorthand for
  `{ "values": [ … ], "scale": "fibonacci" }` and remains valid.

## 7. Configuration (`backlog.config.json`)

```json
{
  "specVersion": "2.0",
  "idPrefix": "AB",
  "idWidth": 4,
  "milestones": ["Alpha", "Beta", "v1", "Future"],
  "priorities": ["High", "Medium", "Low"],
  "effort": [1, 2, 3, 5, 8, 13, 21]
}
```

| key | meaning |
| --- | --- |
| `specVersion` | the Trellis spec version this repo targets (§9) |
| `idPrefix` | id prefix (e.g. `AB`) |
| `idWidth` | zero-padded digit count, 1 to 100000 |
| `milestones` | ordered milestone names (§7.1) |
| `priorities` | ordered priority names, highest first |
| `effort` | canonical values, or the effort-scale object (§6.1) |
| `tasksDir` | optional backlog-root path, repo-relative; defaults to `trellis/` |
| `idAllocation` | optional; `"scan"` (default) or `"ledger"` (§3.1). Ledger mode requires a plain `idPrefix` (`^[A-Za-z][A-Za-z0-9]*$`) and `idWidth` of at most 9 |
| `idLedgerRef` | optional; the ledger ref, under `refs/trellis/` and valid per `git check-ref-format`; defaults to `refs/trellis/ids` |
| `generatedArtifacts` | optional; `"committed"` (default) or `"local"` (§8.5). Any other value is a validation error |
| `legacy` | optional object with exactly two required keys, `through` and `closedBefore` (below). Requires a plain `idPrefix` (`^[A-Za-z][A-Za-z0-9]*$`) |
| `nextIdFloor` | optional; floors the next organically-assigned id — `nextId` = max(floor, highest+1) — so hand-created tasks begin above a reserved band (must fit `idWidth`) |

`tasksDir` locates the task tree and the generated artifacts; omit it to accept
the `trellis/` default. The config file itself stays at `trellis/backlog.config.json`
regardless (§2) — its location is **not** governed by `tasksDir`, so the spec
example above omits the key.

`legacy` lets a long-lived backlog adopt Trellis in place without inventing history
for closed items that predate it (§5.1). `through` is a full id in the repo's format
(for example `AB0388`): the highest id that existed at adoption. `closedBefore` is a
real calendar date (`YYYY-MM-DD`, so `2026-02-31` is an error), exclusive: the
adoption date, the day of the commit that adds `legacy`. Any other key, a `null`
value or a non-object is a config error. Set both once, at adoption: any item closed
on or after `closedBefore`, including same-day closures before the cutover, must
carry the full snapshot, and setting `closedBefore` to the next day reopens that
same-day gap. Raising `through` to silence new errors defeats the rule. The plain
`idPrefix` requirement keeps the id scan unambiguous: a prefix such as `T.P` or `T+P`
would be read as pattern syntax.

`nextIdFloor` reserves the low id range: when set, the next organically-assigned id
is `max(nextIdFloor, highest-existing + 1)`, so newly created tasks begin above a
reserved band (e.g. one populated by an import) while ids within the band remain
available. Absent, the next id is the historical `highest + 1`.

**Configurable** per repo: everything in the table above, including the backlog
root via `tasksDir`. **Fixed** by the spec: the `trellis/backlog.config.json`
config location, the in-root layout (`active/`, `completed/tasks/`, `removed/`,
and the generated artifacts under `tasksDir`), the status lifecycle, the
front-matter schema, the generated-artifact contracts, and the meaning of each
field.

### 7.1 Milestones are a maturity axis

A milestone names the **release gate** an item must land in — and nothing else.
It is a single, ordered axis (e.g. `Alpha → Beta → v1 → Future`). A milestone is
**not** a feature area (that is the title), **not** a priority (its own field),
and **not** an on-hold state (§4). Milestone *names* are configured; the
single-axis, ordered semantics are fixed.

### 7.2 Team roster (`team.json`)

The optional **team roster** records who can own work. It is a separate authored
file, `team.json`, at the fixed config home (`trellis/team.json`, next to
`backlog.config.json` and independent of `tasksDir`) — kept apart from the config so
the core vocabulary stays stable while the roster (richer, faster-changing) evolves
on its own.

```json
{
  "members": [
    { "handle": "ada",  "name": "Ada Lovelace", "email": "ada@example.com", "status": "active" },
    { "handle": "alan", "name": "Alan Turing",  "status": "inactive" }
  ]
}
```

- `members` (required) — the list of people. The object wrapper leaves room for
  additive top-level keys in future minor versions.
- `handle` (required) — the stable key referenced by `owner`/`collaborators` in
  front-matter (§5.1). Constrained to `[A-Za-z0-9._-]` (so it survives the inline
  serialization of `collaborators`) and unique, case-insensitively.
- `name` (required) and `email` (optional) are **display only**.
- `status` — `active` or `inactive` (default `active`). Only **active** members may
  own or collaborate on **active** items; closed items keep historical assignees
  (§8.3), so a member can go `inactive` or leave without breaking the archive.

The roster is **optional**: an absent `team.json` is an empty roster, so a repo that
never assigns owners is unaffected. A present-but-malformed roster (bad JSON,
duplicate handle, bad `handle`/`status`, unknown member key) is a validation error
(§8.3). `handle` is the only identity contract — names/emails are not coupled to any
external identity provider; cross-repo identity is left to future work.

## 8. Generated artifacts

These are derived from the item files and config on every generator run. They
MUST be deterministic — identical inputs produce byte-identical output, with no
timestamps or other volatile fields — so that `--check` (§8.3) is stable in CI.
Reports derived from a source *outside* the item files that is inherently volatile
(e.g. git history) are a separate, **non-gated** class — see §8.4.

### 8.1 `README.md`

A human index. Item tables are emitted between the markers
`<!-- BEGIN GENERATED:MILESTONES -->` and `<!-- END GENERATED:MILESTONES -->`;
content outside the markers is author-owned and preserved. Active items are
grouped by milestone (config order) and sorted by priority then id. The next id
is not published here — `backlog.json` carries it (§8.2). Text between the markers
MUST NOT be hand-edited.

The completed and removed indexes (`completed/index.md`, `removed/index.md`) are
generated the same way, each between its own `BEGIN/END GENERATED` markers, as a
table that includes the item's **summary** — completed: id, title, summary, date;
removed: id, title, summary, date, reason. Closing or removing an item is a file
move plus a generator run; index rows are never hand-added.

In `generatedArtifacts: "local"` mode none of this applies: these three files are
author-owned and the generator never writes them (§8.5).

### 8.2 `backlog.json`

The machine contract consumers build on:

```json
{
  "prefix": "AB",
  "milestones": ["Alpha", "Beta", "v1", "Future"],
  "nextId": "AB0016",
  "counts": { "active": 14, "completed": 1, "removed": 0 },
  "tasks": [
    {
      "id": "AB0042", "title": "…", "status": "active",
      "milestone": "Beta", "priority": "High",
      "effort": 5, "effortLabel": "Tuna", "effortImage": "assets/effort/tuna.svg",
      "depends_on": ["AB0007"], "owner": "ada", "collaborators": ["alan"], "summary": "…"
    }
  ]
}
```

Every entry carries the descriptive metadata (`milestone`, `summary`,
`priority`, `effort`, `depends_on`) plus `owner` (a roster handle or `null`) and
`collaborators` (handles, `[]` if none) — historical on closed entries. Completed
entries add `completed_on`; removed entries add `removed_on` and `removed_reason`.
Effort label/emoji/image fields appear when a scale is active.

Under `legacy` (§5.1), `milestone`, `summary`, `priority` and `effort` are nullable on
a qualifying closed entry: a missing or blank value is `null`, `effort` included, and
the effort label, emoji and image fields are omitted when `effort` is missing.

### 8.3 Tooling contract

A conforming generator MUST:

1. **Validate** every item against the schema (§5), config (§7), and roster (§7.2)
   with actionable messages: id/filename match, required fields, enum membership,
   effort resolution, unique ids, `depends_on` referential integrity, and
   owner/collaborator roster membership. Enum membership (milestone/priority/effort)
   and roster **membership** (owner/collaborators must be **active** members) are
   enforced for **active** items only; on completed/removed items these values are
   historical and MUST NOT fail validation if they are no longer in the current
   config or roster (a mismatch MAY warn). `owner`/`collaborators` MUST nonetheless
   be syntactically valid handles (§7.2) on **every** item — the closed-item
   exemption is from membership, not from being a handle. A malformed `team.json` is
   a validation error regardless. With `legacy` (§5.1, §7), a qualifying closed item
   MAY omit the four descriptive fields, a blank value in one of those four counts as
   missing on every closed item (a present, non-blank, falsy `summary` such as the
   number `0` is still rejected as missing, as without `legacy`), and a close date that is well-shaped but not a real calendar date is
   an error on any completed or removed item.
2. **Regenerate** deterministically. In committed mode (the default) that is
   `README.md` and the completed/removed indexes (each between its markers) and
   `backlog.json`. With `generatedArtifacts: "local"` (§8.5) it writes only the
   four files under `.generated/`; `README.md` and the index files are
   author-owned and are never written.
3. Support a **`--check`** mode that validates and verifies the artifacts are
   current **without writing**, exiting non-zero on any error or drift. This is
   the CI gate. With `generatedArtifacts: "local"` (§8.5) `--check` validates
   (item 1), scans for leftover generated markers, and compares no generated file,
   since none is committed.
4. **Warn** when `specVersion` is absent or its major version differs from the
   spec version the generator implements (§9).

### 8.4 Derived, non-gated reports

Not every useful derivation belongs to the gated, deterministic set above. A
**derived report** is computed from a source *outside* the item files — typically
volatile (commit timestamps, author names) — so it cannot be byte-identical across
runs and is therefore handled separately from §8.1–§8.3. Such reports:

- are **regenerable** and **not authoritative** — the upstream source is (for a
  git-derived report, git itself);
- are produced **on demand or at build time** (e.g. a CI step before a static-site
  deploy), **not** by the generator on every edit;
- SHOULD NOT be committed; a repo that does commit one MUST mark it generated (e.g.
  a top-level `"generated": true`) and keep it out of `--check`.

A conforming generator's **`--check` MUST NOT depend on git history** or any other
volatile source. Derived reports are **optional** and do not affect conformance
(§11).

**`history.json`** is the reference derived report: a per-repo change log keyed by
task id, materialized for a viewer with no git runtime at serve time. It lives under
the backlog root (`<tasksDir>/history.json`) when materialized. Each id maps to a
list of entries `{ id, commit, date, author, subject, reason }`, newest-first,
reconstructed with `git log --follow` over the task file so history survives the
active→completed move. `reason` is the value of a `Trellis-Reason:` commit trailer
when present, otherwise the commit subject. An item imported into a repo carries
history from its import commit forward; a single-commit or empty history is valid,
not an error.

### 8.5 Local generated artifacts (`generatedArtifacts: "local"`)

By default the generated files are committed, so every branch that adds, edits or
closes an item rewrites them and parallel branches conflict on them. A repo can opt
out with `"generatedArtifacts": "local"` (§7). The generator then writes every
artifact under `<tasksDir>/.generated/` and nothing generated is committed:

| file | content |
| --- | --- |
| `.generated/index.md` | the milestone tables (§8.1), as a whole file |
| `.generated/completed.md` | the completed table |
| `.generated/removed.md` | the removed table |
| `.generated/backlog.json` | the machine index (§8.2), unchanged in shape |

- Each Markdown file is wholly generated: it has no markers and no author-owned
  text, and it is a pure function of the items. Its links resolve from
  `.generated/` (for example `../active/<ID>.md`).
- `<tasksDir>/README.md`, `completed/index.md` and `removed/index.md` are
  **author-owned**. The generator and scaffolder never write them. A leftover
  generated marker comment (§8.1) on a line of its own in any of them is a
  validation error, which catches a half-finished switch from committed mode.
  Prose that merely mentions a marker is fine.
- **`.generated/` must be ignored by git.** Tooling does not edit `.gitignore`.
  Every tool that writes the folder checks, inside a git work tree, that each of
  the four outputs is ignored and untracked, and refuses before writing otherwise,
  printing the line to add (`<tasksDir>/.generated/`, with gitignore
  metacharacters escaped). Outside a work tree, or without git, that check is
  skipped; any other failure to inspect the repo is a refusal. `--check` never
  runs git.
- **ASCII backlog root.** In local mode `tasksDir` must be ASCII (a config error
  otherwise), so no Unicode filesystem alias can hide an output from git's ignore check.
- **`--check`** validates config, roster and items (§8.3 item 1), runs the marker
  scan above, and compares no generated file. It remains the required CI gate
  (§10), and it passes with no `.generated/` folder present.
- **`nextId`.** `.generated/backlog.json` is uncommitted and may differ between
  clones: in ledger mode (§3.1) it holds the ledger preview, and `null` when the
  ref is missing or unusable. This is the one exception to §8's rule that output
  depends only on items and config. CI never reads it.
- **What is given up.** The committed README tables and the committed
  `backlog.json` no longer exist, so a forge file view shows no index, and a
  consumer that read `backlog.json` from the default branch must run `trellis
  generate` first, or use the MCP `list_tasks` tool.
- **Nulls.** `.generated/backlog.json` carries the same nulls and omissions for
  qualifying closed items under `legacy` (§8.2), and the generated tables an
  empty Summary cell only where `summary` is missing or blank.
- **Migration.** `trellis init --switch-to-local` moves a committed-mode repo over:
  it strips the generated blocks from `README.md` and the index files, sets the
  config, and prints the `git rm` commands for the legacy generated files. It never
  stages, commits or edits `.gitignore`.

## 9. Versioning and compatibility

This spec uses SemVer. A repo declares the version it targets via `specVersion`
(`major.minor`). Within a major version, changes are additive and backward
compatible; a major bump may change required fields or artifact shape. Tooling
warns on a major mismatch between `specVersion` and the implemented spec.

**2.5** (additive): the optional `idAllocation` and `idLedgerRef` config keys and
the local id ledger (§3.1), and the optional `generatedArtifacts` config key with
local generated artifacts (§8.5), and the optional `legacy` config key, which lets
closed items from before adoption omit the descriptive metadata (§5.1). Repos that
omit them behave as in 2.4. One compatibility exception: the generator now inserts
table text literally. The old scan-mode replacement string expanded `$$` (to `$`),
`$&`, `` $` `` and `$'` (the old pattern had no capture groups, so `$1` stayed
literal). A committed scan-mode index built from a title holding one of those held
corrupt bytes, so it may now fail `check` until regenerated, even without `legacy`.
Upgrading repos rerun `trellis generate`. If an old `$&`, `` $` `` or `$'` expansion
nested a second generated marker pair inside the block, first restore one clean
marker pair, keeping the authored text, and then rerun `trellis generate`.
2.5 ships in package release 0.3.0.

## 10. CI and branch protection

Conformant repositories MUST gate the default branch so the index cannot drift:

- The default branch is **protected**; changes land via pull/merge request.
- The generator's **`--check` is a required status check** that must pass before
  merge. With `generatedArtifacts: "local"` (§8.5) it verifies validity and the
  marker scan only, since no generated file is committed to drift.

This is forge-agnostic — GitHub branch protection, GitLab merge-request
pipelines, Bitbucket, or Azure DevOps all satisfy it. Setup specifics are left to
the consumer's onboarding tooling, which SHOULD provide a forge-appropriate setup
recipe.

Where a forge identifies the required check by name (e.g. a GitHub Actions job
name), keeping that name stable and pinned — and updating the protection rule in
lockstep if it ever changes — keeps a workflow or job rename from silently
dropping the gate. This is operational guidance for keeping the required check
effective, not an additional conformance requirement.

## 11. Conformance

A repository is **Trellis-conformant** at `specVersion` *X* if its items follow
§3–§6, its `backlog.config.json` follows §7, its generated artifacts follow §8
(the four committed files in `committed` mode, or the four files under
`.generated/` of §8.5 in `local` mode), and its default branch is gated per §10. A **tool** is conformant if it
implements the generator contract (§8.3) for that version.
