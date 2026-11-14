import test from "node:test";
import assert from "node:assert/strict";

import { compareVersions, parseRange, parseVersion, satisfies, VersionError } from "../src/version.js";

const RANGE = ">=0.2.2-rc.3 <0.3.0";

// ── parseVersion ──────────────────────────────────────────────────────────

test("parseVersion reads a plain release", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
});

test("parseVersion reads a prerelease and keeps numeric identifiers numeric", () => {
  assert.deepEqual(parseVersion("0.2.2-rc.3"), {
    major: 0,
    minor: 2,
    patch: 2,
    prerelease: ["rc", 3]
  });
});

test("parseVersion tolerates a leading v and build metadata", () => {
  assert.equal(parseVersion("v0.2.2-rc.3+build.7").prerelease.join("."), "rc.3");
});

test("parseVersion rejects a string that is not a version", () => {
  for (const bad of ["", "1.2", "abc", "1.2.3.4"]) {
    assert.throws(() => parseVersion(bad), (error) => error.name === "VersionError", bad);
  }
});

// ── compareVersions ───────────────────────────────────────────────────────

test("compareVersions orders releases by major, minor then patch", () => {
  assert.equal(compareVersions(parseVersion("0.2.2"), parseVersion("0.2.3")), -1);
  assert.equal(compareVersions(parseVersion("0.3.0"), parseVersion("0.2.9")), 1);
  assert.equal(compareVersions(parseVersion("1.0.0"), parseVersion("1.0.0")), 0);
});

test("a prerelease ranks below its release", () => {
  assert.equal(compareVersions(parseVersion("0.2.2-rc.3"), parseVersion("0.2.2")), -1);
  assert.equal(compareVersions(parseVersion("0.2.2"), parseVersion("0.2.2-rc.3")), 1);
});

test("prerelease identifiers compare numerically, then lexically", () => {
  assert.equal(compareVersions(parseVersion("0.2.2-rc.2"), parseVersion("0.2.2-rc.3")), -1);
  assert.equal(compareVersions(parseVersion("0.2.2-rc.10"), parseVersion("0.2.2-rc.9")), 1);
  assert.equal(compareVersions(parseVersion("0.2.2-alpha"), parseVersion("0.2.2-beta")), -1);
});

test("a numeric identifier ranks below an alphanumeric one", () => {
  assert.equal(compareVersions(parseVersion("0.2.2-1"), parseVersion("0.2.2-alpha")), -1);
});

test("a shorter identifier list ranks below a longer one with the same prefix", () => {
  assert.equal(compareVersions(parseVersion("0.2.2-rc"), parseVersion("0.2.2-rc.1")), -1);
});

// ── satisfies: the range the plugin actually ships ────────────────────────

test("the supported range accepts the measured build", () => {
  assert.equal(satisfies("0.2.2-rc.3", RANGE), true);
});

test("the supported range accepts later releases inside 0.2.x", () => {
  for (const version of ["0.2.2", "0.2.5", "0.2.99"]) {
    assert.equal(satisfies(version, RANGE), true, version);
  }
});

test("the supported range rejects an earlier prerelease", () => {
  assert.equal(satisfies("0.2.2-rc.2", RANGE), false);
});

test("the supported range rejects a prerelease of 0.3.0", () => {
  // The upper bound is 0.3.0, and a 0.3.0 prerelease is not inside it: the
  // prerelease rule only admits prereleases named by a comparator.
  assert.equal(satisfies("0.3.0-rc.1", RANGE), false);
});

test("the supported range rejects 0.3.0 and later", () => {
  for (const version of ["0.3.0", "0.3.1", "1.0.0"]) {
    assert.equal(satisfies(version, RANGE), false, version);
  }
});

test("the supported range rejects 0.2.1 and earlier", () => {
  for (const version of ["0.2.1", "0.1.0", "0.2.0-rc.1"]) {
    assert.equal(satisfies(version, RANGE), false, version);
  }
});

// ── the rest of the grammar ───────────────────────────────────────────────

test("caret ranges follow npm semantics", () => {
  assert.equal(satisfies("1.2.3", "^1.2.3"), true);
  assert.equal(satisfies("1.9.0", "^1.2.3"), true);
  assert.equal(satisfies("2.0.0", "^1.2.3"), false);
  assert.equal(satisfies("0.2.5", "^0.2.3"), true);
  assert.equal(satisfies("0.3.0", "^0.2.3"), false);
});

test("tilde ranges allow patch changes only", () => {
  assert.equal(satisfies("1.2.9", "~1.2.3"), true);
  assert.equal(satisfies("1.3.0", "~1.2.3"), false);
});

test("alternatives are separated by ||", () => {
  assert.equal(satisfies("0.1.0", "<0.2.0 || >=0.3.0"), true);
  assert.equal(satisfies("0.2.5", "<0.2.0 || >=0.3.0"), false);
});

test("a wildcard accepts everything", () => {
  assert.equal(satisfies("9.9.9", "*"), true);
});

test("an exact version is a range of one", () => {
  assert.equal(satisfies("0.2.2-rc.3", "0.2.2-rc.3"), true);
  assert.equal(satisfies("0.2.2-rc.4", "0.2.2-rc.3"), false);
});

test("parseRange rejects an empty range", () => {
  assert.throws(() => parseRange("  "), (error) => error.name === "VersionError");
  assert.throws(() => satisfies("1.0.0", ""), VersionError);
});
