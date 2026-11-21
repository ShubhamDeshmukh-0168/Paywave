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
  default = 2
}

variable "node_max_size" {
  type    = number
  default = 4
}

variable "node_desired_size" {
  type    = number
  default = 2
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
  description = "Set true to protect the database from accidental deletion/destroy."
  type        = bool
  default     = false
}

variable "db_skip_final_snapshot" {
  description = "When false, a final snapshot is taken on destroy."
  type        = bool
  default     = true
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
