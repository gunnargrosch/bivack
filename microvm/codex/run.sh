#!/bin/sh
# Codex CLI on the user's own OpenAI login (persisted under ~/.codex in the
# home directory). Unattended defaults are safe here because the MicroVM is the
# isolation boundary and belongs to a single user.
exec /opt/codex/node_modules/.bin/codex \
  --dangerously-bypass-approvals-and-sandbox \
  -c 'mcp_optional_startup_grace_ms = 5000' \
  "$@"
