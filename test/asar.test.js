import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStockMain, fixtureSkip } from "./fixture.js";
import { PATCH_MARKER, STOCK_TRAY_REGION } from "../src/patch.js";
import { applyTrayRestart, restoreTrayRestart } from "../src/asar.js";
import { BACKUP_DIR_ENV } from "../src/backup.js";

/**
 * Path of the installed DSH Desktop asar. Only ever read: every test that
 * writes works on a temporary copy made once in `before`.
 */
const REAL_ASAR = process.env.DSH_TRAY_ASAR
  ?? "D:\\Program Files\\Deepseek\\resources\\app.asar";

const skip = fixtureSkip() || (existsSync(REAL_ASAR) ? false : `[asar-missing] ${REAL_ASAR}`);

const MAIN_PATH = ["lib", "main.js"];
const REGION_START_MARKER = "//#region lib/types/tray.js";

/** @type {string} */
let workDir;
/** @type {string} */
let asarCopy;
let stockMain;

/** Read the asar header: data offset, JSON size and the parsed tree. */
function readHeader(buf) {
  const pickleSize = buf.readUInt32LE(4);
  const jsonSize = buf.readUInt32LE(12);
  const dataOffset = 8 + pickleSize;
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString("utf8"));
  return { dataOffset, jsonSize, header };
}

/** Resolve a path inside the header tree. */
function nodeAt(header, parts) {
  let node = header;
  for (const part of parts) node = node.files[part];
  return node;
}

/** Absolute byte offset of a file's content inside the asar. */
function absoluteOffset(buf, parts) {
  const { dataOffset, header } = readHeader(buf);
  const node = nodeAt(header, parts);
  return dataOffset + Number(node.offset);
}

/** Read one file out of the asar by walking the header from the buffer. */
function readEntry(buf, parts) {
  const start = absoluteOffset(buf, parts);
  const node = nodeAt(readHeader(buf).header, parts);
  return buf.subarray(start, start + Number(node.size));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

let previousBackupEnv;

before(() => {
  if (skip) return;
  workDir = mkdtempSync(join(tmpdir(), "dsh-tray-restart-asar-"));
  asarCopy = join(workDir, "app.asar");
  copyFileSync(REAL_ASAR, asarCopy);
  stockMain = loadStockMain();
  // applyTrayRestart writes a backup; keep it inside the temp directory so the
  // real ~/.dsh/tray-restart-backup is never touched by the test suite.
  previousBackupEnv = process.env[BACKUP_DIR_ENV];
  process.env[BACKUP_DIR_ENV] = join(workDir, "backup");
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

test("the patched asar still parses as an asar and lib/main.js passes node --check", { skip }, async () => {
  const buf = readFileSync(asarCopy);
  const { header } = readHeader(buf);
  assert.ok(header.files.lib, "header must still parse");
  const main = readEntry(buf, MAIN_PATH);
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
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
  const real = readFileSync(REAL_ASAR);
  assert.equal(real.length, 209021953);
  const main = readEntry(real, MAIN_PATH);
  assert.ok(!main.includes(PATCH_MARKER), "the installed asar must still be stock");
});
