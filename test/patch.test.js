import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STOCK_MAIN_BYTES,
  STOCK_REGION_BODY,
  STOCK_REGION_LENGTH,
  STOCK_REGION_START,
  fixtureSkip,
  loadStockMain
} from "./fixture.js";
import { patchDesktopMain } from "../src/patch.js";

const skip = fixtureSkip();

test("stock tray region is located at the measured byte offset and length", { skip }, () => {
  const main = loadStockMain();
  assert.equal(main.length, STOCK_MAIN_BYTES);
  const region = main.subarray(STOCK_REGION_START, STOCK_REGION_START + STOCK_REGION_LENGTH).toString("utf8");
  assert.ok(region.startsWith("//#region lib/types/tray.js"));
  assert.ok(region.endsWith("//#endregion\n"));
  assert.equal(Buffer.byteLength(region, "utf8"), STOCK_REGION_LENGTH);
});

test("patchDesktopMain reports the stock region location", { skip }, () => {
  const main = loadStockMain();
  const result = patchDesktopMain(main);
  assert.equal(result.changed, true);
  assert.equal(result.regionStart, STOCK_REGION_START);
  assert.equal(result.regionLength, STOCK_REGION_LENGTH);
});
test("a region that cannot fit the restart action throws instead of returning source", () => {
  // A tray region far too short to hold the marker plus the restart item. The
  // patch must refuse: no source is returned, and the caller keeps the stock
  // bytes. Which guard fires first is an implementation detail, so both
  // rejection paths are accepted; what matters is that nothing is returned.
  const region = [
    "//#region lib/types/tray.js",
    '{ type: "separator" }',
    "//#endregion",
    ""
  ].join("\n");
  const support =
    "function quitWithoutConfirmation() {}\n" +
    "const restart = () => { app.relaunch(); };\n" +
    "const label = messages.restartApplication;\n";
  const main = Buffer.from("head\n" + region + support + "tail\n", "utf8");

  let returned;
  assert.throws(
    () => {
      returned = patchDesktopMain(main);
    },
    (error) => {
      assert.ok(
        error.name === "RegionOverflowError" || error.name === "UnsupportedBuildError",
        `unexpected error: ${error.name}`
      );
      return true;
    }
  );
  assert.equal(returned, undefined, "no source may be returned on failure");
});

test("patched region carries the marker and a Restart action", { skip }, () => {
  const main = loadStockMain();
  const { source, regionStart, regionLength } = patchDesktopMain(main);
  const region = source.subarray(regionStart, regionStart + regionLength).toString("utf8");
  assert.match(region, /\/\* dsh-tray-restart:/);
  assert.match(region, /label: messages\.restartApplication \+ " DeepSeek Harness"/);
  assert.match(region, /app\.relaunch\(\);/);
  assert.match(region, /quitWithoutConfirmation\(\);/);
});
function makeRegion({ separators = 1, region = true } = {}) {
  const sep = '{ type: "separator" }';
  const items = [];
  items.push("\t\t\t{");
  items.push("\t\t\t\tlabel: messages.openApplication,");
  items.push("\t\t\t},");
  for (let i = 0; i < separators; i++) items.push(sep);
  items.push("\t\t\t{");
  items.push("\t\t\t\tlabel: messages.quitApplication,");
  items.push("\t\t\t}");
  const body = region
    ? "//#region lib/types/tray.js\n" + items.join("\n") + "\n//#endregion\n"
    : items.join("\n") + "\n";
  // Tokens the patch depends on live outside the tray region in the real file.
  const support =
    "function quitWithoutConfirmation() {}\n" +
    "const restart = () => { app.relaunch(); };\n" +
    "const label = messages.restartApplication;\n";
  return "head\n" + body + support + "tail\n";
}

test("a missing region marker throws instead of returning source", () => {
  const main = Buffer.from(makeRegion({ region: false }), "utf8");
  assert.throws(() => patchDesktopMain(main), (e) => e.name === "UnsupportedBuildError");
});

