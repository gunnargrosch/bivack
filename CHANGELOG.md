# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-09-20

### Added

- **Per-user AWS Lambda MicroVMs.** Each user gets a dedicated MicroVM, launched on demand and suspended when idle, with configurable memory and lifetime limits.
- **A persistent home on Amazon S3 Files.** The home is a per-user S3 Files access point mounted at `/home/coder`, so files, shell history, and logins survive restarts and VM recycles.
- **A browser VS Code workbench.** A real VS Code workbench served from CloudFront, with its file system and terminal backed by an in-VM agent over an authenticated WebSocket, and a File menu action back to the chooser.
- **A browser terminal.** An xterm.js terminal with a touch key bar and PWA install; clicking a file path in the output opens it in the editor.
- **Four coding CLIs, preinstalled and preconfigured** for unattended work: Claude Code, Codex CLI, OpenCode, and Kiro CLI. Each uses the user's own provider login; no API keys ship in the image.
- **Cognito authentication.** Admin-created users only, with API Gateway validating the JWT before a token-vending Lambda finds or creates the user's home, launches or resumes their MicroVM, and mints short-lived credentials.
- **One-command deploy and teardown.** `scripts/deploy.sh` bootstraps the stack, builds the IDE and MicroVM image, uploads the frontend, creates the first login, and smoke-tests a throwaway VM; `scripts/teardown.sh` removes everything it created.
- **Runtime configuration through `deploy.env`**: MicroVM memory, idle, suspend, and lifetime limits, NAT mode (instance or gateway), and a monthly AWS Budget whose limit, recipient, and enable/disable are configurable.
- **Release-based versioning.** The footer shows the running release and flags newer GitHub releases instead of treating every commit as an update.
- **Break-glass tooling** (`tools/`) to reach a running MicroVM without SSH.
