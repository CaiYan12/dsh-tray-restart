/**
 * Equal-length in-place patching of the DSH Desktop tray menu.
 *
 * The tray menu is built by `DesktopTray.relabel()` inside the
 * `//#region lib/types/tray.js` block of the packaged `lib/main.js`. That block
 * is 1254 bytes long (1253 plus the trailing newline). Everything here operates
 * on plain bytes: no filesystem access, no asar knowledge. Offsets are byte
 * offsets, never string indices.
 */

const REGION_START_MARKER = "//#region lib/types/tray.js";
const REGION_END_MARKER = "//#endregion";
const SEPARATOR_ANCHOR = '{ type: "separator" }';

/** Tokens the patch relies on. Any of them missing means an unsupported build. */
const REQUIRED_TOKENS = ["quitWithoutConfirmation", "app.relaunch()", "restartApplication"];

/** Idempotency marker. Its presence inside the region means the patch is applied. */
export const PATCH_MARKER =
  "/* dsh-tray-restart: adds Restart DeepSeek Harness to the tray menu */";

/**
 * Menu item inserted before the separator.
 *
 * Written as one compact line so the whole patch fits the stock region length.
 */
const RESTART_ACTION =
  '\t\t\t{ label: messages.restartApplication + " DeepSeek Harness", ' +
  "click: () => { app.relaunch(); quitWithoutConfirmation(); } },\n";

/**
 * Region comments dropped to make room for the restart item.
 *
 * The stock region is exactly full: the restart item plus its marker need more
 * bytes than the region has spare. These three JSDoc comments are the only
 * reclaimable bytes that carry no behaviour, so removing them keeps every line
 * of code intact and the file length unchanged. The class comment and the
 * `relabel()` comment are deliberately kept.
 */
const RECLAIMED_COMMENTS = [
  "/** Tray icon present for the whole run, not only while the window is hidden. */\n",
  "\t/** @param options - Icon path, locale reader, and the open and quit actions. */\n",
  "\t/** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */\n"
];

/** Thrown when the build does not look like a supported DSH Desktop release. */
export class UnsupportedBuildError extends Error {
  constructor(reason) {
    super(`unsupported DSH Desktop build: ${reason}`);
    this.name = "UnsupportedBuildError";
  }
}

/** Thrown when the patched region would not fit in the stock region length. */
export class RegionOverflowError extends Error {
  constructor(needed, available) {
    super(`patched tray region needs ${needed} bytes but only ${available} are available`);
    this.name = "RegionOverflowError";
    this.needed = needed;
    this.available = available;
  }
}

/**
 * @typedef {object} PatchResult
 * @property {boolean} changed  false when the region already carries the marker.
 * @property {Buffer} source    the patched bytes (identical to the input when unchanged).
 * @property {number} regionStart  byte offset of the region start marker.
 * @property {number} regionLength byte length of the region, trailing newline included.
 */

function countOccurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Locate the tray region and return its byte range.
 *
 * @param {Buffer} main the `lib/main.js` bytes.
 * @returns {{ start: number, length: number }}
 */
function locateRegion(main) {
  const startCount = countOccurrences(main, REGION_START_MARKER);
  if (startCount !== 1) {
    throw new UnsupportedBuildError(
      `expected exactly one "${REGION_START_MARKER}" marker, found ${startCount}`
    );
  }
  const start = main.indexOf(REGION_START_MARKER);
  const endAt = main.indexOf(REGION_END_MARKER, start + REGION_START_MARKER.length);
  if (endAt === -1) {
    throw new UnsupportedBuildError(`no "${REGION_END_MARKER}" after the tray region start`);
  }
  return { start, length: endAt + REGION_END_MARKER.length + 1 - start };
}

/**
 * Insert a Restart action before the tray menu separator.
 *
 * @param {Buffer} main the stock `lib/main.js` bytes.
 * @returns {PatchResult}
 */
export function patchDesktopMain(main) {
  const { start: regionStart, length: regionLength } = locateRegion(main);
  let region = main.subarray(regionStart, regionStart + regionLength).toString("utf8");

  for (const token of REQUIRED_TOKENS) {
    if (!main.includes(token)) throw new UnsupportedBuildError(`missing token "${token}"`);
  }

  // Idempotency first: an already patched region is returned untouched, before
  // any layout check that the patch itself changed.
  if (region.includes(PATCH_MARKER)) {
    return { changed: false, source: main, regionStart, regionLength };
  }

  const sepCount = countOccurrences(region, SEPARATOR_ANCHOR);
  if (sepCount !== 1) {
    throw new UnsupportedBuildError(
      `expected exactly one tray separator anchor, found ${sepCount}`
    );
  }

  // Reclaim the comments first: without the space they free, the restart item
  // never fits, and the region length is the hard constraint.
  let reclaimed = region;
  for (const comment of RECLAIMED_COMMENTS) {
    if (!reclaimed.includes(comment)) {
      throw new UnsupportedBuildError("tray region comments do not match the expected layout");
    }
    reclaimed = reclaimed.replace(comment, "");
  }

  // The marker goes inside the region, right after the start marker line, so a
  // later run finds it in the same slice this function inspects.
  const afterStart = reclaimed.indexOf("\n") + 1;
  const sepAt = reclaimed.indexOf(SEPARATOR_ANCHOR);
  const patched =
    reclaimed.slice(0, afterStart) +
    PATCH_MARKER + "\n" +
    reclaimed.slice(afterStart, sepAt) +
    RESTART_ACTION +
    reclaimed.slice(sepAt);
  const needed = Buffer.byteLength(patched, "utf8");
  if (needed > regionLength) throw new RegionOverflowError(needed, regionLength);
  const padded = patched.padEnd(regionLength, " ");

  const source = Buffer.concat([
    main.subarray(0, regionStart),
    Buffer.from(padded, "utf8"),
    main.subarray(regionStart + regionLength)
  ]);
  return { changed: true, source, regionStart, regionLength };
}

