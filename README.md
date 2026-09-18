# StatPulse

A public status page, and the machinery that keeps it honest.

When a service goes down its customers stop filing tickets and start
refreshing one page. That page has to answer while the database behind it
is the thing on fire — so it is served from Redis, rebuilt at most once
per expiry however many thousands are watching, and falls back to a copy
marked _stale_ rather than to a stack trace.

```bash
npm install
docker compose up -d      # mongo + redis
cp .env.example .env
npm run seed              # an admin and five demo components
npm run build             # build the frontend
npm run dev               # api + workers + vite
```

Open **http://localhost:4000** for the status page, or
**http://localhost:5174** for the frontend with hot reload. Sign in at
`/signin` with the credentials the seed prints.

```bash
curl localhost:4000/api/v1/status
```

---

## The product

**Public** — the status page, per-component detail with ninety days of
uptime bars, and the incident history with full timelines.

**Admin** — sign in, add and edit components, pause them, trigger a
check on demand, declare incidents and post timeline updates, invite
colleagues, and revoke your own sessions.

The frontend is served by the API itself. A status page hosted somewhere
that can fail independently of the thing it reports on is one more
thing that can be down at the moment it is needed — and same-origin
means the refresh cookie behaves in production exactly as it does in
development, with no `SameSite=None` and no CSRF token to get wrong.

Two details the UI is deliberate about:

- **An SSRF rejection lands on the field that caused it.** Typing
  `http://169.254.169.254/latest/meta-data/` as a target gives you
  _"169.254.169.254 is not a permitted address"_ under the URL input,
  not a generic banner.
- **Uptime reads "no data" when nothing has been measured.** A component
  added a minute ago has unknown uptime, and printing 100% for it is the
  one lie a status page cannot afford.

---

## What is actually interesting about it

### A cache that cannot stampede

The obvious cache-aside has a hole, and it is the specific hole a status
page cannot afford: the TTL expires at the exact moment two thousand
people are refreshing, every one of those requests misses, and every one
queries MongoDB. The database dies — and it dies _because_ you cached.

So a miss does not mean "go and rebuild". It means "try to become the one
request that rebuilds; if someone else already is, serve the stale copy".

```
200 concurrent misses  →  1 MongoDB query
```

That is a test, not a claim. The stale copy is what makes it safe: even
if the rebuild takes four seconds because Mongo is struggling, everyone
else answers in two milliseconds with data at most ten minutes old and
**labelled as such**. A status page quietly serving old data is worse
than one that admits it is struggling.

The TTL is not the freshness mechanism — every admin write deletes the
key. The TTL is the _correctness backstop_: the longest the page can stay
wrong if a delete is ever lost.

### Checks that do not cry wolf

A single failed check means almost nothing. A dropped packet, a rolling
deploy, a GC pause — all produce one timeout from a perfectly healthy
service. Flipping the page to DOWN on that produces a page that cries
wolf, and a page that cries wolf is ignored during the outage that
matters.

So a transition needs three consecutive failures to go down and two
successes to come back. The thresholds are asymmetric on purpose: going
down is a claim that needs evidence, coming back up needs less, because
being slightly slow to announce recovery costs far less than being wrong
about an outage.

Twelve checks through a deploy gone wrong produce **two** state changes,
not twelve. A brief blip produces none.

### 72,000 writes a day, or 144

Fifty components on a one-minute interval generate 72,000 samples a day.
Each is tiny; each is also an index update, a journal entry and an oplog
record arriving at a steady fifty a minute forever, competing with the
reads that matter.

They go into a Redis stream instead, drained into MongoDB every ten
minutes. A component that is fine and stays fine costs **zero** database
writes — only transitions are written synchronously, because those are
the thing you cannot afford to lose.

Consumer groups are at-least-once, so a flusher that dies between writing
and acknowledging is handed the same entries again. Samples are keyed on
the stream entry id, so a replay collides and is skipped. The rollup
counters cannot use that trick — `$inc` applied twice is simply wrong —
so each bucket carries a watermark and the increment is conditional on
the batch being newer. Uptime numbers end up in renewal conversations;
"approximately right" is an awkward thing to say about them.

