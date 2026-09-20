#!/bin/bash
# One-command deploy for Bivack. Re-running it on an existing stack upgrades it
# in place; the S3 Files home and the buckets are preserved. See the README
# "Upgrading" section.
#
#   ./scripts/deploy.sh                 build what changed, deploy, smoke test
#   ./scripts/deploy.sh --frontend-only re-upload the frontend + IDE only
#   ./scripts/deploy.sh --no-smoke      skip the throwaway smoke-test VM
#   ./scripts/deploy.sh --build-ide     force an IDE rebuild
#   ./scripts/deploy.sh --review        show the changeset and confirm before applying
#
# Configuration lives in deploy.env (untracked; created from deploy.env.example
# on first run).
set -euo pipefail

SCRIPT_DIR="$(unset CDPATH; cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(unset CDPATH; cd "$SCRIPT_DIR/.." && pwd)"

FRONTEND_ONLY=false
NO_SMOKE=false
BUILD_IDE=false
REVIEW=false
while [ $# -gt 0 ]; do
  case "$1" in
    --frontend-only) FRONTEND_ONLY=true; shift ;;
    --no-smoke)      NO_SMOKE=true; shift ;;
    --build-ide)     BUILD_IDE=true; shift ;;
    --review)        REVIEW=true; shift ;;
    -h|--help)       sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { echo -e "\033[1;36m▶ $*\033[0m"; }
ok()   { echo -e "\033[1;32m✓ $*\033[0m"; }
err()  { echo -e "\033[1;31m✗ $*\033[0m" >&2; }

# ── Config ────────────────────────────────────────────────────────────────────
if [ -f "$ROOT_DIR/deploy.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/deploy.env"
  set +a
else
  cp "$ROOT_DIR/deploy.env.example" "$ROOT_DIR/deploy.env"
  err "Created deploy.env — fill in AWS_PROFILE, AWS_REGION and LOGIN_EMAIL, then run this again."
  exit 1
fi

STACK_NAME="${STACK_NAME:-bivack}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
LOGIN_EMAIL="${LOGIN_EMAIL:-}"
# Runtime knobs, overridable in deploy.env. Defaults match the template.
MEMORY_MIB="${MEMORY_MIB:-4096}"
IDLE_MAX_SECONDS="${IDLE_MAX_SECONDS:-7200}"
IDLE_SUSPEND_SECONDS="${IDLE_SUSPEND_SECONDS:-1800}"
MAX_LIFETIME_SECONDS="${MAX_LIFETIME_SECONDS:-28800}"
BUDGET_USD="${BUDGET_USD:-25}"
BUDGET_ENABLED="${BUDGET_ENABLED:-true}"
BUDGET_EMAIL="${BUDGET_EMAIL:-}"
NAT_MODE="${NAT_MODE:-instance}"
# Temporary password for the first auto-created login. Random by default;
# override with INITIAL_PASSWORD in deploy.env. The pool policy needs 12+ chars
# with upper, lower, and a digit, so build a value that always satisfies it.
INITIAL_PASSWORD="${INITIAL_PASSWORD:-$(python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; pw=[secrets.choice(string.ascii_uppercase),secrets.choice(string.ascii_lowercase),secrets.choice(string.digits)]+[secrets.choice(a) for _ in range(13)]; secrets.SystemRandom().shuffle(pw); print("".join(pw))')}"
SAM_PROFILE=()
[ -n "${AWS_PROFILE:-}" ] && SAM_PROFILE=(--profile "$AWS_PROFILE")
PARAM_OVERRIDES="LoginEmail=\"$LOGIN_EMAIL\" MicrovmMemoryMiB=$MEMORY_MIB IdleMaxSeconds=$IDLE_MAX_SECONDS IdleSuspendSeconds=$IDLE_SUSPEND_SECONDS MaxLifetimeSeconds=$MAX_LIFETIME_SECONDS MonthlyBudgetUsd=$BUDGET_USD BudgetEnabled=$BUDGET_ENABLED BudgetEmail=\"$BUDGET_EMAIL\" NatMode=$NAT_MODE"

# ── Preflight ─────────────────────────────────────────────────────────────────
missing=()
for tool in aws sam node npm zip python3; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -gt 0 ]; then
  err "Missing required tools: ${missing[*]}"
  echo "  Install: awscli (https://aws.amazon.com/cli), sam (https://docs.aws.amazon.com/serverless-application-model),"
  echo "           node 20+, zip, python3."
  exit 1
fi

