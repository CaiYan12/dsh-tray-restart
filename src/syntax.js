/**
 * Whole-file syntax gate for the patched `lib/main.js`.
 *
 * The patch core proves the region is the right length and carries the right
 * tokens, but only a parser can prove the result is still valid JavaScript. The
 * spec requires the patched file to pass `node --check`, so the asar writer runs
 * that check on the candidate bytes before any byte reaches the archive.
 *
 * The check runs in a child process because `node --check` is a CLI flag, not an
 * API. That costs one process start (about 50 ms) on the single start that
 * actually patches; every later start is a no-op and never reaches this module.
 *
 * When the check cannot run at all — no `node` executable, or a spawn failure —
 * the caller is told so (`status: "unavailable"`) and decides. The asar writer
 * refuses to write in that case: see `assertParses` in `asar.js`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Thrown when the candidate bytes are not valid JavaScript. */
export class SyntaxCheckError extends Error {
  constructor(detail) {
    super(`patched lib/main.js failed the syntax check: ${detail}`);
    this.name = "SyntaxCheckError";
  }
}

/**
 * @typedef {object} SyntaxCheckResult
 * @property {"ok" | "invalid" | "unavailable"} status
 * @property {string} [detail]  why the check failed, or why it could not run.
 */

/**
 * Run `node --check` over `source`.
 *
 * @param {Buffer} source the candidate `lib/main.js` bytes.
 * @param {{ execPath?: string, spawn?: typeof spawnSync, timeoutMs?: number }} [options]
 *   `execPath` defaults to the running Node; `spawn` is injectable for tests.
 * @returns {SyntaxCheckResult}
 */
export function checkSyntax(source, options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const spawn = options.spawn ?? spawnSync;
  const timeoutMs = options.timeoutMs ?? 60_000;

  if (typeof execPath !== "string" || execPath === "") {
    return { status: "unavailable", detail: "no node executable to run --check with" };
  }

  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "dsh-tray-restart-check-"));
  } catch (error) {
    return { status: "unavailable", detail: `could not create a temp file: ${error.message}` };
  }

  const file = join(dir, "main.js");
  try {
    writeFileSync(file, source);
    let result;
    try {
      result = spawn(execPath, ["--check", file], { encoding: "utf8", timeout: timeoutMs });
    } catch (error) {
      return { status: "unavailable", detail: `could not run node --check: ${error.message}` };
    }
    if (result?.error) {
      // ENOENT and friends: the executable is not there or not runnable.
      return { status: "unavailable", detail: `could not run node --check: ${result.error.message}` };
    }
    if (result?.status === 0) return { status: "ok" };
    const stderr = String(result?.stderr ?? "").trim();
    const signal = result?.signal ? ` (killed by ${result.signal})` : "";
    return { status: "invalid", detail: `${stderr || `exit code ${result?.status}`}${signal}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
