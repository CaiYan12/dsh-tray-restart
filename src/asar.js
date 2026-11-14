/**
 * asar I/O: connect the pure patch core to a real `app.asar` on disk.
 *
 * An asar is a header followed by a concatenation of file contents. The header
 * is a pickle:
 *
 *   u32 @ 0  = 4                pickle header
 *   u32 @ 4  = header pickle size
 *   u32 @ 8  = header string size (padded)
 *   u32 @ 12 = JSON size
 *   dataOffset = 8 + u32@4      <- not 16 + u32@12
 *
 * The JSON tree follows at offset 16 and holds, per file, `offset` (relative to
 * dataOffset), `size` and an `integrity` record: the whole-file SHA-256 plus a
 * SHA-256 per `blockSize` chunk.
 *
 * The tray patch is equal-length, so no offset or size in the header changes.
 * Only file contents change, and with them the integrity record of
 * `lib/main.js`. The hashes are rewritten in place inside the header buffer:
 * a SHA-256 hex digest is always 64 characters, so the header keeps its size.
 */

import { createHash } from "node:crypto";

import { PATCH_MARKER, patchDesktopMain, restoreDesktopMain } from "./patch.js";
import { backupExists, readBackup, writeBackup } from "./backup.js";

/**
 * Filesystem implementation.
 *
 * Inside Electron, `node:fs` is patched to route `*.asar` paths through the
 * asar archive reader, which is read-only and rejects writes. `original-fs` is
 * the real filesystem module. Outside Electron the import fails and plain
 * `node:fs` is already the real filesystem.
 */
async function loadFs() {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    return require("original-fs");
  } catch {
    return import("node:fs");
  }
}

const fs = await loadFs();

/** Path of `lib/main.js` inside the asar tree. */
const MAIN_PATH = ["lib", "main.js"];

/** Path of the asar's own manifest, read for the DSH version. */
const PACKAGE_PATH = ["package.json"];

/** Thrown when the file is not a readable asar, or lacks the expected entry. */
export class AsarFormatError extends Error {
  constructor(reason) {
    super(`not a supported asar: ${reason}`);
    this.name = "AsarFormatError";
  }
}

/**
 * @typedef {object} TrayRestartResult
 * @property {boolean} changed          false when the asar was already in the requested state.
 * @property {string} asarPath          the path that was handled.
 * @property {number} mainBytes         byte length of `lib/main.js`.
 * @property {boolean} integrityUpdated true when the integrity record was rewritten.
 * @property {boolean} backupCreated    true when this call wrote the backup.
 * @property {boolean} backupUsed       true when the backup bytes were read for the restore.
 */

/** Read exactly `length` bytes at `position`, looping over short reads. */
function readExactly(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const read = fs.readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new AsarFormatError(`unexpected end of file at byte ${position + done}`);
    done += read;
  }
  return buffer;
}

/** Write all of `buffer` at `position`, looping over short writes. */
function writeExactly(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const written = fs.writeSync(fd, buffer, done, buffer.length - done, position + done);
    if (written === 0) throw new Error(`could not write at byte ${position + done}`);
    done += written;
  }
}

/** Parse the header of an open asar. */
function readHeader(fd, fileSize) {
  const prefix = readExactly(fd, 16, 0);
  if (prefix.readUInt32LE(0) !== 4) throw new AsarFormatError("unexpected pickle header");
  const pickleSize = prefix.readUInt32LE(4);
  const jsonSize = prefix.readUInt32LE(12);
  const dataOffset = 8 + pickleSize;
  if (jsonSize === 0 || 16 + jsonSize > fileSize) {
    throw new AsarFormatError(`header JSON size ${jsonSize} does not fit the file`);
  }
  const headerBuffer = readExactly(fd, jsonSize, 16);
  let header;
  try {
    header = JSON.parse(headerBuffer.toString("utf8"));
  } catch (error) {
    throw new AsarFormatError(`header JSON is not parseable: ${error.message}`);
  }
  return { dataOffset, jsonSize, headerBuffer, header };
}

