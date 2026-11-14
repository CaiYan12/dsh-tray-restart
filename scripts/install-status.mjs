/**
 * Install status: read what the installed `app.asar` looks like right now.
 *
 * Both maintenance scripts read their state through this module, so the
 * decision "is the tray patched" and the wording of the report are tested
 * once. Everything here is pure apart from `readInstallStatus`, which only
 * ever opens the asar for reading.
 *
 * The marker is the same one the patch core writes, so the answer here always
 * agrees with what the Host plugin would do on its next start.
 */

import { existsSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { dirname, join } from "node:path";

import { PATCH_MARKER } from "../src/patch.js";
import { backupDir, readBackup } from "../src/backup.js";

/** Environment variable that points the scripts at a specific asar. */
export const ASAR_ENV = "DSH_DESKTOP_APP_ASAR";

/**
 * `resources/app.asar` beside a running executable.
 *
 * This is the same rule the Host entry uses, so the scripts and the plugin always
 * agree on which asar they mean. It is derived rather than hardcoded: an install
 * directory is a property of one machine, not of this repository.
 *
 * @param {string} execPath the executable to derive from, normally `process.execPath`.
 * @returns {string}
 */
export function asarPathFromExecPath(execPath) {
  return join(dirname(execPath), "resources", "app.asar");
}

/**
 * The asar the scripts fall back to when neither an argument nor the environment
 * names one: `resources/app.asar` beside the running Node executable.
 *
 * Run the scripts with the desktop app's own executable (`DSH_DESKTOP_APP_ASAR`
 * or an explicit argument) when Node lives somewhere else, as it usually does.
 */
export const DEFAULT_ASAR_PATH = asarPathFromExecPath(process.execPath);

/** Byte string that opens the tray region inside `lib/main.js`. */
const REGION_START_MARKER = "//#region lib/types/tray.js";

/** Byte string that closes it. */
const REGION_END_MARKER = "//#endregion";

/** Byte length of the stock tray region on DSH Desktop 0.2.2-rc.3, trailing newline included. */
export const STOCK_REGION_LENGTH = 1254;

/** Exit codes of `check-install`: 0 patched, 1 not patched, 2 unreadable. */
export const CHECK_EXIT = { patched: 0, notPatched: 1, unreadable: 2 };

/** Exit code of `restore-install` when the asar is missing or not an asar. */
export const RESTORE_EXIT = { ok: 0, failed: 1, unreadable: 2 };

/**
 * Resolve the asar path: the first positional argument, then the environment,
 * then the installed default.
 *
 * @param {string[]} argv the arguments after the script name.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function asarPathFromArgs(argv, env) {
  const fromArgs = argv?.[0];
  if (typeof fromArgs === "string" && fromArgs !== "") return fromArgs;
  const fromEnv = env?.[ASAR_ENV];
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return DEFAULT_ASAR_PATH;
}

/** Read exactly `length` bytes at `position`, looping over short reads. */
function readExactly(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new Error(`unexpected end of file at byte ${position + done}`);
    done += read;
  }
  return buffer;
}

/** Walk the header tree to a file node. */
function nodeAt(header, parts) {
  let node = header;
  for (const part of parts) {
    if (!node?.files?.[part]) throw new Error(`missing entry ${parts.join("/")}`);
    node = node.files[part];
  }
  return node;
}

/**
 * Read `lib/main.js` and `package.json` out of an asar, read-only.
 *
 * @param {string} asarPath
 * @returns {{ main: Buffer, version: string }}
 */
function readEntries(asarPath) {
  const fd = openSync(asarPath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const prefix = readExactly(fd, 16, 0);
    const pickleSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    const dataOffset = 8 + pickleSize;
    if (jsonSize === 0 || 16 + jsonSize > fileSize) {
      throw new Error(`not a supported asar: header JSON size ${jsonSize} does not fit the file`);
    }
    const header = JSON.parse(readExactly(fd, jsonSize, 16).toString("utf8"));

    const readEntry = (parts) => {
      const node = nodeAt(header, parts);
      const start = dataOffset + Number(node.offset);
      const size = Number(node.size);
      if (start + size > fileSize) throw new Error(`not a supported asar: ${parts.join("/")} extends past the end of the file`);
      return readExactly(fd, size, start);
    };

    const main = readEntry(["lib", "main.js"]);
    const version = JSON.parse(readEntry(["package.json"]).toString("utf8")).version;
    return { main, version };
  } finally {
    closeSync(fd);
  }
}

/**
 * Locate the tray region inside `lib/main.js`, in bytes.
 *
 * The region runs from the start marker through the newline that follows
 * `//#endregion`, which is how the patch core measures it: 1254 bytes on the
 * stock 0.2.2-rc.3 build. The range is identical before and after a patch,
 * because the patch is equal-length.
 */
function locateRegion(main) {
  const start = main.indexOf(REGION_START_MARKER);
  if (start === -1) return { regionStart: null, regionLength: null, regionEnd: null };
  const endAt = main.indexOf(REGION_END_MARKER, start + REGION_START_MARKER.length);
  if (endAt === -1) return { regionStart: null, regionLength: null, regionEnd: null };
  const end = endAt + REGION_END_MARKER.length;
  // A patched region carries the marker right after the start marker line and
  // pads its tail with spaces, so the region is measured from the marker to the
  // stock region length (1254 bytes on 0.2.2-rc.3) rather than to the first
  // `//#endregion` found, which sits 63 bytes earlier inside the patch.
  if (main.includes(PATCH_MARKER, start)) {
    return { regionStart: start, regionLength: STOCK_REGION_LENGTH, regionEnd: start + STOCK_REGION_LENGTH };
  }
  return { regionStart: start, regionLength: end + 1 - start, regionEnd: end + 1 };
}

