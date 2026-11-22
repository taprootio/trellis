// Viewer config (TRL0005): where the file lives, and the strict rules for its keys.
// A typo is never ignored: an unknown key, a bad type or a duplicate id fails startup.

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir as osHomedir } from "node:os";
import { isIP } from "node:net";

export const DEFAULT_PORT = 4747;
export const DEFAULT_BIND = "127.0.0.1";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HOST_RE = /^(?:[a-z0-9][a-z0-9._-]*|\[[0-9a-f:.]+\])$/;
const TOP_KEYS = new Set(["backlogs", "port", "bind", "allowedHosts"]);
const ENTRY_KEYS = new Set(["id", "name", "path"]);

// A config problem the CLI reports with exit 1.
export class ViewerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ViewerConfigError";
  }
}

// The config file to load, or null for "no file". Order: $TRELLIS_VIEWER_CONFIG (which must
// exist), $XDG_CONFIG_HOME/trellis/viewer.json, ~/.config/trellis/viewer.json. All inputs are
// injectable so tests never read the developer's real config.
export function findConfigFile({ cwd = process.cwd(), env = process.env, homedir = osHomedir() } = {}) {
  if (env.TRELLIS_VIEWER_CONFIG) {
    const file = resolve(cwd, env.TRELLIS_VIEWER_CONFIG);
    if (!isFile(file)) throw new ViewerConfigError(`TRELLIS_VIEWER_CONFIG names ${file}, which is not a file`);
    return file;
  }
  const candidates = [];
  if (env.XDG_CONFIG_HOME) candidates.push(resolve(cwd, env.XDG_CONFIG_HOME, "trellis", "viewer.json"));
  candidates.push(join(homedir, ".config", "trellis", "viewer.json"));
  // Fall through only when a candidate is absent; one that exists but is not a file is a startup
  // error from the guarded loader, never a silent fallback to a lower-priority file.
  return candidates.find(exists) ?? null;
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function exists(path) {
  // lstat: a dangling symlink exists, and must reach the loader's error rather than be skipped.
  try { lstatSync(path); return true; } catch (e) { return e.code !== "ENOENT" && e.code !== "ENOTDIR"; }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Expands a leading `~/` against `homedir`.
export const expandHome = (path, homedir) => (path.startsWith("~/") ? join(homedir, path.slice(2)) : path);

// Validates a parsed config object and returns { backlogs, port, bind, allowedHosts }
// (port and bind are null when absent). Throws ViewerConfigError naming every problem.
export function parseViewerConfig(raw, { homedir = osHomedir() } = {}) {
  if (!isObject(raw)) throw new ViewerConfigError("the config must be a JSON object");
  const errors = [];
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) errors.push(`unknown key \`${k}\``);

  const backlogs = [];
  if (!Array.isArray(raw.backlogs) || raw.backlogs.length === 0) {
    errors.push("`backlogs` must be a non-empty array");
  } else {
    const seen = new Set();
    raw.backlogs.forEach((e, i) => {
      const at = `backlogs[${i}]`;
      if (!isObject(e)) { errors.push(`${at} must be an object`); return; }
      for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) errors.push(`${at}: unknown key \`${k}\``);
      let ok = true;
      if (typeof e.id !== "string" || !ID_RE.test(e.id)) { errors.push(`${at}: \`id\` must match ${ID_RE.source}`); ok = false; }
      else if (seen.has(e.id)) { errors.push(`${at}: duplicate \`id\` "${e.id}"`); ok = false; }
      else seen.add(e.id);
      if (typeof e.name !== "string" || !e.name.trim()) { errors.push(`${at}: \`name\` must be a non-empty string`); ok = false; }
      if (typeof e.path !== "string" || !(isAbsolute(e.path) || e.path.startsWith("~/"))) {
        errors.push(`${at}: \`path\` must be absolute or start with ~/`);
        ok = false;
      }
      if (ok) backlogs.push({ id: e.id, name: e.name, path: expandHome(e.path, homedir) });
    });
  }

  let port = null;
  if (Object.hasOwn(raw, "port")) {
    if (!Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) errors.push("`port` must be an integer from 0 to 65535");
    else port = raw.port;
  }
  let bind = null;
  if (Object.hasOwn(raw, "bind")) {
    if (typeof raw.bind !== "string" || !raw.bind.trim()) errors.push("`bind` must be a non-empty string");
    else bind = raw.bind.trim();
  }
  const allowedHosts = [];
  if (Object.hasOwn(raw, "allowedHosts")) {
    if (!Array.isArray(raw.allowedHosts)) errors.push("`allowedHosts` must be an array of host names");
    else raw.allowedHosts.forEach((h, i) => {
      const name = typeof h === "string" ? normalizeHost(h) : null;
      if (name === null) errors.push(`allowedHosts[${i}] must be a bare host name`);
      else allowedHosts.push(name);
    });
  }
  if (errors.length) throw new ViewerConfigError(errors.join("; "));
  return { backlogs, port, bind, allowedHosts };
}

// One spelling per IPv6 address, so `::ffff:127.0.0.1` and `::ffff:7f00:1` compare equal.
// Null when the literal does not parse. Request Host values and allowedHosts share this.
export function canonicalV6(literal) {
  try { return new URL(`http://${literal}`).hostname; } catch { return null; }
}

// A bare host name, lower-cased, or null when it is not one (a port, path or space). A
// bracketed IPv6 literal comes back canonical, and null when it does not parse.
export function normalizeHost(value) {
  const name = value.trim().toLowerCase();
  if (!HOST_RE.test(name)) return null;
  return name.startsWith("[") ? canonicalV6(name) : name;
}

export function loadViewerConfig(file, { homedir = osHomedir() } = {}) {
  let text;
  let fd;
  // Nonblocking open, then a regular-file check, so a FIFO given to --config fails instead of hanging.
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    text = readFileSync(fd, "utf8");
  } catch (e) { throw new ViewerConfigError(`cannot read ${file}: ${e.message}`); } finally { if (fd !== undefined) closeSync(fd); }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new ViewerConfigError(`${file} is not valid JSON (${e.message})`); }
  try { return parseViewerConfig(raw, { homedir }); } catch (e) {
    if (e instanceof ViewerConfigError) throw new ViewerConfigError(`${file}: ${e.message}`);
    throw e;
  }
}

// `--repo <path>` as a one-entry config. The id is the folder name made safe for the id rule.
export function singleRepoConfig(path, { cwd = process.cwd() } = {}) {
  const abs = resolve(cwd, path);
  const name = basename(abs) || abs;
  const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "repo";
  return { backlogs: [{ id, name, path: abs }], port: null, bind: null, allowedHosts: [] };
}

// True for a literal address in a loopback range (127.0.0.0/8, ::1, or the IPv4-mapped form),
// or the name `localhost`. A host name such as `127.example.com` is not loopback.
export function isLoopbackBind(bind) {
  const b = String(bind).toLowerCase();
  if (b === "localhost") return true;
  const family = isIP(b);
  if (family === 4) return b.startsWith("127.");
  return family === 6 && (b === "::1" || b.startsWith("::ffff:127."));
}
