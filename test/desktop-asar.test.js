import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  ASAR_ENV,
  DESKTOP_EXE,
  SOURCE,
  asarFromBackup,
  asarFromRegistry,
  asarFromRegistryOutput,
  asarPathFromExecPath,
  formatMissingAsar,
  isDesktopExecutable,
  resolveAsarPath
} from "../src/desktop-asar.js";

// ── Paths used by the cases ───────────────────────────────────────────────
//
// None of these exist: every existence check is injected, so the cases describe
// an installation without touching one. The names mirror a Windows install so
// the path joining is exercised with backslashes, as it is on the target.

const INSTALL = "C:\\Program Files\\Deepseek";
const DESKTOP_EXE_PATH = join(INSTALL, DESKTOP_EXE);
const INSTALLED_ASAR = join(INSTALL, "resources", "app.asar");
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const NODE_ASAR = join("C:\\Program Files\\nodejs", "resources", "app.asar");

/** An existence predicate that only accepts the paths listed. */
function onlyExisting(...paths) {
  const allowed = new Set(paths);
  return (path) => allowed.has(path);
}

/** Probe stubs that must not run: they fail the case if called. */
function noProbes() {
  return {
    fromBackup: () => {
      throw new Error("the backup probe must not run");
    },
    fromRegistry: () => {
      throw new Error("the registry probe must not run");
    }
  };
}

// ── asarPathFromExecPath / isDesktopExecutable ─────────────────────────────

test("asarPathFromExecPath puts resources/app.asar beside the executable", () => {
  assert.equal(asarPathFromExecPath(DESKTOP_EXE_PATH), INSTALLED_ASAR);
});

test("isDesktopExecutable recognises the desktop app in either path style", () => {
  assert.equal(isDesktopExecutable(DESKTOP_EXE_PATH), true);
  assert.equal(isDesktopExecutable("D:/Program Files/Deepseek/DeepSeek Harness.exe"), true);
  assert.equal(isDesktopExecutable("C:\\Program Files\\Deepseek\\DEEPSEEK HARNESS.EXE"), true);
  assert.equal(isDesktopExecutable(NODE_EXE), false);
  assert.equal(isDesktopExecutable(""), false);
  assert.equal(isDesktopExecutable(undefined), false);
});

// ── resolveAsarPath: the order ────────────────────────────────────────────

test("the argument wins over everything, including the environment", () => {
  const resolution = resolveAsarPath({
    argv: ["C:\\x\\app.asar"],
    env: { [ASAR_ENV]: "C:\\y\\app.asar" },
    execPath: DESKTOP_EXE_PATH,
    platform: "win32",
    exists: () => true,
    ...noProbes()
  });
  assert.equal(resolution.path, "C:\\x\\app.asar");
  assert.equal(resolution.source, SOURCE.argument);
});

test("the environment wins over the desktop executable", () => {
  const resolution = resolveAsarPath({
    argv: [],
    env: { [ASAR_ENV]: "C:\\y\\app.asar" },
    execPath: DESKTOP_EXE_PATH,
    platform: "win32",
    exists: () => true,
    ...noProbes()
  });
  assert.equal(resolution.path, "C:\\y\\app.asar");
  assert.equal(resolution.source, SOURCE.environment);
});

test("an empty argument and an empty environment variable are ignored", () => {
  const resolution = resolveAsarPath({
    argv: [""],
    env: { [ASAR_ENV]: "" },
    execPath: DESKTOP_EXE_PATH,
    platform: "win32",
    exists: onlyExisting(INSTALLED_ASAR),
    ...noProbes()
  });
  assert.equal(resolution.path, INSTALLED_ASAR);
  assert.equal(resolution.source, SOURCE.execPath);
});

test("inside the Host, process.execPath is the desktop and needs no probe", () => {
  const resolution = resolveAsarPath({
    argv: [],
    env: {},
    execPath: DESKTOP_EXE_PATH,
    platform: "win32",
    exists: onlyExisting(INSTALLED_ASAR),
    ...noProbes()
  });
  assert.equal(resolution.path, INSTALLED_ASAR);
  assert.equal(resolution.source, SOURCE.execPath);
  assert.deepEqual(resolution.probed, []);
});

