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
preview both steps without writing anything.

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
    "milestone":  { "from": "inline", "label": "Milestone" }
  },
  "remap":    { "priority": { "P1": "High" }, "milestone": { "Pre-Launch": "Alpha" } },
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
`priority`, `effort`, `milestone`, `summary`, `depends_on`, `completed_on`,
`removed_on`, `removed_reason`. Each maps to an **extractor**:

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
[synthesized](#how-fields-are-resolved) when absent.

### `remap` (optional)

Resolve foreign enum values to the target's configured vocabulary, by field
(`priority`, `milestone`). Keys are matched case-insensitively. A milestone that
mixes maturity gates with feature areas (which the spec disallows — see SPEC §7.1)
**must** be remapped to a single maturity axis; an unmapped value on an active item
is a hard error, never a silent guess.

### `defaults` (optional)

Fill a field when the source has no value for it — chiefly the historical
descriptive metadata (`milestone`, `priority`, `effort`, and `removed_reason`)
that header-style legacy closed items lack but the schema still requires on
completed/removed items (SPEC §5.1). A defaulted value is treated like an
extracted one.

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
- **Close dates** are validated as real calendar dates (`YYYY-MM-DD`); an
  impossible date like `2024-02-31` is refused rather than guessed.

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
