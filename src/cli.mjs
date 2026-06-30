// Shared helpers for the dependency-free CLI wrappers.

import { resolve } from "node:path";

export function optionToken(arg) {
  const eq = arg.indexOf("=");
  return {
    key: arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg,
    inline: arg.startsWith("--") && eq !== -1 ? arg.slice(eq + 1) : null,
  };
}

export function usageError(message) {
  console.error(message);
  process.exit(2);
}

export function showHelp(help) {
  process.stdout.write(help);
  process.exit(0);
}

export function requiredValue(argv, index, inline, flag) {
  const value = inline !== null ? inline : argv[index + 1];
  if (value === undefined || value === "" || (inline === null && value.startsWith("-"))) {
    usageError(`error: ${flag} requires a value`);
  }
  return { value, index: inline !== null ? index : index + 1 };
}

export function resolveRepoRoot(value) {
  return resolve(value || process.cwd());
}
