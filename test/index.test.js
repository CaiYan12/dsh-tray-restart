import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLY_DEFAULTS,
  apply,
  asarPathFrom,
  describeResult,
  notificationBody,
  shouldPatch
} from "../src/index.js";

/**
 * Minimal stand-in for the Cordis context the Host hands to a plugin.
 * Only `ctx.logger(name)` is used by the entry.
 */
function fakeCtx() {
  const lines = [];
  const ctx = {
    logger(name) {
      assert.equal(typeof name, "string");
      return {
        info: (message) => lines.push({ level: "info", message }),
        warn: (message) => lines.push({ level: "warn", message })
      };
    },
    lines
  };
  return ctx;
}

/** Entry dependencies, all injected so the tests never touch a real asar. */
function deps(overrides = {}) {
  const calls = { applyTrayRestart: [], notify: [] };
  const value = {
    platform: "win32",
    asarPath: "C:\\Program Files\\Deepseek\\resources\\app.asar",
    asarExists: () => true,
    applyTrayRestart: (path) => {
      calls.applyTrayRestart.push(path);
      return { changed: true, asarPath: path, mainBytes: 848505, integrityUpdated: true, backupCreated: true, backupUsed: false };
    },
    notify: (message) => {
      calls.notify.push(message);
      return true;
    },
    ...overrides
  };
  return { value, calls };
}

// ── shouldPatch: the decision that gates every side effect ──────────────────

test("shouldPatch is false off Windows", () => {
  assert.deepEqual(shouldPatch({ platform: "darwin", asarExists: true }), { patch: false, reason: "platform" });
  assert.deepEqual(shouldPatch({ platform: "linux", asarExists: true }), { patch: false, reason: "platform" });
});

test("shouldPatch is false when the asar is missing, even on Windows", () => {
  assert.deepEqual(shouldPatch({ platform: "win32", asarExists: false }), { patch: false, reason: "asar-missing" });
});

test("shouldPatch is true only on Windows with an asar present", () => {
  assert.deepEqual(shouldPatch({ platform: "win32", asarExists: true }), { patch: true, reason: "ok" });
});

// ── asarPathFrom: environment override first, execPath otherwise ────────────

test("asarPathFrom prefers DSH_DESKTOP_APP_ASAR", () => {
  const path = asarPathFrom({
    env: { DSH_DESKTOP_APP_ASAR: "D:\\custom\\app.asar" },
    execPath: "C:\\Program Files\\Deepseek\\DeepSeek Harness.exe"
  });
  assert.equal(path, "D:\\custom\\app.asar");
});

test("asarPathFrom derives resources/app.asar from the executable path", () => {
  const path = asarPathFrom({
    env: {},
    execPath: join("C:\\", "Program Files", "Deepseek", "DeepSeek Harness.exe")
  });
  assert.equal(path, join("C:\\", "Program Files", "Deepseek", "resources", "app.asar"));
});

test("asarPathFrom ignores an empty override", () => {
  const path = asarPathFrom({ env: { DSH_DESKTOP_APP_ASAR: "" }, execPath: join("C:\\", "Deepseek.exe") });
  assert.equal(path, join("C:\\", "resources", "app.asar"));
});

// ── describeResult: log line per outcome ───────────────────────────────────

test("describeResult reports a fresh patch as info with the restart hint", () => {
  const line = describeResult({ changed: true, mainBytes: 848505, integrityUpdated: true });
  assert.equal(line.level, "info");
  assert.match(line.message, /848505/);
  assert.match(line.message, /integrity/);
  assert.match(line.message, /restart/i);
});

test("describeResult reports an already patched asar as info without a restart hint", () => {
  const line = describeResult({ changed: false, mainBytes: 848505, integrityUpdated: false });
  assert.equal(line.level, "info");
  assert.match(line.message, /already/i);
  assert.doesNotMatch(line.message, /restart the desktop app/i);
});

test("describeResult reports a failure as warn and keeps the error text", () => {
  const line = describeResult(undefined, new Error("boom"));
  assert.equal(line.level, "warn");
  assert.match(line.message, /boom/);
});

// ── notificationBody: the bubble text ──────────────────────────────────────

test("notificationBody asks for a restart in English and Chinese", () => {
  assert.match(notificationBody("zh"), /重启/);
  assert.match(notificationBody("en"), /restart/i);
});

test("notificationBody falls back to English for an unknown language", () => {
  assert.equal(notificationBody("xx"), notificationBody("en"));
});

// ── apply: the Host entry ──────────────────────────────────────────────────