### The URL an admin types is the dangerous one

An administrator supplies a URL and this server fetches it, from inside
the production network, every sixty seconds, forever. Without a guard
that is a port scanner with a pleasant UI and a way to read the cloud
metadata endpoint, which on most providers hands out credentials to
anyone who asks from the right place.

The guard refuses private address space, loopback, link-local, CGNAT and
the metadata address; refuses non-HTTP schemes, embedded credentials, and
ports nobody's health check runs on; and re-validates **every redirect
hop**, because a 302 to `169.254.169.254` is the oldest trick there is.

The part most hand-written filters miss: it connects to the IP that was
_checked_. Validating a hostname and then handing that hostname to the
HTTP client means two separate DNS resolutions, and an attacker
controlling the record answers with a public address for the check and a
private one for the fetch a millisecond later. Nothing in the validation
is wrong — it validated a different answer than the one used.

### A limiter that is atomic, or it is nothing

Trim the window, count it, decide, record. Issued as four commands from
Node, fifty concurrent requests all read the same pre-increment count,
all see room, and all pass — which is precisely the case a limiter exists
for. It is one Lua script, and there is a test that fails the moment
anyone "optimises" it back apart:

```
50 parallel requests, limit 10  →  exactly 10 admitted
```

Time comes from Redis rather than from the caller, because several API
instances answer these and their clocks differ by tens of milliseconds.

Public buckets **fail open** when Redis is unreachable; admin writes fail
closed. Rate limiting protects against abuse, and refusing all traffic
because the abuse-protection layer is down converts a degradation into an
outage — which on a status page means going dark during someone else's
incident.

---

## Layout

```
packages/shared/   pure domain logic - status aggregation, hysteresis, uptime maths
packages/core/     config, logging, mongo, redis, lua, models, the SSRF guard
packages/api/      express: public reads, auth, admin writes
packages/web/      react: the status page and the admin dashboard
packages/jobs/     bullmq: the checker, and the metrics flusher
tests/             the suite
```

Three processes, deployed separately. Checking two hundred URLs with a
five-second timeout can hold two hundred sockets on the same event loop
that owes visitors a 50 ms p99 — during an outage, when every target is
timing out _and_ traffic is at its peak.

```bash
npm test
npm run lint
npm run loadtest      # asserts NFR-1, and fails if it misses
```

The load test measures the cache _hit_ path, which is the one that
matters: during an outage the cache is warm and everybody is reading it.
Most recent run on a laptop, 50 components, a 10.5KB payload:

```
requests/sec   6536
latency p50    6 ms
latency p99    20 ms        NFR-1 asks for under 50
non-2xx        0
```

---

## What it does when things break

The status page's job is to be the last thing standing, so each
dependency has a defined degraded mode rather than a stack trace.

| Failure      | Public read                                       | Admin write                    |
| ------------ | ------------------------------------------------- | ------------------------------ |
| Redis down   | rebuilds from Mongo; limiter fails open           | works; invalidation is a no-op |
| Mongo down   | serves the stale copy, `"stale": true`            | 503                            |
| Both down    | 503 with a documented code                        | 503                            |
| Checker dead | last known status, `lastCheckedAt` visibly ageing | normal                         |
| Flusher dead | current status fine; uptime stops advancing       | normal                         |

The distinction between 500 and 503 is deliberate. A 503 with a
machine-readable code is the _designed_ degraded state; a 500 is a bug.
Conflating them means nobody knows which they are looking at — and that
distinction was itself a bug here once, where a Mongo outage during
tenant resolution returned `internal_error` from the one endpoint built
to survive exactly that.

---

## Design

[plan.md](plan.md) — requirement analysis, the fourteen gaps found in the
original brief, and a spec per subsystem.

[docs/architecture.md](docs/architecture.md) — decisions that were not
obvious, with what they cost.