/**
 * Stock tray region, verbatim, as shipped in DSH Desktop 0.2.2-rc.3.
 *
 * TEMPORARY SOURCE OF TRUTH. Restoring needs the original bytes, and the pure
 * patch core has no filesystem access, so the stock region is embedded here
 * instead of being read from the asar or from a test fixture. It is exactly
 * 1254 bytes, matching the region length the patch core asserts.
 *
 * T4 replaces this constant with a read from the Backup written before the
 * first patch. Until then, a build whose stock region differs from this text
 * cannot be restored correctly from here: the marker check proves the region
 * was patched by this plugin, but not that the text underneath matches.
 */
export const STOCK_TRAY_REGION = "//#region lib/types/tray.js\n/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */\n/** Tray icon present for the whole run, not only while the window is hidden. */\nvar DesktopTray = class {\n\toptions;\n\ttray;\n\t/** @param options - Icon path, locale reader, and the open and quit actions. */\n\tconstructor(options) {\n\t\tthis.options = options;\n\t\tconst tray = new Tray(nativeImage.createFromPath(options.iconPath));\n\t\tthis.tray = tray;\n\t\ttray.on(\"click\", () => {\n\t\t\toptions.open();\n\t\t});\n\t\tthis.relabel();\n\t}\n\t/** Rebuild the tooltip and context menu in the current locale. */\n\trelabel() {\n\t\tconst tray = this.tray;\n\t\tif (tray === void 0) return;\n\t\tconst { messages } = this.options.locale();\n\t\ttray.setToolTip(messages.aboutProduct);\n\t\ttray.setContextMenu(Menu.buildFromTemplate([\n\t\t\t{\n\t\t\t\tlabel: messages.openApplication,\n\t\t\t\tclick: () => {\n\t\t\t\t\tthis.options.open();\n\t\t\t\t}\n\t\t\t},\n\t\t\t{ type: \"separator\" },\n\t\t\t{\n\t\t\t\tlabel: messages.quitApplication,\n\t\t\t\tclick: () => {\n\t\t\t\t\tthis.options.quit();\n\t\t\t\t}\n\t\t\t}\n\t\t]));\n\t}\n\t/** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */\n\tdispose() {\n\t\tconst tray = this.tray;\n\t\tthis.tray = void 0;\n\t\ttray?.destroy();\n\t}\n};\n//#endregion\n";

/**
 * Restore the tray region to the stock text.
 *
 * Pure: no filesystem access. Only a region that carries the marker is
 * rewritten; a region without it was never patched, so the input is returned
 * unchanged and the caller learns nothing was done. The restored region is
 * padded with spaces to the original region length, so the total byte count of
 * `lib/main.js` never changes and every later asar offset stays valid.
 *
 * @param {Buffer} main the `lib/main.js` bytes, possibly already patched.
 * @returns {PatchResult}
 */
export function restoreDesktopMain(main) {
  const { start: regionStart } = locateRegion(main);

  // The patched region is longer than the stock one: the restart item is
  // inserted before the separator, so "//#endregion" moves to the right and the
  // patch pads the tail with spaces to keep the file length. The window that
  // must be overwritten is therefore the stock region length, not the length
  // locateRegion measures on the patched bytes.
  const regionLength = Buffer.byteLength(STOCK_TRAY_REGION, "utf8");
  const region = main.subarray(regionStart, regionStart + regionLength).toString("utf8");

  // No marker means this build was never patched: leave it alone rather than
  // rewriting a region that may belong to a newer DSH release.
  if (!region.includes(PATCH_MARKER)) {
    return { changed: false, source: main, regionStart, regionLength };
  }

  const padded = STOCK_TRAY_REGION.padEnd(regionLength, " ");

  const source = Buffer.concat([
    main.subarray(0, regionStart),
    Buffer.from(padded, "utf8"),
    main.subarray(regionStart + regionLength)
  ]);
  return { changed: true, source, regionStart, regionLength };
}
