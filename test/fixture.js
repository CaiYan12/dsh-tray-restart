import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Absolute path of the stock `lib/main.js` fixture.
 *
 * The fixture is a byte-for-byte copy of `lib/main.js` extracted from the
 * packaged DSH Desktop `app.asar`. It is 848505 bytes, so it lives outside the
 * repository and is read from the shared research directory at test time.
 *
 * Override with `DSH_TRAY_FIXTURE` when the shared directory moves.
 */
export const FIXTURE_PATH = process.env.DSH_TRAY_FIXTURE
  ?? "D:\\Dev\\dsh-tray-restart-shared\\fixtures\\main-stock.js";

export const FIXTURE_MISSING_MESSAGE =
  `[fixture-missing] stock fixture not found at ${FIXTURE_PATH}. ` +
  "Set DSH_TRAY_FIXTURE to the path of the extracted stock lib/main.js " +
  "(see D:\\Dev\\dsh-tray-restart-shared\\notes\\fixture-guide.md).";

/** @returns {Buffer | null} the stock `lib/main.js` bytes, or null when the fixture is absent. */
export function loadStockMain() {
  if (!existsSync(FIXTURE_PATH)) return null;
  return readFileSync(FIXTURE_PATH);
}

/**
 * node:test `skip` option. Tests that need the fixture pass this so a missing
 * shared directory skips them with the explicit message above instead of
 * failing the suite.
 */
export function fixtureSkip() {
  if (existsSync(FIXTURE_PATH)) return false;
  console.log(FIXTURE_MISSING_MESSAGE);
  return FIXTURE_MISSING_MESSAGE;
}

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");
