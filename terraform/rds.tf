resource "aws_db_instance" "this" {
  identifier = "${local.name}-pg"

  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 5
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = "paywave_admin"

  # RDS generates the password and keeps it in a Secrets Manager secret it owns.
  # The password never appears in Terraform code or state.
  manage_master_user_password = true

  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period    = 7
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_skip_final_snapshot ? null : "${local.name}-pg-final"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  lifecycle {
    ignore_changes = [engine_version]
  }
}
