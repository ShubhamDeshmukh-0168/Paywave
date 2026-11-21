# Runs due AutoPay payments: EventBridge invokes the same Lambda every 5 minutes with a
# scheduled event, which backend/src/index.js routes to autopay.runDue().
resource "aws_cloudwatch_event_rule" "autopay" {
  name                = "${local.name}-autopay"
  description         = "Run due AutoPay payments"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "autopay" {
  rule = aws_cloudwatch_event_rule.autopay.name
  arn  = aws_lambda_function.api.arn
}

resource "aws_lambda_permission" "autopay" {
  statement_id  = "AllowEventBridgeAutoPay"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.autopay.arn
}
