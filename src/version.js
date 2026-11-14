/**
 * Minimal semver range check for `engines.dsh`.
 *
 * The plugin may only patch a DSH Desktop build it was measured against, so the
 * Host entry compares the asar's own `version` against `engines.dsh` before
 * touching anything. The range syntax is small enough that a dependency would be
 * more surface than value, and every rule below is exercised by the tests.
 *
 * Supported range grammar (space-separated comparators, all must hold):
 *
 *   >=1.2.3   >1.2.3   <=1.2.3   <1.2.3   =1.2.3   1.2.3
 *   ^1.2.3    ~1.2.3   *   x
 *
 * Prerelease semantics follow semver.org §11: a prerelease version only
 * satisfies a comparator set when at least one comparator in that set itself
 * carries a prerelease with the same `major.minor.patch`, and it must be
 * strictly greater than that comparator's prerelease. So
 * `>=0.2.2-rc.3 <0.3.0` accepts `0.2.2-rc.3` and `0.2.5` but rejects
 * `0.2.2-rc.2` and `0.2.2-beta.1`.
 */

/** A parsed version: numeric triple plus prerelease identifiers. */
const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

/** Thrown when a version string or a range cannot be parsed. */
export class VersionError extends Error {
  constructor(reason) {
    super(`invalid version: ${reason}`);
    this.name = "VersionError";
  }
}

/**
 * Parse a version string.
 *
 * @param {string} text e.g. "0.2.2-rc.3"
 * @returns {{ major: number, minor: number, patch: number, prerelease: (string | number)[] }}
 */
export function parseVersion(text) {
  const match = VERSION_PATTERN.exec(String(text).trim());
  if (match === null) throw new VersionError(`"${text}" is not a semantic version`);
  const prerelease = match[4] === undefined
    ? []
    : match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

/** True when the version carries a prerelease tag. */
function isPrerelease(version) {
  return version.prerelease.length > 0;
}

/**
 * Compare two parsed versions per semver.org §11.
 *
 * @returns {number} negative, zero or positive.
 */
export function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  // A version without a prerelease ranks above one with it.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    // A shorter identifier list ranks below a longer one with equal prefix.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = typeof a === "number";
    const bNumeric = typeof b === "number";
    if (aNumeric && bNumeric) {
      if (a !== b) return a < b ? -1 : 1;
      continue;
    }
    // Numeric identifiers always rank below alphanumeric ones.
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * @typedef {object} Comparator
 * @property {"<" | "<=" | ">" | ">=" | "="} operator
 * @property {ReturnType<typeof parseVersion>} version
 */

/**
 * Expand one range token into the comparators it stands for.
 *
 * @param {string} token
 * @returns {Comparator[]}
 */
function expandToken(token) {
  const wildcard = /^(\*|x|X)$/;
  if (wildcard.test(token)) return [];

  const caret = /^\^(.*)$/.exec(token);
  if (caret !== null) {
    const base = parseVersion(caret[1]);
    const upper = caretUpperBound(base);
    return [
      { operator: ">=", version: base },
      { operator: "<", version: upper }
    ];
  }

  const tilde = /^~(.*)$/.exec(token);
  if (tilde !== null) {
    const base = parseVersion(tilde[1]);
    const upper = { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] };
    return [
      { operator: ">=", version: base },
      { operator: "<", version: upper }
    ];
  }

  const explicit = /^(>=|<=|>|<|=)(.*)$/.exec(token);
  if (explicit !== null) {
    return [{ operator: explicit[1], version: parseVersion(explicit[2]) }];
  }
  return [{ operator: "=", version: parseVersion(token) }];
}

/** The exclusive upper bound of a caret range, per npm's caret semantics. */
function caretUpperBound(base) {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] };
  return { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
}

/**
 * Parse a range into a list of comparator sets. Each set is the conjunction of
 * its comparators; the sets are alternatives separated by `||`.
 *
 * @param {string} range
 * @returns {Comparator[][]}
 */
export function parseRange(range) {
  const text = String(range).trim();
  if (text === "") throw new VersionError("the range is empty");
  return text.split("||").map((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter((token) => token !== "");
    if (tokens.length === 0) throw new VersionError(`"${range}" has an empty alternative`);
    return tokens.flatMap(expandToken);
  });
}

/** Test one comparator. */
function satisfiesComparator(version, comparator) {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">=": return order >= 0;
    case ">": return order > 0;
    case "<=": return order <= 0;
    case "<": return order < 0;
    default: return order === 0;
  }
}

/**
 * Test one comparator set, including the semver §11 prerelease rule.
 *
 * A prerelease version is only allowed through a set that names a prerelease on
 * the same `major.minor.patch`: otherwise `0.3.0-rc.1` would sneak past
 * `>=0.2.2-rc.3 <0.3.0`, which is exactly the unverified build the range exists
 * to exclude.
 */
function satisfiesSet(version, comparators) {
  if (!comparators.every((comparator) => satisfiesComparator(version, comparator))) return false;
  if (!isPrerelease(version)) return true;
  return comparators.some((comparator) => {
    const other = comparator.version;
    return isPrerelease(other)
      && other.major === version.major
      && other.minor === version.minor
      && other.patch === version.patch;
  });
}

/**
 * True when `version` satisfies `range`.
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  return parseRange(range).some((comparators) => satisfiesSet(parsed, comparators));
}
