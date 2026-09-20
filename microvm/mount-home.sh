#!/bin/bash
# Mount THIS user's S3 Files home directory.
#
# Invoked by the /run and /resume lifecycle hooks (hooks.js) with the per-user
# access-point id — NOT at boot. The image snapshot is shared across every VM,
# so the mount cannot be baked in at build time: each VM must mount its own
# user's access point at run time, and the access-point id only arrives via the
# /run hook payload (post-resume). Idempotent — safe to call on both /run and
# /resume, and safe if the mount already exists.
#
# Runs in the background (the hook returns 200 immediately); terminal.js waits
# for /tmp/home-ready before spawning the shell.
set +e

ACCESS_POINT="$1"
MOUNT_PATH="/home/coder"
FS_ID="${S3_FILES_FS_ID:-}"
HOME_READY="/tmp/home-ready"
SKEL="/etc/skel-coder"

# Already mounted (resume after a surviving mount, or a double hook)? Done.
if mountpoint -q "$MOUNT_PATH"; then
  echo "mount-home: already mounted at $MOUNT_PATH" >> /tmp/hooks.log
  touch "$HOME_READY"
  exit 0
fi

rm -f "$HOME_READY" /tmp/home-ready-failed

# Fail SAFE: never mount the filesystem root as a fallback — that would share
# one home across all users. No access point → run without persistence.
if [ -z "$FS_ID" ] || [ -z "$ACCESS_POINT" ]; then
  echo "mount-home: missing FS_ID or access point — running without persistence" >> /tmp/hooks.log
  touch /tmp/home-ready-failed "$HOME_READY"
  exit 0
fi

echo "mount-home: mounting $FS_ID (accesspoint=$ACCESS_POINT) at $MOUNT_PATH..." >> /tmp/hooks.log
MOUNTED=false
for attempt in 1 2 3 4 5 6; do
  if mount -t s3files -o "accesspoint=$ACCESS_POINT" "$FS_ID" "$MOUNT_PATH" 2>>/tmp/hooks.log; then
    echo "mount-home: mounted on attempt $attempt" >> /tmp/hooks.log
    # Seed defaults on first use (empty home). Never let a seed error abort —
    # NFS-managed entries like .s3files-lost+found reject chown, so guard each.
    if [ ! -f "$MOUNT_PATH/.zshrc" ]; then
      echo "mount-home: new home — seeding defaults" >> /tmp/hooks.log
      cp -r "$SKEL/." "$MOUNT_PATH/" 2>>/tmp/hooks.log || echo "mount-home: seed copy partial" >> /tmp/hooks.log
      for entry in "$SKEL"/* "$SKEL"/.[!.]*; do
        [ -e "$entry" ] || continue
        chown -R 1000:1000 "$MOUNT_PATH/$(basename "$entry")" 2>>/tmp/hooks.log || true
      done
      echo "mount-home: seed complete" >> /tmp/hooks.log
    fi
    # The environment briefing is image-owned, not user-owned: refresh it on
    # EVERY mount (not just first seed) so image updates reach existing homes.
    # One shared file feeds all four agents; the image seeds it to each agent's
    # expected path.
    for rel in .claude/CLAUDE.md .codex/AGENTS.md .kiro/steering/microvm.md .config/opencode/AGENTS.md; do
      [ -f "$SKEL/$rel" ] || continue
      mkdir -p "$MOUNT_PATH/$(dirname "$rel")" 2>>/tmp/hooks.log || true
      cp "$SKEL/$rel" "$MOUNT_PATH/$rel" 2>>/tmp/hooks.log \
        && chown 1000:1000 "$MOUNT_PATH/$rel" 2>>/tmp/hooks.log \
        || echo "mount-home: $rel refresh failed" >> /tmp/hooks.log
    done
    # Persist the unattended Claude Code mode while preserving all other user
    # settings, including plugins.
    node /opt/app/claude-settings.js "$MOUNT_PATH/.claude/settings.json" >> /tmp/hooks.log 2>&1 \
      && chown 1000:1000 "$MOUNT_PATH/.claude/settings.json" 2>>/tmp/hooks.log \
      || echo "mount-home: Claude permissions refresh failed" >> /tmp/hooks.log
    if [ -f "$SKEL/.kiro/settings/permissions.yaml" ]; then
      mkdir -p "$MOUNT_PATH/.kiro/settings" 2>>/tmp/hooks.log || true
      cp "$SKEL/.kiro/settings/permissions.yaml" "$MOUNT_PATH/.kiro/settings/permissions.yaml" 2>>/tmp/hooks.log \
        && chown 1000:1000 "$MOUNT_PATH/.kiro/settings/permissions.yaml" 2>>/tmp/hooks.log \
        || echo "mount-home: Kiro permissions refresh failed" >> /tmp/hooks.log
    fi
    # The startup banner moved to terminal.js (image v11); strip the old copies
    # from rc files seeded by earlier images so it does not print twice. Only
    # the banner lines are removed; any user customization is left alone.
    for rc in "$MOUNT_PATH/.zshrc" "$MOUNT_PATH/.bashrc"; do
      [ -f "$rc" ] || continue
      if grep -q "log in once, then /model to switch" "$rc" 2>/dev/null; then
        sed -i \
          -e "/Claude Code: 'claude' (log in once/d" \
          -e "/Codex: 'codex' (log in once/d" \
          -e "/OpenCode: 'opencode' (run \/connect/d" \
          -e "/Kiro CLI: 'kiro-cli login' once/d" \
          -e "/Workspace: \/home\/coder  (persistent S3 storage)/d" \
          -e "/echo \"  VM: \$MICROVM_ID\"/d" \
          "$rc" 2>>/tmp/hooks.log || true
        chown 1000:1000 "$rc" 2>>/tmp/hooks.log || true
        echo "mount-home: stripped legacy startup banner from $(basename "$rc")" >> /tmp/hooks.log
      fi
    done
    # No web-search MCP wiring: every CLI provides native web search.
    MOUNTED=true
    break
  fi
  echo "mount-home: attempt $attempt failed, retrying in 5s..." >> /tmp/hooks.log
  sleep 5
done

if [ "$MOUNTED" = false ]; then
  echo "mount-home: failed after 6 attempts — running without persistence" >> /tmp/hooks.log
  touch /tmp/home-ready-failed
fi
touch "$HOME_READY"
