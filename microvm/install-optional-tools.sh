#!/bin/bash
# Install deploy-configured infrastructure CLIs into the image. The generated
# config is validated by deploy.sh before this script sources it.
set -euo pipefail

CONFIG_FILE="${1:?usage: install-optional-tools.sh CONFIG_FILE}"
# shellcheck disable=SC1090
. "$CONFIG_FILE"

install_tofu() {
  curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_arm64.zip" -o /tmp/tofu.zip
  unzip -q /tmp/tofu.zip -d /tmp/tofu
  install -m 0755 /tmp/tofu/tofu /usr/local/bin/tofu
  rm -rf /tmp/tofu.zip /tmp/tofu
}

install_terraform() {
  curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_arm64.zip" -o /tmp/terraform.zip
  unzip -q /tmp/terraform.zip -d /tmp/terraform
  install -m 0755 /tmp/terraform/terraform /usr/local/bin/terraform
  rm -rf /tmp/terraform.zip /tmp/terraform
}

if [ -n "$CDK" ]; then
  npm install -g "aws-cdk@${CDK}"
fi
if [ -n "$SAM" ]; then
  if [ "$SAM" = "latest" ]; then
    python3.13 -m pip install --no-cache-dir aws-sam-cli
  else
    python3.13 -m pip install --no-cache-dir "aws-sam-cli==${SAM}"
  fi
fi
if [ -n "$TOFU" ]; then
  install_tofu
fi
if [ -n "$TERRAFORM" ]; then
  install_terraform
fi

if [ -n "$CDK$SAM$TOFU$TERRAFORM" ]; then
  npm cache clean --force
fi
