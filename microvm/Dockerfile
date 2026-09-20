FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# curl-minimal is pre-installed — don't reinstall curl
RUN dnf install -y \
    git \
    openssh-clients \
    tar \
    gzip \
    unzip \
    which \
    shadow-utils \
    procps-ng \
    sudo \
    zsh \
    amazon-efs-utils \
    python3-pip \
    && dnf clean all

# GitHub CLI. Agents use it for pull requests, issues, releases, and private
# clones. `gh auth login` (device flow) stores its session under ~/.config/gh in
# the persistent home, so it survives VM recycles like the other provider logins.
# Must install BEFORE the python3.13 alternatives step below: that repoints
# /usr/bin/python3, which breaks dnf (a python3.9 script) for later layers.
RUN curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o /etc/yum.repos.d/gh-cli.repo \
    && dnf install -y gh \
    && dnf clean all \
    && gh --version

# Disable efs-utils/efs-proxy CloudWatch telemetry (mount attempts + proxy
# metrics). It cannot work here anyway — mount.s3files runs under python3.13
# (no botocore; installing it would put a ~90MB cold import on the mount's
# critical path), and efs-proxy derives a log-stream name that fails
# CloudWatch's own [^:*]* validation — so every mount logged two spurious
# errors. Mount diagnostics remain in /var/log/amazon/efs/ inside the VM.
RUN sed -i '/^\[cloudwatch-log\]/,/^\[/ s/^enabled = true/enabled = false/' \
      /etc/amazon/efs/s3files-utils.conf /etc/amazon/efs/efs-utils.conf \
    && sed -i 's/^metrics_enabled = true/metrics_enabled = false/' \
      /etc/amazon/efs/s3files-utils.conf

# Node.js (latest LTS via NodeSource)
RUN curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - \
    && dnf install -y nodejs \
    && dnf clean all

# Build tools needed for native node modules (node-pty)
RUN dnf install -y python3 make gcc gcc-c++ && dnf clean all

# AWS CLI v2 — baked into the image so it survives restarts (system FS is not persisted)
RUN ARCH=$(uname -m) \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# Python 3.13 as the system interpreter. AL2023 ships 3.9, and several tools
# want >=3.10. uv installs its own Pythons on top of this when a tool needs one.
# NOTE: the alternatives line below repoints /usr/bin/python3, which breaks dnf
# (a python3.9 script) for every later layer. Any `dnf install` must run above.
RUN dnf install -y python3.13 python3.13-pip \
    && dnf clean all \
    && alternatives --install /usr/bin/python3 python3 /usr/bin/python3.13 90

# uv/uvx on the SYSTEM filesystem (/opt), with all uv state pointed at /opt too.
# WHY: uv relies on hardlinks for cache locking and package materialization, and
# /home/coder is an NFS mount that rejects hardlinks (EMLINK) — so uv/uvx fail
# there no matter the link mode. /opt is a normal FS (hardlinks OK) and is baked
# into the image snapshot.
ENV UV_INSTALL_DIR=/opt/uv/bin \
    UV_CACHE_DIR=/opt/uv/cache \
    UV_TOOL_DIR=/opt/uv/tool \
    UV_TOOL_BIN_DIR=/opt/uv/toolbin \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN mkdir -p /opt/uv/bin /opt/uv/cache /opt/uv/tool /opt/uv/toolbin /opt/uv/python \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=/opt/uv/bin sh \
    && ln -sf /opt/uv/bin/uv /usr/local/bin/uv \
    && ln -sf /opt/uv/bin/uvx /usr/local/bin/uvx \
    && chown -R 1000:1000 /opt/uv

# Coding CLIs. Claude Code and OpenCode are installed globally; Codex lives
# under /opt so the system-owned wrapper below can invoke a stable binary path.
# Each user's configuration, history, and login state sit in the mounted S3
# Files home, so provider logins survive VM recycles.
RUN npm install -g @anthropic-ai/claude-code opencode-ai \
    && npm install --prefix /opt/codex --omit=dev @openai/codex@latest \
    && /opt/codex/node_modules/.bin/codex --version \
    && npm cache clean --force

