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
 *   readDesktopVersion() the DSH version the asar was built for
 *   versionSupported() whether that version is inside `engines.dsh`
 *
 * `apply(ctx, deps)` wires those to the real patch module and the real
 * notification channel; the dependencies are injectable so the tests never
 * touch an installed asar or a live Electron process.
 *
 * The bubble copy lives in `locale/{en,zh}.json` beside this file, not in the
 * code, so the plugin's own text follows the same convention as its title and
 * description. The tray menu label is different: it is built by DSH from
 * `messages.restartApplication`, the Host's own locale dictionary, and stays
 * that way.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { satisfies } from "./version.js";

/** Loader identity for the tray restart bundle. */
export const name = "dsh-tray-restart";

/** Environment variable that points the entry at a specific asar. */
export const ASAR_ENV = "DSH_DESKTOP_APP_ASAR";

/** The patch module, imported with a cache-busting revision below. */
const PATCH_MODULE = new URL("./asar.js", import.meta.url);

/** Read exactly `length` bytes at `position`, looping over short reads. */
function readExactly(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new Error(`unexpected end of file at byte ${position + done}`);
    done += read;
  }
  return buffer;
}

/**
 * `engines.dsh` from this package's own manifest.
 *
 * Read at module load so the range the code enforces is the one the manifest
 * declares; a mismatch between the two is what the package test guards.
 */
export const DSH_RANGE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
).engines.dsh;

/** Language the plugin falls back to when the desktop's language has no dictionary. */
export const FALLBACK_LANGUAGE = "en";

/** Languages the bundle ships a dictionary for. */
export const SUPPORTED_LANGUAGES = ["en", "zh"];

/** Directory holding the locale dictionaries, beside this module. */
const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "locale");

/** Parsed dictionaries, keyed by language. Read once per process. */
const dictionaryCache = new Map();

/**
 * The language key for a locale id: `zh-CN` and `zh_Hans` both map to `zh`.
 *
 * @param {string} language
 * @returns {string}
 */
function languageKey(language) {
  return String(language).toLowerCase().split(/[-_]/)[0];
}

/**
 * Read one locale dictionary.
 *
 * A missing or unparseable file is not fatal: the fallback dictionary is used
 * instead, so a packaging mistake degrades the bubble text rather than the
 * plugin. The caller that cares (`apply`) only ever shows a bubble, never fails.
 *
 * @param {string} key a `SUPPORTED_LANGUAGES` entry.
 * @returns {{ notification?: { title?: string, body?: string } } | null}
 */
function readDictionary(key) {
  if (dictionaryCache.has(key)) return dictionaryCache.get(key);
  let dictionary = null;
  try {
    dictionary = JSON.parse(readFileSync(join(LOCALE_DIR, `${key}.json`), "utf8"));
  } catch {
    dictionary = null;
  }
  dictionaryCache.set(key, dictionary);
  return dictionary;
}

/**
 * The notification copy for a language id.
 *
 * @param {string} language
 * @returns {{ title: string, body: string }}
 */
export function notificationCopy(language) {
  const key = languageKey(language);
  const dictionary = readDictionary(key) ?? readDictionary(FALLBACK_LANGUAGE);
  const notification = dictionary?.notification ?? {};
  return {
    title: typeof notification.title === "string" ? notification.title : "DeepSeek Harness",
    body: typeof notification.body === "string" ? notification.body : ""
  };
}

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
    // Collect the parenthetical parts first, then open and close the bracket
    // once: building it from two independently-terminated fragments produced
    // an unclosed "(" whenever the byte count was known but integrity was not.
    const details = [];
    if (result.mainBytes !== undefined) details.push(`${String(result.mainBytes)} bytes`);
    if (result.integrityUpdated) details.push("integrity updated");
    const suffix = details.length === 0 ? "" : ` (${details.join(", ")})`;
    return {
      level: "info",
      message: `added Restart DeepSeek Harness to the tray menu${suffix}; restart the desktop app to use it`
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
  return notificationCopy(language).body;
}

/** The bubble title for a language id. */
function notificationTitle(language) {
  return notificationCopy(language).title;
}

/**
 * Read `version` out of an asar's own `package.json`, read-only.
 *
 * Only the header is parsed; the manifest is a small packed file, so this is a
 * header read plus one small read, not a scan of the archive.
 *
 * @param {string} asarPath
 * @returns {string | null} the version, or null when it cannot be read.
 */
export function readDesktopVersion(asarPath) {
  let fd;
  try {
    fd = openSync(asarPath, "r");
    const fileSize = fstatSync(fd).size;
    const prefix = readExactly(fd, 16, 0);
    const dataOffset = 8 + prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize === 0 || 16 + jsonSize > fileSize) return null;
    const header = JSON.parse(readExactly(fd, jsonSize, 16).toString("utf8"));
    const node = header?.files?.package?.files?.["package.json"];
    if (node === undefined || node.unpacked || node.files) return null;
    const start = dataOffset + Number(node.offset);
    const size = Number(node.size);
    if (start + size > fileSize) return null;
    const manifest = JSON.parse(readExactly(fd, size, start).toString("utf8"));
    return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Decide whether a DSH version is inside the plugin's supported range.
 *
 * @param {string | null} version the asar's own version.
 * @param {string} range `engines.dsh` from this package's manifest.
 * @returns {{ supported: boolean, reason: "ok" | "unknown-version" | "out-of-range" | "bad-range", message?: string }}
 */
export function versionSupported(version, range) {
  if (typeof version !== "string" || version === "") {
    return {
      supported: false,
      reason: "unknown-version",
      message: "could not read the DSH version from app.asar/package.json"
    };
  }
  let ok;
  try {
    ok = satisfies(version, range);
  } catch (error) {
    return {
      supported: false,
      reason: "bad-range",
      message: `engines.dsh "${range}" is not a usable range: ${error.message}`
    };
  }
  if (ok) return { supported: true, reason: "ok" };
  return {
    supported: false,
    reason: "out-of-range",
    message: `DSH ${version} is outside the supported range "${range}"`
  };
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
  language: () => desktopLanguage(),
  readVersion: (path) => readDesktopVersion(path),
  supportedRange: DSH_RANGE
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

  // Version gate: an unverified DSH build is refused before anything is read
  // for writing. The patch relies on the exact text of the tray region, so a
  // build outside `engines.dsh` is a build nobody measured.
  const version = options.readVersion(options.asarPath);
  const supported = versionSupported(version, options.supportedRange);
  if (!supported.supported) {
    logger.warn(`${supported.message}; the tray menu was not patched`);
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
    // One copy lookup per language, so the title and the body always come from
    // the same dictionary.
    const language = options.language();
    const copy = notificationCopy(language);
    await options.notify(copy.body, copy.title);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`could not show the restart reminder: ${reason}`);
  }
}
