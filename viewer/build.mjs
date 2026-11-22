// Bundles the viewer into one hashed JS file plus the license files.
// Progress goes to stderr: stdout stays empty so callers can parse their own output.
import { rolldown } from "rolldown";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const log = (msg) => process.stderr.write(`build:viewer ${msg}\n`);

// "exports" hides package.json, so walk up from a resolvable entry to the package root.
function packageRoot(entry, name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(entry)));
  while (!existsSync(join(dir, "package.json")) || !dir.endsWith(join("node_modules", name))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find the ${name} package root`);
    dir = parent;
  }
  return dir;
}

// The only directory the build empties, fixed from this module's own location.
const outDir = join(here, "dist");

export async function build() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "licenses"), { recursive: true });

  log("bundling app.mjs");
  const bundle = await rolldown({ input: join(here, "app.mjs"), platform: "browser" });
  const { output } = await bundle.write({
    dir: outDir,
    format: "esm",
    entryFileNames: "app-[hash].js",
    // Espalier lazy-loads its virtualizer layout; one file keeps /app/ simple.
    codeSplitting: false,
    minify: true,
  });
  await bundle.close();
  const entry = output.find((o) => o.type === "chunk" && o.isEntry);
  if (!entry) throw new Error("rolldown produced no entry chunk");

  const shell = (await readFile(join(here, "index.html"), "utf8")).replace("/app/app.js", `/app/${entry.fileName}`);
  if (!shell.includes(entry.fileName)) throw new Error("index.html lost its app.js reference");
  await writeFile(join(outDir, "index.html"), shell);

  const espalier = packageRoot("@taprootio/espalier/root", "@taprootio/espalier");
  await cp(join(espalier, "css", "esp-reset.css"), join(outDir, "esp-reset.css"));
  await cp(join(espalier, "LICENSE"), join(outDir, "ESPALIER-LICENSE.md"));
  await cp(join(espalier, "licenses"), join(outDir, "licenses"), { recursive: true });
  await cp(join(packageRoot("lit", "lit"), "LICENSE"), join(outDir, "licenses", "LIT-LICENSE"));

  log(`wrote ${entry.fileName} to ${outDir}`);
  return { outDir, entry: entry.fileName };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().catch((err) => {
    process.stderr.write(`build:viewer failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
