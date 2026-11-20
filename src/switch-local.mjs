// `trellis init --switch-to-local` (TRL0038): moves a repo from committed generated
// artifacts to local mode. It only edits files. It never runs `git rm`, never stages,
// never commits and never edits `.gitignore`: the user keeps the ignore rule, and runs
// the removal commands this prints for the legacy generated files.
//
// Every check and every new file is computed in memory first. Then the edited files
// are installed through staged files and backups (the config last), and any failure puts
// them all back, so a rerun starts clean and a finished switch is a no-op.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DEFAULT_TASKS_DIR, GENERATED_DIR, MARKERS, SPEC_VERSION, artifactSet, loadConfig, paths, validateConfig } from "./backlog.mjs";
import { AGENTS_MARKERS, artifactBullet, completedSkeleton, removedSkeleton } from "./init.mjs";
import { OutputRefused, checkOutputFiles, discoverGit, foldsCase, gitPrefix, ignoreLineFor, installStaged, pathspec, probe, verifyOutputPaths } from "./local-output.mjs";

// Test seam: runs before each file write (with its path and index) and after the last one.
export const testSeams = { beforeWrite: null, afterWrites: null };

const posix = (rel) => rel.split(sep).join("/");
const firstLine = (s) => String(s || "").trim().split("\n")[0] || "git error";
const ALL_MARKERS = Object.values(MARKERS).flat();
const trimEnd = (line) => line.replace(/[ \t\r]+$/, "");

function refuse(message) {
  throw new OutputRefused(`${message}\nNothing was changed.`);
}

// `git` through the shared probe: the cleaned environment, no fsmonitor command, no
// optional index refresh, and literal pathspecs (`status` and `ls-files` support them).
function git(repoRoot, args, { literal = true } = {}) {
  const r = probe(repoRoot, args, { literal });
  if (r.status !== 0) refuse(`git ${args[0]} failed: ${r.error ? r.error.message : firstLine(r.stderr)}`);
  return r.stdout;
}

// Reads a file the switch may edit as bytes and decodes them as strict UTF-8, so a file in
// another encoding is refused before any edit instead of being rewritten with U+FFFD. The
// BOM is kept, so untouched bytes stay untouched.
function readText(path, rel) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (e) {
    if (e instanceof TypeError) refuse(`${rel} is not valid UTF-8, so the switch cannot edit it safely. Convert it to UTF-8, then run again`);
    throw e;
  }
}

// A path the switch would edit or remove must be a regular file, not a link to
// somewhere else or a directory. Absent files are fine.
function requireRegular(path, rel) {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT") return;
    refuse(`cannot inspect ${rel}: ${e.message}`);
  }
  if (st.isSymbolicLink()) refuse(`${rel} is a symlink, and the switch does not edit through links. Replace it with a regular file, or edit it by hand, then run again`);
  if (!st.isFile()) refuse(`${rel} is not a regular file. Fix it, then run again`);
}

// Removes the lines from the begin marker through the end marker, newline included,
// from a file whose markers were already verified. Every other byte stays as it was,
// so an indented code block after the block keeps its indentation.
function stripBlock(text, [begin, end]) {
  let offset = 0;
  let from = -1;
  let to = -1;
  for (const line of text.split("\n")) {
    const next = offset + line.length + 1;
    if (from === -1 && trimEnd(line) === begin) from = offset;
    if (from !== -1 && trimEnd(line) === end) { to = Math.min(next, text.length); break; }
    offset = next;
  }
  return text.slice(0, from) + text.slice(to);
}

// The index of the first copy of `needle` that fills whole lines of `text` (it starts a
// line and ends one), or -1. A customized copy earlier in the text is not a match.
function findWholeLines(text, needle) {
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const after = text[i + needle.length];
    if ((i === 0 || text[i - 1] === "\n") && (after === undefined || after === "\n")) return i;
  }
  return -1;
}

