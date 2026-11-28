module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.37"

  cluster_name    = local.name
  cluster_version = var.eks_version

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnets
  control_plane_subnet_ids = module.vpc.private_subnets

  # The pipeline runs kubectl from GitHub Actions, so the API endpoint is public
  # (still protected by IAM authentication).
  cluster_endpoint_public_access = true

  # Readable names in the IAM / EC2 consoles
  iam_role_name                          = "${local.name}-eks-cluster-role"
  iam_role_use_name_prefix               = false
  cluster_security_group_name            = "${local.name}-eks-cluster-sg"
  cluster_security_group_use_name_prefix = false
  node_security_group_name               = "${local.name}-eks-nodes-sg"
  node_security_group_use_name_prefix    = false
  cluster_security_group_tags            = { Name = "${local.name}-eks-cluster-sg" }
  node_security_group_tags               = { Name = "${local.name}-eks-nodes-sg" }

  # Whoever runs this Terraform (the IAM identity behind your GitHub secrets)
  # becomes cluster admin, which is what lets the pipeline deploy workloads.
  enable_cluster_creator_admin_permissions = true

  # OIDC provider so the API pods can assume an IAM role (see irsa.tf)
  enable_irsa = true

  cluster_enabled_log_types              = ["api", "audit", "authenticator"]
  cloudwatch_log_group_retention_in_days = var.log_retention_days

  cluster_addons = {
    coredns    = { most_recent = true }
    kube-proxy = { most_recent = true }
    vpc-cni    = { most_recent = true }
  }

  eks_managed_node_groups = {
    default = {
      # Node group, role and EC2 instances all show up as paywave-prod-node*
      name                     = "${local.name}-nodes"
      use_name_prefix          = false
      iam_role_name            = "${local.name}-eks-node-role"
      iam_role_use_name_prefix = false
      launch_template_name     = "${local.name}-node-template"
      launch_template_use_name_prefix = false
      launch_template_tags     = { Name = "${local.name}-node" }
      tags                     = { Purpose = "EKS worker node - runs web and API pods" }
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = var.node_instance_types
      min_size       = var.node_min_size
      max_size       = var.node_max_size
      desired_size   = var.node_desired_size
      capacity_type  = "ON_DEMAND"

      # The module's default node role already includes ECR read access, which is
      # what lets nodes pull the web image from the ECR repository.
      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = 30
            volume_type           = "gp3"
            encrypted             = true
            delete_on_termination = true
          }
        }
      }
    }
  }
}
