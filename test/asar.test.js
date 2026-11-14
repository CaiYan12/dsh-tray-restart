import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAIN_PATH,
  REAL_ASAR_PATH,
  REGION_START_MARKER,
  STOCK_ASAR_BYTES,
  STOCK_MAIN_BYTES,
  asarSkip,
  loadStockMain,
  nodeAt,
  readEntry,
  readHeader,
  sandboxStockAsar,
  sha256,
  tempDir
} from "./fixture.js";
import { PATCH_MARKER, STOCK_TRAY_REGION } from "../src/patch.js";
import { applyTrayRestart, restoreTrayRestart } from "../src/asar.js";
import { BACKUP_DIR_ENV } from "../src/backup.js";

/**
 * The installed asar. Only ever read: every test that writes works on a
 * temporary copy made once in `before`.
 *
 * The copy is forced back to the stock tray region before the first test runs,
 * so the suite behaves the same whether the installation is stock or already
 * patched. Without that, a patched installation turned every "changed" assertion
 * below into a false failure.
 */
const skip = asarSkip();

/** @type {string} */
let workDir;
/** @type {string} */
let asarCopy;
let stockMain;
let previousBackupEnv;

before(() => {
  if (skip) return;
  workDir = tempDir("dsh-tray-restart-asar-");
  // sandboxStockAsar copies the installed asar and restores the copy to the stock
  // tray region, and points the backup directory inside the temp directory so the
  // real ~/.dsh/tray-restart-backup is never touched by the test suite.
  previousBackupEnv = process.env[BACKUP_DIR_ENV];
  asarCopy = sandboxStockAsar(workDir).asarCopy;
  stockMain = loadStockMain();
});

