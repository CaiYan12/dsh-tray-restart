import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStockMain, fixtureSkip, repoRoot } from "./fixture.js";
import { PATCH_MARKER } from "../src/patch.js";
import { applyTrayRestart } from "../src/asar.js";
import { BACKUP_DIR_ENV } from "../src/backup.js";
import {
  CHECK_EXIT,
  DEFAULT_ASAR_PATH,
  asarPathFromArgs,
  checkExitCode,
  formatCheckReport,
  formatRestoreReport,
  readInstallStatus
} from "../scripts/install-status.mjs";

/**
 * The installed asar. Only ever read: every case works on a temporary copy, and
 * the backup directory is redirected with DSH_TRAY_RESTART_BACKUP_DIR so the
 * real ~/.dsh/tray-restart-backup is never touched.
 */
const REAL_ASAR = process.env.DSH_TRAY_ASAR
  ?? "D:\\Program Files\\Deepseek\\resources\\app.asar";

const skip = fixtureSkip() || (existsSync(REAL_ASAR) ? false : `[asar-missing] ${REAL_ASAR}`);

/** @type {string} */
let workRoot;
let previousBackupEnv;

/** A fresh asar copy plus a fresh, empty backup directory under the temp root. */
function sandbox() {
  const dir = mkdtempSync(join(workRoot, "case-"));
  const asarCopy = join(dir, "app.asar");
  copyFileSync(REAL_ASAR, asarCopy);
  const backup = join(dir, "backup");
  process.env[BACKUP_DIR_ENV] = backup;
  return { dir, asarCopy, backup };
}

before(() => {
  if (skip) return;
  workRoot = mkdtempSync(join(tmpdir(), "dsh-tray-restart-install-status-"));
  previousBackupEnv = process.env[BACKUP_DIR_ENV];
});

after(() => {
  if (previousBackupEnv === undefined) delete process.env[BACKUP_DIR_ENV];
  else process.env[BACKUP_DIR_ENV] = previousBackupEnv;
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

// ── readInstallStatus: the state the two scripts report on ─────────────────

test("a stock asar reports not patched with the version and region range", { skip }, () => {
  const { asarCopy } = sandbox();
  const status = readInstallStatus(asarCopy);

  assert.equal(status.exists, true);
  assert.equal(status.asarPath, asarCopy);
  assert.equal(status.patched, false);
  assert.equal(status.dshVersion, "0.2.2-rc.3");
  assert.equal(status.regionStart, 779389);
  assert.equal(status.regionLength, 1254);
  assert.equal(status.regionEnd, 779389 + 1254);
  assert.equal(status.backup.exists, false);
});

test("a patched asar reports patched and keeps the region range", { skip }, () => {
  const { asarCopy } = sandbox();
  applyTrayRestart(asarCopy);
  const status = readInstallStatus(asarCopy);

  assert.equal(status.patched, true);
  assert.equal(status.regionStart, 779389);
  assert.equal(status.regionLength, 1254);
  assert.equal(status.backup.exists, true);
  assert.equal(status.backup.meta.regionStart, 779389);
  assert.match(status.backup.meta.sha256, /^[0-9a-f]{64}$/);
});

test("a missing asar reports exists false instead of throwing", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "dsh-tray-restart-absent-")), "app.asar");
  // The backup directory is redirected by the other cases in this file, so the
  // backup is read here explicitly rather than inherited from the environment.
  const status = readInstallStatus(missing, { backup: { exists: false, dir: "C:\\\\x\\\\backup" } });
  assert.equal(status.exists, false);
  assert.equal(status.patched, false);
  assert.equal(status.regionStart, null);
  assert.equal(status.backup.exists, false);
});

