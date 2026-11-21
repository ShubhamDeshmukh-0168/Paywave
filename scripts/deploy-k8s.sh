#!/usr/bin/env bash
# Deploys the API service and the web app to EKS and waits until the public load balancer exists.
# Required env: IMAGE (web), API_IMAGE, PAYMENTS_API_URL, API_POD_ROLE_ARN, DB_HOST, DB_USER, DB_NAME,
#               DB_SECRET_ARN, APP_SECRET_ARN, CLUSTER_NAME, AWS_REGION
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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION" >/dev/null
kubectl wait --for=condition=Ready nodes --all --timeout=600s

# metrics-server is required by the HorizontalPodAutoscaler
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

CONFIG_HASH="$(printf '%s' "$PAYMENTS_API_URL" | sha256sum | cut -c1-16)"
LOG_OTP_WITHOUT_SMTP="${LOG_OTP_WITHOUT_SMTP:-false}"
export IMAGE API_IMAGE PAYMENTS_API_URL API_POD_ROLE_ARN DB_HOST DB_USER DB_NAME DB_SECRET_ARN APP_SECRET_ARN AWS_REGION CONFIG_HASH LOG_OTP_WITHOUT_SMTP
VARS='${IMAGE} ${API_IMAGE} ${PAYMENTS_API_URL} ${API_POD_ROLE_ARN} ${DB_HOST} ${DB_USER} ${DB_NAME} ${DB_SECRET_ARN} ${APP_SECRET_ARN} ${AWS_REGION} ${CONFIG_HASH} ${LOG_OTP_WITHOUT_SMTP}'

# The API goes first: the web pods' nginx resolves the paywave-api Service name when it starts
envsubst "$VARS" < "$ROOT/k8s/namespace.yaml" | kubectl apply -f -
envsubst "$VARS" < "$ROOT/k8s/api.yaml" | kubectl apply -f -
if ! kubectl -n paywave rollout status deployment/paywave-api --timeout=420s; then
  kubectl -n paywave describe pods -l app=paywave-api >&2 || true
  kubectl -n paywave logs -l app=paywave-api --tail=60 >&2 || true
  exit 1
fi

for manifest in configmap deployment service hpa pdb; do
  envsubst "$VARS" < "$ROOT/k8s/${manifest}.yaml" | kubectl apply -f -
done

kubectl -n paywave rollout status deployment/paywave-web --timeout=300s

HOST=""
for _ in $(seq 1 60); do
  HOST="$(kubectl -n paywave get svc paywave-web -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
  [ -n "$HOST" ] && break
  sleep 10
done
if [ -z "$HOST" ]; then
  echo "The load balancer did not get an address in 10 minutes" >&2
  kubectl -n paywave describe svc paywave-web >&2 || true
  exit 1
fi

echo "web_host=$HOST" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "Load balancer: $HOST"
