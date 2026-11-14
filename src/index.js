/**
 * Host plugin entry: patch the desktop shell's tray at startup.
 *
 * The desktop shell owns its tray inside the Electron main process and exposes
 * no plugin API for menu items, so the only way to add a Restart item is to
 * patch `lib/main.js` inside the packaged `app.asar`. This entry does that once
 * per Host start, on Windows only, and never lets a failure reach the Host:
 * every path that is not a successful patch ends in a log line.
 *
 * The decisions worth testing are pure and exported:
 *
 *   shouldPatch()     platform and asar presence decide whether to patch at all
 *   asarPathFrom()    the environment override, or resources/app.asar beside the exe
 *   describeResult()  one log line per outcome
 *   notificationBody() the bubble text, in the desktop's language
 *
 * `apply(ctx, deps)` wires those to the real patch module and the real
 * notification channel; the dependencies are injectable so the tests never
 * touch an installed asar or a live Electron process.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Loader identity for the tray restart bundle. */
export const name = "dsh-tray-restart";

/** Environment variable that points the entry at a specific asar. */
export const ASAR_ENV = "DSH_DESKTOP_APP_ASAR";

/** The patch module, imported with a cache-busting revision below. */
const PATCH_MODULE = new URL("./asar.js", import.meta.url);

/** Notification copy, keyed by the desktop's language. */
const NOTIFICATIONS = {
  en: {
    title: "DeepSeek Harness",
    body: "Restart DeepSeek Harness to use the new tray menu item."
  },
  zh: {
    title: "DeepSeek Harness",
    body: "重启 DeepSeek Harness 后，托盘菜单里的「重启」项才会生效。"
  }
};

/**
 * Decide whether this Host should patch the asar at all.
 *
 * @param {{ platform: string, asarExists: boolean }} input
 * @returns {{ patch: boolean, reason: "ok" | "platform" | "asar-missing" }}
 */
export function shouldPatch(input) {
  if (input.platform !== "win32") return { patch: false, reason: "platform" };
  if (!input.asarExists) return { patch: false, reason: "asar-missing" };
  return { patch: true, reason: "ok" };
}

/**
 * Resolve the asar path: the environment override first, then
 * `resources/app.asar` beside the running executable.
 *
 * @param {{ env?: Record<string, string | undefined>, execPath: string }} input
 * @returns {string}
 */
export function asarPathFrom(input) {
  const override = input.env?.[ASAR_ENV];
  if (override) return override;
  return join(dirname(input.execPath), "resources", "app.asar");
}

/**
 * Turn a patch outcome into one log line.
 *
 * @param {{ changed: boolean, mainBytes?: number, integrityUpdated?: boolean } | undefined} result
 * @param {unknown} [error]
 * @returns {{ level: "info" | "warn", message: string }}
 */
export function describeResult(result, error) {
  if (error !== undefined) {
    const reason = error instanceof Error ? error.message : String(error);
    return { level: "warn", message: `could not add Restart DeepSeek Harness to the tray menu: ${reason}` };
  }
  if (result?.changed) {
    const bytes = result.mainBytes === undefined ? "" : ` (${String(result.mainBytes)} bytes`;
    const integrity = result.integrityUpdated ? ", integrity updated)" : bytes === "" ? "" : ")";
    return {
      level: "info",
      message: `added Restart DeepSeek Harness to the tray menu${bytes}${integrity}; restart the desktop app to use it`
    };
  }
  return { level: "info", message: "the tray menu is already patched; nothing to do" };
}

/**
 * The bubble text for a language id.
 *
 * @param {string} language
 * @returns {string}
 */
export function notificationBody(language) {
  const dictionary = NOTIFICATIONS[String(language).toLowerCase().split("-")[0]] ?? NOTIFICATIONS.en;
  return dictionary.body;
}

/** The bubble title for a language id. */
function notificationTitle(language) {
  const dictionary = NOTIFICATIONS[String(language).toLowerCase().split("-")[0]] ?? NOTIFICATIONS.en;
  return dictionary.title;
}

/**
 * Show one tray bubble through Electron's Notification.
 *
 * Inside the Host process `electron` is not importable, so this returns false
 * and the caller keeps going with the log line alone. The failure is swallowed
 * on purpose: a notification is a nicety, never a reason to fail startup.
 *
 * @param {string} body
 * @param {string} title
 * @returns {Promise<boolean>}
 */
async function showNotification(body, title) {
  const { Notification } = await import("electron");
  if (typeof Notification?.isSupported === "function" && !Notification.isSupported()) return false;
  new Notification({ title, body, silent: true }).show();
  return true;
}

/** The language the desktop is running in, best effort. */
function desktopLanguage() {
  const fromEnv = process.env.DSH_LOCALE ?? process.env.LC_ALL ?? process.env.LANG;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return Intl.DateTimeFormat().resolvedOptions().locale ?? "en";
}

/** Default dependencies: the real filesystem, the real patch module, Electron. */
export const APPLY_DEFAULTS = {
  platform: process.platform,
  asarPath: asarPathFrom({ env: process.env, execPath: process.execPath }),
  asarExists: (path) => existsSync(path),
  importPatch: () => import(withRevision(PATCH_MODULE)),
  applyTrayRestart: undefined,
  notify: (body, title = notificationTitle(desktopLanguage())) => showNotification(body, title),
  language: () => desktopLanguage()
};

/**
 * Append the module's mtime as a query parameter so a development edit is
 * picked up without restarting the Host.
 *
 * @param {URL} moduleUrl
 * @returns {string}
 */
function withRevision(moduleUrl) {
  let revision;
  try {
    revision = statSync(moduleUrl).mtimeMs;
  } catch {
    // A missing file fails at import time with a better message than this one.
    return moduleUrl.href;
  }
  const url = new URL(moduleUrl);
  url.searchParams.set("rev", String(revision));
  return url.href;
}

/**
 * Patch the desktop shell's tray menu at Host startup.
 *
 * @param {object} ctx Host plugin context; only `ctx.logger(name)` is used.
 * @param {object} [overrides] dependencies, for tests.
 */
export async function apply(ctx, overrides = {}) {
  const options = { ...APPLY_DEFAULTS, ...overrides };
  const logger = ctx.logger(name);
  const log = (line) => (line.level === "warn" ? logger.warn(line.message) : logger.info(line.message));

  const decision = shouldPatch({ platform: options.platform, asarExists: options.asarExists(options.asarPath) });
  if (!decision.patch) {
    if (decision.reason === "platform") {
      logger.info("the tray restart action is only available on Windows");
    } else {
      logger.info(`desktop app.asar was not found at ${options.asarPath}; tray restart was not installed`);
    }
    return;
  }

  let result;
  try {
    const patch = async (path) => {
      if (options.applyTrayRestart !== undefined) return options.applyTrayRestart(path);
      const module = await options.importPatch();
      return module.applyTrayRestart(path);
    };
    result = await patch(options.asarPath);
  } catch (error) {
    log(describeResult(undefined, error));
    return;
  }

  log(describeResult(result));

  if (!result?.changed) return;
  try {
    await options.notify(notificationBody(options.language()), notificationTitle(options.language()));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`could not show the restart reminder: ${reason}`);
  }
}
