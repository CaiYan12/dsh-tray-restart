# dsh-tray-restart

## Project overview

A self-built DSH (DeepSeek Harness) Desktop tray plugin that adds a **restart**
item to the tray menu, so the desktop process can be restarted from the tray
after installing, removing or upgrading a host plugin.

Package name: `@local/dsh-tray-restart`. Installed into the desktop profile
(`~/.dsh/profiles/desktop`) as a local link.

**Current state: pre-implementation.** No `package.json`, no plugin source, no
tests. Only repository scaffolding exists.

## Target host

- DSH Desktop `0.2.2-rc.3` (`@deepseek-ai/dsh-tools` / `dsh-home-paths` both
  `0.2.2-rc.3`, cordis `4.1.0`).
- Install directory on this machine: `D:\Program Files\Deepseek\`.
- `app.asar`: `D:\Program Files\Deepseek\resources\app.asar`.
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

## Planned approach (not yet implemented)

Equal-length in-place patching of the `//#region lib/types/tray.js` …
`//#endregion` block inside `lib/main.js`, with space padding, an idempotency
marker, asar integrity-hash rewrite, and a manual restore script. Prior art:
`maqian1632/dsh-tray-restart`.

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

None yet — there is no `package.json`.

## Conventions

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
