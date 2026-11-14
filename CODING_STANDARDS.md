# Coding Standards

Rules a reviewer enforces. Anything mechanical lives in a script instead — see
`npm run check:paths` and the CI workflow — so this file holds only judgement
calls that no check can settle.

## What belongs in a check, not here

Before adding a rule below, ask whether a script could decide it. If yes, write
the script. The repo already has:

| Rule | Where it is enforced |
|---|---|
| No machine-specific absolute paths in tracked files | `npm run check:paths` |
| The suite passes | CI (`.github/workflows/test.yml`) |
| No test is silently skipped | `npm run test:strict` |
| Line endings, final newline, indentation | `.editorconfig` |

## Judgement calls

### The patched region is data, not source

`src/patch.js` rewrites a fixed number of bytes inside `lib/main.js`. When a
change would grow that region past its stock length, the plugin reclaims space
by dropping stock JSDoc comments. That is a deliberate trade, not sloppiness:
the alternative is a longer file, which shifts every later offset in the asar.

A reviewer should not ask for those comments back. They should check that
`RECLAIMED_COMMENTS` still names the declarations whose comments it drops, and
that the patch still refuses to write when an anchor is missing or repeated.

### Tests describe behaviour, not the machine

A test may feed a synthetic install path to a resolver — that is data. A test
must not depend on the archive on the machine being in a particular state: the
sandbox helpers restore a stock copy first, and a suite that would fail on an
already-patched archive is a bug in the suite.

A reviewer should reject any test that reads the real `app.asar` without
copying it, or that assumes its initial state.

### Failure is quiet, refusal is loud

The Host entry never throws: a failed patch logs a warning and the desktop
starts normally. Everything upstream of the write — the anchor check, the
version gate, the syntax gate — refuses loudly instead, because a half-written
archive is worse than a missing menu item.

A reviewer should check that a new failure path picks the right one of those two.

### Comments explain why, at the point of surprise

The codebase carries comments where the reason is not visible from the code:
the byte-versus-string offset distinction, the reclaim trade above, the
`ELECTRON_RUN_AS_NODE` limitation that forced the PowerShell notification.
Comments that restate the code are noise.
