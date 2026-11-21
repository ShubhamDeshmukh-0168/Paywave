output "region" {
  value = var.aws_region
}

output "api_url" {
  description = "Base URL of the payments API (API Gateway + Lambda). The frontend calls it for money movement."
  value       = "https://${aws_api_gateway_rest_api.this.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_api_gateway_stage.this.stage_name}"
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "ecr_repository_url" {
  description = "ECR repository of the web (nginx) image"
  value       = aws_ecr_repository.frontend.repository_url
}

output "ecr_backend_repository_url" {
  description = "ECR repository of the API service image"
  value       = aws_ecr_repository.backend.repository_url
}

output "api_pod_role_arn" {
  description = "IAM role the API pods assume (IRSA)"
  value       = aws_iam_role.api_pod.arn
}

output "db_host" {
  value = aws_db_instance.this.address
}

output "db_user" {
  value = aws_db_instance.this.username
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}

output "rds_endpoint" {
  value = aws_db_instance.this.address
}

output "db_secret_arn" {
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "lambda_function_name" {
  value = aws_lambda_function.api.function_name
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}

output "db_name" {
  value = var.db_name
}

output "grafana_role_arn" {
  description = "IAM role the Grafana pod assumes (IRSA) to read CloudWatch"
  value       = aws_iam_role.grafana.arn
}
