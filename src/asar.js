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
import { SyntaxCheckError, checkSyntax } from "./syntax.js";

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
 * Byte range of `lib/main.js`'s own entry inside the header buffer.
 *
 * The header buffer is the JSON text itself, so the entry can be located by
 * searching for its key in the `lib` object. Scoping every later search to this
 * range is what keeps the rewrite off other files: the header holds one
 * `"hash":` per packed file, and the first one in the text belongs to whichever
 * file the tree lists first, not to `lib/main.js`.
 *
 * @param {Buffer} headerBuffer
 * @returns {{ start: number, end: number }}
 */
function mainEntryRange(headerBuffer) {
  const text = headerBuffer.toString("utf8");
  // "main.js" is a very common file name: hundreds of nested packages under
  // "lib" carry their own, so neither the first nor the last match is reliable.
  // The entry wanted is the direct child of the top-level "lib" object, which
  // is found by walking the root "files" object one level down.
  const rootFilesAt = text.indexOf('"files":{');
  if (rootFilesAt === -1) throw new AsarFormatError("header has no root files object");
  const libAt = directChildKey(text, rootFilesAt + '"files":{'.length, '"lib":');
  if (libAt === -1) throw new AsarFormatError('header has no top-level "lib" directory');
  // The lib node is {"files":{...}}: step past its own "files" object and look
  // for "main.js" one level down, so a nested package's main.js is not taken.
  const libFilesAt = text.indexOf('"files":{', libAt);
  if (libFilesAt === -1) throw new AsarFormatError('"lib" is not a directory');
  const mainAt = directChildKey(text, libFilesAt + '"files":{'.length, '"main.js":');
  if (mainAt === -1) throw new AsarFormatError('"lib" has no direct "main.js" entry');
  const entryStart = mainAt + '"main.js":'.length;
  // The entry is one flat JSON object: find its closing brace by walking the
  // braces, since the integrity record nests two levels inside it.
  let entryDepth = 0;
  for (let at = entryStart; at < text.length; at += 1) {
    const ch = text[at];
    if (ch === "{") entryDepth += 1;
    else if (ch === "}") {
      entryDepth -= 1;
      if (entryDepth === 0) return { start: entryStart, end: at + 1 };
    }
  }
  throw new AsarFormatError('the "main.js" entry is not closed');
}

/**
 * Find a key that is a direct child of the object starting at `objectAt`.
 *
 * Walks the object one level deep, skipping nested objects and arrays, so a key
 * of the same name inside a subdirectory is never mistaken for the child.
 *
 * @param {string} text the header JSON.
 * @param {number} objectAt offset just past the parent object's opening brace.
 * @param {string} key the quoted key plus its colon, e.g. `'"lib":'`.
 * @returns {number} offset of the key, or -1.
 */
function directChildKey(text, objectAt, key) {
  let depth = 0;
  for (let at = objectAt; at < text.length; at += 1) {
    const ch = text[at];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (ch === "]" && depth === 0) {
      return -1;
    } else if (ch === '"' && depth === 0 && text.startsWith(key, at)) {
      return at;
    }
  }
  return -1;
}

/**
 * Locate one integrity hash of `lib/main.js` inside its own entry.
 *
 * @param {Buffer} headerBuffer
 * @param {string} from the hash currently in the header.
 * @param {{ anchor: string, index: number }} where `index` is which occurrence
 *   of `anchor` to use (0 for the whole-file hash, n for block n).
 * @returns {number} byte offset of the hash text.
 */
