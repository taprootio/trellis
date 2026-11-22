// One URL path segment for a task id. Browsers and proxies drop `.` and `..` segments even when
// they are written `%2E`, so an id that is exactly one of those could never be reached. Such an
// id (and any id starting with `~`, to keep the escape collision-free) gets a leading `~`,
// then is percent-encoded as usual. Server links, API calls and client links share this pair.
export function encodeSegment(value) {
  const s = String(value);
  return encodeURIComponent(s === "." || s === ".." || s.startsWith("~") ? `~${s}` : s);
}

// Undoes encodeSegment's escape on an already percent-decoded segment.
export function decodeSegment(s) {
  return s.startsWith("~") ? s.slice(1) : s;
}
