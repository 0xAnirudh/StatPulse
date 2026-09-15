/**
 * Metrics, in Prometheus text format, without a dependency.
 *
 * Same reasoning as the logger: nothing here needs push gateways,
 * exemplars or native histograms, and prom-client is a trivial
 * dependency to add the day one of those becomes real. What matters is
 * that the numbers exist and are honest.
 *
 * Deliberately in-process and unsynchronised. Each API instance reports
 * its own counters and the scraper sums them, which is how Prometheus
 * expects to work anyway.
 */

const counters = new Map();
const histograms = new Map();

/**
 * Bucket boundaries in seconds.
 *
 * Weighted towards the fast end, because the number this system cares
 * about is a 50ms p99 on a cache hit. Buckets at 1s and 5s would put the
 * entire interesting range into one bar.
 */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const HELP = {
  http_request_duration_seconds: 'Time to serve an HTTP request',
  http_requests_total: 'HTTP requests by route and status',
  cache_requests_total: 'Public status cache reads by outcome',
  cache_rebuild_duration_seconds: 'Time to compose the status payload on a miss',
  ratelimit_rejections_total: 'Requests refused by a rate limit bucket',
  ping_checks_total: 'Health checks executed, by outcome',
  mongo_writes_total: 'Writes issued to MongoDB, by collection',
  metrics_stream_length: 'Entries waiting in the write-behind buffer',
  queue_depth: 'Jobs waiting, by queue',
};

/** Label sets are serialised into the key, so ordering must be stable. */
function keyFor(name, labels) {
  const pairs = Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (pairs.length === 0) return name;
  return `${name}{${pairs.map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(',')}}`;
}

export function increment(name, labels, by = 1) {
  const key = keyFor(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function observe(name, seconds, labels) {
  const key = keyFor(name, labels);
  let h = histograms.get(key);
  if (!h) {
    h = { counts: new Array(DEFAULT_BUCKETS.length + 1).fill(0), sum: 0, count: 0 };
    histograms.set(key, h);
  }

  let bucket = DEFAULT_BUCKETS.findIndex((b) => seconds <= b);
  if (bucket === -1) bucket = DEFAULT_BUCKETS.length; // the +Inf bucket
  h.counts[bucket] += 1;
  h.sum += seconds;
  h.count += 1;
}

/**
 * Values read at scrape time rather than tracked continuously.
 *
 * Queue depth and stream length live in Redis and are already exact
 * there; mirroring them into a local counter would only create a second
 * number that can disagree with the first.
 */
const gauges = new Map();

export function registerGauge(name, read) {
  gauges.set(name, read);
}

const baseName = (key) => key.split('{')[0];

export async function render() {
  const lines = [];
  const emitted = new Set();

  const header = (name, type) => {
    if (emitted.has(name)) return;
    emitted.add(name);
    if (HELP[name]) lines.push(`# HELP ${name} ${HELP[name]}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  for (const [key, value] of counters) {
    header(baseName(key), 'counter');
    lines.push(`${key} ${value}`);
  }

  for (const [key, h] of histograms) {
    const name = baseName(key);
    header(name, 'histogram');
    const labels = key.includes('{') ? key.slice(key.indexOf('{') + 1, -1) : '';
    const withLe = (le) =>
      labels ? `${name}_bucket{${labels},le="${le}"}` : `${name}_bucket{le="${le}"}`;

    // Prometheus histogram buckets are cumulative.
    let running = 0;
    DEFAULT_BUCKETS.forEach((b, i) => {
      running += h.counts[i];
      lines.push(`${withLe(b)} ${running}`);
    });
    running += h.counts[DEFAULT_BUCKETS.length];
    lines.push(`${withLe('+Inf')} ${running}`);
    lines.push(`${labels ? `${name}_sum{${labels}}` : `${name}_sum`} ${h.sum.toFixed(6)}`);
    lines.push(`${labels ? `${name}_count{${labels}}` : `${name}_count`} ${running}`);
  }

  for (const [name, read] of gauges) {
    try {
      const value = await read();
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') {
        header(name, 'gauge');
        for (const [key, v] of Object.entries(value))
          lines.push(`${keyFor(name, key ? JSON.parse(key) : {})} ${v}`);
      } else {
        header(name, 'gauge');
        lines.push(`${name} ${value}`);
      }
    } catch {
      // A gauge that cannot be read is omitted, not fatal. Scraping must
      // never be the thing that takes a process down.
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Tests only. */
export function resetMetrics() {
  counters.clear();
  histograms.clear();
  gauges.clear();
}