test("from a terminal, node.exe is not the desktop and the backup is probed", () => {
  const resolution = resolveAsarPath({
    argv: [],
    env: {},
    execPath: NODE_EXE,
    platform: "win32",
    exists: onlyExisting(INSTALLED_ASAR),
    fromBackup: () => INSTALLED_ASAR,
    fromRegistry: () => {
      throw new Error("the registry probe must not run once the backup answers");
    }
  });
  assert.equal(resolution.path, INSTALLED_ASAR);
  assert.equal(resolution.source, SOURCE.backup);
  assert.deepEqual(resolution.probed, [{ source: SOURCE.backup, path: INSTALLED_ASAR }]);
});

test("a backup hint that no longer exists falls through to the registry", () => {
  const resolution = resolveAsarPath({
    argv: [],
    env: {},
    execPath: NODE_EXE,
    platform: "win32",
    exists: onlyExisting(INSTALLED_ASAR),
    fromBackup: () => "C:\\old\\install\\resources\\app.asar",
    fromRegistry: () => INSTALLED_ASAR
  });
  assert.equal(resolution.path, INSTALLED_ASAR);
  assert.equal(resolution.source, SOURCE.registry);
  assert.deepEqual(resolution.probed, [
    { source: SOURCE.backup, path: "C:\\old\\install\\resources\\app.asar" },
    { source: SOURCE.registry, path: INSTALLED_ASAR }
  ]);
});

test("when every probe fails the resolution falls back to resources/app.asar beside node", () => {
  const resolution = resolveAsarPath({
    argv: [],
    env: {},
    execPath: NODE_EXE,
    platform: "win32",
    exists: () => false,
    fromBackup: () => null,
    fromRegistry: () => null
  });
  assert.equal(resolution.path, NODE_ASAR);
  assert.equal(resolution.source, SOURCE.fallback);
  assert.equal(resolution.probed.length, 2);
});

test("a probe that throws is treated as no hint", () => {
  const resolution = resolveAsarPath({
    argv: [],
    env: {},
    execPath: NODE_EXE,
    platform: "win32",
    exists: onlyExisting(INSTALLED_ASAR),
    fromBackup: () => {
      throw new Error("unreadable backup");
    },
    fromRegistry: () => INSTALLED_ASAR
  });
  assert.equal(resolution.path, INSTALLED_ASAR);
  assert.equal(resolution.source, SOURCE.registry);
  assert.equal(resolution.probed[0].path, null);
});

test("off Windows only the executable rule applies, with no registry probe", () => {
  const resolution = resolveAsarPath({
    argv: [],
    env: {},
    execPath: "/usr/bin/node",
    platform: "linux",
    exists: () => false,
    ...noProbes()
  });
  assert.equal(resolution.path, join("/usr/bin", "resources", "app.asar"));
  assert.equal(resolution.source, SOURCE.fallback);
  assert.deepEqual(resolution.probed, []);
});

// ── asarFromBackup ────────────────────────────────────────────────────────

test("asarFromBackup reads the asar recorded in meta.json", () => {
  const path = asarFromBackup({
    dir: "C:\\backup",
    readFile: (file) => {
      assert.equal(file, join("C:\\backup", "meta.json"));
      return JSON.stringify({ asarPath: INSTALLED_ASAR });
    }
  });
  assert.equal(path, INSTALLED_ASAR);
});

test("asarFromBackup returns null for a missing, unparseable or pathless backup", () => {
  assert.equal(
    asarFromBackup({
      dir: "C:\\backup",
      readFile: () => {
        throw new Error("ENOENT");
      }
    }),
    null
  );
  assert.equal(asarFromBackup({ dir: "C:\\backup", readFile: () => "not json" }), null);
  assert.equal(asarFromBackup({ dir: "C:\\backup", readFile: () => JSON.stringify({ asarPath: null }) }), null);
  assert.equal(asarFromBackup({ dir: "C:\\backup", readFile: () => JSON.stringify({}) }), null);
});