test("a file that is not an asar reports the parse error instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tray-restart-not-asar-"));
  const file = join(dir, "app.asar");
  try {
    writeFileSync(file, "not an asar at all");
    const status = readInstallStatus(file);
    assert.equal(status.exists, true);
    assert.equal(status.patched, false);
    assert.match(status.error, /not a supported asar/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── checkExitCode: the contract scripts depend on ─────────────────────────

test("checkExitCode is 0 only for a patched, readable asar", () => {
  assert.equal(checkExitCode({ exists: true, patched: true }), CHECK_EXIT.patched);
  assert.equal(checkExitCode({ exists: true, patched: false }), CHECK_EXIT.notPatched);
  assert.equal(checkExitCode({ exists: false, patched: false }), CHECK_EXIT.unreadable);
  assert.equal(checkExitCode({ exists: true, patched: false, error: "boom" }), CHECK_EXIT.unreadable);
});

test("the exit codes are 0, 1 and 2", () => {
  assert.deepEqual(CHECK_EXIT, { patched: 0, notPatched: 1, unreadable: 2 });
});

// ── formatCheckReport: what the user reads ────────────────────────────────

test("the check report names the asar, the version, the state and the region", () => {
  const text = formatCheckReport({
    exists: true,
    asarPath: "C:\\x\\app.asar",
    dshVersion: "0.2.2-rc.3",
    patched: false,
    regionStart: 779389,
    regionLength: 1254,
    regionEnd: 780643,
    backup: { exists: false, dir: "C:\\x\\backup" }
  });
  assert.match(text, /C:\\x\\app\.asar/);
  assert.match(text, /0\.2\.2-rc\.3/);
  assert.match(text, /not patched/i);
  assert.match(text, /779389/);
  assert.match(text, /1254/);
  assert.match(text, /no backup/i);
});

test("the check report says patched and prints the backup metadata", () => {
  const text = formatCheckReport({
    exists: true,
    asarPath: "C:\\x\\app.asar",
    dshVersion: "0.2.2-rc.3",
    patched: true,
    regionStart: 779389,
    regionLength: 1254,
    regionEnd: 780643,
    backup: {
      exists: true,
      dir: "C:\\x\\backup",
      meta: {
        dshVersion: "0.2.2-rc.3",
        regionStart: 779389,
        regionLength: 1254,
        sha256: "a".repeat(64),
        createdAt: "2026-11-14T00:00:00.000Z"
      }
    }
  });
  assert.match(text, /patched/i);
  assert.match(text, /2026-11-14T00:00:00\.000Z/);
  assert.match(text, /a{64}/);
});

test("the check report says the asar is missing", () => {
  const text = formatCheckReport({ exists: false, asarPath: "C:\\x\\app.asar", patched: false, backup: { exists: false } });
  assert.match(text, /not found/i);
  assert.match(text, /C:\\x\\app\.asar/);
});

// ── formatRestoreReport ───────────────────────────────────────────────────

test("the restore report says restored when the region changed", () => {
  const text = formatRestoreReport({ changed: true, asarPath: "C:\\x\\app.asar", backupUsed: true, mainBytes: 848505 });
  assert.match(text, /restored/i);
  assert.match(text, /C:\\x\\app\.asar/);
});

test("the restore report says already stock when nothing changed", () => {
  const text = formatRestoreReport({ changed: false, asarPath: "C:\\x\\app.asar", backupUsed: false, mainBytes: 848505 });
  assert.match(text, /already stock/i);
});

// ── asarPathFromArgs: argument, then environment, then default ─────────────

test("asarPathFromArgs prefers the argument, then the environment, then the default", () => {
  assert.equal(asarPathFromArgs(["C:\\a\\app.asar"], {}), "C:\\a\\app.asar");
  assert.equal(asarPathFromArgs([], { DSH_DESKTOP_APP_ASAR: "C:\\b\\app.asar" }), "C:\\b\\app.asar");
  assert.equal(asarPathFromArgs([], {}), DEFAULT_ASAR_PATH);
});

// ── the scripts as processes: the acceptance criteria ─────────────────────

function runScript(script, args, env) {
  return spawnSync(process.execPath, [join(repoRoot, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

test("check-install exits 1 on a stock asar and 0 once patched", { skip }, () => {
  const { asarCopy, backup } = sandbox();
  const env = { [BACKUP_DIR_ENV]: backup };

  const before = runScript("check-install.mjs", [asarCopy], env);
  assert.equal(before.status, CHECK_EXIT.notPatched, before.stderr);
  assert.match(before.stdout, /not patched/i);

  applyTrayRestart(asarCopy);

  const after = runScript("check-install.mjs", [asarCopy], env);
  assert.equal(after.status, CHECK_EXIT.patched, after.stderr);
  assert.match(after.stdout, /patched/i);
});

test("restore-install restores the stock region and check-install then reports not patched", { skip }, () => {
  const { asarCopy, backup } = sandbox();
  const env = { [BACKUP_DIR_ENV]: backup };
  const original = readFileSync(asarCopy);
  applyTrayRestart(asarCopy);

  const restored = runScript("restore-install.mjs", [asarCopy], env);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /restored/i);

  const after = readFileSync(asarCopy);
  assert.ok(after.equals(original), "the asar is byte-identical to the stock copy");
  assert.ok(!after.includes(PATCH_MARKER));

  const check = runScript("check-install.mjs", [asarCopy], env);
  assert.equal(check.status, CHECK_EXIT.notPatched, check.stderr);
  assert.match(check.stdout, /not patched/i);
});

test("restore-install exits non-zero with a clear message when the backup is gone", { skip }, () => {
  const { asarCopy, backup } = sandbox();
  applyTrayRestart(asarCopy);
  rmSync(backup, { recursive: true, force: true });

  const result = runScript("restore-install.mjs", [asarCopy], { [BACKUP_DIR_ENV]: backup });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no tray-restart backup/);
});

test("restore-install on a stock asar says already stock and exits 0", { skip }, () => {
  const { asarCopy, backup } = sandbox();
  const result = runScript("restore-install.mjs", [asarCopy], { [BACKUP_DIR_ENV]: backup });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already stock/i);
});

test("restore-install exits 2 when the asar is missing", () => {
  const missing = join(tmpdir(), `dsh-tray-restart-missing-${process.pid}.asar`);
  const result = runScript("restore-install.mjs", [missing], {});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not found/i);
});

test("check-install exits 2 when the asar is missing", () => {
  const missing = join(tmpdir(), `dsh-tray-restart-missing-${process.pid}.asar`);
  const result = runScript("check-install.mjs", [missing], {});
  assert.equal(result.status, CHECK_EXIT.unreadable);
  assert.match(result.stdout, /not found/i);
});
