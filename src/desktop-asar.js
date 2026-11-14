/**
 * Where the desktop's `app.asar` lives, and how to find it without being told.
 *
 * The Host plugin and the two maintenance scripts all need the same file. Inside
 * the Host the answer is trivial — `process.execPath` is the desktop executable,
 * so `resources/app.asar` sits beside it — but the scripts are run from a
 * terminal, where `process.execPath` is whatever `node` binary is on PATH and
 * the same rule points at a directory that does not exist.
 *
 * This module therefore resolves the path in a fixed order:
 *
 *   1. an explicit path (a command-line argument)
 *   2. `DSH_DESKTOP_APP_ASAR`
 *   3. the executable path, when it is the desktop app itself
 *   4. the backup written by an earlier patch (`~/.dsh/tray-restart-backup`)
 *   5. the Windows uninstall registry: `DisplayIcon` / `InstallLocation`
 *   6. `resources/app.asar` beside `process.execPath` (the old fallback, kept
 *      last so the resolution never throws)
 *
 * Steps 4 and 5 are the "probe": they ask the machine where the desktop is
 * installed instead of assuming a directory. Neither hardcodes a path — the
 * registry key is looked up by the product name it publishes, and the backup
 * records the asar it was taken from.
 *
 * Every probe is injectable, so the tests exercise the order, the failure modes
 * and the error text without a real installation.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { backupDir, META_FILE } from "./backup.js";

/** Environment variable that points the tools at a specific asar. */
export const ASAR_ENV = "DSH_DESKTOP_APP_ASAR";

/** File name of the desktop executable on Windows. */
export const DESKTOP_EXE = "DeepSeek Harness.exe";

/** Uninstall registry key that records where the desktop was installed. */
export const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

/** `DisplayName` prefix the desktop publishes in the uninstall registry. */
export const UNINSTALL_DISPLAY_NAME = "DeepSeek Harness";

/** Where a resolved path came from, most specific first. */
export const SOURCE = {
  argument: "argument",
  environment: ASAR_ENV,
  execPath: "process.execPath",
  backup: "backup",
  registry: "registry",
  fallback: "execPath-fallback"
};

/**
 * `resources/app.asar` beside a running executable.
 *
 * @param {string} execPath normally `process.execPath`.
 * @returns {string}
 */
export function asarPathFromExecPath(execPath) {
  return join(dirname(execPath), "resources", "app.asar");
}

/**
 * True when an executable path is the desktop app rather than a plain `node`.
 *
 * The comparison is on the file name, case-insensitively, because Windows paths
 * are case-insensitive and the installer is free to change the casing.
 *
 * @param {string | undefined} execPath
 * @returns {boolean}
 */
export function isDesktopExecutable(execPath) {
  if (typeof execPath !== "string" || execPath === "") return false;
  const base = execPath.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.toLowerCase() === DESKTOP_EXE.toLowerCase();
}

/**
 * The asar recorded in the backup sidecar, if there is one.
 *
 * The backup is written before the first patch and records the asar it came
 * from, which makes it the most reliable machine-local hint available without
 * spawning a process.
 *
 * @param {{ readFile?: (path: string) => string, dir?: string }} [deps]
 * @returns {string | null}
 */
export function asarFromBackup(deps = {}) {
  const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
  const dir = deps.dir ?? backupDir();
  try {
    const meta = JSON.parse(readFile(join(dir, META_FILE)));
    const path = meta?.asarPath;
    return typeof path === "string" && path !== "" ? path : null;
  } catch {
    return null;
  }
}

/**
 * Ask the Windows uninstall registry where the desktop is installed.
 *
 * `DisplayIcon` is `<install dir>\\DeepSeek Harness.exe,0` and
 * `InstallLocation` is `<install dir>`; either yields the executable, and the
 * asar is `resources/app.asar` beside it. The query is bounded by a short
 * timeout and every failure — no PowerShell, a non-zero exit, unparseable
 * output — returns null so the caller can move on.
 *
 * @param {{ run?: (command: string, args: string[]) => { status: number | null, stdout: string } }} [deps]
 * @returns {string | null}
 */
export function asarFromRegistry(deps = {}) {
  const run = deps.run ?? runRegistryQuery;
  let result;
  try {
    result = run("reg", ["query", UNINSTALL_KEY, "/s", "/f", UNINSTALL_DISPLAY_NAME]);
  } catch {
    return null;
  }
  if (result?.status !== 0 || typeof result.stdout !== "string") return null;
  return asarFromRegistryOutput(result.stdout);
}

