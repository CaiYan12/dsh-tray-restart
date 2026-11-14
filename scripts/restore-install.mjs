#!/usr/bin/env node
/**
 * Restore the tray menu of the installed DSH Desktop to the stock region.
 *
 *   npm run restore:install
 *   node scripts/restore-install.mjs [path/to/resources/app.asar]
 *
 * Run this after removing the plugin: the DSH plugin uninstall flow does not
 * roll back the asar patch. The stock bytes come from the Backup written before
 * the first patch; without one the restore is refused rather than guessed.
 *
 * Without an argument the asar is resolved by probing the machine (see
 * `src/desktop-asar.js`), the same way `check-install` resolves it.
 *
 * Exit codes: 0 restored or already stock, 1 restore failed, 2 the asar is
 * missing or unreadable.
 */

import { existsSync } from "node:fs";

import { restoreTrayRestart } from "../src/asar.js";
import {
  RESTORE_EXIT,
  formatRestoreReport,
  missingAsarMessage,
  resolveInstallAsar
} from "./install-status.mjs";

const resolution = resolveInstallAsar(process.argv.slice(2), process.env);

if (!existsSync(resolution.path)) {
  console.error(missingAsarMessage(resolution));
  process.exit(RESTORE_EXIT.unreadable);
}

try {
  const result = restoreTrayRestart(resolution.path);
  console.log(formatRestoreReport(result));
  process.exitCode = RESTORE_EXIT.ok;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`restore failed: ${message}`);
  if (error?.name === "AsarFormatError") process.exit(RESTORE_EXIT.unreadable);
  process.exitCode = RESTORE_EXIT.failed;
}
