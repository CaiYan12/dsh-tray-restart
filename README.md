# dsh-tray-restart

Self-built DSH (DeepSeek Harness) Desktop plugin that adds a **Restart** item to
the tray menu, so the desktop process can be restarted from the tray after
installing, removing or upgrading a host plugin — without quitting and
reopening the app by hand.

> **Status: installable, not yet verified on a live desktop.** The patch core,
> asar I/O, backup, Host entry and the two maintenance scripts are covered by
> `npm test`. Installing the bundle into the desktop profile and clicking the
> tray item is the remaining verification step.

## The problem

The desktop shell keeps its tray inside the Electron main process and exposes
no plugin API for menu items. Host plugins are loaded once at startup and their
ESM modules are cached, so after installing, removing or upgrading a host plugin
the running process keeps the old code until it is restarted.

The existing plugin `@hxhxh/dsh-tray-restart@0.3.1` refuses to work on DSH
Desktop **0.2.2-rc.3**: it runs `node --check` over the whole patched
`lib/main.js` and rejects the result. That check is too strict for this build —
the stock file is a valid ES module, but a whole-file syntax check is not the
right gate for an equal-length region edit.

This plugin takes a different route: it patches only the
`//#region lib/types/tray.js` … `//#endregion` block of `lib/main.js` inside
`resources/app.asar`, **in place and at equal length**, so every offset and
size in the asar header stays valid. Only the file contents change, and the
asar integrity record is rewritten to match. See
[`docs/adr/0001-tray-patch-strategy.md`](./docs/adr/0001-tray-patch-strategy.md).

## What it does

- Adds `Restart DeepSeek Harness` above the separator in the tray menu.
- Runs `app.relaunch()` and then `quitWithoutConfirmation()`, so the desktop
  comes back up immediately with the new plugin code.
- Patches once per Host start, on Windows only, and never lets a failure reach
  the Host: every unsuccessful path ends in a log line.
