import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./fixture.js";

function readJson(relative) {
  return JSON.parse(readFileSync(join(repoRoot, relative), "utf8"));
}

const manifest = readJson("package.json");
const patchYml = readFileSync(join(repoRoot, "cordis.patch.yml"), "utf8");
const en = readJson("locale/en.json");
const zh = readJson("locale/zh.json");

test("the manifest declares the bundle the desktop profile installs", () => {
  assert.equal(manifest.name, "@local/dsh-tray-restart");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.main, "src/index.js");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.deepEqual(manifest.dsh.bundle.platforms, ["win32"]);
});

test("the manifest declares the DSH version range the plugin supports", () => {
  assert.equal(manifest.engines.dsh, ">=0.2.2-rc.3 <0.3.0");
});

test("the manifest exports the entry module and the locale files", () => {
  assert.equal(manifest.exports["."], "./src/index.js");
  assert.equal(manifest.exports["./locale/*.json"], "./locale/*.json");
  assert.equal(manifest.exports["./package.json"], "./package.json");
});

test("the bundle patch declares the plugin row in an insert block", () => {
  assert.match(patchYml, /^- insert:$/m);
  assert.match(patchYml, /^ {4}- id: tray-restart$/m);
  assert.match(patchYml, /^ {6}name: '@local\/dsh-tray-restart'$/m);
});

test("both locale files carry a title and a description", () => {
  for (const [language, dictionary] of [["en", en], ["zh", zh]]) {
    assert.equal(typeof dictionary.meta.title, "string", `${language} meta.title`);
    assert.ok(dictionary.meta.title.trim() !== "");
    assert.equal(typeof dictionary.meta.description, "string", `${language} meta.description`);
    assert.ok(dictionary.meta.description.trim() !== "");
  }
  assert.match(zh.meta.title, /重启/);
});
