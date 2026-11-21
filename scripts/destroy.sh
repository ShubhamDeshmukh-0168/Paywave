#!/usr/bin/env bash
# Tears everything down. Kubernetes goes first: deleting the Services removes the
# AWS load balancers (website and Grafana), otherwise the VPC cannot be deleted. Run from a shell where
# `terraform init` has already been done (the destroy workflow does that).
# Required env: AWS_REGION. Optional: PROJECT_NAME, ENVIRONMENT.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:?AWS_REGION is required}"
CLUSTER_NAME="${PROJECT_NAME:-paywave}-${ENVIRONMENT:-prod}"

if aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION" >/dev/null
  echo "Removing Prometheus + Grafana (this removes the Grafana load balancer)..."
  helm uninstall monitoring --namespace monitoring --wait --timeout 10m 2>/dev/null || true
  kubectl delete namespace monitoring --ignore-not-found --timeout=600s || true
  echo "Deleting the paywave namespace (this removes the web load balancer)..."
  kubectl delete namespace paywave --ignore-not-found --timeout=600s || true
  sleep 30 # let AWS release the load balancer network interfaces
else
  echo "EKS cluster $CLUSTER_NAME not found, skipping Kubernetes cleanup"
fi

cd "$ROOT/terraform" || exit 1
terraform destroy -input=false -auto-approve
