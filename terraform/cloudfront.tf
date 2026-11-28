# ------------------------------------------------------------------ CloudFront in front of the web app
# Users open https://<id>.cloudfront.net. CloudFront serves the site and forwards /api/*
# to the web pods on EKS. The website has no Kubernetes-created public LoadBalancer: the web Service is
# a NodePort, and the only public entry point for the website is the CloudFront distribution (Grafana has its own load balancer).
#
#   browser --https--> CloudFront --http--> NLB (Terraform) --> NodePort 30080 on the EKS nodes --> nginx pods
#
# The NLB itself is only the hop CloudFront needs to reach the nodes. Anyone who calls it directly is
# refused by nginx: CloudFront adds a secret header (X-Origin-Verify) that nginx requires.

locals {
  web_node_port = 30080 # must match k8s/service.yaml
}

resource "random_password" "origin_verify" {
  length  = 40
  special = false
}

# ---- NLB -> nodes
resource "aws_lb" "web" {
  tags = {
    Name    = "${local.name}-web-nlb"
    Purpose = "Network load balancer in front of the web pods"
  }

  name                             = "${local.name}-web"
  load_balancer_type               = "network"
  internal                         = false
  subnets                          = module.vpc.public_subnets
  enable_cross_zone_load_balancing = true
}

resource "aws_lb_target_group" "web" {
  tags = {
    Name    = "${local.name}-web-tg"
    Purpose = "Target group: EKS nodes on the nginx NodePort"
  }

  name        = "${local.name}-web"
  port        = local.web_node_port
  protocol    = "TCP"
  vpc_id      = module.vpc.vpc_id
  target_type = "instance"

  # Traffic reaches the nodes from the NLB's own addresses inside the VPC (the rule below allows exactly that)
  preserve_client_ip   = "false"
  deregistration_delay = 30

  health_check {
    protocol            = "HTTP"
    port                = "traffic-port"
    path                = "/healthz"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "web" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# The EKS managed node group's Auto Scaling group registers every node (now and after scaling) with the target group
resource "aws_autoscaling_attachment" "web" {
  autoscaling_group_name = module.eks.eks_managed_node_groups["default"].node_group_autoscaling_group_names[0]
  lb_target_group_arn    = aws_lb_target_group.web.arn
}

resource "aws_vpc_security_group_ingress_rule" "web_nodeport" {
  security_group_id = module.eks.node_security_group_id
  description       = "NLB (inside the VPC) to the web NodePort"
  ip_protocol       = "tcp"
  from_port         = local.web_node_port
  to_port           = local.web_node_port
  cidr_ipv4         = module.vpc.vpc_cidr_block
}

# ---- CloudFront
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards every viewer header (Authorization, Content-Type, Idempotency-Key, Origin, Host), cookies and query strings
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "web" {
  tags = {
    Name    = "${local.name}-web-cdn"
    Purpose = "CloudFront: public HTTPS entry for the website and API"
  }

  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "${local.name} web app"
  price_class         = "PriceClass_All" # edge locations worldwide, so the site is fast wherever users are (PriceClass_100 is cheaper but skips Asia)
  wait_for_deployment = false            # the pipeline's smoke test waits for the site instead

  origin {
    origin_id   = "web-nlb"
    domain_name = aws_lb.web.dns_name

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 30
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  # The website itself (HTML, JS, CSS, images): cached at the edge following the Cache-Control headers nginx sends
  default_cache_behavior {
    target_origin_id       = "web-nlb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
  }

  # Per-environment config must always be fresh
  ordered_cache_behavior {
    path_pattern           = "/config.js"
    target_origin_id       = "web-nlb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.disabled.id
  }

  # The API: never cached, all methods and headers passed through
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "web-nlb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
