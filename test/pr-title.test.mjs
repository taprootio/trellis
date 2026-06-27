// Behavior tests for the PR-title lint core (TRL0016), run via `node --test`.
// Scope is the pure validator in src/pr-title.mjs; the CLI wrapper in
// scripts/pr-title-lint.mjs is a thin env/exit-code adapter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintPrTitle, MAX_TITLE_LENGTH } from "../src/pr-title.mjs";

const cfg = { idPrefix: "TRL", idWidth: 4 };

test("accepts a conforming title", () => {
  assert.deepEqual(lintPrTitle("TRL0016: add the PR title lint", cfg), { ok: true, errors: [] });
});

test("accepts a multi-item PR that leads with the primary id", () => {
  assert.equal(lintPrTitle("TRL0016: lint titles (also TRL0017)", cfg).ok, true);
});

test("rejects a missing id", () => {
  assert.equal(lintPrTitle("add the PR title lint", cfg).ok, false);
});

test("rejects the wrong prefix", () => {
  assert.equal(lintPrTitle("ABC0016: add the lint", cfg).ok, false);
});

test("rejects the wrong digit width", () => {
  assert.equal(lintPrTitle("TRL16: add the lint", cfg).ok, false);
  assert.equal(lintPrTitle("TRL00016: add the lint", cfg).ok, false);
});

test("rejects a missing colon separator", () => {
  assert.equal(lintPrTitle("TRL0016 add the lint", cfg).ok, false);
  assert.equal(lintPrTitle("TRL0016 — add the lint", cfg).ok, false);
});

test("rejects no space after the colon", () => {
  assert.equal(lintPrTitle("TRL0016:add the lint", cfg).ok, false);
});

test("rejects an empty summary", () => {
  assert.equal(lintPrTitle("TRL0016: ", cfg).ok, false);
  assert.equal(lintPrTitle("TRL0016:", cfg).ok, false);
});

test("rejects leading or trailing whitespace", () => {
  assert.equal(lintPrTitle(" TRL0016: add the lint", cfg).ok, false);
  assert.equal(lintPrTitle("TRL0016: add the lint ", cfg).ok, false);
});

test("rejects an empty or whitespace title", () => {
  assert.equal(lintPrTitle("", cfg).ok, false);
  assert.equal(lintPrTitle("   ", cfg).ok, false);
  assert.equal(lintPrTitle(undefined, cfg).ok, false);
});

test(`rejects a title longer than ${MAX_TITLE_LENGTH} chars`, () => {
  const long = "TRL0016: " + "x".repeat(MAX_TITLE_LENGTH);
  assert.ok(long.length > MAX_TITLE_LENGTH);
  assert.equal(lintPrTitle(long, cfg).ok, false);
});

test("accepts a title exactly at the length limit", () => {
  const exact = "TRL0016: " + "x".repeat(MAX_TITLE_LENGTH - "TRL0016: ".length);
  assert.equal(exact.length, MAX_TITLE_LENGTH);
  assert.equal(lintPrTitle(exact, cfg).ok, true);
});

test("treats a regex-special prefix literally", () => {
  const odd = { idPrefix: "T+", idWidth: 3 };
  assert.equal(lintPrTitle("T+001: add the lint", odd).ok, true);
  assert.equal(lintPrTitle("TT001: add the lint", odd).ok, false);
});

test("honors a different repo's prefix and width", () => {
  const demo = { idPrefix: "DEMO", idWidth: 3 };
  assert.equal(lintPrTitle("DEMO007: ship it", demo).ok, true);
  assert.equal(lintPrTitle("TRL0007: ship it", demo).ok, false);
});
