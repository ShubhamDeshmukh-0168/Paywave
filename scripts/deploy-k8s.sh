#!/usr/bin/env bash
# Deploys the API service and the web app to EKS. The site is reached through CloudFront (Terraform),
# so Kubernetes creates no public load balancer: the web Service is a NodePort.
# Required env: IMAGE (web), API_IMAGE, PAYMENTS_API_URL, API_POD_ROLE_ARN, DB_HOST, DB_USER, DB_NAME,
#               DB_SECRET_ARN, APP_SECRET_ARN, CLUSTER_NAME, AWS_REGION,
#               CLOUDFRONT_DOMAIN, ORIGIN_VERIFY (the secret header value CloudFront sends)
# Optional: LOG_OTP_WITHOUT_SMTP (true/false)
set -euo pipefail

: "${IMAGE:?IMAGE is required}"
: "${API_IMAGE:?API_IMAGE is required}"
: "${PAYMENTS_API_URL:?PAYMENTS_API_URL is required}"
: "${API_POD_ROLE_ARN:?API_POD_ROLE_ARN is required}"
: "${DB_HOST:?DB_HOST is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_SECRET_ARN:?DB_SECRET_ARN is required}"
: "${APP_SECRET_ARN:?APP_SECRET_ARN is required}"
: "${CLUSTER_NAME:?CLUSTER_NAME is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${CLOUDFRONT_DOMAIN:?CLOUDFRONT_DOMAIN is required}"
: "${ORIGIN_VERIFY:?ORIGIN_VERIFY is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION" >/dev/null
kubectl wait --for=condition=Ready nodes --all --timeout=600s

# metrics-server is required by the HorizontalPodAutoscaler
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

CONFIG_HASH="$(printf '%s' "$PAYMENTS_API_URL" | sha256sum | cut -c1-16)"
ORIGIN_HASH="$(printf '%s' "$ORIGIN_VERIFY" | sha256sum | cut -c1-16)"
LOG_OTP_WITHOUT_SMTP="${LOG_OTP_WITHOUT_SMTP:-false}"
export IMAGE API_IMAGE PAYMENTS_API_URL API_POD_ROLE_ARN DB_HOST DB_USER DB_NAME DB_SECRET_ARN APP_SECRET_ARN AWS_REGION CONFIG_HASH ORIGIN_HASH LOG_OTP_WITHOUT_SMTP
# shellcheck disable=SC2016 # the single quotes are intentional: envsubst needs the literal ${NAMES}
VARS='${IMAGE} ${API_IMAGE} ${PAYMENTS_API_URL} ${API_POD_ROLE_ARN} ${DB_HOST} ${DB_USER} ${DB_NAME} ${DB_SECRET_ARN} ${APP_SECRET_ARN} ${AWS_REGION} ${CONFIG_HASH} ${ORIGIN_HASH} ${LOG_OTP_WITHOUT_SMTP}'

# The API goes first: the web pods' nginx resolves the paywave-api Service name when it starts
envsubst "$VARS" < "$ROOT/k8s/namespace.yaml" | kubectl apply -f -
envsubst "$VARS" < "$ROOT/k8s/api.yaml" | kubectl apply -f -
if ! kubectl -n paywave rollout status deployment/paywave-api --timeout=420s; then
  kubectl -n paywave describe pods -l app=paywave-api >&2 || true
  kubectl -n paywave logs -l app=paywave-api --tail=60 >&2 || true
  exit 1
fi

# nginx only accepts requests that carry CloudFront's secret header (plus the /healthz health checks).
# This Secret replaces conf.d/00-origin.conf inside the web pods. The secret is alphanumeric, so it is safe in a regex.
ORIGIN_CONF="$(cat <<EOF
map "\$uri|\$http_x_origin_verify" \$pw_origin_ok {
  default 0;
  "~^/healthz\\|" 1;
  "~^[^|]*\\|${ORIGIN_VERIFY}\$" 1;
}
EOF
)"
kubectl -n paywave create secret generic paywave-web-origin \
  --from-literal=00-origin.conf="$ORIGIN_CONF" --dry-run=client -o yaml | kubectl apply -f -

for manifest in configmap deployment service hpa pdb; do
  envsubst "$VARS" < "$ROOT/k8s/${manifest}.yaml" | kubectl apply -f -
done

kubectl -n paywave rollout status deployment/paywave-web --timeout=300s

echo "web_url=https://$CLOUDFRONT_DOMAIN" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "App address (CloudFront): https://$CLOUDFRONT_DOMAIN"
