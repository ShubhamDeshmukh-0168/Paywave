#!/usr/bin/env bash
# Creates (once) the S3 bucket that holds Terraform state. Safe to re-run.
# Terraform >= 1.11 locks state with a lock file in the bucket (use_lockfile),
# so no DynamoDB table is needed.
set -euo pipefail

REGION="${AWS_REGION:?AWS_REGION is required}"
PROJECT="${PROJECT_NAME:-paywave}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${PROJECT}-tfstate-${ACCOUNT_ID}-${REGION}"

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "State bucket $BUCKET already exists"
else
  echo "Creating state bucket $BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
fi

aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "bucket=$BUCKET" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "$BUCKET"
