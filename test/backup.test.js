import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_DIR_ENV,
  backupDir,
  backupExists,
  readBackup,
  writeBackup
} from "../src/backup.js";
import { STOCK_REGION_START } from "./fixture.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A temporary backup directory, removed when the test ends. */
function tempBackupDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tray-restart-backup-"));
  const previous = process.env[BACKUP_DIR_ENV];
  process.env[BACKUP_DIR_ENV] = dir;
  t.after(() => {
    if (previous === undefined) delete process.env[BACKUP_DIR_ENV];
    else process.env[BACKUP_DIR_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const REGION = Buffer.from("//#region lib/types/tray.js\nstock bytes\n//#endregion\n", "utf8");

test("backupDir honours the environment override", (t) => {
  const dir = tempBackupDir(t);
  assert.equal(backupDir(), dir);
});

test("backupExists is false before anything is written", (t) => {
  tempBackupDir(t);
  assert.equal(backupExists(), false);
});

test("writeBackup stores the region bytes and a JSON sidecar", (t) => {
  const dir = tempBackupDir(t);
  const result = writeBackup({
    region: REGION,
    regionStart: STOCK_REGION_START,
    dshVersion: "0.2.2-rc.3",
    asarPath: "C:\\tmp\\app.asar"
  });
  assert.equal(result.created, true);
  assert.equal(backupExists(), true);

  const files = readFileSync(result.metaFile);
  const meta = JSON.parse(files.toString("utf8"));
  assert.equal(meta.dshVersion, "0.2.2-rc.3");
  assert.equal(meta.regionStart, STOCK_REGION_START);
  assert.equal(meta.regionLength, REGION.length);
  assert.equal(meta.sha256, sha256(REGION));
  assert.equal(meta.asarPath, "C:\\tmp\\app.asar");

  const bytes = readFileSync(result.regionFile);
  assert.ok(bytes.equals(REGION), "the stored region bytes must equal the input");
});

test("readBackup returns the stored region and its metadata", (t) => {
  tempBackupDir(t);
  writeBackup({ region: REGION, regionStart: STOCK_REGION_START, dshVersion: "0.2.2-rc.3" });
  const backup = readBackup();
  assert.ok(backup.region.equals(REGION));
  assert.equal(backup.meta.sha256, sha256(REGION));
  assert.equal(backup.meta.regionLength, REGION.length);
});

test("a second writeBackup does not overwrite the first backup", (t) => {
  tempBackupDir(t);
  writeBackup({ region: REGION, regionStart: STOCK_REGION_START, dshVersion: "0.2.2-rc.3" });
  const other = Buffer.from("//#region lib/types/tray.js\ndifferent\n//#endregion\n", "utf8");
  const second = writeBackup({ region: other, regionStart: 1, dshVersion: "9.9.9" });
  assert.equal(second.created, false);
  const backup = readBackup();
  assert.ok(backup.region.equals(REGION), "the first backup must win");
  assert.equal(backup.meta.dshVersion, "0.2.2-rc.3");
});

test("readBackup throws a clear error when no backup exists", (t) => {
  tempBackupDir(t);
  assert.throws(() => readBackup(), (error) => {
    assert.equal(error.name, "BackupMissingError");
    assert.match(error.message, /no tray-restart backup/);
    return true;
  });
});

test("readBackup rejects a backup whose bytes do not match the recorded SHA-256", (t) => {
  const dir = tempBackupDir(t);
  const result = writeBackup({ region: REGION, regionStart: STOCK_REGION_START, dshVersion: "0.2.2-rc.3" });
  const meta = JSON.parse(readFileSync(result.metaFile, "utf8"));
  writeFileSync(result.regionFile, Buffer.from("tampered", "utf8"));
  assert.throws(() => readBackup(), (error) => {
    assert.equal(error.name, "BackupCorruptError");
    return true;
  });
});
