import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKUP_DIR_ENV } from "../src/backup.js";

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

// ── Named facts about the 0.2.2-rc.3 build ────────────────────────────────
//
// These numbers describe the measured build, not this repository's layout, so
// they are named once here and asserted against the fixture rather than pasted
// into every test that happens to need them.

/** Byte length of the stock `lib/main.js` in DSH Desktop 0.2.2-rc.3. */
export const STOCK_MAIN_BYTES = 848_505;

/** Byte offset of the tray region start marker in the stock `lib/main.js`. */
export const STOCK_REGION_START = 779_389;

/** Byte length of the stock tray region, trailing newline included. */
export const STOCK_REGION_LENGTH = 1_254;

/** Byte length of the stock tray region without the trailing newline. */
export const STOCK_REGION_BODY = STOCK_REGION_LENGTH - 1;

/** Byte length of the installed `app.asar` on the measured machine. */
export const STOCK_ASAR_BYTES = 209_021_953;

/** Byte string that opens the tray region inside `lib/main.js`. */
export const REGION_START_MARKER = "//#region lib/types/tray.js";

/** Path of `lib/main.js` inside the asar tree. */
export const MAIN_PATH = ["lib", "main.js"];

// ── The stock fixture ─────────────────────────────────────────────────────

/**
 * Absolute path of the stock `lib/main.js` fixture, or null when unset.
 *
 * The fixture is a byte-for-byte copy of `lib/main.js` extracted from the
 * packaged DSH Desktop `app.asar`. It is 848505 bytes, so it is not committed;
 * point `DSH_TRAY_FIXTURE` at a copy on the machine running the tests.
 *
 * There is deliberately no default path: a checked-in absolute path would name
 * one developer's directory, and this repository does not ship the bytes.
 */
export const FIXTURE_PATH = process.env.DSH_TRAY_FIXTURE || null;

export const FIXTURE_MISSING_MESSAGE =
  "[fixture-missing] DSH_TRAY_FIXTURE is not set (or points at a missing file). " +
  "Set it to the path of the stock lib/main.js extracted from DSH Desktop's " +
  "resources/app.asar, e.g. " +
  "DSH_TRAY_FIXTURE=/path/to/main-stock.js npm test. " +
  "The asar tests that need a real archive also read DSH_TRAY_ASAR.";

/** @returns {Buffer | null} the stock `lib/main.js` bytes, or null when the fixture is absent. */
export function loadStockMain() {
  if (FIXTURE_PATH === null || !existsSync(FIXTURE_PATH)) return null;
  return readFileSync(FIXTURE_PATH);
}

/**
 * node:test `skip` option. Tests that need the fixture pass this so a machine
 * without it skips them with the explicit message above instead of failing.
 */
export function fixtureSkip() {
  if (FIXTURE_PATH !== null && existsSync(FIXTURE_PATH)) return false;
  console.log(FIXTURE_MISSING_MESSAGE);
  return FIXTURE_MISSING_MESSAGE;
}

// ── The installed asar ────────────────────────────────────────────────────

/**
 * Absolute path of the installed DSH Desktop asar, or null when unset.
 *
 * Like the fixture, there is no default: the install directory is a property of
 * one machine. Set `DSH_TRAY_ASAR` to run the integration suites.
 */
export const REAL_ASAR_PATH = process.env.DSH_TRAY_ASAR || null;

/** True when both the fixture and the installed asar are available. */
export function asarSkip() {
  const fixture = fixtureSkip();
  if (fixture !== false) return fixture;
  if (REAL_ASAR_PATH === null || !existsSync(REAL_ASAR_PATH)) {
    const message = `[asar-missing] DSH_TRAY_ASAR is not set (or points at a missing file): ${REAL_ASAR_PATH}`;
    console.log(message);
    return message;
  }
  return false;
}

// ── Reading an asar from a buffer ─────────────────────────────────────────

/** Parse the pickle header of an asar held in memory. */
export function readHeader(buf) {
  const pickleSize = buf.readUInt32LE(4);
  const jsonSize = buf.readUInt32LE(12);
  const dataOffset = 8 + pickleSize;
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString("utf8"));
  return { dataOffset, jsonSize, header };
}

/** Walk the header tree to a file node. */
export function nodeAt(header, parts) {
  let node = header;
  for (const part of parts) node = node.files[part];
  return node;
}

/** Read one file out of an in-memory asar by walking the header. */
export function readEntry(buf, parts) {
  const { dataOffset, header } = readHeader(buf);
  const node = nodeAt(header, parts);
  const start = dataOffset + Number(node.offset);
  return buf.subarray(start, start + Number(node.size));
}

/** Read one file out of an in-memory asar and parse it as JSON. */
export function readJsonEntry(buf, parts) {
  return JSON.parse(readEntry(buf, parts).toString("utf8"));
}

/** Hex SHA-256 of a buffer. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── Sandbox ───────────────────────────────────────────────────────────────

/**
 * A fresh copy of the installed asar plus a fresh, empty backup directory.
 *
 * The backup directory is redirected with `DSH_TRAY_RESTART_BACKUP_DIR` so the
 * real `~/.dsh/tray-restart-backup` is never touched, and every copy lives under
 * a temp directory so the real `app.asar` is never written.
 *
 * @param {string} root a temp directory owned by the caller.
 * @returns {{ dir: string, asarCopy: string, backup: string }}
 */
export function sandboxAsar(root) {
  const dir = mkdtempSync(join(root, "case-"));
  const asarCopy = join(dir, "app.asar");
  copyFileSync(REAL_ASAR_PATH, asarCopy);
  const backup = join(dir, "backup");
  process.env[BACKUP_DIR_ENV] = backup;
  return { dir, asarCopy, backup };
}

/**
 * Redirect the backup directory for the duration of the process and restore the
 * previous value afterwards.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} dir
 */
export function useBackupDir(t, dir) {
  const previous = process.env[BACKUP_DIR_ENV];
  process.env[BACKUP_DIR_ENV] = dir;
  t.after(() => {
    if (previous === undefined) delete process.env[BACKUP_DIR_ENV];
    else process.env[BACKUP_DIR_ENV] = previous;
  });
}

/** A fresh temp directory under the OS temp dir. */
export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
