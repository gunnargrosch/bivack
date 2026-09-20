# Shared shell environment for the MicroVM, sourced by ~/.zshrc and ~/.bashrc.
# Image-owned and at a fixed system path, so updates reach existing homes even
# though the rc files themselves are seeded once and then left user-owned.
export HOME=/home/coder
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/opt/uv/toolbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# npm -g installs land in the persistent home (the image prefix /usr is
# root-owned and resets on recycle). pip needs no equivalent: it auto-falls
# back to --user (~/.local) when site-packages isn't writable.
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
# This VM's identity, captured from the /run hook (hooks.js writes the files).
# The endpoint may arrive a beat later (async self-lookup) — the file read here
# covers shells opened after that; terminal.js injects both at spawn too.
[ -r /tmp/microvm-id ] && export MICROVM_ID="$(cat /tmp/microvm-id)"
[ -r /tmp/microvm-endpoint ] && export MICROVM_ENDPOINT="$(cat /tmp/microvm-endpoint)"
export AWS_REGION=us-east-1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# Model access uses your own provider logins, persisted in this home directory:
# Claude Code -> ~/.claude, Codex -> ~/.codex, OpenCode -> ~/.local/share/opencode.
# uv/uvx state stays on the hardlink-capable system FS; the S3 Files home
# rejects hardlinks.
export UV_CACHE_DIR=/opt/uv/cache
export UV_PYTHON_INSTALL_DIR=/opt/uv/python
export UV_TOOL_DIR=/opt/uv/tool
export UV_TOOL_BIN_DIR=/opt/uv/toolbin