/** Spawn `reg` with a bounded timeout and decoded output. */
function runRegistryQuery(command, args) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
}

/**
 * Parse `reg query` output into an asar path.
 *
 * The output is a list of `    Name    REG_SZ    Value` lines. `DisplayIcon`
 * wins because it names the executable; `InstallLocation` is the fallback.
 *
 * @param {string} stdout
 * @returns {string | null}
 */
export function asarFromRegistryOutput(stdout) {
  const fields = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^\s{4}(\S+)\s+REG_SZ\s+(.*)$/.exec(line);
    if (match) fields.set(match[1], match[2].trim());
  }

  const icon = fields.get("DisplayIcon");
  if (icon) {
    // "<install dir>\\DeepSeek Harness.exe,0" -> the executable.
    const exe = icon.replace(/,\d+$/, "").replace(/^"(.*)"$/, "$1");
    if (isDesktopExecutable(exe)) return asarPathFromExecPath(exe);
  }

  const location = fields.get("InstallLocation");
  if (location) return join(location.replace(/^"(.*)"$/, "$1"), "resources", "app.asar");

  return null;
}

/**
 * Resolve the asar path, in the documented order.
 *
 * @param {{
 *   argv?: string[],
 *   env?: Record<string, string | undefined>,
 *   execPath?: string,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   fromBackup?: () => string | null,
 *   fromRegistry?: () => string | null
 * }} [input]
 * @returns {{ path: string, source: string, probed: Array<{ source: string, path: string | null }> }}
 */
export function resolveAsarPath(input = {}) {
  const exists = input.exists ?? existsSync;
  const platform = input.platform ?? process.platform;
  const execPath = input.execPath ?? process.execPath;
  const env = input.env ?? process.env;
  const probed = [];

  const fromArgs = input.argv?.[0];
  if (typeof fromArgs === "string" && fromArgs !== "") {
    return { path: fromArgs, source: SOURCE.argument, probed };
  }

  const fromEnv = env?.[ASAR_ENV];
  if (typeof fromEnv === "string" && fromEnv !== "") {
    return { path: fromEnv, source: SOURCE.environment, probed };
  }

  // Inside the Host this is the answer, and it is the only step that needs no
  // filesystem probe: the desktop executable sits beside its own resources.
  if (isDesktopExecutable(execPath)) {
    const path = asarPathFromExecPath(execPath);
    if (exists(path)) return { path, source: SOURCE.execPath, probed };
  }

  if (platform === "win32") {
    const probes = [
      { source: SOURCE.backup, run: input.fromBackup ?? (() => asarFromBackup()) },
      { source: SOURCE.registry, run: input.fromRegistry ?? (() => asarFromRegistry()) }
    ];
    for (const probe of probes) {
      let path = null;
      try {
        path = probe.run();
      } catch {
        path = null;
      }
      probed.push({ source: probe.source, path });
      if (typeof path === "string" && path !== "" && exists(path)) {
        return { path, source: probe.source, probed };
      }
    }
  }

  return { path: asarPathFromExecPath(execPath), source: SOURCE.fallback, probed };
}

/**
 * An error message that tells the user what to do next.
 *
 * A bare `app.asar not found: C:\\Program Files\\nodejs\\resources\\app.asar`
 * names a path the user never chose and says nothing about the fix. This one
 * names what was tried and the two ways to supply the path.
 *
 * @param {{ path: string, source: string, probed: Array<{ source: string, path: string | null }> }} resolution
 * @returns {string}
 */
export function formatMissingAsar(resolution) {
  const lines = [`app.asar not found at ${resolution.path} (from ${resolution.source})`];
  if (resolution.probed.length > 0) {
    lines.push("probed:");
    for (const probe of resolution.probed) {
      lines.push(`  ${probe.source}: ${probe.path ?? "no hint found"}`);
    }
  }
  lines.push("pass the path as an argument, or set the environment variable:");
  lines.push(`  npm run check:install -- "<install dir>/resources/app.asar"`);
  lines.push(`  ${ASAR_ENV}=<install dir>/resources/app.asar npm run check:install`);
  return lines.join("\n");
}