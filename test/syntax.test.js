import test from "node:test";
import assert from "node:assert/strict";

import { checkSyntax } from "../src/syntax.js";

// ── the real check ────────────────────────────────────────────────────────

test("a valid ES module passes the syntax check", () => {
  const result = checkSyntax(Buffer.from("import x from \"node:fs\";\nexport const y = 1;\n", "utf8"));
  assert.equal(result.status, "ok");
});

test("a truncated module is rejected", () => {
  const result = checkSyntax(Buffer.from("export const y = ;\n", "utf8"));
  assert.equal(result.status, "invalid");
  assert.ok(result.detail.length > 0, "the failure carries the parser message");
});

test("a file that ends mid-statement is rejected", () => {
  // The failure mode this gate exists for: a patch that corrupts the tail.
  const result = checkSyntax(Buffer.from("function f() {\n  return 1;\n", "utf8"));
  assert.equal(result.status, "invalid");
});

// ── when the check cannot run ─────────────────────────────────────────────

test("a missing node executable is reported as unavailable, not as invalid", () => {
  const result = checkSyntax(Buffer.from("export {};\n", "utf8"), {
    spawn: () => ({ error: new Error("spawn node ENOENT") })
  });
  assert.equal(result.status, "unavailable");
  assert.match(result.detail, /ENOENT/);
});

test("an empty execPath is reported as unavailable", () => {
  const result = checkSyntax(Buffer.from("export {};\n", "utf8"), { execPath: "" });
  assert.equal(result.status, "unavailable");
});

test("a spawn that throws is reported as unavailable", () => {
  const result = checkSyntax(Buffer.from("export {};\n", "utf8"), {
    spawn: () => {
      throw new Error("no such process");
    }
  });
  assert.equal(result.status, "unavailable");
  assert.match(result.detail, /no such process/);
});

test("a non-zero exit carries the parser's stderr", () => {
  const result = checkSyntax(Buffer.from("export {};\n", "utf8"), {
    spawn: () => ({ status: 1, stderr: "SyntaxError: Unexpected token" })
  });
  assert.equal(result.status, "invalid");
  assert.match(result.detail, /Unexpected token/);
});

test("a check killed by a signal is reported as invalid with the signal", () => {
  const result = checkSyntax(Buffer.from("export {};\n", "utf8"), {
    spawn: () => ({ status: null, signal: "SIGKILL", stderr: "" })
  });
  assert.equal(result.status, "invalid");
  assert.match(result.detail, /SIGKILL/);
});