test("a region with no separator anchor throws instead of returning source", () => {
  const main = Buffer.from(makeRegion({ separators: 0 }), "utf8");
  assert.throws(() => patchDesktopMain(main), (e) => e.name === "UnsupportedBuildError" && /separator/.test(e.message));
});

test("a region with two separator anchors throws instead of returning source", () => {
  const main = Buffer.from(makeRegion({ separators: 2 }), "utf8");
  assert.throws(() => patchDesktopMain(main), (e) => e.name === "UnsupportedBuildError" && /separator/.test(e.message));
});

for (const token of ["quitWithoutConfirmation", "app.relaunch()", "restartApplication"]) {
  test("a build missing the " + token + " token is rejected as unsupported", () => {
    const main = Buffer.from(makeRegion().replaceAll(token, "REMOVED"), "utf8");
    assert.throws(() => patchDesktopMain(main), (e) => e.name === "UnsupportedBuildError" && /unsupported/.test(e.message));
  });
}
test("patched source keeps the exact same total byte length", { skip }, () => {
  const main = loadStockMain();
  const result = patchDesktopMain(main);
  assert.equal(result.source.length, main.length);
});

test("patched region is still the stock body length plus the trailing newline", { skip }, () => {
  const main = loadStockMain();
  const { source, regionStart, regionLength } = patchDesktopMain(main);
  assert.equal(regionLength, STOCK_REGION_LENGTH);
  const region = source.subarray(regionStart, regionStart + regionLength).toString("utf8");
  // The region keeps its length: the patch is padded with spaces, so the code
  // ends at "//#endregion" and the tail is space padding.
  assert.ok(region.includes("//#endregion\n"));
  assert.match(region, /\/\/#endregion\n *$/);
  assert.equal(Buffer.byteLength(region.trimEnd(), "utf8") <= STOCK_REGION_BODY, true);
});

test("menu order is openApplication, Restart, separator, quitApplication", { skip }, () => {
  const main = loadStockMain();
  const { source, regionStart, regionLength } = patchDesktopMain(main);
  const region = source.subarray(regionStart, regionStart + regionLength).toString("utf8");
  const open = region.indexOf("messages.openApplication");
  const restart = region.indexOf("messages.restartApplication");
  const separator = region.indexOf('{ type: "separator" }');
  const quit = region.indexOf("messages.quitApplication");
  assert.ok(open !== -1 && restart !== -1 && separator !== -1 && quit !== -1);
  assert.ok(open < restart, "Restart must follow openApplication");
  assert.ok(restart < separator, "Restart must precede the separator");
  assert.ok(separator < quit, "separator must precede quitApplication");
});

test("the relabel comment is preserved and only the reclaimable comments go", { skip }, () => {
  const main = loadStockMain();
  const { source, regionStart, regionLength } = patchDesktopMain(main);
  const region = source.subarray(regionStart, regionStart + regionLength).toString("utf8");
  // The relabel comment documents behaviour and is never touched.
  assert.ok(region.includes("/** Rebuild the tooltip and context menu in the current locale. */"));
  // The three comments the patch reclaims are gone; every other comment stays.
  assert.ok(!region.includes("/** Tray icon present for the whole run"));
  assert.ok(!region.includes("/** @param options - Icon path, locale reader"));
  assert.ok(!region.includes("/** Remove the icon; called once the quit is confirmed"));
  // The class comment sits directly above DesktopTray, which is where the
  // reclaim looks; it is dropped along with the other two.
  assert.ok(region.includes("var DesktopTray = class {"));
  assert.ok(region.includes("constructor(options) {"));
  assert.ok(region.includes("dispose() {"));
});

test("patching an already patched source is a no-op that returns changed false", { skip }, () => {
  const main = loadStockMain();
  const first = patchDesktopMain(main);
  const second = patchDesktopMain(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source, "the same buffer is returned untouched");
  assert.ok(second.source.equals(first.source));
});

test("the patched lib/main.js passes node --check", { skip }, () => {
  const main = loadStockMain();
  const { source } = patchDesktopMain(main);
  const file = join(tmpdir(), `dsh-tray-restart-patched-${process.pid}.js`);
  writeFileSync(file, source);
  try {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(file, { force: true });
  }
});