function hashOffset(headerBuffer, from, where) {
  const text = headerBuffer.toString("utf8");
  const range = mainEntryRange(headerBuffer);
  const scoped = text.slice(range.start, range.end);
  let anchorAt = -1;
  for (let seen = 0; seen <= where.index; seen += 1) {
    anchorAt = scoped.indexOf(where.anchor, anchorAt + 1);
    if (anchorAt === -1) {
      throw new AsarFormatError(
        `lib/main.js has no "${where.anchor}" for occurrence ${where.index}`
      );
    }
  }
  // The hash follows the anchor, separated only by JSON punctuation, whitespace
  // and (for blocks) the opening quote of the string.
  const after = anchorAt + where.anchor.length;
  const match = /^[\s\[\]"]*([0-9a-f]{64})/.exec(scoped.slice(after));
  if (match === null) throw new AsarFormatError(`no hash follows "${where.anchor}"`);
  const at = range.start + after + match[0].length - 64;
  if (text.slice(at, at + 64) !== from) {
    throw new AsarFormatError(
      `hash at byte ${at} is "${text.slice(at, at + 64)}", expected "${from}"`
    );
  }
  return at;
}

/**
 * Write `to` over the hash at `at`, in place.
 *
 * Both strings are 64 hex characters, so the replacement is equal-length and the
 * header keeps its size. Nothing else in the header is touched: the offset comes
 * from the JSON key that owns the hash, never from a value search.
 *
 * @param {Buffer} headerBuffer
 * @param {number} at byte offset of the hash text.
 * @param {string} to the new hash.
 */
function writeHashAt(headerBuffer, at, to) {
  if (to.length !== 64) throw new Error("hash replacement must be 64 characters");
  headerBuffer.write(to, at, "utf8");
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
 * The syntax gate's policy: refuse to write a candidate that does not parse.
 *
 * When `node --check` cannot run at all the write is refused too, on purpose.
 * The check exists to catch a corrupted candidate, and the one case where it
 * cannot run is a machine without a usable `node` executable — the same machine
 * the Host entry then cannot load the patch module on. Failing open would turn
 * the last guard before an irreversible in-place archive write into a no-op,
 * and the cost of failing closed is only that the tray item does not appear;
 * the asar stays stock and the next start retries. A warning would be logged
 * into a startup log nobody reads before the damage is done.
 *
 * @param {Buffer} source the candidate `lib/main.js` bytes.
 * @param {{ syntaxCheck?: (source: Buffer) => import("./syntax.js").SyntaxCheckResult }} [options]
 */
function assertParses(source, options = {}) {
  const check = options.syntaxCheck ?? checkSyntax;
  const result = check(source);
  if (result.status === "ok") return;
  if (result.status === "invalid") throw new SyntaxCheckError(result.detail);
  throw new SyntaxCheckError(
    `the syntax check could not run (${result.detail}); refusing to write unverified bytes`
  );
}

/**
 * Run `transform` against `lib/main.js` and write the result back.
 *
 * @param {string} asarPath
 * @param {(main: Buffer, hooks: {
 *   backup: (regionStart: number, regionLength: number) => void,
 *   readBackup: () => { region: Buffer, meta: object }
 * }) => { changed: boolean, source: Buffer }} transform
 * @param {{ syntaxCheck?: (source: Buffer) => import("./syntax.js").SyntaxCheckResult }} [options]
 * @returns {TrayRestartResult}
 */
function run(asarPath, transform, options = {}) {
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

    // The syntax gate runs before a single byte reaches the archive: a candidate
    // that does not parse must leave the asar exactly as it was.
    assertParses(result.source, options);

    let integrityUpdated = false;
    if (node.integrity) {
      const next = computeIntegrity(result.source, node.integrity);
      const previousBlocks = node.integrity.blocks ?? [];
      if (previousBlocks.length !== next.blocks.length) {
        throw new AsarFormatError(
          `integrity block count changed from ${previousBlocks.length} to ${next.blocks.length}`
        );
      }
      // Every offset is resolved against the header as it is now, before any
      // write. Resolving them one at a time would break as soon as two hashes
      // share a value, which is the normal case here: a single block covers the
      // whole file, so block 0 and the whole-file hash are the same string, and
      // rewriting block 0 first would make the whole-file lookup find the new
      // value at block 0's offset.
      const offsets = previousBlocks.map((hash, i) => ({
        at: hashOffset(headerBuffer, hash, { anchor: '"blocks":[', index: i }),
        to: next.blocks[i]
      }));
      offsets.push({
        at: hashOffset(headerBuffer, node.integrity.hash, { anchor: '"hash":', index: 0 }),
        to: next.hash
      });
      for (const { at, to } of offsets) writeHashAt(headerBuffer, at, to);

      // Verify the header still parses and now carries the new record.
      const reparsed = JSON.parse(headerBuffer.toString("utf8"));
      const after = nodeAt(reparsed, MAIN_PATH).integrity;
      if (after.hash !== next.hash || after.blocks.join() !== next.blocks.join()) {
        throw new AsarFormatError("integrity record did not update as expected");
      }
      writeExactly(fd, headerBuffer, 16);
      integrityUpdated = true;
    }

    writeExactly(fd, result.source, mainOffset);

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
 * @param {{ syntaxCheck?: (source: Buffer) => import("./syntax.js").SyntaxCheckResult }} [options]
 * @returns {TrayRestartResult}
 */
export function applyTrayRestart(asarPath, options = {}) {
  return run(asarPath, (main, hooks) => {
    const result = patchDesktopMain(main);
    if (result.changed) hooks.backup(result.regionStart, result.regionLength);
    return result;
  }, options);
}

/**
 * Restore the tray region of a real `app.asar` to the stock text.
 *
 * @param {string} asarPath
 * @param {{ syntaxCheck?: (source: Buffer) => import("./syntax.js").SyntaxCheckResult }} [options]
 * @returns {TrayRestartResult}
 */
export function restoreTrayRestart(asarPath, options = {}) {
  return run(asarPath, (main, hooks) => {
    // Only a patched region needs the backup. An asar without the marker is left
    // alone, so it must not fail just because no backup was ever written.
    if (!main.includes(PATCH_MARKER)) return restoreDesktopMain(main);
    const backup = hooks.readBackup();
    return restoreDesktopMain(main, backup.region);
  }, options);
}

export { MAIN_PATH };
