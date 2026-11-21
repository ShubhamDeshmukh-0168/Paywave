#!/usr/bin/env bash
# Installs Prometheus + Grafana (kube-prometheus-stack) on EKS and loads the PayWave dashboards,
# scrape config and alert rules. Safe to re-run (helm upgrade --install).
# Required env: AWS_REGION, CLUSTER_NAME, GRAFANA_ROLE_ARN
# Optional: GRAFANA_ADMIN_PASSWORD (otherwise a random one is generated once and kept in the cluster),
#           GRAFANA_ALLOWED_CIDR (default 0.0.0.0/0, set e.g. 203.0.113.7/32 to restrict who can reach Grafana),
#           KPS_VERSION (kube-prometheus-stack chart version; default 93.6.1, a version this repo was checked against)
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER_NAME:?CLUSTER_NAME is required}"
: "${GRAFANA_ROLE_ARN:?GRAFANA_ROLE_ARN is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MON="$ROOT/k8s/monitoring"
GRAFANA_ALLOWED_CIDR="${GRAFANA_ALLOWED_CIDR:-0.0.0.0/0}"
export AWS_REGION GRAFANA_ROLE_ARN GRAFANA_ALLOWED_CIDR

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

# shellcheck disable=SC2016 # literal ${NAMES} for envsubst
envsubst '${AWS_REGION} ${GRAFANA_ROLE_ARN} ${GRAFANA_ALLOWED_CIDR}' \
  < "$MON/kube-prometheus-stack-values.yaml" > /tmp/kps-values.yaml

if ! helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
     --namespace monitoring -f /tmp/kps-values.yaml --version "$KPS_VERSION" \
     --wait --timeout 15m; then
  kubectl -n monitoring get pods >&2 || true
  kubectl -n monitoring describe pods >&2 || true
  exit 1
fi

# Dashboards: one ConfigMap per JSON file, labelled so the Grafana sidecar loads it
for f in "$MON"/dashboards/*.json; do
  name="dashboard-$(basename "$f" .json)"
  kubectl -n monitoring create configmap "$name" --from-file="$f" --dry-run=client -o yaml \
    | kubectl label --local -f - grafana_dashboard=1 -o yaml \
    | kubectl apply -f -
done

# Scrape config and alert rules for the API pods (the CRDs exist now that the chart is installed)
kubectl apply -f "$MON/servicemonitor.yaml"
kubectl apply -f "$MON/rules.yaml"

HOST=""
for _ in $(seq 1 60); do
  HOST="$(kubectl -n monitoring get svc monitoring-grafana -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
  [ -n "$HOST" ] && break
  sleep 10
done
if [ -z "$HOST" ]; then
  echo "The Grafana load balancer did not get an address in 10 minutes" >&2
  kubectl -n monitoring describe svc monitoring-grafana >&2 || true
  exit 1
fi

echo "grafana_host=$HOST" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "Grafana: http://$HOST"
