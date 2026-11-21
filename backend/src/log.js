'use strict';

// Structured JSON logs so CloudWatch Logs Insights can filter on level / msg / requestId.
// Never pass passwords, tokens or OTP codes in `fields`.
function log(level, msg, fields = {}) {
  console.log(JSON.stringify({ level, msg, ...fields }));
}

module.exports = log;
