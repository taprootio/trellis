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
npx @taprootio/trellis init --import planning/old-backlog --profile yaml-frontmatter
```

This scaffolds the Trellis layout (config, `trellis/` tree, generated indexes, CI
check, AGENTS block, playbooks), then imports the backlog at the given path. A
relative `<path>` resolves against the repo being onboarded. Add `--dry-run` to
preview the scaffold without writing; to preview the import plan itself (counts,
id map, warnings), run `trellis import --dry-run` once the repo is initialized.

Use `--mapping <file.json>` instead of `--profile <name>` to supply your own
mapping. Provide exactly one of the two.

### Two steps: `init`, then `import`

If the repo is already initialized (or you want to import again later), run the
importer on its own. It is **dry-run by default** — it prints the plan, the id
map, and per-field warnings without writing — so you can review before committing
to a write:

```
npx @taprootio/trellis import planning/old-backlog --profile yaml-frontmatter            # preview
npx @taprootio/trellis import planning/old-backlog --profile yaml-frontmatter --apply    # write
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
- **Ids are assigned fresh-sequentially** from the target's next id by default (with
  `--preserve-ids`, sound source ids are kept — see below), so an import is safe even
  into a non-empty backlog. Colliding source ids are deduped by construction, and every
  `depends_on` is rewritten through the id map. A dependency on a collided (ambiguous)
  or unknown source id is a hard error.
- **A real run leaves the backlog `--check`-green**, or rolls back to the
  pre-import state if anything fails.

### Adopt a Trellis-shaped backlog in place (`legacy`)

A backlog that is already Trellis-shaped but older than the closed-item rules (its
archive omits `summary`, `milestone`, `priority` or `effort`) is adopted in place, not
imported. Set the optional `legacy` cutoff (SPEC §5.1, §7) so items from before
adoption may omit those fields, while new closures stay strict. `legacy` covers this
in-place onboarding only: it does not relax the milestone, priority and effort
requirement on a source item for any import profile, including `trellis`. A target
that has `legacy` is read under its rules, so its qualifying blank items do not block
an import.

1. Write `legacy` into `trellis/backlog.config.json` first: `through` is the highest
   id that exists today and `closedBefore` is today's date (the adoption date,
   exclusive). `init` cannot create `legacy` itself. It validates the archive with the
   config it keeps, so a repo with no config must hand-author the full config
   (`idPrefix`, `idWidth`, `milestones`, `priorities`, `effort`, `legacy`) before it
   runs `init`; with no config, init validates against the strict defaults. The
   `idPrefix` must be a plain prefix (a letter, then letters or digits). When the
   backlog lives outside `trellis/`, set `tasksDir` in that config too; the config
   file itself stays at `trellis/backlog.config.json`. Otherwise `init` can succeed
   against an empty default tree.
2. Add `depends_on: []` to any item that lacks it: it stays required.
3. Run `npx @taprootio/trellis init` **without** `--force`. `init --force` is refused
   (exit 2, nothing written) once the config has `legacy`, because the replacement
   config would drop it. Rerun the same command without `--force`,
   keeping `--retire-source` or `--import`: when scaffolding, `--force` would drop
   `legacy`; with `--retire-source`, `--force` has no use, since that step only stages
   the removal of the source. Without `--force`, `init`
   refreshes stale generated sections and creates missing scaffold files in committed
   mode; do not delete an existing README or index, which can lose authored text. In
   local mode it writes `.generated/` and does not create the README or index files,
   which are author-owned. `trellis/backlog.config.json` must stay. In committed mode, a backlog-root
   `README.md`, `completed/index.md` or `removed/index.md` that has no generated
   markers still fails ordinary `init` after `legacy` is added: add the correct marker
   pair and keep the authored text outside it, or move the file aside first.
4. Run `npx @taprootio/trellis check`.

