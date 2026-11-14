#!/usr/bin/env node
/**
 * Print the current dsh-tray-restart install state.
 *
 *   npm run check:install
 *   node scripts/check-install.mjs [path/to/resources/app.asar]
 *
 * Exit codes: 0 patched, 1 not patched, 2 the asar is missing or unreadable.
 * The asar is only ever opened for reading.
 */

import {
  CHECK_EXIT,
  asarPathFromArgs,
  checkExitCode,
  formatCheckReport,
  readInstallStatus
} from "./install-status.mjs";

const asarPath = asarPathFromArgs(process.argv.slice(2), process.env);
const status = readInstallStatus(asarPath);
console.log(formatCheckReport(status));
process.exitCode = checkExitCode(status);
