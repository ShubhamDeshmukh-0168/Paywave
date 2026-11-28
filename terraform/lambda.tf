resource "aws_cloudwatch_log_group" "lambda" {
  tags = {
    Name    = "${local.name}-lambda-logs"
    Purpose = "Lambda function logs"
  }

  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "api" {
  tags = {
    Name    = "${local.name}-payments-lambda"
    Purpose = "Payments API and AutoPay runner"
  }

  function_name = "${local.name}-api"
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs22.x"
  handler       = "src/index.handler"
  architectures = ["x86_64"]

  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  timeout     = 20 # API Gateway hard limit is 29s
  memory_size = 512

  vpc_config {
    subnet_ids         = module.vpc.private_subnets
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      NODE_OPTIONS    = "--enable-source-maps"
      ROUTE_MODE      = "payments" # this function only moves money; the Kubernetes API serves the rest
      DB_HOST         = aws_db_instance.this.address
      DB_PORT         = tostring(aws_db_instance.this.port)
      DB_NAME         = var.db_name
      DB_USER         = aws_db_instance.this.username
      DB_SECRET_ARN   = aws_db_instance.this.master_user_secret[0].secret_arn
      APP_SECRET_ARN  = aws_secretsmanager_secret.app.arn
      CORS_ORIGIN     = var.cors_allowed_origin
      OTP_TTL_MINUTES = tostring(var.otp_ttl_minutes)
      # Only when no SMTP host is configured: print OTP codes to CloudWatch (testing).
      LOG_OTP_WITHOUT_SMTP = var.smtp_host == "" ? "true" : "false"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_iam_role_policy.lambda_secrets,
    aws_secretsmanager_secret_version.app,
  ]
}
