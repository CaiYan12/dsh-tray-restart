/**
 * Backup: the stock tray region, saved before the first patch.
 *
 * Restoring needs the exact bytes that were replaced. The pure patch core cannot
 * read the asar, and a hardcoded copy of the stock region only holds for one DSH
 * release, so the first patch writes the region it is about to overwrite into a
 * fixed directory together with a JSON sidecar describing it.
 *
 * Two files, both under the backup directory:
 *
 *   tray-region.bin   the stock region bytes, verbatim
 *   meta.json         DSH version, region offset, region length, SHA-256
 *
 * The backup is written once and never overwritten: it records the region as it
 * was before any patch, so a later write would capture patched bytes instead.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Environment variable that redirects the backup directory (tests point it at a temp dir). */
export const BACKUP_DIR_ENV = "DSH_TRAY_RESTART_BACKUP_DIR";

/** File name of the stored stock region bytes. */
export const REGION_FILE = "tray-region.bin";

/** File name of the JSON sidecar. */
export const META_FILE = "meta.json";

/** Thrown when a restore is attempted but no backup was ever written. */
export class BackupMissingError extends Error {
  constructor(dir) {
    super(`no tray-restart backup in ${dir}; patch the tray once before restoring`);
    this.name = "BackupMissingError";
    this.dir = dir;
  }
}

/** Thrown when the stored bytes do not match the recorded SHA-256. */
export class BackupCorruptError extends Error {
  constructor(reason) {
    super(`tray-restart backup is corrupt: ${reason}`);
    this.name = "BackupCorruptError";
  }
}

/** Absolute path of the backup directory: `~/.dsh/tray-restart-backup/` unless overridden. */
export function backupDir() {
  const override = process.env[BACKUP_DIR_ENV];
  if (override) return override;
  return join(homedir(), ".dsh", "tray-restart-backup");
}

/** True when a backup is already present. */
export function backupExists() {
  const dir = backupDir();
  return existsSync(join(dir, META_FILE)) && existsSync(join(dir, REGION_FILE));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * @typedef {object} BackupInput
 * @property {Buffer} region        the stock region bytes, verbatim.
 * @property {number} regionStart   byte offset of the region inside `lib/main.js`.
 * @property {string} dshVersion    `version` from the asar's `package.json`.
 * @property {string} [asarPath]    the asar the region came from.
 */

/**
 * Write the backup, unless one already exists.
 *
 * @param {BackupInput} input
 * @returns {{ created: boolean, dir: string, regionFile: string, metaFile: string }}
 */
export function writeBackup(input) {
  const dir = backupDir();
  const regionFile = join(dir, REGION_FILE);
  const metaFile = join(dir, META_FILE);
  if (existsSync(metaFile) && existsSync(regionFile)) {
    return { created: false, dir, regionFile, metaFile };
  }

  const region = Buffer.from(input.region);
  const meta = {
    dshVersion: input.dshVersion,
    regionStart: input.regionStart,
    regionLength: region.length,
    sha256: sha256(region),
    asarPath: input.asarPath ?? null,
    createdAt: new Date().toISOString()
  };

  mkdirSync(dir, { recursive: true });
  // Write the bytes first, then the sidecar: a sidecar without bytes is treated as
  // no backup, so a crash between the two writes leaves a retryable state.
  writeFileSync(regionFile, region);
  const temp = `${metaFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  renameSync(temp, metaFile);
  return { created: true, dir, regionFile, metaFile };
}

/**
 * Read the backup back, verifying the stored bytes against the recorded SHA-256.
 *
 * @returns {{ region: Buffer, meta: object, dir: string }}
 */
export function readBackup() {
  const dir = backupDir();
  const regionFile = join(dir, REGION_FILE);
  const metaFile = join(dir, META_FILE);
  if (!existsSync(metaFile) || !existsSync(regionFile)) throw new BackupMissingError(dir);

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaFile, "utf8"));
  } catch (error) {
    throw new BackupCorruptError(`meta.json is not parseable: ${error.message}`);
  }
  const region = readFileSync(regionFile);
  if (region.length !== meta.regionLength) {
    throw new BackupCorruptError(
      `stored region is ${region.length} bytes, meta.json records ${meta.regionLength}`
    );
  }
  if (sha256(region) !== meta.sha256) {
    throw new BackupCorruptError("stored region does not match the recorded SHA-256");
  }
  return { region, meta, dir };
}
