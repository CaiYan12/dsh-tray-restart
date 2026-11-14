# Contributing

## Workflow

This repository follows the Matt Pocock skill flow. Before writing code, read
`AGENTS.md` and `docs/agents/issue-tracker.md`.

1. Discuss the idea (`/grill-with-docs`).
2. Decide whether the task is a multi-session build. If it is, write a spec
   (`/to-spec`) and tickets (`/to-tickets`).
3. Implement test-first (`/tdd`), then review (`/code-review`).

## Issues

Issues live in GitHub Issues for `CaiYan12/dsh-tray-restart`. Triage labels are
defined in `docs/agents/triage-labels.md`.

## Commits

- Do not commit or push without explicit approval from the maintainer.
- Keep commits scoped to one change.
- Reference the issue number in the commit body when one exists.

## Code style

- ES modules (`"type": "module"`).
- LF line endings, UTF-8, two-space indentation (see `.editorconfig`).
- No secrets, tokens or machine-specific absolute paths in committed files.

## License

By contributing you agree that your contributions are licensed under the MIT
License (see `LICENSE`).
