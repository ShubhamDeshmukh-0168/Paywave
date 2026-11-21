# Application secret: JWT signing key (generated here) + SMTP credentials
# (supplied by the pipeline from GitHub Secrets).
# The database credentials live in the secret that RDS manages itself,
# see aws_db_instance.this.master_user_secret.

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app-config"
  description             = "PayWave JWT key and SMTP credentials"
  recovery_window_in_days = 0 # allows destroy then re-create with the same name
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    jwt_secret    = random_password.jwt.result
    smtp_host     = var.smtp_host
    smtp_port     = var.smtp_port
    smtp_user     = var.smtp_user
    smtp_password = var.smtp_password
    smtp_from     = var.smtp_from
  })
}
