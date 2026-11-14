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
 * Exit codes: 0 restored or already stock, 1 restore failed, 2 the asar is
 * missing or unreadable.
 */

import { existsSync } from "node:fs";

import { restoreTrayRestart } from "../src/asar.js";
import { RESTORE_EXIT, asarPathFromArgs, formatRestoreReport } from "./install-status.mjs";

const asarPath = asarPathFromArgs(process.argv.slice(2), process.env);

if (!existsSync(asarPath)) {
  console.error(`app.asar not found: ${asarPath}`);
  process.exit(RESTORE_EXIT.unreadable);
}

try {
  const result = restoreTrayRestart(asarPath);
  console.log(formatRestoreReport(result));
  process.exitCode = RESTORE_EXIT.ok;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`restore failed: ${message}`);
  if (error?.name === "AsarFormatError") process.exit(RESTORE_EXIT.unreadable);
  process.exitCode = RESTORE_EXIT.failed;
}