/** Walk the header tree to a file node. */
function nodeAt(header, parts) {
  let node = header;
  for (const part of parts) {
    if (!node?.files?.[part]) throw new AsarFormatError(`missing entry ${parts.join("/")}`);
    node = node.files[part];
  }
  if (node.files) throw new AsarFormatError(`${parts.join("/")} is a directory`);
  return node;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Recompute an integrity record for `bytes`, keeping the record's own
 * algorithm and block size.
 *
 * @param {Buffer} bytes
 * @param {{ algorithm?: string, blockSize?: number }} integrity
 * @returns {{ hash: string, blocks: string[] }}
 */
function computeIntegrity(bytes, integrity) {
  const algorithm = (integrity.algorithm ?? "SHA256").toLowerCase().replaceAll("-", "");
  if (algorithm !== "sha256") {
    throw new AsarFormatError(`unsupported integrity algorithm ${integrity.algorithm}`);
  }
  const blockSize = integrity.blockSize ?? bytes.length;
  const blocks = [];
  for (let at = 0; at < bytes.length; at += blockSize) {
    blocks.push(sha256(bytes.subarray(at, at + blockSize)));
  }
  return { hash: sha256(bytes), blocks };
}

/**
 * Replace every occurrence of `from` with `to` in `headerBuffer`, in place.
 *
 * The integrity hashes live inside the header JSON. Both strings are 64 hex
 * characters, so the replacement is equal-length and the header keeps its size.
 * The search is anchored on the surrounding JSON text so a hash that happens to
 * appear elsewhere in the header is not touched by accident.
 */
function replaceHash(headerBuffer, from, to, occurrences) {
  if (from === to) return 0;
  if (from.length !== to.length) throw new Error("hash replacement must be equal-length");
  let replaced = 0;
  let at = headerBuffer.indexOf(from);
  while (at !== -1) {
    headerBuffer.write(to, at, "utf8");
    replaced += 1;
    at = headerBuffer.indexOf(from, at + to.length);
  }
  if (occurrences !== undefined && replaced !== occurrences) {
    throw new AsarFormatError(
      `expected ${occurrences} occurrences of the old hash in the header, found ${replaced}`
    );
  }
  return replaced;
}

/** Read `version` from the asar's own `package.json`. */
function versionOf(fd, header, dataOffset, fileSize) {
  const node = nodeAt(header, PACKAGE_PATH);
  if (node.unpacked || node.files) throw new AsarFormatError("package.json is not a packed file");
  const offset = dataOffset + Number(node.offset);
  const size = Number(node.size);
  if (offset + size > fileSize) throw new AsarFormatError("package.json extends past the end of the file");
  const manifest = JSON.parse(readExactly(fd, size, offset).toString("utf8"));
  if (typeof manifest.version !== "string" || manifest.version === "") {
    throw new AsarFormatError("package.json carries no version");
  }
  return manifest.version;
}

/**
 * Run `transform` against `lib/main.js` and write the result back.
 *
 * @param {string} asarPath
 * @param {(main: Buffer, hooks: {
 *   backup: (regionStart: number, regionLength: number) => void,
 *   readBackup: () => { region: Buffer, meta: object }
 * }) => { changed: boolean, source: Buffer }} transform
 * @returns {TrayRestartResult}
 */
function run(asarPath, transform) {
  const fd = fs.openSync(asarPath, "r+");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const { dataOffset, jsonSize, headerBuffer, header } = readHeader(fd, fileSize);
    const node = nodeAt(header, MAIN_PATH);
    if (node.unpacked) throw new AsarFormatError("lib/main.js is unpacked");
    const mainOffset = dataOffset + Number(node.offset);
    const mainSize = Number(node.size);
    if (mainOffset + mainSize > fileSize) {
      throw new AsarFormatError("lib/main.js extends past the end of the file");
    }

    const main = readExactly(fd, mainSize, mainOffset);

    // The backup is taken here, with the stock bytes in hand and before anything is
    // written. A transform that reports no change (already patched, or never
    // patched) must not create one: those bytes are not necessarily stock.
    let backupCreated = false;
    let backupUsed = false;
    const result = transform(main, {
      backup(regionStart, regionLength) {
        if (backupExists()) return;
        const version = versionOf(fd, header, dataOffset, fileSize);
        backupCreated = writeBackup({
          region: main.subarray(regionStart, regionStart + regionLength),
          regionStart,
          dshVersion: version,
          asarPath
        }).created;
      },
      readBackup() {
        backupUsed = true;
        return readBackup();
      }
    });

    if (!result.changed) {
      return { changed: false, asarPath, mainBytes: mainSize, integrityUpdated: false, backupCreated, backupUsed };
    }
    if (result.source.length !== mainSize) {
      throw new Error(
        `patched lib/main.js is ${result.source.length} bytes, expected ${mainSize}`
      );
    }

    writeExactly(fd, result.source, mainOffset);

    let integrityUpdated = false;
    if (node.integrity) {
      const next = computeIntegrity(result.source, node.integrity);
      const previousBlocks = node.integrity.blocks ?? [];
      if (previousBlocks.length !== next.blocks.length) {
        throw new AsarFormatError(
          `integrity block count changed from ${previousBlocks.length} to ${next.blocks.length}`
        );
      }
      // Blocks and the whole-file hash can share a value (a single block covers
      // the whole file). Block hashes are replaced first, then the whole-file
      // hash, so each pass searches for the value that is still in the header.
      for (let i = 0; i < previousBlocks.length; i += 1) {
        replaceHash(headerBuffer, previousBlocks[i], next.blocks[i]);
      }
      replaceHash(headerBuffer, node.integrity.hash, next.hash);

      // Verify the header still parses and now carries the new record.
      const reparsed = JSON.parse(headerBuffer.toString("utf8"));
      const after = nodeAt(reparsed, MAIN_PATH).integrity;
      if (after.hash !== next.hash || after.blocks.join() !== next.blocks.join()) {
        throw new AsarFormatError("integrity record did not update as expected");
      }
      writeExactly(fd, headerBuffer, 16);
      integrityUpdated = true;
    }

    fs.fsyncSync(fd);
    return { changed: true, asarPath, mainBytes: mainSize, integrityUpdated, backupCreated, backupUsed };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Add the Restart action to the tray menu of a real `app.asar`.
 *
 * @param {string} asarPath
 * @returns {TrayRestartResult}
 */
export function applyTrayRestart(asarPath) {
  return run(asarPath, (main, hooks) => {
    const result = patchDesktopMain(main);
    if (result.changed) hooks.backup(result.regionStart, result.regionLength);
    return result;
  });
}

/**
 * Restore the tray region of a real `app.asar` to the stock text.
 *
 * @param {string} asarPath
 * @returns {TrayRestartResult}
 */
export function restoreTrayRestart(asarPath) {
  return run(asarPath, (main, hooks) => {
    // Only a patched region needs the backup. An asar without the marker is left
    // alone, so it must not fail just because no backup was ever written.
    if (!main.includes(PATCH_MARKER)) return restoreDesktopMain(main);
    const backup = hooks.readBackup();
    return restoreDesktopMain(main, backup.region);
  });
}

export { MAIN_PATH };