# Kiro CLI — standalone binaries. The installer places them under root's home
# even when INSTALL_DIR is supplied, so move the complete CLI family to
# /usr/local/bin in the same image layer. `kiro-cli login` then stores its
# device-flow session under the invoking user's persistent home directory.
RUN curl -fsSL https://cli.kiro.dev/install | bash \
    && install -m 0755 /root/.local/bin/kiro-cli /usr/local/bin/kiro-cli \
    && install -m 0755 /root/.local/bin/kiro-cli-chat /usr/local/bin/kiro-cli-chat \
    && install -m 0755 /root/.local/bin/kiro-cli-term /usr/local/bin/kiro-cli-term \
    && rm -rf /root/.local/bin \
    && (kiro-cli settings "app.disableAutoupdates" "true" 2>/dev/null || true)

# App infrastructure lives at /opt/app — never shadowed by the S3 mount
WORKDIR /opt/app
RUN npm init -y && npm install node-pty ws && npm cache clean --force

COPY hooks.js /opt/app/hooks.js
COPY terminal.js /opt/app/terminal.js
COPY mount-home.sh /opt/app/mount-home.sh
COPY claude/settings.js /opt/app/claude-settings.js
COPY ide-agent.js /opt/app/ide-agent.js
COPY shell/env.sh /opt/app/shell-env.sh
COPY codex/run.sh /usr/local/bin/codex
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /opt/app/mount-home.sh /usr/local/bin/codex

# App user — NO -m flag: /home/coder must be empty so S3 Files can mount over it.
# zsh is the login shell.
RUN useradd -M -s /bin/zsh -u 1000 coder \
    && mkdir -p /home/coder \
    && chown 1000:1000 /home/coder

# Passwordless sudo for coder (browser terminal runs as coder).
# Note: system changes via sudo do NOT persist — only /home/coder is on S3.
RUN echo 'coder ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/coder \
    && chmod 0440 /etc/sudoers.d/coder

# SHELL_INGRESS execs /bin/bash, /bin/zsh, or /bin/sh directly. Guarantee all
# exist (some base layouts only ship the /usr/bin variants).
RUN [ -e /bin/bash ] || ln -s /usr/bin/bash /bin/bash; \
    [ -e /bin/zsh ]  || ln -s /usr/bin/zsh  /bin/zsh; \
    [ -e /bin/sh ]   || ln -s /usr/bin/sh   /bin/sh; \
    true

# Seed defaults — copied into /home/coder on first S3 mount (empty filesystem)
RUN mkdir -p /etc/skel-coder/.claude /etc/skel-coder/.codex \
    /etc/skel-coder/.kiro/steering /etc/skel-coder/.kiro/settings \
    /etc/skel-coder/.config/opencode
# One environment briefing, seeded to each agent's expected path.
COPY agents/AGENTS.md /etc/skel-coder/.claude/CLAUDE.md
COPY agents/AGENTS.md /etc/skel-coder/.codex/AGENTS.md
COPY agents/AGENTS.md /etc/skel-coder/.kiro/steering/microvm.md
COPY agents/AGENTS.md /etc/skel-coder/.config/opencode/AGENTS.md
COPY shell/zshrc /etc/skel-coder/.zshrc
COPY shell/bashrc /etc/skel-coder/.bashrc
COPY kiro/permissions.yaml /etc/skel-coder/.kiro/settings/permissions.yaml

RUN cat > /etc/skel-coder/.claude.json <<'EOF'
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "99.0.0",
  "lastReleaseNotesSeen": "99.0.0",
  "theme": "dark",
  "autoUpdates": false,
  "bypassPermissionsModeAccepted": true,
  "projects": {
    "/home/coder": {
      "hasTrustDialogAccepted": true,
      "projectOnboardingSeenCount": 1
    }
  }
}
EOF

# Home + AWS region. Model access uses the user's own provider logins persisted
# under /home/coder.
ENV HOME=/home/coder
ENV S3_FILES_FS_ID=__S3_FILES_FS_ID__
ENV AWS_REGION=us-east-1
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV DISABLE_AUTOUPDATER=1
ENV DO_NOT_TRACK=1

EXPOSE 8080 9000

ENTRYPOINT ["/entrypoint.sh"]