after(() => {
  if (previousBackupEnv === undefined) delete process.env[BACKUP_DIR_ENV];
  else process.env[BACKUP_DIR_ENV] = previousBackupEnv;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test("applyTrayRestart writes the patch into a real asar without changing its size", { skip }, () => {
  const before = readFileSync(asarCopy);
  const beforeSize = before.length;

  const result = applyTrayRestart(asarCopy);
  assert.equal(result.changed, true);
  assert.equal(result.asarPath, asarCopy);
  assert.equal(result.mainBytes, stockMain.length);
  assert.equal(result.integrityUpdated, true);

  const after = readFileSync(asarCopy);
  assert.equal(after.length, beforeSize, "total byte count must not change");

  const main = readEntry(after, MAIN_PATH);
  assert.equal(main.length, stockMain.length);
  assert.ok(main.includes(PATCH_MARKER), "patched lib/main.js must carry the marker");
  assert.match(main.toString("utf8"), /label: messages\.restartApplication \+ " DeepSeek Harness"/);
  assert.match(main.toString("utf8"), /app\.relaunch\(\);/);
});

test("applyTrayRestart rewrites the integrity record of lib/main.js", { skip }, () => {
  const buf = readFileSync(asarCopy);
  const { header } = readHeader(buf);
  const node = nodeAt(header, MAIN_PATH);
  const main = readEntry(buf, MAIN_PATH);

  assert.ok(node.integrity, "lib/main.js must carry an integrity record");
  assert.equal(node.integrity.algorithm, "SHA256");
  assert.equal(node.integrity.hash, sha256(main), "whole-file hash must match the patched bytes");

  const blockSize = node.integrity.blockSize;
  const expectedBlocks = [];
  for (let at = 0; at < main.length; at += blockSize) {
    expectedBlocks.push(sha256(main.subarray(at, at + blockSize)));
  }
  assert.deepEqual(node.integrity.blocks, expectedBlocks);
  assert.equal(node.integrity.blocks.length, 1);
});

test("applyTrayRestart keeps every other file readable at its recorded offset", { skip }, () => {
  const buf = readFileSync(asarCopy);
  const { dataOffset, header } = readHeader(buf);

  // Sample files spread over the archive, plus their neighbours in the tree.
  const samples = [
    ["package.json"],
    ["lib", "preload-app.cjs"],
    ["dsh", "package.json"],
    ["dsh", "desktop-runtime.json"],
    ["dsh", "node_modules", "acorn", "README.md"]
  ];
  let checked = 0;
  for (const parts of samples) {
    let node;
    try {
      node = nodeAt(header, parts);
    } catch {
      continue;
    }
    if (node.files || node.unpacked) continue;
    const start = dataOffset + Number(node.offset);
    const bytes = buf.subarray(start, start + Number(node.size));
    assert.equal(bytes.length, Number(node.size), `${parts.join("/")} must be fully readable`);
    assert.ok(bytes.length > 0);
    if (node.integrity?.hash) {
      assert.equal(sha256(bytes), node.integrity.hash, `${parts.join("/")} integrity must still match`);
    }
    checked += 1;
  }
  assert.ok(checked >= 2, `expected at least two sample files, checked ${checked}`);
});

test("the patched asar still parses as an asar and lib/main.js passes node --check", { skip }, () => {
  const buf = readFileSync(asarCopy);
  const { header } = readHeader(buf);
  assert.ok(header.files.lib, "header must still parse");
  const main = readEntry(buf, MAIN_PATH);
  const file = join(workDir, "patched-main.js");
  writeFileSync(file, main);
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("a second applyTrayRestart reports changed false and leaves the file untouched", { skip }, () => {
  const before = readFileSync(asarCopy);
  const beforeStat = statSync(asarCopy);
  const result = applyTrayRestart(asarCopy);
  assert.equal(result.changed, false);
  assert.equal(result.integrityUpdated, false);
  const after = readFileSync(asarCopy);
  assert.ok(after.equals(before), "an already patched asar must not be rewritten");
  assert.equal(statSync(asarCopy).mtimeMs, beforeStat.mtimeMs);
});

test("restoreTrayRestart puts the stock region back", { skip }, () => {
  const before = readFileSync(asarCopy);
  const result = restoreTrayRestart(asarCopy);
  assert.equal(result.changed, true);
  assert.equal(result.integrityUpdated, true);

  const after = readFileSync(asarCopy);
  assert.equal(after.length, before.length, "total byte count must not change");

  const main = readEntry(after, MAIN_PATH);
  assert.ok(main.equals(stockMain), "restored lib/main.js must equal the stock bytes");
  const regionStart = main.indexOf(REGION_START_MARKER);
  assert.ok(regionStart >= 0);
  assert.equal(
    main.subarray(regionStart, regionStart + STOCK_TRAY_REGION.length).toString("utf8"),
    STOCK_TRAY_REGION
  );
});

test("restoreTrayRestart rewrites the integrity record back to the stock hash", { skip }, () => {
  const buf = readFileSync(asarCopy);
  const { header } = readHeader(buf);
  const node = nodeAt(header, MAIN_PATH);
  const main = readEntry(buf, MAIN_PATH);
  assert.equal(node.integrity.hash, sha256(main));
  assert.deepEqual(node.integrity.blocks, [sha256(main)]);
});

test("a second restoreTrayRestart reports changed false", { skip }, () => {
  const before = readFileSync(asarCopy);
  const result = restoreTrayRestart(asarCopy);
  assert.equal(result.changed, false);
  const after = readFileSync(asarCopy);
  assert.ok(after.equals(before));
});

test("the real installed asar is never modified by the tests", { skip }, () => {
  // The installation may be stock or already patched by the plugin; either is a
  // legitimate state for a user's machine. What must not change is the archive
  // itself, so the whole file is compared before and after a full copy-and-patch.
  const real = readFileSync(REAL_ASAR_PATH);
  assert.equal(real.length, STOCK_ASAR_BYTES, "an asar patch is equal-length");
  const main = readEntry(real, MAIN_PATH);
  assert.equal(main.length, STOCK_MAIN_BYTES);

  const dir = tempDir("dsh-tray-restart-untouched-");
  try {
    const copy = join(dir, "app.asar");
    copyFileSync(REAL_ASAR_PATH, copy);
    applyTrayRestart(copy);
    restoreTrayRestart(copy);
    assert.ok(readFileSync(REAL_ASAR_PATH).equals(real), "the installed asar must be byte-identical");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the syntax gate: nothing is written unless the candidate parses ───────

test("a candidate that fails the syntax check is refused and the asar is untouched", { skip }, () => {
  const dir = tempDir("dsh-tray-restart-syntax-");
  try {
    // A stock copy: an already patched one would make the patch a no-op and never
    // reach the syntax gate this test is about.
    const copy = sandboxStockAsar(dir).asarCopy;
    const before = readFileSync(copy);

    assert.throws(
      () => applyTrayRestart(copy, { syntaxCheck: () => ({ status: "invalid", detail: "boom" }) }),
      (error) => {
        assert.equal(error.name, "SyntaxCheckError");
        assert.match(error.message, /failed the syntax check/);
        assert.match(error.message, /boom/);
        return true;
      }
    );
    assert.ok(readFileSync(copy).equals(before), "a refused patch must not touch the asar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a syntax check that cannot run is refused rather than skipped", { skip }, () => {
  const dir = tempDir("dsh-tray-restart-syntax-");
  try {
    const copy = sandboxStockAsar(dir).asarCopy;
    const before = readFileSync(copy);

    assert.throws(
      () => applyTrayRestart(copy, {
        syntaxCheck: () => ({ status: "unavailable", detail: "no node executable" })
      }),
      (error) => {
        assert.equal(error.name, "SyntaxCheckError");
        assert.match(error.message, /could not run/);
        assert.match(error.message, /refusing to write/);
        return true;
      }
    );
    assert.ok(readFileSync(copy).equals(before), "an unverified patch must not touch the asar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real syntax gate accepts the real patch", { skip }, () => {
  const dir = tempDir("dsh-tray-restart-syntax-");
  const previous = process.env[BACKUP_DIR_ENV];
  try {
    const copy = sandboxStockAsar(dir).asarCopy;
    const result = applyTrayRestart(copy);
    assert.equal(result.changed, true);
  } finally {
    if (previous === undefined) delete process.env[BACKUP_DIR_ENV];
    else process.env[BACKUP_DIR_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