log "Checking AWS credentials..."
if ! CALLER=$(aws sts get-caller-identity --output json 2>/dev/null); then
  err "No working AWS credentials. Run 'aws configure' or 'aws sso login' for profile '${AWS_PROFILE:-default}'."
  exit 1
fi
CALLER_ARN=$(echo "$CALLER" | python3 -c "import sys,json; print(json.load(sys.stdin)['Arn'])")
CALLER_ACCOUNT=$(echo "$CALLER" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])")
ok "Deploying to account $CALLER_ACCOUNT as $CALLER_ARN"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true
}
stack_exists() { aws cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null 2>&1; }

sam_build() {
  log "Building SAM application..."
  # No --cached and no stale build dir: a cached .aws-sam/build/template.yaml
  # once shipped an old template while the CLI parameter overrides looked new,
  # so a template edit (removing resources) silently did not apply. Always
  # regenerate the built template from source.
  rm -rf "$ROOT_DIR/.aws-sam/build"
  (cd "$ROOT_DIR" && sam build --parallel --template template.yaml)
}
sam_deploy() {
  # --review keeps sam's own changeset prompt so stateful replacements are
  # visible before they are applied. Default is to deploy without prompting.
  local confirm=()
  [ "$REVIEW" = false ] && confirm=(--no-confirm-changeset)
  (cd "$ROOT_DIR" && sam deploy \
    --stack-name "$STACK_NAME" --region "$AWS_REGION" ${SAM_PROFILE[@]+"${SAM_PROFILE[@]}"} \
    --capabilities CAPABILITY_NAMED_IAM --resolve-s3 \
    ${confirm[@]+"${confirm[@]}"} --no-fail-on-empty-changeset \
    --parameter-overrides "$@")
}

if [ "$FRONTEND_ONLY" = true ] && ! stack_exists; then
  err "Stack '$STACK_NAME' does not exist; --frontend-only needs an existing deploy."
  exit 1
fi

# ── First-ever deploy: bootstrap the stack so it has an artifact bucket ───────
if ! stack_exists; then
  log "First deploy: bootstrapping stack (no MicroVM image yet)..."
  sam_build
  sam_deploy "DeployMicrovmImage=false $PARAM_OVERRIDES"
  ok "Bootstrap complete"
fi

# ── Build the IDE when its sources changed ────────────────────────────────────
# ide/dist is git-ignored, so a git pull never updates it. Compare a hash of the
# IDE inputs against the last build and rebuild on any change, so a plain
# upgrade (git pull && ./scripts/deploy.sh) ships the new workbench.
if [ "$FRONTEND_ONLY" = false ]; then
  IDE_HASH=$(cd "$ROOT_DIR/ide" && {
    /usr/bin/find src -type f 2>/dev/null
    printf '%s\n' index.html package.json package-lock.json vite.config.ts tsconfig.json
  } | LC_ALL=C sort | xargs cat 2>/dev/null | shasum -a 256 | cut -c1-16)
  IDE_STAMP_FILE="$ROOT_DIR/ide/.build-hash"
  IDE_STAMP=$(cat "$IDE_STAMP_FILE" 2>/dev/null || echo "")
  if [ "$BUILD_IDE" = true ] || [ ! -d "$ROOT_DIR/ide/dist" ] || [ "$IDE_HASH" != "$IDE_STAMP" ]; then
    log "Building the IDE (npm ci && npm run build)..."
    (cd "$ROOT_DIR/ide" && npm ci && npm run build)
    printf '%s' "$IDE_HASH" > "$IDE_STAMP_FILE"
    ok "IDE built"
  else
    ok "IDE up to date"
  fi
fi

