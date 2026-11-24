#!/usr/bin/env bash
# Installs Prometheus + Grafana (kube-prometheus-stack) on EKS and loads the PayWave dashboards,
# scrape config and alert rules. Safe to re-run (helm upgrade --install).
# Required env: AWS_REGION, CLUSTER_NAME, GRAFANA_ROLE_ARN
# Optional: GRAFANA_ADMIN_PASSWORD (otherwise a random one is generated once and kept in the cluster),
#           KPS_VERSION (kube-prometheus-stack chart version; default 93.6.1; if that version does not exist the newest chart is used)
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER_NAME:?CLUSTER_NAME is required}"
: "${GRAFANA_ROLE_ARN:?GRAFANA_ROLE_ARN is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MON="$ROOT/k8s/monitoring"
export AWS_REGION GRAFANA_ROLE_ARN

aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION" >/dev/null

kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

# Grafana admin login. An explicit GRAFANA_ADMIN_PASSWORD always wins; otherwise a random
# password is generated the first time and reused on later deploys.
if [ -n "${GRAFANA_ADMIN_PASSWORD:-}" ]; then
  kubectl -n monitoring create secret generic grafana-admin \
    --from-literal=admin-user=admin --from-literal=admin-password="$GRAFANA_ADMIN_PASSWORD" \
    --dry-run=client -o yaml | kubectl apply -f -
elif ! kubectl -n monitoring get secret grafana-admin >/dev/null 2>&1; then
  PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  kubectl -n monitoring create secret generic grafana-admin \
    --from-literal=admin-user=admin --from-literal=admin-password="$PASS"
fi

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
helm repo update >/dev/null

KPS_VERSION="${KPS_VERSION:-93.6.1}"
VERSION_ARGS=()
if helm search repo prometheus-community/kube-prometheus-stack --versions -o json | grep -q "\"version\":\"${KPS_VERSION}\""; then
  VERSION_ARGS=(--version "$KPS_VERSION")
  echo "Using kube-prometheus-stack chart ${KPS_VERSION}"
else
  echo "::warning::Chart version ${KPS_VERSION} not found, installing the newest kube-prometheus-stack chart instead"
fi

# shellcheck disable=SC2016 # literal ${NAMES} for envsubst
envsubst '${AWS_REGION} ${GRAFANA_ROLE_ARN}' \
  < "$MON/kube-prometheus-stack-values.yaml" > /tmp/kps-values.yaml

# Not --wait for the whole release: Grafana's load balancer is checked separately below with a clear message.
if ! helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
     --namespace monitoring -f /tmp/kps-values.yaml "${VERSION_ARGS[@]}" \
     --wait --timeout 15m; then
  kubectl -n monitoring get pods -o wide >&2 || true
  kubectl -n monitoring get events --sort-by=.lastTimestamp 2>&1 | tail -30 >&2 || true
  kubectl -n monitoring describe pods 2>&1 | tail -150 >&2 || true
  exit 1
fi

# Dashboards: one ConfigMap per JSON file, labelled so the Grafana sidecar loads it into the "PayWave" folder
for f in "$MON"/dashboards/*.json; do
  name="dashboard-$(basename "$f" .json)"
  kubectl -n monitoring create configmap "$name" --from-file="$f" --dry-run=client -o yaml \
    | kubectl label --local -f - grafana_dashboard=1 -o yaml \
    | kubectl annotate --local -f - grafana_folder=PayWave -o yaml \
    | kubectl apply -f -
done

# Scrape config and alert rules for the API pods (the CRDs exist now that the chart is installed)
kubectl apply -f "$MON/servicemonitor.yaml"
kubectl apply -f "$MON/rules.yaml"

# Grafana's own public load balancer: wait for AWS to give it an address, then for it to answer.
echo "Waiting for the Grafana load balancer address..."
HOST=""
for i in $(seq 1 60); do
  HOST="$(kubectl -n monitoring get svc monitoring-grafana -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
  [ -n "$HOST" ] && break
  sleep 10
done
if [ -z "$HOST" ]; then
  kubectl -n monitoring describe svc monitoring-grafana >&2 || true
  echo "::error::AWS did not create the Grafana load balancer in 10 minutes (see the service events above)" >&2
  exit 1
fi

GRAFANA_URL="http://${HOST}"
echo "Load balancer: $GRAFANA_URL . Waiting for it to answer (a new load balancer needs 2-5 minutes for DNS and health checks)..."
READY=no
for i in $(seq 1 60); do
  if curl -fsS --max-time 10 "${GRAFANA_URL}/api/health" >/dev/null 2>&1; then READY=yes; break; fi
  sleep 10
done
[ "$READY" = yes ] || echo "::warning::Grafana is installed but ${GRAFANA_URL} does not answer yet. Wait a few minutes and open it again."

{
  echo "grafana_url=${GRAFANA_URL}"
  echo "grafana_ready=${READY}"
} >> "${GITHUB_OUTPUT:-/dev/null}"
echo "Grafana: ${GRAFANA_URL}  (user: admin)"
