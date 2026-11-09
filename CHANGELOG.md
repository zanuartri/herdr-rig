# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.4] - 2026-11-09

### Fixed
- After a FIX verdict the board showed the ticket as "worker exited", because it looked at the reviewer that had just closed. It now shows the run that is still going.

## [0.1.3] - 2026-11-09

### Fixed
- The app board showed Done as 5 however many tickets were done. It now shows the real count, and how many older ones `rig ls --all` lists.

## [0.1.2] - 2026-11-09

Upgrading from 0.1.0 or 0.1.1: run `rig update`, then `rig install` once. That swaps the copied skills for the short ones that follow rig from now on.

### Added
- `rig update`: reinstalls from GitHub, or pulls a git checkout, and refreshes the board mod.
- A contributors list in the README, redrawn by a workflow onto the `contributors` branch; bot and AI agent accounts are left out.
- A once-a-day check for a newer release; `rig ls`, `new` and `dispatch` print one line when there is one (`RIG_NO_UPDATE_CHECK=1` turns it off).

### Changed
- `rig install` writes a short skill that runs `rig skill <role>`, so skills always match the installed rig and updates need no reinstall.

## [0.1.1] - 2026-11-09

### Fixed
- `rig inbox --wait`: when a newer listener starts for the same manager, the older one exits with `(replaced by a newer listener)` instead of reading messages meant for the newer one. Before this, a reviewer's verdict could be swallowed and a ticket would sit in review. ([#1](https://github.com/zanuartri/herdr-rig/pull/1), thanks @mfh7)
- `rig install` puts the Claude Code skills under `$CLAUDE_CONFIG_DIR/skills` when that variable is set, so sessions on another profile find them. ([#1](https://github.com/zanuartri/herdr-rig/pull/1))
- Tests no longer follow an inherited `RIG_ROOT`, so running `bun test` inside a rig worker doesn't write tickets into the real repo. ([#1](https://github.com/zanuartri/herdr-rig/pull/1))

### Changed
- The manager skill says to keep a single listener, and that the `(replaced by a newer listener)` notice can be ignored.

## [0.1.0] - 2026-11-08

First public release.

### Added
- `rig` CLI (Bun + SQLite): tickets, dispatch, messages, steering, runs, cleanup, settings.
- Skills for the three roles: `manager`, `worker`, `reviewer`, installable into Claude Code, Codex, opencode, pi, omp and Command Code (`rig install`), plus a Claude Code plugin.
- Harnesses for workers and reviewers: Claude Code, Codex, opencode, pi, omp, Command Code, each with model and effort, and custom harnesses through `rig set harness.<name>`.
- Two backends: the herdr CLI and the herdr desktop app (`hc` + `herdr-app`).
- Pane, tab and headless runs, with a default layout (manager left, board top right, up to `pane.max` runs under it, tabs after that).
- A git worktree and `rig/T-n` branch per ticket, cut from the manager's branch or `--base`.
- Ticket order with `--after`, and a message to the manager when a ticket is unblocked.
- A watcher per pane run that reports agents that go idle or blocked without reporting, or exit.
- Cleanup when a ticket is done: panes and tabs closed, worktree and branch removed once the work has landed (normal or squash merge), and `rig clean` for leftovers.
- The board, as a native herdr-app mod and as a terminal board with spinners and an activity feed.
- CI on Linux, macOS and Windows.

[0.1.4]: https://github.com/zanuartri/herdr-rig/releases/tag/v0.1.4
[0.1.3]: https://github.com/zanuartri/herdr-rig/releases/tag/v0.1.3
[0.1.2]: https://github.com/zanuartri/herdr-rig/releases/tag/v0.1.2
[0.1.1]: https://github.com/zanuartri/herdr-rig/releases/tag/v0.1.1
[0.1.0]: https://github.com/zanuartri/herdr-rig/releases/tag/v0.1.0
