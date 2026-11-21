# IAM role for the API pods running on EKS (IAM Roles for Service Accounts).
# The pods read the same two secrets as the Lambda, nothing else.
data "aws_iam_policy_document" "api_pod_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:paywave:paywave-api"]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_pod" {
  name               = "${local.name}-api-pod"
  assume_role_policy = data.aws_iam_policy_document.api_pod_assume.json
}

resource "aws_iam_role_policy" "api_pod_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.api_pod.id
  policy = data.aws_iam_policy_document.lambda_secrets.json
}
