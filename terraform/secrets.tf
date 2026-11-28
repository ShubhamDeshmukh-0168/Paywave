# Application secret: JWT signing key (generated here) + SMTP credentials
# (supplied by the pipeline from GitHub Secrets).
# The database credentials live in the secret that RDS manages itself,
# see aws_db_instance.this.master_user_secret.

resource "random_password" "jwt" {
  length  = 64
  special = false
}

locals {
  # Normally generated. Set var.jwt_secret only when you rebuild from a backup, so the restored database's
  # encrypted card data (and sign-up code hashes) can still be read with the SAME key.
  jwt_secret = var.jwt_secret != "" ? var.jwt_secret : random_password.jwt.result
}

resource "aws_secretsmanager_secret" "app" {
  tags = {
    Name    = "${local.name}-app-config-secret"
    Purpose = "Database login - JWT key and app settings"
  }

  name                    = "${local.name}/app-config"
  description             = "PayWave JWT key and SMTP credentials"
  recovery_window_in_days = 0 # allows destroy then re-create with the same name
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    jwt_secret    = local.jwt_secret
    smtp_host     = var.smtp_host
    smtp_port     = var.smtp_port
    smtp_user     = var.smtp_user
    smtp_password = var.smtp_password
    smtp_from     = var.smtp_from
  })
}

# The key above encrypts the stored card numbers and CVVs, so a database backup is unreadable for those fields without
# it. A copy goes to the disaster recovery region (a different name, so it never clashes with the stack you may
# rebuild there). It is deleted by a destroy: save the key yourself too, see README, Backup and disaster recovery.
resource "aws_secretsmanager_secret" "jwt_backup" {
  tags = {
    Name    = "${local.name}-jwt-key-secret"
    Purpose = "Copy of the JWT signing key for disaster recovery"
  }

  provider                = aws.dr
  count                   = var.enable_dr_copy ? 1 : 0
  name                    = "${local.name}/jwt-key-backup"
  description             = "Copy of the PayWave JWT/encryption key for disaster recovery"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "jwt_backup" {
  provider      = aws.dr
  count         = var.enable_dr_copy ? 1 : 0
  secret_id     = aws_secretsmanager_secret.jwt_backup[0].id
  secret_string = local.jwt_secret
}