- Saves the stock tray region to a backup **before** the first patch, so the
  patch can be rolled back later (see [Uninstall](#uninstall)).

## Package name

`@local/dsh-tray-restart` — installed into the desktop profile
(`~/.dsh/profiles/desktop`) as a local link.

## Install

1. Make sure DSH Desktop is installed. On this machine the asar lives at
   `D:\Program Files\Deepseek\resources\app.asar`.
2. Link the package into the desktop profile, the same way as the other local
   plugins:

   ```sh
   cd ~/.dsh/profiles/desktop
   pnpm add link:../../path/to/dsh-tray-restart
   ```

3. Add the bundle patch row to the profile's `cordis.patch.yml`. The bundle
   ships it as `cordis.patch.yml` in this repository:

   ```yaml
   - insert:
       - id: tray-restart
         name: '@local/dsh-tray-restart'
   ```

4. Restart DeepSeek Harness once so the Host loads the plugin. On that start
   the plugin patches the asar and logs the outcome.

5. **Restart once more.** The patch only takes effect on the *next* start, so the
   first start after installing still shows the old tray menu. The Restart item
   appears from the second start onward.

6. Confirm the state at any time:

   ```sh
   npm run check:install
   ```

   ```
   dsh-tray-restart install status
     asar: D:\Program Files\Deepseek\resources\app.asar
     DSH version: 0.2.2-rc.3
     lib/main.js: 848505 bytes
     state: patched (Restart item present)
     tray region: offset 779389, length 1254 bytes, end 780643
     backup: C:\Users\<you>\.dsh\tray-restart-backup
       DSH version: 0.2.2-rc.3
       region: offset 779389, length 1254 bytes
       sha256: <64 hex characters>
       created: <ISO timestamp>
   ```

## Uninstall

> ### ⚠️ Removing the plugin does **not** undo the asar patch
>
> The DSH plugin uninstall flow (removing the row from `cordis.patch.yml`,
> `pnpm remove`, or disabling the plugin in the UI) only stops the plugin from
> running. The patched `app.asar` stays patched, so the **Restart item keeps
> showing up in the tray menu** even with the plugin gone.
>
> **You must run the restore script by hand after uninstalling the plugin:**

```sh
npm run restore:install
```

The script writes the stock tray region back from the backup, then reports:

```
dsh-tray-restart restore
  asar: D:\Program Files\Deepseek\resources\app.asar
  state: restored to the stock tray region
  backup used: yes
  lib/main.js: 848505 bytes

Restart DeepSeek Harness to drop the Restart item from the tray menu.
```

Full uninstall order:

1. `npm run restore:install` (restores the asar; run it **before** the backup
   directory is cleaned up).
2. Remove the `tray-restart` row from `cordis.patch.yml`.
3. `pnpm remove @local/dsh-tray-restart` in `~/.dsh/profiles/desktop`.
4. Restart DeepSeek Harness.

Notes:

- If no backup exists the restore is **refused** rather than guessed — a
  hardcoded stock region only holds for one DSH release. The error names the
  backup directory it looked in.
- Running `npm run restore:install` on an asar that was never patched prints
  `already stock; nothing to restore` and exits 0.
- The backup lives in `~/.dsh/tray-restart-backup/` (`tray-region.bin` plus
  `meta.json`). Override the directory with
  `DSH_TRAY_RESTART_BACKUP_DIR` — useful for testing against a copy.

## Warnings

> ### ⚠️ The Restart item interrupts running tasks
>
> Clicking **Restart DeepSeek Harness** calls `quitWithoutConfirmation()`,
> which **skips the "tasks are still running" confirmation** and relaunches the
> app immediately. Any session that is still working is cut off mid-task.
> Check that no other session is running a long task before you click it.

> ### ⚠️ After a desktop upgrade the first start still shows the old menu
>
> Upgrading DSH Desktop replaces `app.asar` wholesale, which discards the patch.
> The plugin re-applies it on the next Host start, but the new menu item only
> appears on the start **after** that one. If the item is missing right after an
> upgrade, start the desktop once more. Do not patch the asar by hand.

## Development

```sh
npm test                 # node --test test/
npm run check:install    # print the current install state
npm run restore:install  # restore the stock tray region
```

Both scripts accept an explicit asar path, and honour
`DSH_DESKTOP_APP_ASAR`:

```sh
node scripts/check-install.mjs "C:/path/to/resources/app.asar"
```

`check:install` exit codes: `0` patched, `1` not patched, `2` the asar is
missing or unreadable. `restore:install` exit codes: `0` restored or already
stock, `1` restore failed, `2` the asar is missing or unreadable.

The asar tests read the stock `lib/main.js` fixture from
`D:\Dev\dsh-tray-restart-shared\fixtures\main-stock.js` (override with
`DSH_TRAY_FIXTURE`) and always work on a temporary copy of the installed asar —
no test writes to the real `app.asar` or to `~/.dsh/tray-restart-backup`.

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
├── GLOSSARY.md            domain vocabulary
├── LICENSE                MIT
├── README.md
├── cordis.patch.yml       the bundle patch row
├── package.json
├── locale/                notification copy
├── scripts/
│   ├── install-status.mjs shared state reader and report formatting
│   ├── check-install.mjs  print the current install state
│   └── restore-install.mjs restore the stock tray region
├── src/
│   ├── index.js           Host plugin entry
│   ├── asar.js            asar I/O and integrity rewrite
│   ├── patch.js           pure equal-length patch core
│   └── backup.js          stock-region backup
├── test/                  node:test suites
└── docs/
    ├── adr/               architecture decision records
    ├── agents/            per-repo config for the engineering skills
    └── research/          measurement records
```

The engineering workflow for this repo is the Matt Pocock skill flow
(`/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` → `/retro`).
See `AGENTS.md`.

## License

[MIT](./LICENSE)
