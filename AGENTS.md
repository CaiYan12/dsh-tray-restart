# dsh-tray-restart

## Project overview

A self-built DSH (DeepSeek Harness) Desktop tray plugin that adds a **restart**
item to the tray menu, so the desktop process can be restarted from the tray
after installing, removing or upgrading a host plugin.

Package name: `@local/dsh-tray-restart`. Installed into the desktop profile
(`~/.dsh/profiles/desktop`) as a local link.

**Current state: implemented and installed.** The bundle is linked into the
desktop profile and the tray menu shows the Restart item. `src/` holds the patch
core, the asar I/O, the backup, the syntax and version gates, the asar-path
resolver, and the Host entry; `test/` holds the suites.

## Target host

- DSH Desktop `0.2.2-rc.3` (`@deepseek-ai/dsh-tools` / `dsh-home-paths` both
  `0.2.2-rc.3`, cordis `4.1.0`).
- Install directory: whatever `process.execPath` points at. The plugin derives
  `resources/app.asar` from it, and `src/desktop-asar.js` adds the fallbacks
  (env var, backup sidecar, uninstall registry) for when the script runs under a
  plain `node` instead of the desktop executable.
- Main process file: `lib/main.js` inside the asar.
- Electron fuses: `EnableEmbeddedAsarIntegrityValidation` **disabled**,
  `OnlyLoadAppFromAsar` disabled, `RunAsNode` enabled.

## Critical constraint

Measured on this machine (2026-11-14, DSH Desktop `0.2.2-rc.3`): the packaged
`lib/main.js` is a **complete, valid ES module** — it starts with
`import { createRequire } from "node:module";` and ends with
`//#endregion\nexport {};`, and `node --check` exits **0** on the stock file.

The asar header layout is:

```
u32 @ 0  = 4          pickle header
u32 @ 4  = header pickle size
u32 @ 8  = header string size (padded)
u32 @ 12 = JSON size
dataOffset = 8 + u32@4        <- NOT 16 + u32@12
```

`lib/main.js` is at `offset 201509551`, `size 848505`, absolute **207179531**.
The tray region `//#region lib/types/tray.js` … `//#endregion` is **1253 bytes**
long (1254 including the trailing newline) and starts at **byte offset 779389**.

> Offsets in this file are **byte** offsets. `lib/main.js` is 848505 bytes but
> 828725 UTF-16 code units, so a string index is not a byte offset: the same
> region starts at string index 759609. Patch code must search the Buffer, not
> the decoded string.

See `docs/research/step1-findings.md` for the full measurement record.

## Approach

Equal-length in-place patching of the `//#region lib/types/tray.js` …
`//#endregion` block inside `lib/main.js`, with space padding, an idempotency
marker, asar integrity-hash rewrite, and a manual restore script. The reasoning
and the rejected alternatives are in `docs/adr/0001-tray-patch-strategy.md`.

## Repository layout

```
/
├── AGENTS.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── GLOSSARY.md
├── LICENSE
├── README.md
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .github/
└── docs/
    ├── adr/
    │   └── 0001-tray-patch-strategy.md
    ├── agents/
    │   ├── domain.md
    │   ├── issue-tracker.md
    │   └── triage-labels.md
    └── research/
        └── step1-findings.md
```

## Development commands

```sh
npm test         # skips the asar suites when the two variables below are unset
npm run test:strict   # refuses to run without them, and fails on any skip
npm run check:paths   # no machine-specific absolute paths in tracked files
```

The asar tests read the stock `lib/main.js` fixture from `DSH_TRAY_FIXTURE`
and the installed asar from `DSH_TRAY_ASAR`. Neither has a default: this
repository commits neither the 848505-byte fixture nor any machine's install
path, so the dependent tests skip with a message naming the missing variable
when the two are unset. Tests only ever copy the installed asar; nothing writes
to the real one.

## Conventions

Reviewer rules live in `CODING_STANDARDS.md`; mechanical ones are scripts, not prose.

- ES modules, LF line endings, UTF-8, two-space indent.
- Never commit or push without explicit maintainer approval.
- Never put secrets, tokens or machine-specific absolute paths in committed
  files.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `CaiYan12/dsh-tray-restart`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, each label string equal to its role name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