/**
 * Read the backup metadata, if a backup exists.
 *
 * @returns {{ exists: boolean, dir: string, meta?: object, error?: string }}
 */
export function backupStatus() {
  const dir = backupDir();
  try {
    const backup = readBackup();
    return { exists: true, dir, meta: backup.meta };
  } catch (error) {
    if (error?.name === "BackupMissingError") return { exists: false, dir };
    return { exists: false, dir, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The current install state. Never throws: a missing or unreadable asar is
 * reported as data, so a check script can still print a useful line.
 *
 * @param {string} asarPath
 * @param {{ backup?: { exists: boolean, dir: string, meta?: object, error?: string } }} [options]
 * @returns {{
 *   asarPath: string, exists: boolean, patched: boolean,
 *   dshVersion: string | null, mainBytes: number | null,
 *   regionStart: number | null, regionLength: number | null, regionEnd: number | null,
 *   backup: { exists: boolean, dir: string, meta?: object, error?: string },
 *   error?: string
 * }}
 */
export function readInstallStatus(asarPath, options = {}) {
  const backup = options.backup ?? backupStatus();
  const base = {
    asarPath,
    exists: existsSync(asarPath),
    patched: false,
    dshVersion: null,
    mainBytes: null,
    regionStart: null,
    regionLength: null,
    regionEnd: null,
    backup
  };
  if (!base.exists) return base;

  let entries;
  try {
    entries = readEntries(asarPath);
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
  const { main, version } = entries;
  return {
    ...base,
    patched: main.includes(PATCH_MARKER),
    dshVersion: version,
    mainBytes: main.length,
    ...locateRegion(main)
  };
}

/**
 * The exit code of `check-install` for a status.
 *
 * @param {{ exists: boolean, patched: boolean, error?: string }} status
 * @returns {number}
 */
export function checkExitCode(status) {
  if (!status.exists || status.error !== undefined) return CHECK_EXIT.unreadable;
  return status.patched ? CHECK_EXIT.patched : CHECK_EXIT.notPatched;
}

/** Format one line as `  label: value`. */
function field(label, value) {
  return `  ${label}: ${value}`;
}

/**
 * The human-readable check report.
 *
 * @param {ReturnType<typeof readInstallStatus>} status
 * @returns {string}
 */
export function formatCheckReport(status) {
  const lines = ["dsh-tray-restart install status", field("asar", status.asarPath)];
  if (!status.exists) {
    lines.push(field("state", "app.asar not found"));
    lines.push(field("backup", status.backup?.exists ? "present" : "no backup"));
    return lines.join("\n");
  }
  if (status.error !== undefined) {
    lines.push(field("state", `not patched (unreadable: ${status.error})`));
    lines.push(field("backup", status.backup?.exists ? "present" : "no backup"));
    return lines.join("\n");
  }

  lines.push(field("DSH version", status.dshVersion));
  lines.push(field("lib/main.js", `${status.mainBytes} bytes`));
  lines.push(field("state", status.patched ? "patched (Restart item present)" : "not patched"));
  if (status.regionStart === null) {
    lines.push(field("tray region", "not found"));
  } else {
    lines.push(
      field(
        "tray region",
        `offset ${status.regionStart}, length ${status.regionLength} bytes, end ${status.regionEnd}`
      )
    );
  }

  const backup = status.backup ?? { exists: false };
  if (!backup.exists) {
    lines.push(field("backup", "no backup"));
    if (backup.error) lines.push(field("backup error", backup.error));
    return lines.join("\n");
  }
  lines.push(field("backup", backup.dir));
  const meta = backup.meta ?? {};
  lines.push(field("  DSH version", meta.dshVersion ?? "unknown"));
  lines.push(
    field(
      "  region",
      `offset ${meta.regionStart ?? "?"}, length ${meta.regionLength ?? "?"} bytes`
    )
  );
  lines.push(field("  sha256", meta.sha256 ?? "unknown"));
  lines.push(field("  created", meta.createdAt ?? "unknown"));
  if (meta.asarPath) lines.push(field("  from asar", meta.asarPath));
  return lines.join("\n");
}

/**
 * The human-readable restore report.
 *
 * @param {{ changed: boolean, asarPath: string, backupUsed: boolean, mainBytes: number }} result
 * @returns {string}
 */
export function formatRestoreReport(result) {
  const lines = ["dsh-tray-restart restore", field("asar", result.asarPath)];
  if (result.changed) {
    lines.push(field("state", "restored to the stock tray region"));
    lines.push(field("backup used", result.backupUsed ? "yes" : "no (built-in stock region)"));
    lines.push(field("lib/main.js", `${result.mainBytes} bytes`));
    lines.push("");
    lines.push("Restart DeepSeek Harness to drop the Restart item from the tray menu.");
  } else {
    lines.push(field("state", "already stock; nothing to restore"));
  }
  return lines.join("\n");
}


