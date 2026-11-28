# ------------------------------------------------------------------ Backup and disaster recovery
# Layers of protection for the database (the only place that holds user data):
#   1. RDS automated backups + point-in-time recovery (rds.tf, db_backup_retention_days)
#   2. AWS Backup plan: a daily and a monthly snapshot kept in a backup vault
#   3. A second copy of every snapshot in another region (DR), so losing a region does not lose the data
#   4. A final snapshot when the database is deleted, plus deletion protection
# Failures and finished restores are emailed through the SNS topic below.

provider "aws" {
  alias  = "dr"
  region = var.dr_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Purpose     = "disaster-recovery"
    }
  }
}

# ---- vaults (where the backups live)
resource "aws_backup_vault" "main" {
  tags = {
    Name    = "${local.name}-backup-vault"
    Purpose = "AWS Backup vault - primary region"
  }

  name          = "${local.name}-vault"
  force_destroy = true # the destroy workflow must be able to remove the vault; the RDS final snapshot is kept
}

resource "aws_backup_vault" "dr" {
  tags = {
    Name    = "${local.name}-backup-vault-dr"
    Purpose = "AWS Backup vault - disaster recovery region"
  }

  provider      = aws.dr
  count         = var.enable_dr_copy ? 1 : 0
  name          = "${local.name}-vault-dr"
  force_destroy = true
}

# ---- IAM role AWS Backup uses to take and restore snapshots
data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  tags = {
    Name    = "${local.name}-backup-role"
    Purpose = "IAM role used by AWS Backup"
  }

  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

# ---- the plan: when to back up, how long to keep, where to copy
resource "aws_backup_plan" "db" {
  tags = {
    Name    = "${local.name}-db-backup-plan"
    Purpose = "Daily and monthly database backups"
  }

  name = "${local.name}-db"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(30 19 * * ? *)" # 19:30 UTC = 01:00 IST, a quiet hour
    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = var.backup_retention_days
    }

    dynamic "copy_action" {
      for_each = var.enable_dr_copy ? [1] : []
      content {
        destination_vault_arn = aws_backup_vault.dr[0].arn
        lifecycle {
          delete_after = var.backup_retention_days
        }
      }
    }
  }

  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 20 1 * ? *)" # the 1st of every month
    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = var.backup_monthly_retention_days
    }

    dynamic "copy_action" {
      for_each = var.enable_dr_copy ? [1] : []
      content {
        destination_vault_arn = aws_backup_vault.dr[0].arn
        lifecycle {
          delete_after = var.backup_monthly_retention_days
        }
      }
    }
  }
}

resource "aws_backup_selection" "db" {
  name         = "${local.name}-db"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.db.id
  resources    = [aws_db_instance.this.arn]
}

# ---- email when a backup or a copy fails, and when a restore finishes
resource "aws_sns_topic" "backup" {
  tags = {
    Name    = "${local.name}-backup-events"
    Purpose = "SNS topic for backup job events"
  }

  name = "${local.name}-backup-events"
}

data "aws_iam_policy_document" "backup_topic" {
  statement {
    sid       = "AllowAwsBackupToPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.backup.arn]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "backup" {
  arn    = aws_sns_topic.backup.arn
  policy = data.aws_iam_policy_document.backup_topic.json
}

resource "aws_sns_topic_subscription" "backup_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.backup.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_backup_vault_notifications" "main" {
  backup_vault_name   = aws_backup_vault.main.name
  sns_topic_arn       = aws_sns_topic.backup.arn
  backup_vault_events = ["BACKUP_JOB_FAILED", "COPY_JOB_FAILED", "RESTORE_JOB_COMPLETED"]
  depends_on          = [aws_sns_topic_policy.backup]
}
