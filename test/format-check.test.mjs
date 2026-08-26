import assert from "node:assert/strict";
import test from "node:test";

import { findFormattingViolations } from "../scripts/check-format.mjs";

test("accepts formatted TypeScript content", () => {
  assert.deepEqual(findFormattingViolations("const value = 1;\n", "src/example.ts"), []);
});

test("rejects trailing whitespace in planned source formats", () => {
  assert.notDeepEqual(
    findFormattingViolations("const value = 1;  \n", "src/example.ts"),
    []
  );
});

test("rejects a missing final newline in Python content", () => {
  assert.notDeepEqual(findFormattingViolations("value = 1", "src/example.py"), []);
});

test("accepts a Markdown hard line break", () => {
  assert.deepEqual(findFormattingViolations("First line  \nSecond line\n", "docs/guide.md"), []);
});

test("rejects CRLF and whitespace before a carriage return", () => {
  const violations = findFormattingViolations("const value = 1;  \r\n", "src/example.ts");
  assert.ok(violations.some((violation) => violation.includes("non-LF line ending")));
  assert.ok(violations.some((violation) => violation.includes("trailing whitespace")));
});
