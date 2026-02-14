import assert from "node:assert/strict";
import { sanitizeCaptures } from "../capture-utils.ts";

const cleaned1 = sanitizeCaptures([
  { role: "user", text: " hello " },
  { role: "assistant", text: "<relevant-memories>ignore</relevant-memories>" },
]);
assert.equal(cleaned1.length, 1);
assert.equal(cleaned1[0].text, "hello");

const cleaned2 = sanitizeCaptures([
  { role: "user", text: "ok" },
  { role: "assistant", text: "" },
]);
assert.equal(cleaned2.length, 1);
assert.equal(cleaned2[0].text, "ok");

console.log("sanitizeCaptures tests passed");
