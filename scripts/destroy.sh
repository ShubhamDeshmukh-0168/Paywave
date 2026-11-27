#!/usr/bin/env bash
# Tears everything down. The Kubernetes namespaces (app, Prometheus, Grafana) are removed first for a clean
# shutdown; then `terraform destroy` removes the rest, including CloudFront and the NLB (Terraform resources,
# so no load balancer is left behind). Run from a shell where `terraform init` has already been done (the
# destroy workflow does that).
# Required env: AWS_REGION. Optional: PROJECT_NAME, ENVIRONMENT.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:?AWS_REGION is required}"
CLUSTER_NAME="${PROJECT_NAME:-paywave}-${ENVIRONMENT:-prod}"

if aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION" >/dev/null
  echo "Removing Prometheus + Grafana (Grafana)..."
  helm uninstall monitoring --namespace monitoring --wait --timeout 10m 2>/dev/null || true
  kubectl delete namespace monitoring --ignore-not-found --timeout=600s || true
  echo "Deleting the paywave namespace (the app)..."
  kubectl delete namespace paywave --ignore-not-found --timeout=600s || true
  sleep 30 # let the cluster finish releasing its network interfaces
else
  echo "EKS cluster $CLUSTER_NAME not found, skipping Kubernetes cleanup"
fi

# The database has deletion protection and takes a final snapshot (kept after the destroy). Switch protection
# off first so the destroy is not blocked. Nothing is lost: the final snapshot is created before deletion.
aws rds modify-db-instance --db-instance-identifier "${CLUSTER_NAME}-pg" --no-deletion-protection \
  --apply-immediately --region "$REGION" >/dev/null 2>&1 || true

cd "$ROOT/terraform" || exit 1
terraform destroy -input=false -auto-approve
