#!/bin/bash
# Tear down a Bivack deployment completely: the CloudFormation stack, the S3
# buckets it retains, the retained Cognito user pool, SSM parameters, running
# MicroVMs, leftover MicroVM images, and CloudWatch log groups. Idempotent, so
# it is safe to re-run or to clean up a half-finished deploy.
#
# Usage: ./scripts/teardown.sh [--yes] [--stack <name>]
#   --yes          skip the confirmation prompt
#   --stack <name> stack to remove (default: STACK_NAME from deploy.env, else
#                  "bivack")
#
# Profile/region come from deploy.env (see deploy.env.example) or the standard
# AWS CLI environment, same as deploy.sh.
set -euo pipefail

SCRIPT_DIR="$(unset CDPATH; cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(unset CDPATH; cd "$SCRIPT_DIR/.." && pwd)"

CONFIRM=true
STACK_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)   CONFIRM=false; shift ;;
    --stack)    STACK_OVERRIDE="$2"; shift 2 ;;
    -h|--help)  sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Load the untracked config if present. deploy.env may set AWS_PROFILE,
# AWS_REGION, and STACK_NAME.
if [ -f "$ROOT_DIR/deploy.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/deploy.env"
  set +a
fi

STACK_NAME="${STACK_OVERRIDE:-${STACK_NAME:-bivack}}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

log()  { echo -e "\033[1;36m▶ $*\033[0m"; }
ok()   { echo -e "\033[1;32m✓ $*\033[0m"; }
warn() { echo -e "\033[1;33m! $*\033[0m"; }

out() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true
}

log "Tearing down '$STACK_NAME' (region $AWS_REGION)"
if [ "$CONFIRM" = true ]; then
  echo "This deletes the stack, its buckets (versioned), the Cognito user pool,"
  echo "running VMs, images, and log groups. There is no undo."
  read -r -p "Type the stack name to confirm: " answer
  [ "$answer" = "$STACK_NAME" ] || { echo "aborted"; exit 1; }
fi

# Read what we need off the stack before it is gone.
FRONTEND_BUCKET=$(out FrontendBucketName)
ARTIFACT_BUCKET=$(out ArtifactBucketName)
WORKSPACE_BUCKET=$(out WorkspaceBucketName)
USER_POOL_ID=$(out UserPoolId)
IMAGE_ARN=$(out MicrovmImageArn)
S3_FILES_FS_ID=$(out S3FilesFileSystemId)

