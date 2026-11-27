variable "project_name" {
  description = "Short name used as a prefix for every resource."
  type        = string
  default     = "paywave"
}

variable "environment" {
  description = "Environment name. Also used as the API Gateway stage name."
  type        = string
  default     = "prod"
}

variable "aws_region" {
  description = "AWS region to deploy to."
  type        = string
  default     = "us-east-1"
}

# ---------------------------------------------------------------- network
variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones (min 2 for EKS and RDS)."
  type        = number
  default     = 2
}

# ---------------------------------------------------------------- EKS
variable "eks_version" {
  description = "Kubernetes version for EKS."
  type        = string
  default     = "1.35"
}

variable "node_instance_types" {
  type    = list(string)
  default = ["t3.medium"]
}

variable "node_min_size" {
  type    = number
  default = 3 # 3 nodes: the app plus Prometheus/Grafana need more pod slots than 2 t3.medium nodes have
}

variable "node_max_size" {
  type    = number
  default = 5
}

variable "node_desired_size" {
  type    = number
  default = 3
}

# ---------------------------------------------------------------- RDS
variable "db_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "db_name" {
  type    = string
  default = "paywave"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_multi_az" {
  description = "Set true for production-grade availability (doubles RDS cost)."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "When true, the database cannot be deleted from the console or CLI until protection is switched off. (Terraform switches it off itself during a destroy.)"
  type        = bool
  default     = true
}

variable "db_skip_final_snapshot" {
  description = "When false (the default), a final snapshot is taken when the database is deleted, and it is kept after the destroy."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Days of RDS automated backups. Also the window for point-in-time recovery (0 to 35)."
  type        = number
  default     = 14

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 1 and 35."
  }
}

variable "db_snapshot_identifier" {
  description = "Recovery: a snapshot to restore the database from (a name, or an awsbackup:job-... snapshot). Leave empty for a normal, new, empty database. See README, Backup and recovery."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- Backup and disaster recovery
variable "backup_retention_days" {
  description = "Days the daily AWS Backup snapshots are kept."
  type        = number
  default     = 35
}

variable "backup_monthly_retention_days" {
  description = "Days the monthly AWS Backup snapshots are kept."
  type        = number
  default     = 365
}

variable "enable_dr_copy" {
  description = "Copy every backup to a second region (disaster recovery). Set false to keep backups in one region only."
  type        = bool
  default     = true
}

variable "dr_region" {
  description = "Region that receives the disaster recovery copy. Must differ from aws_region."
  type        = string
  default     = "us-west-2"

  validation {
    condition     = var.dr_region != var.aws_region
    error_message = "dr_region must be a different region from aws_region, otherwise it is not a disaster recovery copy."
  }
}

# ---------------------------------------------------------------- Lambda / API
variable "lambda_zip_path" {
  description = "Path to the built Lambda package (scripts/build-lambda.sh creates it)."
  type        = string
  default     = "../backend/dist/lambda.zip"
}

variable "cors_allowed_origin" {
  description = "Value for Access-Control-Allow-Origin. The app uses bearer tokens (no cookies), so * is acceptable. Tighten it once you have a domain."
  type        = string
  default     = "*"
}

variable "api_throttle_rate_limit" {
  description = "Steady-state requests per second for the whole stage."
  type        = number
  default     = 100
}

variable "api_throttle_burst_limit" {
  type    = number
  default = 50
}

variable "otp_ttl_minutes" {
  type    = number
  default = 10
}

# ---------------------------------------------------------------- SMTP (email OTP)
variable "smtp_host" {
  description = "SMTP server, e.g. smtp.gmail.com or email-smtp.ap-south-1.amazonaws.com. Leave empty to log OTPs to CloudWatch instead (test only)."
  type        = string
  default     = ""
}

variable "smtp_port" {
  type    = number
  default = 587
}

variable "smtp_user" {
  type    = string
  default = ""
}

variable "smtp_password" {
  type      = string
  default   = ""
  sensitive = true
}

variable "smtp_from" {
  description = "From address, e.g. \"PayWave <no-reply@example.com>\"."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- Monitoring
variable "alert_email" {
  description = "Email that receives CloudWatch alarm notifications. Leave empty to skip the subscription."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "jwt_secret" {
  description = "Recovery only: reuse this JWT/encryption key instead of generating a new one, so a restored database's encrypted card data stays readable. Leave empty for a normal deploy."
  type        = string
  default     = ""
  sensitive   = true
}
