#!/usr/bin/env node
/**
 * Run the whole suite and fail when a test was skipped.
 *
 * `npm test` skips the suites that need a real app.asar when
 * `DSH_TRAY_FIXTURE` or `DSH_TRAY_ASAR` is unset. A skip is indistinguishable
 * from a pass in the summary line, so a run that silently dropped a quarter of
 * its coverage still reads green. This script refuses that outcome: set both
 * variables, or the run fails.
 *
 * Usage: DSH_TRAY_FIXTURE=... DSH_TRAY_ASAR=... npm run test:strict
 */
import { spawnSync } from "node:child_process";

const REQUIRED = ["DSH_TRAY_FIXTURE", "DSH_TRAY_ASAR"];

const missing = REQUIRED.filter((name) => {
  const value = process.env[name];
  return typeof value !== "string" || value.trim() === "";
});

if (missing.length > 0) {
  console.error(
    `[test:strict] refusing to run: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset.\n` +
      "Set both so the asar suites run, or use `npm test` to accept the skips.",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", "test/"], {
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) process.exit(result.status ?? 1);

// A skip means a suite did not run. Treat it as a failure.
const rerun = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/"], {
  encoding: "utf8",
  env: process.env,
});
const skipped = (rerun.stdout ?? "").split("\n").filter((line) => /^# SKIP|^ok \d+ .*# SKIP/.test(line)).length;
if (skipped > 0) {
  console.error(`[test:strict] ${skipped} test(s) were skipped; coverage is incomplete.`);
  process.exit(1);
}