# ── 1. Terminate running MicroVMs backed by this stack's image ────────────────
if [ -n "$IMAGE_ARN" ] && [ "$IMAGE_ARN" != "None" ]; then
  log "Terminating running MicroVMs..."
  ids=$(aws lambda-microvms list-microvms --output json 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
for i in d.get('items', []):
    if i.get('imageArn') == '$IMAGE_ARN' and i.get('state') not in ('TERMINATED', 'TERMINATING'):
        print(i.get('microvmId', ''))
" 2>/dev/null || true)
  for id in $ids; do
    aws lambda-microvms terminate-microvm --microvm-identifier "$id" >/dev/null 2>&1 \
      && ok "  terminated $id" || warn "  could not terminate $id"
  done
fi

# ── 2. SSM parameters under the stack's prefix ────────────────────────────────
log "Deleting SSM parameters under /$STACK_NAME/..."
names=$(aws ssm get-parameters-by-path --path "/$STACK_NAME" --recursive \
  --query 'Parameters[].Name' --output text 2>/dev/null || true)
for n in $names; do
  aws ssm delete-parameter --name "$n" >/dev/null 2>&1 || true
done
if [ -n "$names" ]; then ok "  parameters removed"; else ok "  none found"; fi

# ── 3. Empty every bucket ─────────────────────────────────────────────────────
# The frontend bucket has no DeletionPolicy, so the stack delete fails unless it
# is empty; the other two are Retain and would otherwise be left behind full.
empty_bucket() {
  local bucket="$1"
  aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1 || return 0
  log "  emptying $bucket"
  aws s3 rm "s3://$bucket" --recursive >/dev/null 2>&1 || true
  local tmp; tmp=$(mktemp)
  while true; do
    if ! aws s3api list-object-versions --bucket "$bucket" --output json 2>/dev/null \
      | python3 -c "
import sys, json
d = json.load(sys.stdin)
objs = [{'Key': o['Key'], 'VersionId': o['VersionId']}
        for o in (d.get('Versions', []) + d.get('DeleteMarkers', []))]
print(json.dumps({'Objects': objs[:1000], 'Quiet': True}) if objs else '')
" > "$tmp" 2>/dev/null; then
      break
    fi
    [ -s "$tmp" ] || break
    aws s3api delete-objects --bucket "$bucket" --delete "file://$tmp" >/dev/null 2>&1 || break
  done
  rm -f "$tmp"
}
for b in "$FRONTEND_BUCKET" "$ARTIFACT_BUCKET" "$WORKSPACE_BUCKET"; do
  [ -n "$b" ] && [ "$b" != "None" ] && empty_bucket "$b"
done

# ── 4. Delete the stack ───────────────────────────────────────────────────────
# The S3 Files filesystem blocks a normal delete in two ways: per-user access
# points created by the token Lambda (not stack resources), and pending data
# that S3 Files wants to export. Delete the access points first; if the stack
# delete still fails on the filesystem, force-delete it and retry with
# --retain-resources so CloudFormation stops trying to manage it.
delete_stack() { aws cloudformation delete-stack --stack-name "$STACK_NAME" "$@"; }

if aws cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null 2>&1; then
  if [ -n "$S3_FILES_FS_ID" ] && [ "$S3_FILES_FS_ID" != "None" ]; then
    log "Removing S3 Files access points..."
    aps=$(aws s3files list-access-points --file-system-id "$S3_FILES_FS_ID" \
      --output json 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(a.get('accessPointId','') for a in d.get('accessPoints', d.get('items', []))))" \
      2>/dev/null || true)
    for ap in $aps; do
      aws s3files delete-access-point --access-point-id "$ap" >/dev/null 2>&1 \
        && ok "  deleted access point $ap" || warn "  could not delete $ap"
    done
  fi

  log "Deleting CloudFormation stack (this can take a few minutes)..."
  delete_stack
  if ! aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"; then
    warn "Stack delete failed; checking for the S3 Files filesystem..."
    if [ -n "$S3_FILES_FS_ID" ] && [ "$S3_FILES_FS_ID" != "None" ]; then
      aps=$(aws s3files list-access-points --file-system-id "$S3_FILES_FS_ID" \
        --output json 2>/dev/null \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(a.get('accessPointId','') for a in d.get('accessPoints', d.get('items', []))))" \
        2>/dev/null || true)
      for ap in $aps; do aws s3files delete-access-point --access-point-id "$ap" >/dev/null 2>&1 || true; done
      aws s3files delete-file-system --file-system-id "$S3_FILES_FS_ID" --force-delete >/dev/null 2>&1 || true
      delete_stack --retain-resources S3FilesFileSystem
      aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" \
        && ok "  stack deleted" || warn "  stack delete still did not complete"
    fi
  else
    ok "  stack deleted"
  fi
else
  ok "No stack named $STACK_NAME"
fi

# ── 5. Retained buckets (Retain survives the stack delete) ────────────────────
for b in "$ARTIFACT_BUCKET" "$WORKSPACE_BUCKET" "$FRONTEND_BUCKET"; do
  [ -n "$b" ] && [ "$b" != "None" ] || continue
  aws s3api head-bucket --bucket "$b" >/dev/null 2>&1 || continue
  aws s3api delete-bucket --bucket "$b" >/dev/null 2>&1 && ok "  deleted bucket $b" \
    || warn "  could not delete bucket $b"
done

# ── 6. Retained Cognito user pool ─────────────────────────────────────────────
if [ -n "$USER_POOL_ID" ] && [ "$USER_POOL_ID" != "None" ]; then
  log "Deleting Cognito user pool..."
  aws cognito-idp delete-user-pool --user-pool-id "$USER_POOL_ID" >/dev/null 2>&1 \
    && ok "  pool deleted" || warn "  could not delete pool $USER_POOL_ID"
fi

# ── 7. MicroVM images for this stack ─────────────────────────────────────────
log "Deleting leftover MicroVM images..."
imgs=$(aws lambda-microvms list-microvm-images --output json 2>/dev/null \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
for i in d.get('items', []):
    name = i.get('name', '')
    if name == '$STACK_NAME' or name.startswith('$STACK_NAME-'):
        print(i.get('imageArn', ''))
" 2>/dev/null || true)
for a in $imgs; do
  aws lambda-microvms delete-microvm-image --image-identifier "$a" >/dev/null 2>&1 \
    && ok "  deleted image $a" || warn "  could not delete image $a"
done

# ── 8. CloudWatch log groups ──────────────────────────────────────────────────
for prefix in "/aws/lambda/$STACK_NAME" "/aws/lambda-microvms/$STACK_NAME"; do
  lgs=$(aws logs describe-log-groups --log-group-name-prefix "$prefix" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null || true)
  for lg in $lgs; do
    aws logs delete-log-group --log-group-name "$lg" >/dev/null 2>&1 || true
  done
done

echo ""
ok "Teardown complete for '$STACK_NAME'"
