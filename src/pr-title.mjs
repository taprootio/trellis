// PR-title lint core (zero-dependency, like src/backlog.mjs).
//
// The standard: a PR title is `<ID>: <imperative summary>`, where `<ID>` is the
// repo's configured id prefix + width (read live from backlog.config.json, so
// the lint is prefix-agnostic per TRL0007) and the colon is the separator. A
// multi-item PR leads with the primary id and names the rest in the body, so the
// lint only anchors on a single leading id and ignores whatever follows the
// summary. Pure so the CLI wrapper (scripts/pr-title-lint.mjs) and `node --test`
// both call it; see .github/pull_request_template.md / docs/playbooks/pr-draft.md.

export const MAX_TITLE_LENGTH = 72;

// Escape regex metacharacters so a configured idPrefix is matched literally — a
// prefix like `T+` must mean two characters, not "one or more T".
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Returns { ok, errors[] }. cfg is the loaded backlog.config.json (needs
// idPrefix + idWidth). Collects every violation so a malformed title reports all
// of its problems at once.
export function lintPrTitle(title, cfg) {
  if (typeof title !== "string" || !title.trim()) {
    return { ok: false, errors: ["title is empty"] };
  }

  const errors = [];
  // Lint the real, untrimmed title: stray leading/trailing whitespace is itself a
  // defect (the start-anchored id pattern below only catches the leading case).
  if (title !== title.trim()) {
    errors.push("title has leading or trailing whitespace");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    errors.push(`title is ${title.length} chars; must be ≤ ${MAX_TITLE_LENGTH}`);
  }

  // `^<prefix><width digits>: ` then a non-space, so an exactly-formed id, the
  // colon-space separator, and a non-empty summary are all required.
  const idRe = new RegExp(`^${escapeRe(cfg.idPrefix)}\\d{${cfg.idWidth}}: \\S`);
  if (!idRe.test(title)) {
    const example = `${cfg.idPrefix}${"0".repeat(cfg.idWidth)}: add the widget`;
    errors.push(
      `title must start with \`${cfg.idPrefix}\` + ${cfg.idWidth} digits, then \`: \`, ` +
        `then a summary (e.g. \`${example}\`)`,
    );
  }

  return { ok: errors.length === 0, errors };
}
