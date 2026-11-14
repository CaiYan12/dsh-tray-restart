import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStockMain, fixtureSkip } from "./fixture.js";
import { PATCH_MARKER } from "../src/patch.js";
import { applyTrayRestart, restoreTrayRestart } from "../src/asar.js";
import { BACKUP_DIR_ENV, backupExists, readBackup } from "../src/backup.js";

/**
 * The installed asar. Only ever read: every test works on its own temporary copy.
 */
const REAL_ASAR = process.env.DSH_TRAY_ASAR
  ?? "D:\\Program Files\\Deepseek\\resources\\app.asar";

const skip = fixtureSkip() || (existsSync(REAL_ASAR) ? false : `[asar-missing] ${REAL_ASAR}`);

const MAIN_PATH = ["lib", "main.js"];
const REGION_START_MARKER = "//#region lib/types/tray.js";

/** @type {string} */
let workRoot;
/** @type {string} */
let stockMain;
/** @type {string[]} */
const madeDirs = [];
let previousBackupEnv;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readHeader(buf) {
  const pickleSize = buf.readUInt32LE(4);
  const jsonSize = buf.readUInt32LE(12);
  const dataOffset = 8 + pickleSize;
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString("utf8"));
  return { dataOffset, header };
}

function nodeAt(header, parts) {
  let node = header;
  for (const part of parts) node = node.files[part];
  return node;
}

function readEntry(buf, parts) {
  const { dataOffset, header } = readHeader(buf);
  const node = nodeAt(header, parts);
  const start = dataOffset + Number(node.offset);
  return buf.subarray(start, start + Number(node.size));
}

/** Read one file out of the asar as text (used for package.json). */
function readJsonEntry(buf, parts) {
  return JSON.parse(readEntry(buf, parts).toString("utf8"));
}

/**
 * A fresh asar copy plus a fresh, empty backup directory, both under a temp root.
 * The environment override keeps the real ~/.dsh/tray-restart-backup untouched.
 */
function sandbox(t) {
  const dir = mkdtempSync(join(workRoot, "case-"));
  const asarCopy = join(dir, "app.asar");
  copyFileSync(REAL_ASAR, asarCopy);
  const backup = join(dir, "backup");
  process.env[BACKUP_DIR_ENV] = backup;
  madeDirs.push(dir);
  return { dir, asarCopy, backup };
}

before(() => {
  if (skip) return;
  workRoot = mkdtempSync(join(tmpdir(), "dsh-tray-restart-backup-it-"));
  stockMain = loadStockMain();
  previousBackupEnv = process.env[BACKUP_DIR_ENV];
});

after(() => {
  if (previousBackupEnv === undefined) delete process.env[BACKUP_DIR_ENV];
  else process.env[BACKUP_DIR_ENV] = previousBackupEnv;
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

test("the first patch writes a backup of the stock region before patching", { skip }, (t) => {
  const { asarCopy } = sandbox(t);
  const original = readFileSync(asarCopy);
  const originalMain = readEntry(original, MAIN_PATH);
  const regionStart = originalMain.indexOf(REGION_START_MARKER);
  const version = readJsonEntry(original, ["package.json"]).version;

  assert.equal(backupExists(), false, "no backup before the first patch");

  const result = applyTrayRestart(asarCopy);
  assert.equal(result.changed, true);
  assert.equal(result.backupCreated, true);

  assert.equal(backupExists(), true);
  const backup = readBackup();
  const stockRegion = originalMain.subarray(regionStart, regionStart + backup.region.length);
  assert.ok(backup.region.equals(stockRegion), "the backup holds the stock region bytes");
  assert.equal(backup.meta.regionStart, regionStart);
  assert.equal(backup.meta.regionLength, backup.region.length);
  assert.equal(backup.meta.sha256, sha256(backup.region));
  assert.equal(backup.meta.dshVersion, version);
  assert.match(backup.meta.dshVersion, /^\d+\.\d+\.\d+/);
});

test("patching again does not overwrite the existing backup", { skip }, (t) => {
  const { asarCopy } = sandbox(t);
  applyTrayRestart(asarCopy);
  const first = readBackup();

  // Restore, then patch again: the second patch must not capture patched bytes.
  restoreTrayRestart(asarCopy);
  const second = applyTrayRestart(asarCopy);
  assert.equal(second.changed, true);
  assert.equal(second.backupCreated, false);

  const after = readBackup();
  assert.ok(after.region.equals(first.region), "the first backup must win");
  assert.equal(after.meta.sha256, first.meta.sha256);
  assert.equal(after.meta.createdAt, first.meta.createdAt);
});

test("restore reads the backup and writes those bytes back", { skip }, (t) => {
  const { asarCopy } = sandbox(t);
  const original = readFileSync(asarCopy);
  applyTrayRestart(asarCopy);
  const backup = readBackup();

  const result = restoreTrayRestart(asarCopy);
  assert.equal(result.changed, true);
  assert.equal(result.backupUsed, true);

  const after = readFileSync(asarCopy);
  const main = readEntry(after, MAIN_PATH);
  assert.ok(main.equals(readEntry(original, MAIN_PATH)), "restored lib/main.js equals the stock bytes");
  assert.ok(
    main.subarray(backup.meta.regionStart, backup.meta.regionStart + backup.meta.regionLength)
      .equals(backup.region),
    "the region equals the backed-up bytes"
  );
  assert.ok(!main.includes(PATCH_MARKER));
});

test("restore without a backup throws a clear error and leaves the asar alone", { skip }, (t) => {
  const { asarCopy } = sandbox(t);
  applyTrayRestart(asarCopy);
  const patched = readFileSync(asarCopy);
  rmSync(process.env[BACKUP_DIR_ENV], { recursive: true, force: true });

  assert.throws(() => restoreTrayRestart(asarCopy), (error) => {
    assert.equal(error.name, "BackupMissingError");
    assert.match(error.message, /no tray-restart backup/);
    return true;
  });
  assert.ok(readFileSync(asarCopy).equals(patched), "a refused restore must not touch the asar");
});

test("restore on a never-patched asar still reports changed false without a backup", { skip }, (t) => {
  const { asarCopy } = sandbox(t);
  const original = readFileSync(asarCopy);
  const result = restoreTrayRestart(asarCopy);
  assert.equal(result.changed, false);
  assert.equal(result.backupUsed, false);
  assert.ok(readFileSync(asarCopy).equals(original));
});
