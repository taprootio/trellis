# Importing an existing backlog

Trellis can import a backlog that already exists on a *foreign* schema — a folder
of Markdown files with their own front-matter, bold-inline metadata, or header
lines — and convert it into conformant Trellis items. The conversion is driven by
a declarative **mapping**; a reusable, named mapping is a **profile**.

This guide has two parts: [onboarding a repo that already has a
backlog](#onboard-a-repo-that-already-has-a-backlog), and the [mapping/profile
schema reference](#the-mapping-schema).

## Onboard a repo that already has a backlog

### One command: `init --import`

If the repo is not yet a Trellis backlog, scaffold and import in one step:

```
npx trellis init --import planning/old-backlog --profile yaml-frontmatter
```

This scaffolds the Trellis layout (config, `trellis/` tree, generated indexes, CI
check, AGENTS block, playbooks), then imports the backlog at the given path. A
relative `<path>` resolves against the repo being onboarded. Add `--dry-run` to
preview the scaffold without writing; to preview the import plan itself (counts, id
map, warnings), run `trellis import --dry-run` once the repo is initialized.

Use `--mapping <file.json>` instead of `--profile <name>` to supply your own
mapping. Provide exactly one of the two.

### Two steps: `init`, then `import`

If the repo is already initialized (or you want to import again later), run the
importer on its own. It is **dry-run by default** — it prints the plan, the id
map, and per-field warnings without writing — so you can review before committing
to a write:

```
npx trellis import planning/old-backlog --profile yaml-frontmatter            # preview
npx trellis import planning/old-backlog --profile yaml-frontmatter --apply    # write
```

`trellis import --list-profiles` lists the built-in profiles. The target defaults
to `.`; pass `--target <dir>` to import into another repo.

### Over MCP

The same operation is exposed as the MCP `import` tool, so an MCP-aware client can
onboard a backlog without a shell. It takes `source`, exactly one of `profile` or
`mapping` (an inline mapping object), and an optional `apply` flag. Like the CLI it
is **dry-run unless `apply: true`**, and it regenerates and **rolls back on any
failure**, so a refused import leaves the target exactly as it was.

### What the importer guarantees

- **The source tree is read-only** — items are copied out, never moved or deleted.
- **Ids are assigned fresh-sequentially** from the target's next id, so an import
  is safe even into a non-empty backlog. Colliding source ids are deduped by
  construction, and every `depends_on` is rewritten through the id map. A
  dependency on a collided (ambiguous) or unknown source id is a hard error.
- **A real run leaves the backlog `--check`-green**, or rolls back to the
  pre-import state if anything fails.

### Add the adoption tracker after import

When onboarding a repo that already has a backlog, import the legacy backlog
before creating any new Trellis task for the adoption work itself. Trellis assigns
imported ids from the target's current `nextId`, so an early "Adopt Trellis" item
would consume the first id and shift every imported task up by one. Import first,
review the id map, then create and work the adoption tracker at the next id.

### After adopting: reconcile guidance, then retire the source

Importing copies items into Trellis but leaves two things for you to finish the
adoption — both deliberately **report-first**, so nothing author-written is lost.

**Reconcile stale guidance.** Every `trellis init` run scans a small set of root
guidance files (`AGENTS.md`, `AI_GUIDELINES.md`, `CLAUDE.md`) for pre-Trellis backlog
instructions — an "AI Backlog" section, a reference to the old backlog path — and
prints them as a `reconcile` checklist:

```
  reconcile (1) — pre-Trellis backlog guidance to rewrite by hand (init left these untouched):
    - AI_GUIDELINES.md: has a "AI Backlog" section that looks like pre-Trellis backlog guidance — rewrite it to point at trellis/
```

`init` **only ever reports** here — it appends its own marked block and never edits or
deletes your prose. The surgical rewrite (point the section at `trellis/`, drop the old
field names) is the onboarding agent's job; the checklist just says where to look. The
scan skips Trellis's own appended block and any section that already points at the new
root, so it won't flag guidance you've already migrated.

**Retire the old source tree.** The importer never touches the source, so after you have
imported, **reviewed, and committed** the result, the legacy tree is still on disk. Once
you're satisfied, retire it history-preservingly:

```
npx trellis init --retire-source planning/old-backlog --dry-run   # list what would go
npx trellis init --retire-source planning/old-backlog             # stage the removal
```

This runs `git rm -r` on the path — git keeps the files' history — and **stages** the
deletion for you to review (`git status`) and commit. It does not scaffold, import, or
commit, and it **cannot be combined with `--import`**: retirement is a separate, later
step so the source is intact if an import ever rolls back. The path must be inside the
repo and already tracked by git (commit the import first).

## The mapping schema

A mapping is a JSON object. A profile is the same object shipped under
[`profiles/`](../profiles) and addressed by name; an optional top-level
`description` documents it and is ignored by the engine. The worked examples below
are the two built-in profiles:
[`taproot-ai-backlog`](../profiles/taproot-ai-backlog.json) (bold-inline + header
style) and [`yaml-frontmatter`](../profiles/yaml-frontmatter.json) (full YAML
front-matter).

```json
{
  "description": "optional, human-only",
  "sources": {
    "active":    { "dirs": ["active"],    "file": "*.md" },
    "completed": { "dirs": ["completed"], "file": "*.md" },
    "removed":   { "dirs": ["removed"],   "file": "*.md" }
  },
  "fields": {
    "title":      { "from": "h1" },
    "priority":   { "from": "inline", "label": "Priority" },
    "milestone":  { "from": "inline", "label": "Milestone" },
    "effort":     { "from": "inline", "label": "Effort", "fallback": { "from": "inline", "label": "Size" } },
    "owner":      { "from": "inline", "label": "Owner" }
  },
  "remap":    { "priority": { "P1": "High" }, "milestone": { "Pre-Launch": "Alpha" }, "effort": { "S": 1, "M": 3, "L": 8 }, "owner": { "Jane Doe": "jane" } },
  "defaults": { "milestone": "Alpha", "priority": "Low", "effort": 1 },
  "summary":  { "strategy": "firstSentence" }
}
```

### `sources` (required)

One entry per source **status** — at least one of `active`, `completed`,
`removed`. Each has `dirs` (a non-empty list of source-relative directories; no
absolute paths or `..` segments) and an optional `file` glob (default `*.md`,
`*`-only). An item's status is determined by **which source directory it is in** —
see [the directory caveat](#caveats).

### `fields` (required)

How to locate each field on a source item. Recognized fields: `id`, `title`,
`priority`, `effort`, `milestone`, `summary`, `depends_on`, `owner`,
`collaborators`, `completed_on`, `removed_on`, `removed_reason`. Each maps to an
**extractor**:

| extractor | reads |
| --- | --- |
| `{ "from": "yaml", "key": "k" }` | front-matter key `k` |
| `{ "from": "inline", "label": "L" }` | a bold metadata line `**L:** value` |
| `{ "from": "header", "label": "L" }` | a header line `L: value` |
| `{ "from": "h1" }` | the first `# Heading` |
| `{ "from": "filename", "pattern": "^(\\d+)" }` | the filename (no extension); `pattern`'s first capture group if given |
| `{ "from": "const", "value": "v" }` | the literal `v` |

Any extractor may carry a `"fallback": { … }` extractor, tried when the primary
yields nothing (e.g. `completed_on` from a `Completed:` line, falling back to
`Created:`). Defaults: `id` → filename, `title` → `h1`. `summary` is
[synthesized](#how-fields-are-resolved) when absent. `owner` is a single roster
handle; `collaborators` is a list (an inline `[a, b]`, a `-` block, or a
comma/semicolon-separated value), resolved the same way as `owner`.

The `title` field accepts one extra option, `"stripIdPrefix": true`: when the
resolved title begins with the item's **own** source id followed by a separator —
whitespace, optionally around a single `. : - – —` — that leading token is dropped,
so a foreign `# 001 README Truth Pass` (source id `001`) imports as `README Truth
Pass`. The cleaned title also heads the rebuilt body. It is matched **exactly**
against the source id and only when a real whitespace break follows, so id `04` never
bites into a `047 …` title, an unbroken `001README` is left intact, and a genuinely
number-leading title (`2024 Roadmap` under a different id) is untouched. Off by
default; the [`taproot-ai-backlog`](../profiles/taproot-ai-backlog.json) profile
(numeric-prefix filenames) sets it on.

### `remap` (optional)

Resolve foreign values to the target's configured vocabulary, by field
(`priority`, `milestone`, `effort`, `owner`). Keys are matched case-insensitively. A
milestone that mixes maturity gates with feature areas (which the spec disallows — see
SPEC §7.1) **must** be remapped to a single maturity axis; an unmapped value on an
active item is a hard error, never a silent guess. `remap.owner` maps a source assignee
(e.g. a display name or legacy username) to a roster `handle` (SPEC §7.2) and applies
to **both** `owner` and `collaborators` — they share one identity space. `remap.effort`
maps a foreign size token (`S`/`M`/`L`, or an off-scale number) to a canonical effort
value (SPEC §6); paired with an `effort` extractor that falls back to a `Size:` label,
that is how a legacy `**Size:**` field becomes Trellis effort.

### `defaults` (optional)

Fill a field when the source has no value for it — chiefly the historical
descriptive metadata (`milestone`, `priority`, `effort`, and `removed_reason`)
that header-style legacy closed items lack but the schema still requires on
completed/removed items (SPEC §5.1). A defaulted value is treated like an
extracted one. `defaults.owner` is the fallback owner for **active** items whose
source owner doesn't resolve to an active roster member (closed items keep their
historical owner instead). `defaults.completed_on` / `defaults.removed_on` are an
optional **floor** for a close date with no header that git can't recover (see
[Import-time git and provenance](#import-time-git-and-provenance)); a defaulted close
date is flagged in the import summary.

### `summary` (optional)

`{ "strategy": "firstSentence" }` (default) synthesizes a missing summary from the
first prose sentence, skipping headings and metadata-shaped lines; `"title"` uses
the title.

### How fields are resolved

- **Active items** are validated in full against the target config: priority,
  milestone, and effort must resolve, or the import is refused with an actionable
  error.
- **Closed items** (completed/removed) keep their enum values as a *historical*
  snapshot — those are not re-validated against the current config (SPEC §5.1,
  §8.3) — but the metadata must be **present** (from the source or `defaults`).
- **Close dates** (`completed_on`/`removed_on`) resolve through a fallback chain when
  the field is **absent**: the date header/field → the source file's **last git commit
  date** (read at import time from the *source* repo) → an optional `defaults.<field>`
  floor → a hard error. A field that is **present but malformed** (e.g. an impossible
  `2024-02-31`) is refused outright — never papered over by git or a floor. A
  git-derived or defaulted date is flagged, never silently passed as authored — see
  [Import-time git and provenance](#import-time-git-and-provenance).
- **Owners and collaborators** resolve against the target's `team.json` roster
  (SPEC §7.2). On an **active** item the resolution chain is: `remap.owner` (or a
  direct case-insensitive handle match) → `defaults.owner` → **unassigned, with a
  warning** — an owner that resolves to no active member is dropped, never invented.
  An unresolved collaborator is likewise dropped with a warning. On a **closed**
  item the value is historical: a member who has since gone inactive keeps their
  canonical handle; a handle absent from the roster is kept (after `remap.owner`) only
  if it is a valid handle — a former member — and otherwise dropped with a warning, so
  a non-handle value can never corrupt the stored item. Carrying owners therefore requires the target
  repo to have a `team.json` (with no roster, every owner drops or carries as
  above); curating the roster can stay a manual post-import step.

### Import-time git and provenance

Some legacy backlogs don't record everything the schema needs — most commonly a
closed item with no date header, or an item whose effort lives under a `Size:` label
or isn't recorded at all. The importer fills these as faithfully as it can and
**reports what it inferred**, so nothing passes as authored history:

- **Git is read at import time only.** When a close date has no header, the importer
  reads the source file's last commit date from the *source* repo's git. This is the
  one-time importer's privilege; the deterministic generator and `--check` never read
  git (SPEC §8.4), so the gate stays reproducible.
- **It degrades, never fails on git alone.** Missing git, a non-repo or shallow
  source, or an uncommitted file all make the lookup return nothing — the chain then
  falls to a `defaults.<field>` floor if configured, and only errors if neither git
  nor a floor yields a date. The importer never invents a close date out of nothing.
- **Inferred values are flagged.** A git-derived or floor-defaulted close date, and a
  **closed** item whose effort fell back to `defaults.effort` (no `Effort:`/`Size:`
  signal), each emit a per-item warning and increment a count in the import summary
  (`N git-dated, M effort-estimated`). Provenance lives in that report — reviewed
  before `--apply` — not in a new front-matter field: volatile git-derived data stays
  out of the gated item files (SPEC §8.4). A higher-quality per-item effort estimate
  is a job for the onboarding agent, not the dependency-free importer.

### Caveats

- **Remap targets are the *target* repo's vocabulary.** The built-in profiles map
  to the default Trellis vocabulary (`Alpha → Beta → v1 → Future`, `High`/`Medium`/
  `Low`, Fibonacci effort). If your target repo configures a different vocabulary,
  edit the profile's `remap` (and `defaults`) to match it.
- **Status comes from the source *directory*, not a per-item field.** The engine
  routes items by which `sources.{active,completed,removed}.dirs` directory they
  live in. A source that keeps everything in one folder with a `Status:` field is
  not directly importable today; split it into per-status directories first, or
  point each status at the directory that holds those items.