// Checks that a file holds either no generated marker or exactly one well-formed pair
// of its own, each on a line of its own. The committed generator only ever replaced the
// first pair, so any other layout may hide authored text and is refused.
function inspectMarkers(rel, text, own) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    const hits = ALL_MARKERS.filter((m) => line.includes(m));
    if (!hits.length) return;
    if (hits.length > 1 || trimEnd(line) !== hits[0]) {
      refuse(`${rel} line ${i + 1}: a generated marker comment shares its line with other text. Move the comment onto its own line, then run again`);
    }
    found.push({ line: i, marker: hits[0] });
  });
  if (!found.length) return false;
  const foreign = found.find((f) => !own.includes(f.marker));
  if (foreign) refuse(`${rel} line ${foreign.line + 1}: ${foreign.marker} belongs to another file. Remove it, then run again`);
  const begins = found.filter((f) => f.marker === own[0]);
  const ends = found.filter((f) => f.marker === own[1]);
  if (begins.length > 1 || ends.length > 1) {
    refuse(`${rel} holds a generated marker more than once. The committed generator replaced only the first pair, so a later one may be authored text (such as a fenced example). Remove the extra markers, then run again`);
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0].line > ends[0].line) {
    refuse(`${rel} has an unpaired or out-of-order generated marker. Fix the pair or remove the block, then run again`);
  }
  return true;
}

const lowerThanCurrent = (v) => {
  if (v == null) return false;
  const [maj, min] = String(v).split(".").map(Number);
  const [curMaj, curMin] = SPEC_VERSION.split(".").map(Number);
  return maj < curMaj || (maj === curMaj && min < curMin);
};

