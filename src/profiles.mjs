// Trellis source-mapping profiles (zero-dependency).
//
// A profile is a reusable *mapping object* — the exact shape the import engine
// (src/import.mjs) consumes — shipped under `profiles/` and resolved by name. The
// engine stays pure (it takes a mapping object); this module is only the registry
// plus the loaders shared by the `trellis import` CLI, the `init --import` on-ramp,
// and the MCP `import` tool, so all three resolve `--profile <name>` /
// `--mapping <file>` / inline mappings the same way. An optional top-level
// `description` documents a profile and is ignored by the engine (validateMapping
// neither requires nor rejects it).
//
// Built-in profiles assume the DEFAULT Trellis vocabulary as their remap targets
// (Alpha → Beta → v1 → Future, High/Medium/Low, Fibonacci effort); a target on a
// different vocabulary edits the profile's `remap`. See docs/import.md.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Built-in profiles ship next to the package (one level up from src/), so a
// packaged install (TRL0010) carries them. Computed from this module's location,
// never cwd, so resolution is the same wherever the tool runs.
export const BUILTIN_PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");

// A profile name addresses exactly one file in the profiles dir; restrict it to a
// flat basename so `--profile ../../etc/passwd` (or any separator) can't escape.
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

// list the built-in profiles → [{ name, description, path }], sorted by name.
// Returns [] when the dir is absent. Never throws: a malformed profile is still
// listed (with an empty description) and only errors when actually loaded.
export function listProfiles(dir = BUILTIN_PROFILES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      let description = "";
      try { description = String(JSON.parse(readFileSync(path, "utf8")).description ?? ""); } catch { /* listed even if unparseable */ }
      return { name: f.replace(/\.json$/, ""), description, path };
    });
}

// loadProfile — resolve a built-in profile name to its mapping → { mapping, error }.
// Unknown name lists the available ones; a bad name or unreadable/!JSON file is a
// clear error. Mirrors loadConfig's result-object idiom (no throw), so each caller
// maps the error to its own surface (a CLI exit, or an MCP TrellisError).
export function loadProfile(name, dir = BUILTIN_PROFILES_DIR) {
  if (typeof name !== "string" || !name.trim()) return { mapping: null, error: "a profile name is required" };
  const safe = name.trim();
  if (!PROFILE_NAME_RE.test(safe)) return { mapping: null, error: `invalid profile name "${safe}" (use letters, digits, ., _, -)` };
  const file = join(dir, `${safe}.json`);
  if (!existsSync(file)) {
    const avail = listProfiles(dir).map((p) => p.name).join(", ") || "(none)";
    return { mapping: null, error: `unknown profile "${safe}" (available: ${avail})` };
  }
  return loadMappingFile(file);
}

// loadMappingFile — read a mapping from an arbitrary JSON file → { mapping, error }.
// Backs the `--mapping <file>` flag; same result-object shape as loadProfile so the
// two are interchangeable at the call site.
export function loadMappingFile(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { return { mapping: null, error: `cannot read mapping file ${file}: ${e.message}` }; }
  try { return { mapping: JSON.parse(text), error: null }; } catch (e) { return { mapping: null, error: `mapping file ${file} is not valid JSON: ${e.message}` }; }
}
