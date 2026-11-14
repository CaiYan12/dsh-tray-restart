#!/usr/bin/env node
/**
 * Fail when production code or agent-facing docs hard-code a machine-specific
 * absolute path.
 *
 * AGENTS.md forbids committing machine-specific absolute paths. The rule is
 * mechanical, so it gets a check rather than a reviewer's attention.
 *
 * Exempt: `test/`. A unit test that feeds
 * `C:\\Program Files\\Deepseek\\DeepSeek Harness.exe` to a resolver is asserting
 * behaviour for that shape; the path is data, not a dependency. The exemption is
 * the point of the rule — production code must never need a specific install.
 *
 * Exempt: `docs/research/`. A measurement record cites the paths it measured;
 * rewriting them would make the record false.
 *
 * Usage: node scripts/check-no-machine-paths.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Paths whose contents are data or history, not runtime dependencies. */
const EXEMPT = [/^test\//, /^docs\/research\//];

const RULES = [
  { name: "DSH install path", re: /\b[A-Za-z]:\\{1,2}Program Files\\{1,2}Deepseek/i },
  { name: "user home path", re: /\b[A-Za-z]:\\{1,2}Users\\{1,2}(?!<)[^\\<>"'`]+/ },
  { name: "MSYS mount path", re: /(?:^|[\s"'`(])\/(?:c|d|e)\/Users\//i },
];

const findings = [];
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "");

for (const file of files) {
  if (EXEMPT.some((re) => re.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    for (const { name, re } of RULES) {
      if (re.test(lines[index])) {
        findings.push({ file, line: index + 1, rule: name, text: lines[index].trim() });
      }
    }
  }
}

if (findings.length === 0) {
  console.log("no machine-specific paths in tracked files");
  process.exit(0);
}

for (const finding of findings) {
  console.error(`${finding.file}:${finding.line}  [${finding.rule}]  ${finding.text}`);
}
console.error(`\n${findings.length} machine-specific path(s) found. Derive the path at runtime instead.`);
process.exit(1);
