#!/usr/bin/env node
/**
 * Print the current dsh-tray-restart install state.
 *
 *   npm run check:install
 *   node scripts/check-install.mjs [path/to/resources/app.asar]
 *
 * Without an argument the asar is resolved by probing the machine (see
 * `src/desktop-asar.js`), so running this from a terminal with plain `node`
 * finds the installed desktop instead of looking beside `node.exe`.
 *
 * Exit codes: 0 patched, 1 not patched, 2 the asar is missing or unreadable.
 * The asar is only ever opened for reading.
 */

import {
  CHECK_EXIT,
  checkExitCode,
  formatCheckReport,
  missingAsarMessage,
  readInstallStatus,
  resolveInstallAsar
} from "./install-status.mjs";

const resolution = resolveInstallAsar(process.argv.slice(2), process.env);
const status = readInstallStatus(resolution.path);
console.log(formatCheckReport(status));
if (!status.exists) console.error(missingAsarMessage(resolution));
process.exitCode = checkExitCode(status);
