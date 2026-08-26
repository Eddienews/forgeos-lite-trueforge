import assert from "node:assert/strict";
import test from "node:test";

import { findLanguageViolations } from "../scripts/check-language.mjs";

test("accepts English repository text", () => {
  assert.deepEqual(findLanguageViolations("Save the reviewed candidate patch."), []);
});

test("rejects a common blocked phrase", () => {
  const nonEnglishSample = Buffer.from("cG9yIGZhdm9y", "base64").toString("utf8");
  assert.notDeepEqual(findLanguageViolations(nonEnglishSample), []);
});

test("rejects unintended accented Latin text", () => {
  const accentedSample = String.fromCodePoint(0x00e7);
  assert.notDeepEqual(findLanguageViolations(accentedSample), []);
});

test("does not reject a blocked term embedded in a longer English token", () => {
  assert.deepEqual(findLanguageViolations("tested"), []);
});

