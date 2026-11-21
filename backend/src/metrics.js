'use strict';

// Minimal Prometheus metrics (text exposition format, no dependencies).
// Only used by the Kubernetes server (server.js), which serves them on a separate internal port
// so they are never reachable through the public nginx /api/ proxy.
const { monitorEventLoopDelay } = require('node:perf_hooks');

const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
// Only these first path segments become label values; anything else is "other",
// so random URLs from the internet cannot create unlimited time series.
const KNOWN = new Set([
  'health', 'auth', 'me', 'lookup', 'wallet', 'transactions', 'insights', 'contacts',
  'profile', 'avatar', 'notifications', 'autopay',
]);

const counts = new Map(); // "method|route|status" -> number
const hists = new Map(); // "method|route" -> { buckets: number[], sum, count }
let inFlight = 0;
const startedAt = Date.now() / 1000;
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

function routeLabel(path) {
  const seg = String(path || '/').split('/')[1];
  if (!seg) return '/';
  return KNOWN.has(seg) ? `/${seg}` : 'other';
}

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

// Call when a request starts; call the returned function with the final status code.
function startRequest(method, path) {
  inFlight += 1;
  const t0 = process.hrtime.bigint();
  const route = routeLabel(path);
  const m = String(method || 'GET').toUpperCase();
  return function done(status) {
    inFlight -= 1;
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    const ck = `${m}|${route}|${status}`;
    counts.set(ck, (counts.get(ck) || 0) + 1);
    const hk = `${m}|${route}`;
    let h = hists.get(hk);
    if (!h) {
      h = { buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
      hists.set(hk, h);
    }
    h.sum += seconds;
    h.count += 1;
    for (let i = 0; i < BUCKETS.length; i += 1) if (seconds <= BUCKETS[i]) h.buckets[i] += 1;
  };
}

function render() {
  const out = [];
  out.push('# HELP paywave_http_requests_total HTTP requests handled by the API pod.');
  out.push('# TYPE paywave_http_requests_total counter');
  for (const [k, v] of counts) {
    const [method, route, status] = k.split('|');
    out.push(`paywave_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${esc(status)}"} ${v}`);
  }
  out.push('# HELP paywave_http_request_duration_seconds HTTP request duration.');
  out.push('# TYPE paywave_http_request_duration_seconds histogram');
  for (const [k, h] of hists) {
    const [method, route] = k.split('|');
    const lbl = `method="${esc(method)}",route="${esc(route)}"`;
    BUCKETS.forEach((le, i) => out.push(`paywave_http_request_duration_seconds_bucket{${lbl},le="${le}"} ${h.buckets[i]}`));
    out.push(`paywave_http_request_duration_seconds_bucket{${lbl},le="+Inf"} ${h.count}`);
    out.push(`paywave_http_request_duration_seconds_sum{${lbl}} ${h.sum}`);
    out.push(`paywave_http_request_duration_seconds_count{${lbl}} ${h.count}`);
  }
  out.push('# HELP paywave_http_requests_in_flight Requests currently being handled.');
  out.push('# TYPE paywave_http_requests_in_flight gauge');
  out.push(`paywave_http_requests_in_flight ${inFlight}`);

  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  out.push('# TYPE paywave_process_resident_memory_bytes gauge');
  out.push(`paywave_process_resident_memory_bytes ${mem.rss}`);
  out.push('# TYPE paywave_process_heap_used_bytes gauge');
  out.push(`paywave_process_heap_used_bytes ${mem.heapUsed}`);
  out.push('# TYPE paywave_process_cpu_seconds_total counter');
  out.push(`paywave_process_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`);
  out.push('# TYPE paywave_process_start_time_seconds gauge');
  out.push(`paywave_process_start_time_seconds ${startedAt}`);
  out.push('# TYPE paywave_eventloop_lag_p99_seconds gauge');
  out.push(`paywave_eventloop_lag_p99_seconds ${(loop.percentile(99) || 0) / 1e9}`);
  loop.reset();
  return `${out.join('\n')}\n`;
}

module.exports = { startRequest, render, routeLabel };