test("apply patches the asar and shows one notification when it changed", async () => {
  const ctx = fakeCtx();
  const { value, calls } = deps();
  await apply(ctx, value);

  assert.deepEqual(calls.applyTrayRestart, [value.asarPath]);
  assert.equal(calls.notify.length, 1, "exactly one bubble");
  assert.match(calls.notify[0], /重启/);
  assert.equal(ctx.lines.filter((line) => line.level === "warn").length, 0);
  assert.equal(ctx.lines.filter((line) => line.level === "info").length, 1);
});

test("apply logs info and shows no notification when the asar is already patched", async () => {
  const ctx = fakeCtx();
  const { value, calls } = deps({
    applyTrayRestart: (path) => {
      calls.applyTrayRestart.push(path);
      return { changed: false, asarPath: path, mainBytes: 848505, integrityUpdated: false, backupCreated: false, backupUsed: false };
    }
  });
  await apply(ctx, value);

  assert.equal(calls.applyTrayRestart.length, 1);
  assert.equal(calls.notify.length, 0, "no bubble on a no-op patch");
  assert.equal(ctx.lines.length, 1);
  assert.equal(ctx.lines[0].level, "info");
});

test("apply does nothing off Windows and logs info", async () => {
  const ctx = fakeCtx();
  const { value, calls } = deps({ platform: "darwin" });
  await apply(ctx, value);

  assert.deepEqual(calls.applyTrayRestart, [], "no patch off Windows");
  assert.equal(calls.notify.length, 0);
  assert.equal(ctx.lines.length, 1);
  assert.equal(ctx.lines[0].level, "info");
  assert.match(ctx.lines[0].message, /windows/i);
});

test("apply does nothing when the asar is missing and logs info", async () => {
  const ctx = fakeCtx();
  const { value, calls } = deps({ asarExists: () => false });
  await apply(ctx, value);

  assert.deepEqual(calls.applyTrayRestart, []);
  assert.equal(calls.notify.length, 0);
  assert.equal(ctx.lines.length, 1);
  assert.equal(ctx.lines[0].level, "info");
  assert.match(ctx.lines[0].message, /app\.asar/);
});

test("apply warns instead of throwing when the patch fails", async () => {
  const ctx = fakeCtx();
  const { value, calls } = deps({
    applyTrayRestart: () => {
      throw new Error("unsupported DSH Desktop build: missing token");
    }
  });
  await assert.doesNotReject(() => apply(ctx, value));

  assert.equal(calls.notify.length, 0);
  assert.equal(ctx.lines.length, 1);
  assert.equal(ctx.lines[0].level, "warn");
  assert.match(ctx.lines[0].message, /missing token/);
});

test("apply warns instead of throwing when the patch module cannot be imported", async () => {
  const ctx = fakeCtx();
  const { value, calls } = deps({
    // No applyTrayRestart stub: the entry must reach the patch through the
    // import, so a failing import is the only thing that can run.
    applyTrayRestart: undefined,
    importPatch: async () => {
      throw new Error("module exploded");
    }
  });
  await assert.doesNotReject(() => apply(ctx, value));

  assert.deepEqual(calls.applyTrayRestart, []);
  assert.equal(ctx.lines[0].level, "warn");
  assert.match(ctx.lines[0].message, /module exploded/);
});

test("apply warns instead of throwing when the notification fails", async () => {
  const ctx = fakeCtx();
  const { value } = deps({
    notify: () => {
      throw new Error("no notification channel");
    }
  });
  await assert.doesNotReject(() => apply(ctx, value));

  // The patch itself succeeded, so its info line is still there; the failed
  // bubble adds a warning and never turns into a rejected promise.
  assert.equal(ctx.lines.filter((line) => line.level === "info").length, 1);
  assert.equal(ctx.lines.filter((line) => line.level === "warn").length, 1);
});

test("apply defaults to the real patch module and a real asar check", async () => {
  const ctx = fakeCtx();
  // A path that cannot exist keeps the test off the real installation: the
  // default asarExists must report false and the entry must stop there.
  const missing = join(mkdtempSync(join(tmpdir(), "dsh-tray-restart-entry-")), "app.asar");
  try {
    await apply(ctx, { platform: "win32", asarPath: missing });
  } finally {
    rmSync(join(missing, ".."), { recursive: true, force: true });
  }
  assert.equal(ctx.lines.length, 1);
  assert.equal(ctx.lines[0].level, "info");
  assert.match(ctx.lines[0].message, /app\.asar/);
});

test("APPLY_DEFAULTS exposes the platform and asar path the Host entry uses", () => {
  assert.equal(typeof APPLY_DEFAULTS.platform, "string");
  assert.equal(typeof APPLY_DEFAULTS.asarPath, "string");
  assert.equal(APPLY_DEFAULTS.asarPath.endsWith("app.asar"), true);
});