# ── Package the MicroVM source and deploy the stack ───────────────────────────
if [ "$FRONTEND_ONLY" = false ]; then
  ARTIFACT_BUCKET=$(out ArtifactBucketName)
  if [ -z "$ARTIFACT_BUCKET" ] || [ "$ARTIFACT_BUCKET" = "None" ]; then
    err "Stack is missing the artifact bucket output; delete the stack and retry."
    exit 1
  fi

  # MicrovmCodeUri must be a real, already-uploaded object before `sam deploy`
  # runs. CloudFormation only diffs property values and this resource is not in
  # SAM's auto-upload list, so the S3 key carries a content hash: a real
  # microvm/ change changes the URI and triggers a rebuild, no change no-ops.
  log "Packaging MicroVM source..."
  BUILD_DIR="/tmp/bivack-microvm-build"
  rm -rf "$BUILD_DIR"; cp -R "$ROOT_DIR/microvm" "$BUILD_DIR"
  S3_FILES_FS_ID=$(out S3FilesFileSystemId)
  sed -i.bak "s|^ENV S3_FILES_FS_ID=.*|ENV S3_FILES_FS_ID=${S3_FILES_FS_ID}|" "$BUILD_DIR/Dockerfile"
  rm -f "$BUILD_DIR/Dockerfile.bak"
  find "$BUILD_DIR" -exec touch -t 202001010000.00 {} + 2>/dev/null || true
  ZIP_PATH="/tmp/bivack-microvm.zip"
  rm -f "$ZIP_PATH"
  (cd "$BUILD_DIR" && zip -r "$ZIP_PATH" . -x "*.DS_Store" > /dev/null)
  ZIP_HASH=$(cd "$BUILD_DIR" && /usr/bin/find . -type f -print0 \
    | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-16)
  ZIP_KEY="microvm/bivack-microvm-${ZIP_HASH}.zip"
  MICROVM_CODE_URI="s3://$ARTIFACT_BUCKET/$ZIP_KEY"
  aws s3 cp "$ZIP_PATH" "s3://$ARTIFACT_BUCKET/$ZIP_KEY" >/dev/null
  ok "Source uploaded ($ZIP_KEY)"

  log "Deploying stack (a MicroVM image build here can take 5-10 min)..."
  sam_build
  sam_deploy "MicrovmCodeUri=$MICROVM_CODE_URI DeployMicrovmImage=true $PARAM_OVERRIDES"
  ok "Stack deployed"
else
  log "Frontend-only: reusing existing stack."
fi

# ── Read outputs ──────────────────────────────────────────────────────────────
EXECUTION_ROLE=$(out ExecutionRoleArn)
FRONTEND_BUCKET=$(out FrontendBucketName)
CF_DIST_ID=$(out CloudFrontDistributionId)
USER_POOL_ID=$(out UserPoolId)
USER_POOL_CLIENT_ID=$(out UserPoolClientId)
TOKEN_API_URL=$(out TokenApiUrl)
S3_FILES_FS_ID=$(out S3FilesFileSystemId)
NETWORK_CONNECTOR_ARN=$(out NetworkConnectorArn)
IMAGE_ID=$(out MicrovmImageArn)
FRONTEND_URL=$(out FrontendUrl)

# ── Upload the frontend ───────────────────────────────────────────────────────
# Version shown in the frontend footer and used for the update check.
# RELEASE is the nearest tag (the "running version"); BUILD is a support id for
# the tooltip. Never bake `-dirty`: it reflects the maintainer's working tree,
# not something a user can act on.
RELEASE=$(git -C "$ROOT_DIR" describe --tags --abbrev=0 2>/dev/null || echo dev)
BUILD=$(git -C "$ROOT_DIR" describe --tags --always 2>/dev/null || echo dev)
REPO_URL="${REPO_URL:-https://github.com/gunnargrosch/bivack}"
APP_CONFIG_JSON="{\"tokenApiUrl\":\"$TOKEN_API_URL\",\"region\":\"$AWS_REGION\",\"userPoolId\":\"$USER_POOL_ID\",\"userPoolClientId\":\"$USER_POOL_CLIENT_ID\",\"release\":\"$RELEASE\",\"build\":\"$BUILD\",\"repo\":\"$REPO_URL\"}"
render_page() {
  local src="$1" key="$2"
  local out_file="/tmp/bivack-render-$(echo "$key" | tr '/' '_')"
  sed "s|<script>window.APP_CONFIG = {}; /\* APP_CONFIG_PLACEHOLDER \*/</script>|<script>window.APP_CONFIG = $APP_CONFIG_JSON;</script>|" \
    "$src" > "$out_file"
  aws s3 cp "$out_file" "s3://$FRONTEND_BUCKET/$key" \
    --cache-control "no-cache, no-store, must-revalidate" --content-type "text/html" >/dev/null
  rm -f "$out_file"
}

log "Uploading frontend..."
render_page "$ROOT_DIR/frontend/landing.html" "index.html"
render_page "$ROOT_DIR/frontend/index.html"   "cli/index.html"
render_page "$ROOT_DIR/frontend/login.html"   "login/index.html"
[ -f "$ROOT_DIR/frontend/manifest.webmanifest" ] && aws s3 cp "$ROOT_DIR/frontend/manifest.webmanifest" \
  "s3://$FRONTEND_BUCKET/cli/manifest.webmanifest" --cache-control "no-cache" --content-type "application/manifest+json" >/dev/null
