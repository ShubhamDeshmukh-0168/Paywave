# ------------------------------------------------------------------ Lambda execution role
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# CloudWatch Logs + ENI management for running inside the VPC
resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Least privilege: read exactly the two secrets the function needs
data "aws_iam_policy_document" "lambda_secrets" {
  statement {
    sid       = "ReadAppSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.app.arn,
      aws_db_instance.this.master_user_secret[0].secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "lambda_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_secrets.json
}

# ------------------------------------------------------------------ API Gateway -> CloudWatch
# One role per account/region; lets API Gateway write access logs and metrics.
data "aws_iam_policy_document" "apigw_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apigw_cloudwatch" {
  name               = "${local.name}-apigw-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.apigw_assume.json
}

resource "aws_iam_role_policy_attachment" "apigw_cloudwatch" {
  role       = aws_iam_role.apigw_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "this" {
  cloudwatch_role_arn = aws_iam_role.apigw_cloudwatch.arn
  depends_on          = [aws_iam_role_policy_attachment.apigw_cloudwatch]
}
