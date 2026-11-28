data "aws_availability_zones" "available" {
  state = "available"

  # EKS cannot place its control plane in use1-az3 (us-east-1); harmless elsewhere
  exclude_zone_ids = ["use1-az3"]
}

data "aws_caller_identity" "current" {}

locals {
  name = "${var.project_name}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

# ------------------------------------------------------------------ VPC
# public   : load balancers + NAT gateway
# private  : EKS nodes + Lambda (outbound through NAT, needed for SMTP)
# database : RDS only, no route to the internet
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.21"

  name = local.name
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets   = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i + 100)]
  private_subnets  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i)]
  database_subnets = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i + 200)]

  create_database_subnet_group = true

  # Readable names in the VPC console
  vpc_tags                = { Name = "${local.name}-vpc" }
  public_subnet_names     = [for az in local.azs : "${local.name}-public-${az}"]
  private_subnet_names    = [for az in local.azs : "${local.name}-private-${az}"]
  database_subnet_names   = [for az in local.azs : "${local.name}-database-${az}"]
  igw_tags                = { Name = "${local.name}-igw" }
  nat_gateway_tags        = { Name = "${local.name}-nat" }
  nat_eip_tags            = { Name = "${local.name}-nat-eip" }
  public_route_table_tags = { Name = "${local.name}-public-rt" }
  private_route_table_tags = { Name = "${local.name}-private-rt" }
  database_route_table_tags = { Name = "${local.name}-database-rt" }

  enable_nat_gateway   = true
  single_nat_gateway   = true # one NAT keeps cost down; use one per AZ for HA
  enable_dns_hostnames = true
  enable_dns_support   = true

  # Required so Kubernetes can place internet-facing / internal load balancers
  public_subnet_tags = {
    "kubernetes.io/role/elb" = 1
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = 1
  }
}

# ------------------------------------------------------------------ Security groups
resource "aws_security_group" "lambda" {
  tags = {
    Name    = "${local.name}-lambda-sg"
    Purpose = "Security group for the payments Lambda"
  }

  name_prefix = "${local.name}-lambda-"
  description = "PayWave Lambda functions"
  vpc_id      = module.vpc.vpc_id

  egress {
    description = "Outbound to RDS, Secrets Manager and SMTP"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "rds" {
  tags = {
    Name    = "${local.name}-rds-sg"
    Purpose = "Security group for the PostgreSQL database - Lambda and EKS nodes only"
  }

  name_prefix = "${local.name}-rds-"
  description = "PayWave PostgreSQL, reachable only from Lambda and the EKS nodes"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "PostgreSQL from Lambda"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  ingress {
    description     = "PostgreSQL from the EKS nodes (the API pods)"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  ingress {
    description     = "PostgreSQL from the EKS cluster security group (pods that use it instead of the node group one)"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.cluster_primary_security_group_id]
  }

  lifecycle {
    create_before_destroy = true
  }
}
