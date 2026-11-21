'use strict';

const log = require('./log');
const { getAppConfig } = require('./secrets');

let transporter;
let transporterKey;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function getTransporter(cfg) {
  const key = [cfg.smtp_host, cfg.smtp_port, cfg.smtp_user, cfg.smtp_password].join('|');
  if (transporter && transporterKey === key) return transporter;

  const nodemailer = require('nodemailer');
  const port = Number(cfg.smtp_port) || 587;
  transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port,
    secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_password } : undefined,
    ignoreTLS: process.env.LOCAL_MODE === 'true', // local mail catcher has no TLS
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  transporterKey = key;
  return transporter;
}

async function sendOtpEmail({ to, name, code, ttlMinutes }) {
  const cfg = await getAppConfig();

  if (!cfg.smtp_host) {
    if (process.env.LOG_OTP_WITHOUT_SMTP === 'true') {
      // Testing aid for stacks deployed without SMTP credentials. Remove by setting smtp_host.
      log('warn', 'SMTP not configured, OTP written to log for testing', { to, code });
      return { delivered: false };
    }
    throw new Error('SMTP is not configured');
  }

  const mailer = await getTransporter(cfg);
  const subject = 'Your PayWave verification code';
  const text =
    `Hi ${name},\n\nYour PayWave verification code is ${code}.\n` +
    `It expires in ${ttlMinutes} minutes. If you did not request it, ignore this email.\n`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">` +
    `<h2 style="color:#002e6e">PayWave</h2>` +
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>Your verification code is</p>` +
    `<p style="font-size:32px;letter-spacing:6px;font-weight:bold;color:#00baf2">${escapeHtml(code)}</p>` +
    `<p>It expires in ${Number(ttlMinutes)} minutes. If you did not request it, you can ignore this email.</p>` +
    `</div>`;

  await mailer.sendMail({ from: cfg.smtp_from || cfg.smtp_user, to, subject, text, html });
  return { delivered: true };
}

/** Generic notification email (payment received, payment sent, AutoPay result ...). */
async function sendEmail({ to, name, subject, headline, lines = [] }) {
  const cfg = await getAppConfig();
  if (!cfg.smtp_host) {
    log('info', 'email skipped, SMTP not configured', { subject });
    return { delivered: false };
  }
  const mailer = await getTransporter(cfg);
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = `${greeting}\n\n${headline}\n${lines.map((l) => `- ${l}`).join('\n')}\n\nPayWave\n`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">` +
    `<h2 style="color:#002e6e">PayWave</h2>` +
    `<p>${escapeHtml(greeting)}</p>` +
    `<p style="font-size:18px;font-weight:bold">${escapeHtml(headline)}</p>` +
    (lines.length ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '') +
    `<p style="color:#64708a;font-size:12px">This is an automatic notification from PayWave.</p>` +
    `</div>`;
  await mailer.sendMail({ from: cfg.smtp_from || cfg.smtp_user, to, subject, text, html });
  return { delivered: true };
}

module.exports = { sendOtpEmail, sendEmail };
