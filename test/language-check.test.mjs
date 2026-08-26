import assert from "node:assert/strict";
import test from "node:test";

import { findLanguageViolations } from "../scripts/check-language.mjs";
import { decodeOwnedText } from "../scripts/owned-text-files.mjs";

test("accepts English repository text", () => {
  assert.deepEqual(findLanguageViolations("Save the reviewed candidate patch."), []);
});

test("rejects a common blocked phrase", () => {
  const nonEnglishSample = Buffer.from("cG9yIGZhdm9y", "base64").toString("utf8");
  assert.notDeepEqual(findLanguageViolations(nonEnglishSample), []);
});

test("rejects an ASCII-only non-English sentence", () => {
  const nonEnglishSample = Buffer.from(
    "ZXUgZ29zdG8gZGUgZXNjcmV2ZXIgY29kaWdv",
    "base64"
  ).toString("utf8");
  assert.notDeepEqual(findLanguageViolations(nonEnglishSample), []);
});

test("rejects unintended accented Latin text", () => {
  const accentedSample = String.fromCodePoint(0x00e7);
  assert.notDeepEqual(findLanguageViolations(accentedSample), []);
});

test("accepts language-neutral mathematical symbols", () => {
  assert.deepEqual(findLanguageViolations("5 × 3 = 15; 12 ÷ 4 = 3."), []);
});

test("does not reject a blocked term embedded in a longer English token", () => {
  assert.deepEqual(findLanguageViolations("tested"), []);
});

test("treats CSV, SVG, and extensionless configuration as owned text", () => {
  const sample = Buffer.from("English sample\n", "utf8");
  assert.equal(decodeOwnedText("fixtures/sample.csv", sample), "English sample\n");
  assert.equal(decodeOwnedText("assets/diagram.svg", sample), "English sample\n");
  assert.equal(decodeOwnedText("Dockerfile", sample), "English sample\n");
});

test("excludes known binary artifacts", () => {
  assert.equal(decodeOwnedText("screenshots/demo.png", Buffer.from([1, 2, 3])), null);
});
