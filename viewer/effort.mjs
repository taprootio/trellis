// Chooses how to draw an effortDisplay the server already resolved. It never
// reads authored fields, so a task cannot show an effort the scale lacks.

const NONE = Object.freeze({ kind: "none", text: "" });

export function effortView(display) {
  if (!display || typeof display !== "object") return NONE;
  const text = typeof display.text === "string" ? display.text : "";
  const label = typeof display.label === "string" ? display.label : "";
  if (!text && !label) return NONE;
  // Only same-origin effort assets are drawn; anything else falls back to text.
  if (typeof display.imageUrl === "string" && display.imageUrl.startsWith("/assets/")) {
    return { kind: "image", src: display.imageUrl, alt: label || text, text };
  }
  if (typeof display.emoji === "string" && display.emoji) {
    return { kind: "emoji", emoji: display.emoji, text };
  }
  return { kind: "text", text: text || label };
}