[ -f "$ROOT_DIR/frontend/sw.js" ] && aws s3 cp "$ROOT_DIR/frontend/sw.js" \
  "s3://$FRONTEND_BUCKET/cli/sw.js" --cache-control "no-cache" --content-type "application/javascript" >/dev/null
[ -f "$ROOT_DIR/frontend/icon.svg" ] && aws s3 cp "$ROOT_DIR/frontend/icon.svg" \
  "s3://$FRONTEND_BUCKET/cli/icon.svg" --cache-control "max-age=86400" --content-type "image/svg+xml" >/dev/null
# Stylesheets (vscode.css plus one per page).
for css in "$ROOT_DIR"/frontend/*.css; do
  aws s3 cp "$css" "s3://$FRONTEND_BUCKET/$(basename "$css")" \
    --cache-control "no-cache" --content-type "text/css" >/dev/null
done

if [ -d "$ROOT_DIR/ide/dist" ]; then
  log "Uploading the IDE..."
  (
    cd "$ROOT_DIR/ide/dist"
    find . -type f | while read -r f; do
      key="ide/${f#./}"
      case "$key" in
        ide/index.html|ide/config.json) cc="no-cache, no-store, must-revalidate" ;;
        *) cc="public, max-age=31536000, immutable" ;;
      esac
      case "$f" in
        *.js|*.css|*.json|*.html|*.svg|*.txt|*.map)
          case "$f" in
            *.js) ct="text/javascript" ;;
            *.css) ct="text/css" ;;
            *.json) ct="application/json" ;;
            *.html) ct="text/html" ;;
            *.svg) ct="image/svg+xml" ;;
            *.txt) ct="text/plain" ;;
            *.map) ct="application/json" ;;
          esac
          gzip -9 -c "$f" > /tmp/bivack-gz
          aws s3 cp /tmp/bivack-gz "s3://$FRONTEND_BUCKET/$key" \
            --content-encoding gzip --content-type "$ct" --cache-control "$cc" >/dev/null
          ;;
        *) aws s3 cp "$f" "s3://$FRONTEND_BUCKET/$key" --cache-control "$cc" >/dev/null ;;
      esac
    done
  )
  rm -f /tmp/bivack-gz
  printf '%s' "$APP_CONFIG_JSON" > /tmp/bivack-ide-config.json
  aws s3 cp /tmp/bivack-ide-config.json "s3://$FRONTEND_BUCKET/ide/config.json" \
    --cache-control "no-cache" --content-type "application/json" >/dev/null
fi

if [ -n "$CF_DIST_ID" ] && [ "$CF_DIST_ID" != "None" ]; then
  aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths "/*" >/dev/null
fi
ok "Frontend uploaded and CDN invalidated"

# ── First login user ──────────────────────────────────────────────────────────
CREATE_USER_CMD="aws cognito-idp admin-create-user --user-pool-id $USER_POOL_ID --username $LOGIN_EMAIL --user-attributes Name=email,Value=$LOGIN_EMAIL Name=email_verified,Value=true --temporary-password 'YOUR_TEMP_PASSWORD'"
FIRST_USER_CREATED=false
if [ -n "$USER_POOL_ID" ] && [ "$USER_POOL_ID" != "None" ] && [ -n "$LOGIN_EMAIL" ] \
   && [ "$LOGIN_EMAIL" != "you@example.com" ]; then
  user_count=$(aws cognito-idp list-users --user-pool-id "$USER_POOL_ID" \
    --query 'Users | length(@)' --output text 2>/dev/null || echo 0)
  if [ "$user_count" = "0" ]; then
    log "Creating the first login user ($LOGIN_EMAIL)..."
    aws cognito-idp admin-create-user --user-pool-id "$USER_POOL_ID" \
      --username "$LOGIN_EMAIL" \
      --user-attributes Name=email,Value="$LOGIN_EMAIL" Name=email_verified,Value=true \
      --temporary-password "$INITIAL_PASSWORD" >/dev/null
    ok "  user created (temporary password: $INITIAL_PASSWORD)"
    FIRST_USER_CREATED=true
  else
    ok "User pool already has users"
  fi
fi

# ── Smoke test (throwaway VM) ─────────────────────────────────────────────────
MVM_STATE="not launched"
PROBE_FAILED=false
if [ "$NO_SMOKE" = false ] && [ "$FRONTEND_ONLY" = false ]; then
  if [ -z "$IMAGE_ID" ] || [ "$IMAGE_ID" = "None" ]; then
    err "No MicroVM image ARN in the stack outputs."
    exit 1
  fi

  EGRESS_FLAG=""
  [ -n "$NETWORK_CONNECTOR_ARN" ] && [ "$NETWORK_CONNECTOR_ARN" != "None" ] \
    && EGRESS_FLAG="--egress-network-connectors [\"$NETWORK_CONNECTOR_ARN\"]"

  log "Launching a throwaway MicroVM for the smoke test..."
  SMOKE_AP=$(aws s3files create-access-point \
    --file-system-id "$S3_FILES_FS_ID" \
    --posix-user 'uid=1000,gid=1000' \
    --root-directory 'path=/users/_smoketest,creationPermissions={ownerUid=1000,ownerGid=1000,permissions=0755}' \
    --query 'accessPointId' --output text 2>/dev/null || echo "")

  RUN_OUT=$(aws lambda-microvms run-microvm \
    --image-identifier "$IMAGE_ID" \
    --execution-role-arn "$EXECUTION_ROLE" \
    --idle-policy "{\"maxIdleDurationSeconds\":$IDLE_MAX_SECONDS,\"suspendedDurationSeconds\":$IDLE_SUSPEND_SECONDS,\"autoResumeEnabled\":true}" \
    --maximum-duration-in-seconds "$MAX_LIFETIME_SECONDS" \
    --ingress-network-connectors "[\"arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector:HTTP_INGRESS\",\"arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector:SHELL_INGRESS\"]" \
    $EGRESS_FLAG \
    ${SMOKE_AP:+--run-hook-payload "{\"accessPointId\":\"$SMOKE_AP\"}"} \
    --output json 2>&1)

  MVM_ID=$(echo "$RUN_OUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('microvmId',''))" 2>/dev/null || echo "")
  MVM_ENDPOINT=$(echo "$RUN_OUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ep = d.get('endpoint', '')
print(ep if ep.startswith('https://') else 'https://' + ep)
" 2>/dev/null || echo "")

  if [ -z "$MVM_ID" ]; then
    err "Could not launch the smoke-test VM:"
    echo "$RUN_OUT" | tail -20 >&2
  else
    ok "Smoke VM: $MVM_ID"
    sleep 15

    log "Probing the VM (S3 Files mount + internet)..."
    SHELL_TOKEN=$(aws lambda-microvms create-microvm-shell-auth-token \
      --microvm-identifier "$MVM_ID" --expiration-in-minutes 10 \
      --query 'authToken."X-aws-proxy-auth"' --output text 2>/dev/null || echo "")
    if [ -n "$SHELL_TOKEN" ] && [ -n "$MVM_ENDPOINT" ]; then
      if node "$ROOT_DIR/tools/smoke-probe.js" "$MVM_ENDPOINT" "$SHELL_TOKEN"; then
        ok "VM probe passed"
      else
        err "VM probe FAILED — the stack is up but the VM cannot do useful work"
        PROBE_FAILED=true
      fi
    fi

    log "Tearing down the smoke VM..."
    aws lambda-microvms terminate-microvm --microvm-identifier "$MVM_ID" >/dev/null 2>&1 || true
    [ -n "$SMOKE_AP" ] && [ "$SMOKE_AP" != "None" ] \
      && aws s3files delete-access-point --access-point-id "$SMOKE_AP" >/dev/null 2>&1 || true
    MVM_STATE="smoke-tested + torn down"
  fi
elif [ "$NO_SMOKE" = true ]; then
  MVM_STATE="skipped (--no-smoke)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$PROBE_FAILED" = true ]; then
  echo "  Bivack — deployed with failures"
else
  echo "  Bivack — deployed"
fi
echo "  URL:        $FRONTEND_URL"
[ -n "$LOGIN_EMAIL" ] && echo "  Login:      $LOGIN_EMAIL"
echo "  Smoke test: $MVM_STATE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
if [ "$FIRST_USER_CREATED" = true ]; then
  echo "First sign-in: open the URL, sign in as $LOGIN_EMAIL with the temporary"
  echo "password below, and set a new password when prompted."
  echo ""
  echo "  Temporary password: $INITIAL_PASSWORD"
else
  echo "Create or reset a login with (replace YOUR_TEMP_PASSWORD):"
  echo "  $CREATE_USER_CMD"
fi
echo ""
[ "$PROBE_FAILED" = true ] && exit 1
exit 0
