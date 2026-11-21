'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRequest, render, routeLabel } = require('../src/metrics');

test('routeLabel keeps known first segments and collapses the rest', () => {
  assert.equal(routeLabel('/autopay/action'), '/autopay');
  assert.equal(routeLabel('/transactions'), '/transactions');
  assert.equal(routeLabel('/'), '/');
  assert.equal(routeLabel('/wp-login.php'), 'other');
});

test('render exposes request counters and a histogram', () => {
  const done = startRequest('get', '/me');
  done(200);
  const text = render();
  assert.match(text, /paywave_http_requests_total\{method="GET",route="\/me",status="200"\} 1/);
  assert.match(text, /paywave_http_request_duration_seconds_count\{method="GET",route="\/me"\} 1/);
  assert.match(text, /paywave_http_request_duration_seconds_bucket\{method="GET",route="\/me",le="\+Inf"\} 1/);
  assert.match(text, /paywave_http_requests_in_flight 0/);
});
