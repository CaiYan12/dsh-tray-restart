# dsh-tray-restart

Self-built DSH (DeepSeek Harness) tray restart plugin.

> **Status: pre-implementation.** This repository currently contains only the
> project scaffolding produced by `/setup-matt-pocock-skills` and `/init`.
> No plugin code exists yet.

## What it is meant to do

Add a **restart** item to the DSH Desktop tray menu, so that after installing,
removing or upgrading a host plugin the desktop process can be restarted from
the tray instead of being quit and reopened by hand.

## Package name

`@local/dsh-tray-restart`

Installed into the desktop profile (`~/.dsh/profiles/desktop`) as a local link,
following the same pattern as `@local/dsh-overload-preset`.

## Why not the existing plugin

`@hxhxh/dsh-tray-restart@0.3.1` fails on DSH Desktop **0.2.2-rc.3**:

```
menu patch failed: patched main.js failed syntax check; refusing to touch app.asar
SyntaxError: Unexpected token '}'
```

Root cause: the packaged `app.asar` → `lib/main.js` is itself syntactically
incomplete (starts with `\n}`, ends with `//#endregion\nexport {`). A whole-file
`node --check` therefore fails on the **stock** file, so any patch strategy that
validates the whole file will always refuse to write.

## References

Prior art reviewed before building:

- [maqian1632/dsh-tray-restart](https://github.com/maqian1632/dsh-tray-restart) — npm `dsh-plugin-tray-restart@1.0.1`
- [ShawnZhangGy/dsh-tray-restart](https://github.com/ShawnZhangGy/dsh-tray-restart) — npm `@shawnxiaoyang/dsh-tray-restart@0.1.0`
- [Joshua1ya/dsh-tray-restart](https://github.com/Joshua1ya/dsh-tray-restart) — npm `dsh-tray-restart@0.2.1`

## Repository layout

```
/
├── AGENTS.md              agent instructions (incl. the Agent skills block)
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE                MIT
├── README.md
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .github/               issue and PR templates
└── docs/
    ├── adr/               architecture decision records (created lazily)
    └── agents/            per-repo config for the engineering skills
        ├── domain.md
        ├── issue-tracker.md
        └── triage-labels.md
```

## Development

Not yet defined — no `package.json` or source code exists.

The engineering workflow for this repo is the Matt Pocock skill flow
(`/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` → `/retro`).
See `AGENTS.md`.

## License

[MIT](./LICENSE)
