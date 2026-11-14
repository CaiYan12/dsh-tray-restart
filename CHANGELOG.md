# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository scaffolding: `AGENTS.md` with the `## Agent skills` block,
  `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`,
  `docs/agents/domain.md`.
- GitHub issue tracker configuration and the five canonical triage labels
  (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).
- Baseline repository files: `README.md`, `CHANGELOG.md`, `LICENSE` (MIT),
  `.gitignore`, `.gitattributes`, `.editorconfig`, `CONTRIBUTING.md`,
  `.github/` issue and PR templates.
- `npm run check:install` (`scripts/check-install.mjs`): prints the asar path,
  the DSH version, whether the tray is patched, the tray region offset and
  length, and the backup metadata. Exit codes: `0` patched, `1` not patched,
  `2` the asar is missing or unreadable.
- `npm run restore:install` (`scripts/restore-install.mjs`): restores the stock
  tray region from the backup and exits non-zero with a clear message when the
  restore fails.
- `scripts/install-status.mjs`: the shared, tested state reader and report
  formatting behind both scripts.
- README: install and uninstall steps, the warning that uninstalling the plugin
  does not roll back the asar patch, the warning that the Restart item
  interrupts running tasks, and the note that an upgrade shows the old tray menu
  until the next start.

### Changed

- README rewritten around the shipped behaviour: what the plugin does, how to
  install it, how to remove it, and the development commands.

<!--
Release sections use this shape:

## [0.1.0] - YYYY-MM-DD

### Added
### Changed
### Fixed
### Removed
-->
