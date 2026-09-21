#!/bin/bash
# Install the coding CLIs selected in deploy.env. deploy.sh validates the
# generated config before this script sources it.
set -euo pipefail

CONFIG_FILE="${1:?usage: install-agent-tools.sh CONFIG_FILE}"
# shellcheck disable=SC1090
. "$CONFIG_FILE"

install_kiro() {
  curl -fsSL https://cli.kiro.dev/install | bash
  install -m 0755 /root/.local/bin/kiro-cli /usr/local/bin/kiro-cli
  install -m 0755 /root/.local/bin/kiro-cli-chat /usr/local/bin/kiro-cli-chat
  install -m 0755 /root/.local/bin/kiro-cli-term /usr/local/bin/kiro-cli-term
  rm -rf /root/.local/bin
  kiro-cli settings "app.disableAutoupdates" "true" 2>/dev/null || true
}

if [ -n "$CLAUDE" ]; then
  npm install -g "@anthropic-ai/claude-code@${CLAUDE}"
fi
if [ -n "$CODEX" ]; then
  npm install --prefix /opt/codex --omit=dev "@openai/codex@${CODEX}"
  /opt/codex/node_modules/.bin/codex --version
fi
if [ -n "$OPENCODE" ]; then
  npm install -g "opencode-ai@${OPENCODE}"
fi
if [ -n "$KIRO" ]; then
  install_kiro
fi

if [ -n "$CLAUDE$CODEX$OPENCODE$KIRO" ]; then
  npm cache clean --force
fi
