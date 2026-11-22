// One URL path segment for a task id. encodeURIComponent leaves `.` and `..` as they are, and
// a browser or proxy would then treat them as dot segments, so a task whose id is one of those
// could never be reached. Server links, API calls and client links all share this encoder.
export function encodeSegment(value) {
  const s = String(value);
  if (s === ".") return "%2E";
  if (s === "..") return "%2E%2E";
  return encodeURIComponent(s);
}