To adopt in local generated-artifacts mode (SPEC §8.5), follow [Switch a Trellis
backlog to local generated artifacts](#switch-a-trellis-backlog-to-local-generated-artifacts)
with `legacy` already in the config. A repo migrating from committed mode sets `legacy`
and commits that config change before `init --switch-to-local`, which refuses a config
with uncommitted changes; this applies only to switches that rewrite the config. A new
config that is already local at the current spec version is kept as it is. First-time
local adopters write `generatedArtifacts: "local"` and `specVersion: "2.5"` in the
hand-authored config, so a new untracked config is not rewritten and refused: the
switch rewrites a committed-mode config or one that declares an older `specVersion`,
and an already-local config with no `specVersion` is kept as written. Local adopters
run `init --switch-to-local` and the removal commands it prints before ordinary `init`.

### Not in ledger mode

Import is unsupported when the target's `idAllocation` is `"ledger"` (SPEC §3.1).
`trellis import` (preview and `--apply`), the MCP `import` tool, `init --import` and
plain `init --force` all refuse before any write: the CLI exits 2 and the MCP tool
returns an error with the same guidance. The importer assigns ids from a scan, and in a
ledger-mode backlog that could pick an id that is an open claim. Import first, in scan
mode, then switch `idAllocation` to `"ledger"` and run `trellis claim --seed`.

### Preserve source ids (`--preserve-ids`)

By default an import assigns fresh ids. With `--preserve-ids`, an item **keeps its own
id** when it matches the target format exactly (`<idPrefix><idWidth digits>`) and is
still free — so a same-prefix migration (a repo already Trellis-shaped, or one sharing
the target's prefix) keeps its identities. Anything that can't keep its id — a
collision (two sources claim one id: the first keeps it, the rest are reassigned) or a
mismatched prefix/width — is reassigned into the **gap just above the imported range**,
and every remap is reported.

A configured **`nextIdFloor`** (SPEC §7) is recorded in `backlog.config.json` so the
next *organically-created* id begins above the imported band: `nextId` becomes
`max(floor, highest+1)`. The floor is auto-derived to the next multiple of 1000 above
the band, or set explicitly with `--id-floor <N>`; the gap between the imported max and
the floor is deliberate room to resolve collisions.

`depends_on` is rewritten either way. Body **prose** is copied verbatim, so when an id
changes the importer **warns** for any item whose text still names the old id — fix
those by hand (the importer never rewrites prose).

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
npx @taprootio/trellis init --retire-source planning/old-backlog --dry-run   # list what would go
npx @taprootio/trellis init --retire-source planning/old-backlog             # stage the removal
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
are the three built-in profiles:
[`taproot-ai-backlog`](../profiles/taproot-ai-backlog.json) (a historical bold-inline +
header-style reference), [`yaml-frontmatter`](../profiles/yaml-frontmatter.json) (full
YAML front-matter under flat `active/`, `completed/`, `removed/`), and
[`trellis`](../profiles/trellis.json) (a **Trellis-shaped** backlog — YAML front-matter
under `active/`, `completed/tasks/`, `removed/` — for adopting, splitting, or merging
Trellis repos). Source discovery skips the generator's own `index.md` / `README.md`
artifacts, so importing a Trellis-shaped tree never picks up a generated index as a
task.

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

### Local generated artifacts

An import into a repo with `generatedArtifacts: "local"` (SPEC §8.5) works in scan
mode only, like any import. It writes the items and `.generated/`, never the
committed README or index files, and it refuses, before writing, when one of those
files still holds a generated marker line. It needs only a loadable config and
roster, since the index files are optional there.

### Import-time git and provenance

Some legacy backlogs don't record everything the schema needs — most commonly a
closed item with no date header, or an item whose effort lives under a `Size:` label
or isn't recorded at all. The importer fills these as faithfully as it can and
**reports what it inferred**, so nothing passes as authored history:

- **Git is read here only for the source-date lookup.** When a close date has no
  header, the importer reads the source file's last commit date from the *source*
  repo's git. This is the one-time importer's privilege; `--check` is git-free
  (SPEC §8.3), so the gate stays reproducible.
- **It degrades, never fails on git alone, for the source-date lookup.** Missing git, a non-repo or shallow
  source, or an uncommitted file all make the lookup return nothing — the chain then
  falls to a `defaults.<field>` floor if configured, and only errors if neither git
  nor a floor yields a date. The importer never invents a close date out of nothing.
  This applies only to that lookup. The generator stays git-free for `check`, but in
  `generatedArtifacts: "local"` mode generation and an applied import inspect the
  *target* repo with git (to confirm the generated folder is ignored and untracked)
  and refuse, writing nothing, when that inspection fails for any reason other than
  git being absent or the target being outside a work tree.
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

## Switch a Trellis backlog to local generated artifacts

A repo that commits its generated index and `backlog.json` can stop doing so
(`generatedArtifacts: "local"`, SPEC §8.5). The generated files then live in the
ignored `<tasksDir>/.generated/` folder and parallel branches stop conflicting on
them. The migration is five steps, in this order:

1. Add the ignore line to `.gitignore` (the switch prints the exact line when it is
   missing, escaped for the repo's `tasksDir`): `trellis/.generated/` by default.
2. Run `npx @taprootio/trellis init --switch-to-local` (add `--dry-run` to preview).
   It sets `generatedArtifacts` to `"local"` and raises `specVersion` to 2.5, strips
   the generated block and markers from `README.md` and from index files that hold
   authored text, and updates the AGENTS.md bullet when it is still Trellis's own
   text. It runs before ordinary init, so its checks see a tracked `.generated/`
   file before init could overwrite it. It never prompts, stages, commits or edits
   `.gitignore`. Index files that hold nothing but a generated block are left
   exactly as they are and reported.
3. Run the `git -C '<repo root>' --literal-pathspecs rm -- '<path>'` commands it prints. They delete
   the untouched generated-only index files and the legacy `backlog.json`.
4. Run `npx @taprootio/trellis init`, without `--force` (init refuses `--force` on a
   local repo). It creates nothing under the README or index paths.
5. Run `npx @taprootio/trellis generate`, then `npx @taprootio/trellis check`.

The switch refuses, changing nothing, when an output path is not ignored, a file it
would edit or remove is a symlink or has uncommitted changes, a marker is unpaired,
sits inline, repeats or belongs to another file, anything under `.generated/` is
tracked, or an untracked `backlog.json` exists. A rerun after a finished switch
changes nothing.
