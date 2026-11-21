'use strict';

// Reads credentials from AWS Secrets Manager (or from env vars when LOCAL_MODE=true).
// Results are cached for a few minutes. That matters because RDS rotates the
// managed master password every 7 days, so a long-lived container must refresh.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
let client;

async function fetchSecretJson(arn) {
  const hit = cache.get(arn);
  if (hit && hit.expires > Date.now()) return hit.value;

  if (!client) {
    // The AWS SDK v3 is provided by the Lambda nodejs22.x runtime, so it is not bundled.
    const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
    client = new SecretsManagerClient({});
  }
  const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = JSON.parse(res.SecretString);
  cache.set(arn, { value, expires: Date.now() + TTL_MS });
  return value;
}

const isLocal = () => process.env.LOCAL_MODE === 'true';

async function getDbPassword() {
  if (isLocal()) return process.env.DB_PASSWORD;
  const secret = await fetchSecretJson(process.env.DB_SECRET_ARN);
  return secret.password;
}

async function getAppConfig() {
  if (isLocal()) {
    return {
      jwt_secret: process.env.JWT_SECRET,
      smtp_host: process.env.SMTP_HOST || '',
      smtp_port: Number(process.env.SMTP_PORT || 587),
      smtp_user: process.env.SMTP_USER || '',
      smtp_password: process.env.SMTP_PASSWORD || '',
      smtp_from: process.env.SMTP_FROM || '',
    };
  }
  return fetchSecretJson(process.env.APP_SECRET_ARN);
}

module.exports = { getDbPassword, getAppConfig };
