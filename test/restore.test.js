import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STOCK_REGION_LENGTH,
  STOCK_REGION_START,
  fixtureSkip,
  loadStockMain
} from "./fixture.js";
import { patchDesktopMain, restoreDesktopMain, PATCH_MARKER } from "../src/patch.js";

const skip = fixtureSkip();

test("restoreDesktopMain reports the stock region location", { skip }, () => {
  const main = loadStockMain();
  const patched = patchDesktopMain(main);
  const result = restoreDesktopMain(patched.source);
  assert.equal(result.changed, true);
  assert.equal(result.regionStart, STOCK_REGION_START);
  assert.equal(result.regionLength, STOCK_REGION_LENGTH);
});

test("a patched region is restored to the stock region byte for byte", { skip }, () => {
  const main = loadStockMain();
  const patched = patchDesktopMain(main);
  const { source, regionStart, regionLength } = restoreDesktopMain(patched.source);
  const restored = source.subarray(regionStart, regionStart + regionLength);
  const stock = main.subarray(regionStart, regionStart + regionLength);
  assert.ok(restored.equals(stock), "restored region must equal the stock region exactly");
  assert.ok(!restored.toString("utf8").includes(PATCH_MARKER), "the marker must be gone");
});

test("restoring keeps the exact same total byte length", { skip }, () => {
  const main = loadStockMain();
  const patched = patchDesktopMain(main);
  const { source } = restoreDesktopMain(patched.source);
  assert.equal(source.length, patched.source.length);
  assert.equal(source.length, main.length);
});

test("a source without the marker is returned untouched with changed false", { skip }, () => {
  const main = loadStockMain();
  const result = restoreDesktopMain(main);
  assert.equal(result.changed, false);
  assert.equal(result.source, main, "the same buffer is returned untouched");
  assert.ok(result.source.equals(main));
});

test("restoring twice is idempotent: the second run reports changed false", { skip }, () => {
  const main = loadStockMain();
  const patched = patchDesktopMain(main);
  const first = restoreDesktopMain(patched.source);
  const second = restoreDesktopMain(first.source);
  assert.equal(second.changed, false);
  assert.ok(second.source.equals(first.source));
});

test("patch then restore then patch again is a round trip", { skip }, () => {
  const main = loadStockMain();
  const once = patchDesktopMain(main);
  const restored = restoreDesktopMain(once.source);
  assert.ok(restored.source.equals(main), "restored source equals the stock source");
  const twice = patchDesktopMain(restored.source);
  assert.equal(twice.changed, true);
  assert.ok(twice.source.equals(once.source), "re-patching yields the same patched bytes");
});

test("the restored lib/main.js passes node --check", { skip }, () => {
  const main = loadStockMain();
  const patched = patchDesktopMain(main);
  const { source } = restoreDesktopMain(patched.source);
  const file = join(tmpdir(), `dsh-tray-restart-restored-${process.pid}.js`);
  writeFileSync(file, source);
  try {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(file, { force: true });
  }
});

test("a backup region of a different length is refused instead of spliced in", { skip }, () => {
  const main = loadStockMain();
  const patched = patchDesktopMain(main);
  // A backup taken from another DSH build: shorter than the region the patched
  // file actually carries, so its end does not land on the region boundary.
  // Restoring it would splice an unrelated region over this one, so the restore
  // must refuse rather than guess.
  // It still carries the marker, so the restore reaches the length check rather
  // than treating the region as never patched.
  const shorter = Buffer.from(
    `//#region lib/types/tray.js\n${PATCH_MARKER}\n//#endregion\n`,
    "utf8"
  );
  assert.throws(
    () => restoreDesktopMain(patched.source, shorter),
    (error) => {
      assert.equal(error.name, "RegionLengthMismatchError");
      assert.match(error.message, /different DSH Desktop build/);
      return true;
    }
  );
});

test("a backup region of the right length is accepted", { skip }, () => {
  const main = loadStockMain();
  const patched = patchDesktopMain(main);
  const stockRegion = main.subarray(STOCK_REGION_START, STOCK_REGION_START + STOCK_REGION_LENGTH);
  const result = restoreDesktopMain(patched.source, stockRegion);
  assert.equal(result.changed, true);
  assert.ok(result.source.equals(main));
});

test("a source with no tray region throws instead of returning source", () => {
  const main = Buffer.from("head\ntail\n", "utf8");
  assert.throws(() => restoreDesktopMain(main), (e) => e.name === "UnsupportedBuildError");
});