// Runs the switch. Returns { edits, removals, warnings, dryRun }: the files changed (or
// that would change) and the legacy files still tracked, each with the plain `git rm`
// command for the user to run. Throws OutputRefused (exit 2) on a failed check, and a
// plain Error (exit 1) when a write failed, after restoring every file.
export function switchToLocal(repoRoot, { dryRun = false } = {}) {
  if (discoverGit(repoRoot) !== "inside") {
    refuse(`${repoRoot} is not inside a git work tree, or git is not installed. The switch needs git to check that the generated files are ignored and clean`);
  }
  const configPath = paths(repoRoot).config;
  const rel = (p) => posix(relative(repoRoot, p));
  requireRegular(configPath, rel(configPath));
  const loaded = loadConfig(repoRoot);
  if (loaded.errors.length) refuse(`the config has errors; fix them first: ${loaded.errors.join("; ")}`);
  const { cfg } = loaded;
  // The config the switch would write must pass the same rules, local-mode ones included.
  const wouldWrite = { ...JSON.parse(readText(configPath, rel(configPath))), generatedArtifacts: "local" };
  if (lowerThanCurrent(wouldWrite.specVersion)) wouldWrite.specVersion = SPEC_VERSION;
  const wouldErrors = validateConfig(wouldWrite).errors;
  if (wouldErrors.length) refuse(`the config would be invalid in local mode; fix it first: ${wouldErrors.join("; ")}`);
  const localCfg = { ...cfg, generatedArtifacts: "local" };
  const root = cfg.tasksDir || DEFAULT_TASKS_DIR;

  // 1. The file kinds, before anything is read.
  const set = artifactSet(repoRoot, localCfg);
  const [readme, completedIdx, removedIdx] = set.authorOwned;
  const legacyBacklog = artifactSet(repoRoot, { ...cfg, generatedArtifacts: "committed" }).generated.find((e) => e.key === "backlog");
  const agentsPath = join(repoRoot, "AGENTS.md");
  for (const f of [readme, completedIdx, removedIdx, legacyBacklog]) requireRegular(f.path, posix(f.rel));
  requireRegular(agentsPath, "AGENTS.md");

  // 2. The output paths: sound, ignored, and nothing tracked under `.generated/`.
  checkOutputFiles(repoRoot, localCfg);
  const { unignored } = verifyOutputPaths(repoRoot, localCfg);
  if (unignored.length) {
    refuse(`${unignored.map(posix).join(", ")} ${unignored.length > 1 ? "are" : "is"} not ignored by git. Add this line to the .gitignore at the repository root, then run again:\n  ${ignoreLineFor(cfg.tasksDir, gitPrefix(repoRoot))}`);
  }
  const dirRel = rel(set.dir);
  // On a case-insensitive filesystem `.GENERATED/` is the same folder, so compare folded.
  // git matches the folder itself with `:(literal,icase)`, then the names are folded to find `.generated/`.
  const icase = foldsCase(repoRoot);
  const fold = icase ? (p) => p.toLowerCase() : (p) => p;
  // Only the `.generated` folder is listed, so a large tasks folder is never enumerated.
  const underGenerated = git(repoRoot, ["ls-files", "-z", "--", pathspec(dirRel, icase)], { literal: !icase }).split("\0").filter(Boolean)
    .filter((p) => fold(p).startsWith(`${fold(dirRel)}/`));
  if (underGenerated.length) {
    refuse(`${underGenerated.join(", ")} ${underGenerated.length > 1 ? "are" : "is"} tracked by git, but local mode keeps ${dirRel}/ out of git. Untrack ${underGenerated.length > 1 ? "them" : "it"} (git rm --cached), then run again`);
  }

  // 3. What git knows: which candidates are tracked, and which are clean.
  const candidates = [readme, completedIdx, removedIdx, legacyBacklog].map((f) => posix(f.rel)).concat("AGENTS.md", rel(configPath));
  // `ls-files -v` tags a path with a lowercase letter when it is assume-unchanged and with
  // S when it is skip-worktree; either hides edits from `git status`, so it is refused.
  const tracked = new Set();
  const hidden = new Set();
  for (const entry of git(repoRoot, ["ls-files", "-v", "-z", "--", ...candidates.map((c) => `./${c}`)]).split("\0").filter(Boolean)) {
    const path = posix(entry.slice(2));
    tracked.add(path);
    if (/[a-zS]/.test(entry[0])) hidden.add(path);
  }
  const isDirty = (r) => git(repoRoot, ["status", "--porcelain=v1", "--", `./${r}`]).trim() !== "";
  // A file the switch edits or removes must be tracked and unchanged, so the printed
  // plain `git rm` works and the user's own edits are never mixed with ours.
  const requireClean = (r, what) => {
    if (!tracked.has(r)) refuse(`${r} is untracked and ${what}. Commit it (or move it away), then run again`);
    if (hidden.has(r)) refuse(`${r} is marked assume-unchanged or skip-worktree, so git cannot show whether it changed and ${what}. Clear the flag (git update-index --no-assume-unchanged --no-skip-worktree), then run again`);
    if (isDirty(r)) refuse(`${r} has uncommitted changes and ${what}. Commit them, then run again`);
  };

  const legacyRel = posix(legacyBacklog.rel);
  // Tracked, not present on disk, decides: an unstaged deletion is a dirty tracked file.
  const hasLegacy = tracked.has(legacyRel);
  if (!hasLegacy && existsSync(legacyBacklog.path)) refuse(`${legacyRel} exists but is not tracked by git. Inspect it, then remove or move it, and run again`);

  // 4. The README and index files: strip the generated block, keep authored text.
  const edits = [];
  const removals = [];
  const warnings = [];
  const pairs = [[readme, MARKERS.milestones, null], [completedIdx, MARKERS.completed, completedSkeleton()], [removedIdx, MARKERS.removed, removedSkeleton()]];
  for (const [f, own, skeleton] of pairs) {
    const r = posix(f.rel);
    // A tracked file missing from the work tree (sparse checkout or a deletion) cannot be
    // checked for markers, so it is refused instead of skipped.
    if (!existsSync(f.path)) {
      if (tracked.has(r)) refuse(`${r} is tracked by git but missing from the work tree (a sparse checkout or a deletion), so the switch cannot check it for generated markers. Restore it (git checkout -- ${r}, or clear the sparse patterns), then run again`);
      continue;
    }
    const text = readText(f.path, rel(f.path));
    if (!inspectMarkers(r, text, own)) continue;
    const stripped = stripBlock(text, own);
    // An index file holding only Trellis's own skeleton around the block is generated only:
    // it stays byte for byte as it is, and the user removes it with the printed command.
    // Whitespace-only is blank. Otherwise only line endings are normalized, so an indented
    // heading (a code block) is authored text and the file is edited, not removed.
    const eol = (t) => t.replace(/\r\n/g, "\n");
    if (skeleton !== null && (stripped.trim() === "" || eol(stripped) === eol(stripBlock(skeleton, own)))) {
      requireClean(r, "would be removed");
      removals.push({ rel: r, why: "generated only" });
      continue;
    }
    requireClean(r, "holds generated markers the switch must strip");
    edits.push({ path: f.path, rel: r, before: text, after: stripped, why: "removed the generated block and its markers" });
  }
  if (hasLegacy) {
    requireClean(legacyRel, "is the legacy generated file");
    removals.push({ rel: legacyRel, why: "legacy generated file" });
  }

  // 5. AGENTS.md: replace the artifact bullet only on an exact match of Trellis's own text.
  if (existsSync(agentsPath)) {
    const text = readText(agentsPath, "AGENTS.md");
    const [begin, end] = AGENTS_MARKERS;
    const bi = text.indexOf(begin);
    const ei = bi === -1 ? -1 : text.indexOf(end, bi);
    if (ei !== -1) {
      const block = text.slice(bi, ei);
      const committed = artifactBullet(root, "committed");
      const local = artifactBullet(root, "local");
      const at = findWholeLines(block, committed);
      // The copy must end its list item: a continuation line after it means the user
      // extended the bullet, so it is not Trellis's own text any more.
      // After a blank line, an indented next line is a continuation paragraph of the same item.
      const following = at === -1 ? [] : block.slice(at + committed.length + 1).split("\n");
      const nextLine = following[0] ?? "";
      const nextText = following.find((l) => l.trim() !== "") ?? "";
      const endsItem = at !== -1 && (block.length <= at + committed.length + 1 || (nextLine.trim() === "" ? !/^\s/.test(nextText) : /^[-*] /.test(nextLine)));
      if (at !== -1 && endsItem) {
        requireClean("AGENTS.md", "holds the Trellis block the switch updates");
        edits.push({ path: agentsPath, rel: "AGENTS.md", before: text, after: text.slice(0, bi) + block.slice(0, at) + local + block.slice(at + committed.length) + text.slice(ei), why: "updated the generated-files bullet" });
      } else if (at !== -1 || findWholeLines(block, local) === -1) {
        warnings.push(`AGENTS.md: the generated-files bullet in the Trellis block differs from Trellis's own text, so it was left alone. Edit it by hand to say the index is generated into ${root}/${GENERATED_DIR}/ and that no committed file is generated`);
      }
    }
  }

  // 6. The config, last. It is patched from a fresh parse of its own bytes, never from
  // the loaded object, which carries derived fields. A config that is already local and
  // current keeps its bytes, even when it is uncommitted.
  const configText = readText(configPath, rel(configPath));
  const obj = JSON.parse(configText);
  if (obj.generatedArtifacts !== "local" || lowerThanCurrent(obj.specVersion)) {
    requireClean(rel(configPath), 'needs `generatedArtifacts` set to "local"');
    obj.generatedArtifacts = "local";
    if (lowerThanCurrent(obj.specVersion)) obj.specVersion = SPEC_VERSION;
    edits.push({ path: configPath, rel: rel(configPath), before: configText, after: JSON.stringify(obj, null, 2) + "\n", why: 'set generatedArtifacts to "local" and raised specVersion when it was lower' });
  }

  // Each command names the target with -C, so it works from any directory (the target
  // may be a subfolder of the git root) and removes only this target's file.
  const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  for (const r of removals) r.command = `git -C ${quote(resolve(repoRoot))} --literal-pathspecs rm -- ${quote(r.rel)}`;
  const result = { edits: edits.map((e) => ({ rel: e.rel, why: e.why })), removals, warnings, dryRun };
  if (dryRun || !edits.length) return result;

  // 7. Install the edits (config last) through the shared staged installer: a failure renames
  // every backup back, and a backup that cannot go back is kept and named.
  let outcome;
  try {
    outcome = installStaged(edits.map((e) => ({ path: e.path, content: e.after })), {
      before: (path, i) => { if (testSeams.beforeWrite) testSeams.beforeWrite(path, i); },
      after: () => { if (testSeams.afterWrites) testSeams.afterWrites(); },
    });
  } catch (e) {
    if (e.kept) {
      const notes = [...(e.kept.length ? [`originals kept at: ${e.kept.join(", ")}`] : []), ...e.failed];
      throw new Error(`the switch failed and could not restore every file; ${notes.join("; ")}: ${e.original}`);
    }
    throw new Error(`the switch failed and every edited file was restored: ${e.message}`);
  }
  warnings.push(...outcome.leftover);
  return result;
}