// ── asarFromRegistry / asarFromRegistryOutput ─────────────────────────────

const REGISTRY_OUTPUT = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1bf39983-50d0-5fe0-9ef4-cece76f67c5e",
  "    DisplayName    REG_SZ    DeepSeek Harness",
  "    UninstallString    REG_SZ    \"C:\\Program Files\\Deepseek\\Uninstall DeepSeek Harness.exe\" /currentuser",
  "    DisplayIcon    REG_SZ    C:\\Program Files\\Deepseek\\DeepSeek Harness.exe,0",
  "    InstallLocation    REG_SZ    C:\\Program Files\\Deepseek",
  "    Publisher    REG_SZ    Hangzhou DeepSeek Artificial Intelligence Co., Ltd.",
  "",
  "End of search: 6 match(es) found.",
  ""
].join("\r\n");

test("asarFromRegistryOutput prefers DisplayIcon and strips the icon index", () => {
  assert.equal(asarFromRegistryOutput(REGISTRY_OUTPUT), INSTALLED_ASAR);
});

test("asarFromRegistryOutput falls back to InstallLocation", () => {
  const output = [
    "    DisplayName    REG_SZ    DeepSeek Harness",
    "    InstallLocation    REG_SZ    C:\\Program Files\\Deepseek"
  ].join("\r\n");
  assert.equal(asarFromRegistryOutput(output), INSTALLED_ASAR);
});

test("asarFromRegistryOutput ignores a DisplayIcon that is not the desktop app", () => {
  const output = [
    "    DisplayIcon    REG_SZ    C:\\somewhere\\other.exe,0",
    "    InstallLocation    REG_SZ    C:\\Program Files\\Deepseek"
  ].join("\r\n");
  assert.equal(asarFromRegistryOutput(output), INSTALLED_ASAR);
});

test("asarFromRegistryOutput returns null when neither field is present", () => {
  assert.equal(asarFromRegistryOutput(""), null);
  assert.equal(asarFromRegistryOutput("    DisplayName    REG_SZ    DeepSeek Harness"), null);
});

test("asarFromRegistry queries the uninstall key and tolerates every failure", () => {
  let queried = null;
  const path = asarFromRegistry({
    run: (command, args) => {
      queried = { command, args };
      return { status: 0, stdout: REGISTRY_OUTPUT };
    }
  });
  assert.equal(path, INSTALLED_ASAR);
  assert.equal(queried.command, "reg");
  assert.deepEqual(queried.args, ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", "DeepSeek Harness"]);

  assert.equal(asarFromRegistry({ run: () => ({ status: 1, stdout: "" }) }), null);
  assert.equal(
    asarFromRegistry({
      run: () => {
        throw new Error("reg is not on PATH");
      }
    }),
    null
  );
});

// ── formatMissingAsar: the actionable error ───────────────────────────────

test("the missing-asar message names what was tried and how to supply the path", () => {
  const text = formatMissingAsar({
    path: NODE_ASAR,
    source: SOURCE.fallback,
    probed: [
      { source: SOURCE.backup, path: null },
      { source: SOURCE.registry, path: "C:\\old\\app.asar" }
    ]
  });
  assert.match(text, /app\.asar not found at/);
  assert.match(text, new RegExp(NODE_ASAR.replace(/\\/g, "\\\\")));
  assert.match(text, /probed:/);
  assert.match(text, /backup: no hint found/);
  assert.match(text, /registry: C:\\old\\app.asar/);
  assert.match(text, new RegExp(ASAR_ENV));
  assert.match(text, /npm run check:install --/);
  assert.match(text, /resources\/app\.asar/);
});

test("the missing-asar message omits the probe list when nothing was probed", () => {
  const text = formatMissingAsar({ path: "C:\\x\\app.asar", source: SOURCE.argument, probed: [] });
  assert.doesNotMatch(text, /probed:/);
  assert.match(text, /from argument/);
});
