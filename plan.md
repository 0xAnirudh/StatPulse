# StatPulse — Implementation Plan

**Real-time public status page and incident tracker.**
Version 0.1 of the plan · target: a working v1 backend + public status page.

---

## 0. How to read this document

Sections 1–2 are **requirement analysis**: what is being built, for whom,
what "done" means, and — importantly — what the brief left undecided.
Sections 3–7 are the **design**: architecture, data, and a spec per
subsystem detailed enough to implement from. Sections 8–13 are
**execution**: failure handling, testing, repo layout, and a phased build
order with acceptance criteria.

Anything marked **[DECISION]** is a call this plan makes on the brief's
behalf; anything marked **[OPEN]** needs an answer before the phase that
depends on it starts. They are collected in §15.

---

## 1. Product framing

### 1.1 The one-line version

When your API goes down, your customers stop filing tickets and start
refreshing one page. StatPulse is that page — and the thing that keeps it
online and truthful while everything behind it is on fire.

### 1.2 Why the architecture is what it is

The whole system is shaped by one asymmetry:

| | Public read path | Admin write path | Ping engine |
|---|---|---|---|
| Traffic | Thousands of req/s, spiky | A handful per hour | 50–500 checks/min |
| Latency budget | < 50 ms p99 | < 500 ms | irrelevant (async) |
| Availability need | **Must survive the outage it reports** | Best effort | Best effort |
| Dominant cost | Read amplification | Nothing | Network I/O + write volume |

Reads are 10,000× writes and arrive exactly when the database is least
healthy. Every design choice below — Redis cache-aside, write-behind
metrics, an out-of-process ping worker — exists to keep that column-one
budget under load. A status page that goes down with the service it
monitors is worse than no status page, because it destroys trust at the
exact moment trust is the only thing you have left.

### 1.3 Actors

| Actor | Auth | What they do |
|---|---|---|
| **Visitor** | none | Reads the status page; subscribes to alerts |
| **Admin** | JWT | Adds components, declares incidents, posts updates |
| **Owner** | JWT + role | Everything an admin does, plus user and org management |
| **Ping worker** | internal | Checks components on a schedule; never serves HTTP |
| **Flusher** | internal | Drains the metrics buffer into MongoDB |

### 1.4 Jobs to be done

- *Visitor:* "Is it just me, or is it down?" — answered in one screen, < 1 s, no login.
- *Visitor:* "Tell me when it's fixed so I can stop watching."
- *Admin:* "Post that we know about it, before support drowns."
- *Admin:* "Show me 90 days of uptime so I can answer the SLA question in the renewal call."

---

## 2. Requirement analysis

### 2.1 Functional requirements

Priority: **M** must-have for v1 · **S** should-have · **C** could-have (post-v1).

#### Authentication & accounts

| ID | Requirement | Pri |
|---|---|---|
| FR-A1 | An admin can register an account with email + password | M |
| FR-A2 | An admin can log in and receive a 15-minute access token plus an `httpOnly` refresh cookie | M |
| FR-A3 | A valid refresh token exchanges for a new access token and a **rotated** refresh token | M |
| FR-A4 | Logout revokes the presented refresh token immediately | M |
| FR-A5 | An owner can list active sessions and revoke any one of them | S |
| FR-A6 | Reuse of an already-rotated refresh token revokes the entire session family | S |
| FR-A7 | Roles: `owner` and `admin`; only `owner` may manage users | S |
| FR-A8 | Registration is open only for the first user; subsequent users join by invite | S |

#### Components (monitored services)

| ID | Requirement | Pri |
|---|---|---|
| FR-C1 | An admin can create a component: name, type, target URL, check interval | M |
| FR-C2 | An admin can list, update, and soft-delete components | M |
| FR-C3 | A component can be paused (excluded from checks without losing history) | M |
| FR-C4 | Components can be grouped for display ("Core API", "Dashboard") | S |
| FR-C5 | A target URL is validated against SSRF rules before it is ever fetched (§7.2) | M |
| FR-C6 | Per-component thresholds: timeout, latency ceiling for `DEGRADED`, expected status codes | S |

#### Monitoring

| ID | Requirement | Pri |
|---|---|---|
| FR-M1 | Every active component is checked on its interval (default 60 s), ±10 s | M |
| FR-M2 | Each check records: reachable, HTTP status, response time, error class | M |
| FR-M3 | Status transitions require hysteresis — 3 consecutive failures to enter `DOWN`, 2 successes to leave it (§5.3.3) | M |
| FR-M4 | A slow-but-alive component becomes `DEGRADED`, not `DOWN` | M |
| FR-M5 | Ping traffic never blocks the Express event loop | M |
| FR-M6 | Every transition emits an event consumable by notifications and realtime push | S |

#### Public status page

| ID | Requirement | Pri |
|---|---|---|
| FR-S1 | `GET /api/v1/status` returns the full health matrix without authentication | M |
| FR-S2 | The response is served from Redis on a hit, in < 5 ms of server time | M |
| FR-S3 | The payload includes overall status, per-component status and latency, and active incidents | M |
| FR-S4 | Uptime percentages for 24 h / 7 d / 90 d per component | S |
| FR-S5 | An admin write invalidates the cache; the next public read reflects it | M |
| FR-S6 | Responses carry `ETag` and `Cache-Control` so CDNs and browsers absorb repeat traffic | S |
| FR-S7 | The page stays up and clearly marked stale when MongoDB is unreachable | M |

#### Incidents

| ID | Requirement | Pri |
|---|---|---|
| FR-I1 | An admin can declare an incident with title, impact, affected components | M |
| FR-I2 | An admin can append timeline updates, each carrying a status | M |
| FR-I3 | Setting status `RESOLVED` stamps `resolvedAt` and closes the incident | M |
| FR-I4 | `GET /api/v1/incidents` returns active and historical incidents, paginated | M |
| FR-I5 | Active incidents override derived component status on the public page (§5.6) | S |
| FR-I6 | Scheduled maintenance windows, announced in advance | C |

#### Subscriptions & notification

| ID | Requirement | Pri |
|---|---|---|
| FR-N1 | A visitor can subscribe an email address to incident notifications | S |
| FR-N2 | Subscriptions are confirmed double opt-in; every message carries an unsubscribe link | S |
| FR-N3 | The subscribe endpoint is rate-limited per IP (§5.2) | M |
| FR-N4 | Incident create/update fans out to confirmed subscribers via a queue | S |
| FR-N5 | SMS and webhook subscribers | C |

> FR-N3 is **M** while FR-N1 is **S** on purpose: the brief specifies rate
> limiting on a subscription endpoint that it never otherwise defines.
> The limiter is built and tested in v1 against whatever public write
> endpoints exist; the subscriber model can follow.

### 2.2 Non-functional requirements

| ID | Requirement | How it is verified |
|---|---|---|
| NFR-1 | `GET /api/v1/status` p99 < 50 ms at 2,000 rps on a cache hit | k6 load test, §10.4 |
| NFR-2 | Cache hit ratio > 95 % under sustained public traffic | `cache_hits / (hits+misses)` metric |
| NFR-3 | A cache miss storm produces **at most one** MongoDB query (§5.1.3) | Integration test with 200 concurrent misses |
| NFR-4 | MongoDB write ops from monitoring ≤ 6/hour/component, regardless of check frequency | Count `bulkWrite` calls in the flush test |
| NFR-5 | The API stays available (degraded) when Redis is down | Chaos test, §10.5 |
| NFR-6 | The public page stays available (stale) when MongoDB is down | Chaos test, §10.5 |
| NFR-7 | Access tokens expire in 15 min; revocation takes effect within 15 min, refresh revocation instantly | Auth test suite |
| NFR-8 | No secret, password hash, or internal URL appears in any public response | Contract test on the public payload shape |
| NFR-9 | Every request carries a correlation id through logs and into the worker | Log assertion |
| NFR-10 | Cold start to serving traffic < 10 s; readiness gated on both Mongo and Redis | `/readyz` behaviour |

### 2.3 Explicitly out of scope for v1

Status page theming/custom domains beyond one host · SSO/SAML · SLA
reporting exports · public API for third parties · multi-region ·
per-component permission scoping · TCP/ICMP checks (HTTP only) · the
frontend beyond a minimal reference page.

### 2.4 Gaps and contradictions in the brief

The brief is coherent but incomplete in ways that matter before the first
line of code. Each is resolved here rather than discovered in week three.

| # | Issue | Resolution |
|---|---|---|
| 1 | `GET /api/status` in the data-flow diagram vs `GET /api/v1/status` in the endpoint table | **[DECISION]** everything is under `/api/v1`. `/api/status` 301s to it. |
| 2 | The folder listing is TypeScript (`.ts`); the model samples are JavaScript | **[DECISION]** TypeScript, `strict: true`. The enums and payload shapes here are worth having checked. |
| 3 | `status.yourcompany.com` and "agencies" imply multi-tenancy, but no `Organization` model exists and nothing is scoped to a tenant | **[DECISION]** carry an `Organization` from day one, resolved from the `Host` header, seeded with one default org. Cheap now, painful to retrofit into every query, index, and cache key later. §4.2 |
| 4 | Components and incidents have `POST` but no `GET`/`PATCH`/`DELETE`; an admin cannot list or fix what they created | Added as FR-C2. Full CRUD in §6.5. |
| 5 | `auth.controller` mentions token refresh; no refresh endpoint is in the table | Added: `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`. §6.4 |
| 6 | The rate limiter protects "public subscription endpoints" that appear nowhere else in the brief | Subscriber model and endpoints specified in §5.8, phased to v1.5; the limiter itself ships in v1. |
| 7 | `queues/` contains only `ping.worker.ts`, but the write-behind buffer needs a flusher and notifications need a dispatcher | Three queues, §5.3 / §5.4 / §5.8. Revised layout in §11. |
| 8 | `POST /api/v1/auth/register` is public — anyone who finds the URL becomes an admin of your status page | **[DECISION]** open for the first account only, invite-only thereafter (FR-A8). §7.3 |
| 9 | Admins supply an arbitrary `targetUrl` that the server then fetches — textbook SSRF into the VPC and cloud metadata endpoints | Mandatory guard, §7.2. This is the single most exploitable part of the design. |
| 10 | `Component.lastCheckedAt` / `responseTimeMs` are written every 60 s, which contradicts the write-behind requirement | Live values live in Redis; MongoDB is written **on transition** plus one snapshot per flush. §5.3.4 |
| 11 | `Incident.updates[]` is an unbounded array inside the document | Acceptable: an incident has tens of updates, not thousands. Capped at 200 with a validator; long-running incidents get a follow-up incident. |
| 12 | Three component statuses, but the brief's impact levels have four grades | Component enum stays 3; system-level status is derived separately and adds `MAINTENANCE`. §5.6 |
| 13 | "Real-time" is claimed but the only transport is a 60 s-TTL cached GET | **[DECISION]** v1 is polling with `ETag` (honest: ≤ 60 s staleness). SSE over Redis pub/sub in v1.5. §5.7 |
| 14 | Nothing says how long ping data is kept | 90 days raw, 13 months rolled up. §5.4.5 |

### 2.5 Assumptions

1. Scale target for v1: **1 organisation, ≤ 200 components, ≤ 50k status page views/day, with a burst ceiling of 2,000 rps during an outage.** The design holds an order of magnitude above this; MongoDB sharding and Redis Cluster do not appear until it doesn't.
2. Single-region deployment. Redis and MongoDB are managed services in the same region as the API.
3. Email delivery is an external provider (Postmark/SES) behind one interface.
4. Node 20+, MongoDB 6+, Redis 7+.
5. Clocks on API instances may skew; **Redis `TIME` is the authority** for anything that compares timestamps across processes.

---

## 3. Architecture

### 3.1 Process topology

Three Node processes, deployed and scaled independently:

```
                       ┌─────────────────────────────────────┐
   visitors ─────────► │  api          (stateless, N pods)   │
   admins   ─────────► │  express + routes + middleware      │
                       └──────┬───────────────────┬──────────┘
                              │                   │
                   ┌──────────▼────────┐   ┌──────▼──────────┐
                   │      Redis        │   │    MongoDB      │
                   │  cache · limits   │   │  source of      │
                   │  sessions · queue │   │  truth          │
                   │  metrics stream   │   │                 │
                   └──▲─────────────▲──┘   └──▲───────────▲──┘
                      │             │         │           │
        ┌─────────────┴───┐   ┌─────┴─────────┴───┐       │
        │ ping-worker     │   │ flush-worker      │───────┘
        │ (N pods,        │   │ (singleton,       │
        │  concurrency 20)│   │  every 10 min)    │
        └────────┬────────┘   └───────────────────┘
                 │
                 ▼
        target URLs (customer infrastructure)
```

**Why three processes and not one.** Pinging 200 URLs with a 5-second
timeout can hold 200 sockets and a second of CPU in JSON/DNS work. Inside
the API process that is 200 slots of the same event loop that owes
visitors a 50 ms p99 — during an outage, when every target is timing out
*and* traffic is at its peak. Separation also means the ping worker can
be scaled, restarted, or crash-looped without the status page noticing.
The flusher is a **singleton** (§5.4.3): two of them double-count
uptime.

In development all three run under one `docker-compose` and one
`npm run dev`.

### 3.2 The three data paths

**Path A — public read (hot).**

```
GET /api/v1/status
  │
  ├─ rate limiter (Redis ZSET, generous bucket)
  ├─ ETag match? ──────────────────────────────► 304, zero work
  ├─ GET cache:status:{org}:v1
  │     ├─ HIT  ─────────────────────────────► 200, ~2 ms
  │     └─ MISS
  │          ├─ SET lock:status:{org} NX PX 5000
  │          │    ├─ lost the race → serve stale copy, or retry in 50 ms
  │          │    └─ won  → Mongo: components + open incidents
  │          │              Redis: live latency hashes (MGET/pipeline)
  │          │              compose payload → SET cache (TTL 60) + stale (TTL 600)
  │          └─ 200
```

**Path B — admin write.**

```
POST /api/v1/admin/incidents
  → verify JWT → RBAC → validate (zod)
  → Mongo write (source of truth)
  → on success: DEL cache:status:{org}:v1  ← after commit, never before
  → PUBLISH events:status {type:"incident.created", ...}
  → 201
```

**Path C — monitoring (async).**

```
scheduler job (every 60 s)
  → for each active component: enqueue ping:component (jitter 0–15 s,
    jobId = ping:{componentId}:{minuteBucket}  ← duplicate-safe)

ping:component job
  → SSRF-guarded HTTP GET, 5 s timeout
  → XADD metrics:pings  (the write-behind buffer)
  → HSET comp:{id}:live  (latency, lastCheckedAt, lastCode)
  → update hysteresis counters; on a transition only:
       Mongo update component.status
       DEL cache:status:{org}:v1
       PUBLISH events:status

flush job (every 10 min, singleton)
  → XREADGROUP up to 5,000 entries
  → bulkWrite samples + rollup increments
  → XACK
```

Note the asymmetry in Path C: the common case (nothing changed) touches
**no MongoDB writes at all**. That is the whole point of §5.4.

### 3.3 Why Redis holds four different things

Redis is doing cache, rate-limit counters, session whitelist, job queue,
and metrics buffer. That is a lot of responsibility in one box, and it is
deliberate — but it means Redis is the **single point of failure with the
widest blast radius**, so §8 specifies how each of the five degrades
independently. Logical separation now, physical separation later:

| Use | Keyspace | Durability needed | If Redis is lost |
|---|---|---|---|
| Status cache | `cache:*` | none | rebuild from Mongo |
| Rate limits | `rl:*` | none | fail-open, log |
| Sessions | `session:*` | **yes** | all users must log in again |
| Queues | `bull:*` | **yes** | in-flight checks lost, rescheduled in 60 s |
| Metrics buffer | `metrics:*` | **yes** | up to 10 min of samples lost |

**[DECISION]** One Redis instance with AOF `everysec` for v1. The two
"none" rows tolerate loss; the three "yes" rows tolerate ≤ 1 s of loss.
When this needs to split, sessions and queues move to a persistent
instance and the cache stays on a volatile one with
`maxmemory-policy allkeys-lru`. Do not set an LRU eviction policy on a
shared instance today — it will silently evict refresh tokens and queue
state.

---

## 4. Data model

### 4.1 Collection overview

| Collection | Grows with | Est. size at target | Written by |
|---|---|---|---|
| `organizations` | tenants | tiny | admin |
| `users` | admins | tiny | admin |
| `components` | monitored services | ≤ 200 docs | admin + transitions |
| `incidents` | outages | ~100/yr | admin |
| `pingsamples` | checks | 72k/day @ 50 comps, 90 d TTL | flusher (batched) |
| `uptimerollups` | comps × hours | 50 × 24 × 90 ≈ 108k | flusher (batched) |
| `subscribers` | visitors | thousands | public (rate-limited) |

### 4.2 Tenancy

Every tenant-owned document carries `orgId`, every index is compound and
**leads with `orgId`**, and every cache key embeds the org slug. The API
resolves the org once per request (from the `Host` header for public
routes, from the JWT for admin routes) and attaches it to
`req.org`. Repository functions take an `orgId` argument — never an
implicit global — so a missing filter is a compile error rather than a
cross-tenant leak.

For v1 there is exactly one org, seeded at bootstrap. The cost is one
extra field and one extra index column; the benefit is that "can we host
a second customer?" is a config change instead of a migration.

### 4.3 Schemas

```ts
// models/Organization.ts
{
  name:        String,            // "Acme Inc"
  slug:        { type: String, unique: true, lowercase: true },   // "acme"
  hosts:       [String],          // ["status.acme.com"] — public host routing
  timezone:    { type: String, default: 'UTC' },
  settings: {
    defaultCheckIntervalSec: { type: Number, default: 60 },
    publicUptimeWindowDays:  { type: Number, default: 90 },
  },
}
// index: { slug: 1 } unique, { hosts: 1 }
```

```ts
// models/User.ts
{
  orgId:        { type: ObjectId, ref: 'Organization', required: true, index: true },
  email:        { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },   // never leaves the DB layer
  role:         { type: String, enum: ['owner', 'admin'], default: 'admin' },
  status:       { type: String, enum: ['active', 'invited', 'disabled'], default: 'active' },
  tokenVersion: { type: Number, default: 0 },   // bump to invalidate every access token
  lastLoginAt:  Date,
}
// index: { orgId: 1, email: 1 } unique
```

`passwordHash` uses `select: false` so it cannot be leaked by an
accidental `res.json(user)` — a `toJSON` transform additionally strips
`__v` and `passwordHash`.

```ts
// models/Component.ts
{
  orgId:       { type: ObjectId, ref: 'Organization', required: true },
  name:        { type: String, required: true },         // "Payment Gateway API"
  slug:        { type: String, required: true },         // stable public identifier
  description: String,
  group:       String,                                   // display grouping
  type:        { type: String, enum: ['API','Database','Website','Webhook'], required: true },

  targetUrl:   { type: String, required: true },
  method:      { type: String, enum: ['GET','HEAD'], default: 'GET' },
  expectedStatusCodes: { type: [Number], default: [200,201,204] },
  timeoutMs:        { type: Number, default: 5000,  min: 1000, max: 15000 },
  degradedAboveMs:  { type: Number, default: 1000 },
  checkIntervalSec: { type: Number, default: 60, min: 30, max: 3600 },

  status:      { type: String, enum: ['OPERATIONAL','DEGRADED','DOWN'], default: 'OPERATIONAL' },
  statusChangedAt: Date,
  lastCheckedAt:   Date,      // snapshot; live value lives in Redis
  responseTimeMs:  Number,    // snapshot; live value lives in Redis

  isActive:    { type: Boolean, default: true },   // paused = false, history kept
  isPublic:    { type: Boolean, default: true },   // internal components hidden from the page
  displayOrder:{ type: Number, default: 0 },
  deletedAt:   Date,                               // soft delete
}
// { orgId: 1, slug: 1 } unique
// { orgId: 1, isActive: 1, deletedAt: 1 }        ← the ping sweep's query
// { orgId: 1, isPublic: 1, displayOrder: 1 }     ← the public page's query
```

Fields added beyond the brief, and why: `slug` (public identifiers must
not be Mongo ObjectIds — they leak insertion order and break if you ever
re-seed), `isActive` (FR-C3), `deletedAt` (deleting a component must not
orphan 90 days of history), `isPublic` (you monitor things you don't
advertise), `timeoutMs`/`degradedAboveMs`/`expectedStatusCodes` (FR-C6 —
a 200 ms database and a 3 s report builder cannot share one threshold),
`checkIntervalSec` (not everything deserves 1,440 checks a day).

```ts
// models/Incident.ts
{
  orgId:   { type: ObjectId, ref: 'Organization', required: true },
  title:   { type: String, required: true },
  slug:    { type: String, required: true },
  status:  { type: String, enum: ['INVESTIGATING','IDENTIFIED','MONITORING','RESOLVED'],
             default: 'INVESTIGATING' },
  impact:  { type: String, enum: ['minor','major','critical'], default: 'minor' },
  affectedComponents: [{ type: ObjectId, ref: 'Component' }],
  updates: [{
    _id:       ObjectId,
    message:   { type: String, required: true, maxlength: 4000 },
    status:    { type: String, enum: ['INVESTIGATING','IDENTIFIED','MONITORING','RESOLVED'] },
    authorId:  { type: ObjectId, ref: 'User' },
    timestamp: { type: Date, default: Date.now },
  }],
  startedAt:  { type: Date, default: Date.now },
  resolvedAt: Date,
  createdBy:  { type: ObjectId, ref: 'User' },
}, { timestamps: true }
// { orgId: 1, resolvedAt: 1, startedAt: -1 }   ← "active incidents", the hottest query
// { orgId: 1, slug: 1 } unique
// { orgId: 1, createdAt: -1 }                  ← history pagination
```

`resolvedAt: null` is the definition of "active". Indexing it first makes
the public page's incident query an index scan over a handful of
documents rather than a filter over every incident ever recorded.

```ts
// models/PingSample.ts
{
  _id:         String,      // = the Redis stream entry id  → idempotent re-insert
  ts:          Date,
  componentId: ObjectId,
  orgId:       ObjectId,
  ok:          Boolean,
  statusCode:  Number,
  responseMs:  Number,
  errorClass:  String,      // 'timeout' | 'dns' | 'conn_refused' | 'tls' | 'http_error' | null
}
// { componentId: 1, ts: -1 }
// { ts: 1 } with expireAfterSeconds: 7776000   (90 days)
```

Using `_id = <stream entry id>` is what makes the flusher safe to retry:
a redelivered batch re-inserts the same `_id` and fails with a duplicate
key that `{ ordered: false }` lets us ignore. Exactly-once effect from
at-least-once delivery, with no coordination.

**[DECISION] A regular collection, not a time-series one.** A time-series
collection would compress this data better and is the obvious fit for the
shape — but time-series collections do not support unique indexes, so the
`_id`-collision trick above silently stops working there and the flusher
loses its cheapest correctness guarantee. If storage becomes the binding
constraint, the migration is: move to a time-series collection, drop the
duplicate-key defence, and make the §5.4.3 watermark the *only* guard for
samples as well as rollups. Not worth it at 7 MB/day.

```ts
// models/UptimeRollup.ts
{
  orgId:       ObjectId,
  componentId: ObjectId,
  bucket:      Date,        // hour-truncated UTC
  total:       Number,
  ok:          Number,
  degraded:    Number,
  down:        Number,
  sumMs:       Number,      // → mean latency
  maxMs:       Number,
  lastStreamId:String,      // watermark, see §5.4.3
}
// { orgId: 1, componentId: 1, bucket: -1 } unique
```

```ts
// models/Subscriber.ts     (v1.5)
{
  orgId:      ObjectId,
  channel:    { type: String, enum: ['email'], default: 'email' },
  address:    { type: String, required: true, lowercase: true },
  status:     { type: String, enum: ['pending','confirmed','unsubscribed'], default: 'pending' },
  confirmToken:     { type: String, select: false },
  unsubscribeToken: { type: String, select: false },
  confirmedAt: Date,
  createdIp:   String,       // abuse forensics; purged after 30 days
}
// { orgId: 1, address: 1 } unique
```

### 4.4 Redis keyspace

Every key is namespaced and every key has a defined lifetime. An
unbounded keyspace is a production incident with a long fuse.

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `cache:status:{org}:v1` | string (JSON) | 60 s | the public payload (§5.1) |
| `cache:status:{org}:stale` | string (JSON) | 600 s | last-known-good, for Mongo outages |
| `cache:etag:{org}` | string | 60 s | current ETag, to answer conditional GETs |
| `lock:status:{org}` | string | 5 s | single-flight rebuild lock |
| `rl:{bucket}:{id}` | zset | window | sliding-window counters (§5.2) |
| `session:refresh:{userId}` | set | 30 d | this user's live refresh-token hashes |
| `session:token:{hash}` | hash | 30 d | hash → {userId, sessionId, ip, ua} |
| `session:used:{hash}` | string | 60 s | rotation grace window / reuse detection |
| `comp:{id}:live` | hash | 300 s | lastCheckedAt, responseMs, code — the live snapshot |
| `comp:{id}:health` | hash | 1 h | consecutiveFail, consecutiveOk — hysteresis state |
| `metrics:pings` | stream | capped 200k | the write-behind buffer (§5.4) |
| `events:status` | pub/sub | — | transitions and incident updates (§5.7) |
| `bull:ping:*`, `bull:flush:*` | BullMQ | managed | queues |

The `:v1` suffix on the cache key is a deploy-time escape hatch: when the
payload shape changes, bump it rather than trying to reason about mixed
old/new documents in flight during a rolling deploy.

---

## 5. Subsystem specifications

### 5.1 Cache-aside for the public status page

#### 5.1.1 The read

```
key   = cache:status:{org}:v1
TTL   = 60 s
value = JSON, ~4–20 KB depending on component count
```

1. Compute the request's `If-None-Match`. If it equals `cache:etag:{org}`, return **304** — no payload, no deserialisation, no work.
2. `GET cache:status:{org}:v1`. Hit → return with `ETag` and `Cache-Control: public, max-age=15, stale-while-revalidate=60`.
3. Miss → §5.1.3.

The `max-age=15` is deliberately shorter than the 60 s TTL: a CDN or
browser holding a response for longer than the server's own cache would
make invalidation meaningless from the outside.

#### 5.1.2 The rebuild

Composing the payload costs three reads, run concurrently:

```ts
const [components, incidents] = await Promise.all([
  Component.find({ orgId, isPublic: true, deletedAt: null })
           .sort({ displayOrder: 1 }).lean(),
  Incident.find({ orgId, resolvedAt: null })
          .sort({ startedAt: -1 }).lean(),
]);
const live = await redis.pipeline(
  components.map(c => ['hgetall', `comp:${c._id}:live`])
).exec();
```

Uptime percentages (FR-S4) are **not** computed here — a 90-day
aggregation on every cache miss would put the expensive query on the
critical path. They are maintained by the flusher into
`cache:uptime:{org}` (15-minute TTL) and merged in, or omitted if absent.
A status page that shows current status instantly and uptime a beat later
is strictly better than one that shows neither for 400 ms.

#### 5.1.3 Stampede protection **[NFR-3]**

Plain cache-aside has a hole: the TTL expires at the exact moment 2,000
people are refreshing, and all 2,000 requests miss and all 2,000 query
MongoDB. The database dies, and it dies *because* you cached.

```ts
const lock = await redis.set(`lock:status:${org}`, id, 'NX', 'PX', 5000);
if (lock === 'OK') {
  try {
    const payload = await rebuild();
    await redis.pipeline()
      .set(key,      json, 'EX', 60)
      .set(staleKey, json, 'EX', 600)
      .set(etagKey,  etag, 'EX', 60)
      .exec();
    return payload;
  } finally {
    await releaseLock(lockKey, id);   // Lua: DEL only if value still mine
  }
}
// lost the race:
const stale = await redis.get(staleKey);
if (stale) return { ...stale, stale: true };        // serve it, mark it
await sleep(50); return read();                      // else brief retry, max 3
```

The stale copy is what makes this safe under the worst case: even if the
rebuild takes 4 seconds because MongoDB is struggling, every other
request returns in 2 ms with data that is at most ten minutes old and
labelled as such.

#### 5.1.4 Invalidation

Invalidate on: component create/update/delete/pause, status transition,
incident create/update/resolve.

Two rules, both non-obvious and both the source of the classic bug:

1. **`DEL` after the Mongo write commits, never before.** Deleting first
   opens a window where a concurrent reader repopulates the cache from
   pre-write data and then the TTL keeps it wrong for 60 seconds.
2. **`DEL`, never `SET`.** Writing the new payload from inside a write
   request means two concurrent writers can land their payloads out of
   order. Deleting is idempotent and order-independent; the next reader
   rebuilds from the committed truth.

Even so, a lost `DEL` (Redis blip during the write) is survivable because
the TTL bounds the error at 60 seconds. That is the real reason a TTL
exists on a key that is explicitly invalidated: the TTL is not the
freshness mechanism, it is the **correctness backstop**.

Implementation: a small `cache.middleware.ts` for the read path and an
explicit `invalidateStatus(orgId)` called from the service layer for
writes — not from the controller, so that anything that mutates state
invalidates regardless of who called it.

---

### 5.2 Sliding-window rate limiting

#### 5.2.1 Why a sorted set

A fixed-window counter (`INCR` + `EXPIRE`) lets an attacker send `limit`
requests at 11:59:59.9 and `limit` more at 12:00:00.1 — double the
intended rate across the boundary. A sorted set keyed by timestamp gives
a true sliding window at the cost of one small ZSET per identifier per
window.

#### 5.2.2 The script

Four Redis commands must be atomic: trim, count, decide, record.
Interleaving them from Node lets concurrent requests all read the same
pre-increment count and all pass.

```lua
-- rateLimit.lua
-- KEYS[1] = rl:{bucket}:{identifier}
-- ARGV[1] = window_ms   ARGV[2] = limit   ARGV[3] = unique member id
local now_ms  = redis.call('TIME')
now_ms = (tonumber(now_ms[1]) * 1000) + math.floor(tonumber(now_ms[2]) / 1000)

local window = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms - window)
local used = redis.call('ZCARD', KEYS[1])

if used >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local reset_ms = math.ceil(tonumber(oldest[2]) + window - now_ms)
  return { 0, 0, reset_ms }
end

redis.call('ZADD',    KEYS[1], now_ms, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return { 1, limit - used - 1, window }
```

Notes that matter:

- **The clock comes from `redis.call('TIME')`, not from Node.** With
  several API pods, client clocks skew by tens of milliseconds and a
  window becomes ragged. Redis is one clock for all of them.
- `PEXPIRE` on every accepted request keeps idle keys from accumulating —
  the keyspace is self-cleaning without a sweeper.
- Loaded once with `SCRIPT LOAD` and invoked by `EVALSHA` via ioredis's
  `defineCommand`, so the script body is not on the wire per request.
- The member must be unique per request (`${now}-${randomUUID()}`), or two
  requests in the same millisecond collapse into one ZSET member and one
  of them is free.

#### 5.2.3 Buckets

| Bucket | Identifier | Limit | Window | Failure mode |
|---|---|---|---|---|
| `public:status` | IP | 120 | 60 s | 429 |
| `public:subscribe` | IP | 5 | 60 s | 429 + captcha hint |
| `public:subscribe:day` | IP | 20 | 24 h | 429 |
| `auth:login:ip` | IP | 10 | 15 min | 429 |
| `auth:login:acct` | email hash | 5 | 15 min | 429 (blunts credential stuffing) |
| `admin:write` | userId | 60 | 60 s | 429 |

Two limiters on login is intentional: per-IP alone is defeated by a
botnet, per-account alone is a denial-of-service vector against a known
admin. Both, together, are the standard answer.

#### 5.2.4 Operational details

- **`app.set('trust proxy', 1)` must match the actual number of proxies.**
  Get this wrong and either every request shares the load balancer's IP
  (one bucket for the internet — instant self-DoS) or a client can spoof
  `X-Forwarded-For` and mint unlimited buckets. This is the most common
  way a correct limiter is deployed uselessly. It is asserted in a test.
- Responses carry `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset`, and `Retry-After` on a 429.
- **Fail-open on Redis errors.** If Redis is unreachable the limiter logs
  and allows the request. Rate limiting protects against abuse; refusing
  all traffic because the abuse-protection layer is down converts a
  degradation into an outage. Admin write endpoints fail-*closed* —
  different risk, different default.
- IPv6 is bucketed by /64, not by address; a single client owns more
  individual v6 addresses than you have memory.

---

### 5.3 Background uptime ping engine

#### 5.3.1 Scheduling

One repeatable **scheduler** job every 60 s (BullMQ's job scheduler —
`queue.upsertJobScheduler` on v5.16+, `repeat: { every: 60_000 }` on
older versions) that fans out one `ping:component` job per due component.

```ts
for (const c of dueComponents) {
  await pingQueue.add('ping:component', { componentId: c._id, orgId: c.orgId }, {
    jobId: `ping:${c._id}:${Math.floor(Date.now() / (c.checkIntervalSec * 1000))}`,
    delay: Math.floor(Math.random() * 15_000),   // jitter
    attempts: 2,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  });
}
```

- **The deterministic `jobId`** makes double-scheduling a no-op. If two
  scheduler instances fire, or a deploy replays the job, BullMQ drops the
  duplicate. This is cheaper and more reliable than trying to guarantee
  exactly one scheduler.
- **Jitter** spreads 200 simultaneous outbound requests across 15 seconds.
  Without it every check leaves at `:00`, which is both a self-inflicted
  burst and a thundering herd against a customer's origin.
- Fan-out (not one job that loops) means one slow target delays only
  itself, and the worker's concurrency does the parallelism.

Worker: `concurrency: 20`, `lockDuration: 30_000` (comfortably above the
5 s timeout plus overhead). The connection passed to a BullMQ `Worker`
**must** be created with `maxRetriesPerRequest: null` — the default
throws on blocking commands and the worker dies in a way that looks like
a Redis problem and isn't.

#### 5.3.2 The check itself

```ts
const res = await axios({
  method: component.method, url: safeUrl,
  timeout: component.timeoutMs,
  maxRedirects: 0,                   // each hop re-validated instead
  validateStatus: () => true,        // a 500 is data, not an exception
  maxContentLength: 64 * 1024,       // we need a status line, not a page
  headers: { 'User-Agent': 'StatPulse/1.0 (+https://statpulse.dev/bot)' },
  httpAgent, httpsAgent,             // keep-alive pools, IP-pinned (§7.2)
});
```

Timing uses `process.hrtime.bigint()` around the call — `Date.now()`
deltas at this resolution are noise. The timer starts before DNS, because
a DNS failure is an outage to the user even if the origin is healthy.

**`attempts: 2` retries infrastructure failures, not target failures.**
A timeout or a 503 from the target is a *successful* job with `ok: false`
— retrying it would erase the very signal we exist to capture. Only
errors thrown by our own code (Redis unavailable, malformed component)
reach BullMQ's retry.

Error classification: `timeout`, `dns`, `conn_refused`, `tls`,
`http_error`, `too_large`, `blocked` (SSRF guard). Stored per sample;
"DNS failure" and "500 error" lead to entirely different pages of a
runbook.

#### 5.3.3 Hysteresis — the difference between a status page and an alarm

A single failed check means almost nothing: a dropped packet, a
redeploy, a GC pause. Flipping the public page to DOWN on one sample
produces a page that cries wolf, and a page that cries wolf gets ignored
during a real outage.

```
State machine, evaluated per check:

  OPERATIONAL ──3 consecutive failures──► DOWN
  OPERATIONAL ──2 consecutive slow──────► DEGRADED
  DEGRADED    ──3 consecutive failures──► DOWN
  DEGRADED    ──2 consecutive ok+fast───► OPERATIONAL
  DOWN        ──2 consecutive ok────────► OPERATIONAL (or DEGRADED if slow)
```

"Slow" = `responseMs > component.degradedAboveMs`. "Failure" = transport
error, timeout, or a status code outside `expectedStatusCodes`.

Counters live in `comp:{id}:health` (a Redis hash, `HINCRBY`, 1 h TTL) —
they are derived state, worthless after a gap, and have no business in
MongoDB. Worst case at the default interval: `DOWN` is declared ~3
minutes after the first failure, recovery ~2 minutes after it returns.
Both thresholds are per-component configurable for anyone who wants to
trade confidence for speed.

#### 5.3.4 What a check actually writes

| Every check (~1,440/day/component) | On a transition only (~a few/month) |
|---|---|
| `XADD metrics:pings` | `Component.updateOne({status, statusChangedAt})` |
| `HSET comp:{id}:live` | `DEL cache:status:{org}:v1` |
| `HINCRBY comp:{id}:health` | `PUBLISH events:status` |
| — **zero MongoDB writes** — | one indexed write |

This is the resolution of gap #10 (§2.4) and the thing that makes NFR-4
achievable. The brief's `lastCheckedAt` and `responseTimeMs` columns
still exist on the document and are still accurate to within ten minutes
— the flusher snapshots the Redis live hash into them on each flush — but
they are no longer paid for 1,440 times a day per component.

---

### 5.4 Write-behind metrics buffer

#### 5.4.1 The arithmetic

50 components × 1,440 checks = **72,000 writes/day**, and it scales
linearly with customers. Each is a tiny document, but each is also an
index update, a journal entry, and an oplog record — and they arrive at a
steady 50/minute forever, competing with the reads that matter. Batched
every 10 minutes, those 72,000 individual writes become **144
`bulkWrite` calls a day.**

#### 5.4.2 Stream, not list

**[DECISION]** Redis Stream (`XADD`) over `LPUSH`/`LRANGE`:

| | List | Stream |
|---|---|---|
| Read without removing | no (`LRANGE`+`LTRIM` races) | yes |
| Crash after read, before write | **data lost** | redelivered via consumer group |
| Multiple consumers | manual | built in |
| Bounded memory | manual `LTRIM` | `MAXLEN ~` on `XADD` |

The list version loses data on exactly the failure the buffer exists to
survive. The cost of the stream is one extra concept (consumer groups)
and it is worth it.

```
XADD metrics:pings MAXLEN ~ 200000 *
  c <componentId> o <orgId> t <ts> ok <0|1> ms <latency> sc <statusCode> e <errorClass>
```

`MAXLEN ~ 200000` is a safety valve, not a policy: at 50 comps/min it is
~66 hours of buffer. If the flusher has been dead for 66 hours, losing the
oldest samples is the correct behaviour — the alternative is Redis
running out of memory and taking the cache, the sessions, and the queues
with it.

#### 5.4.3 The flusher

Runs every 10 minutes as a BullMQ repeatable job, **singleton** —
`concurrency: 1` plus a Redis lock (`SET flush:lock NX PX 540000`), because
two flushers double-count `$inc` rollups.

```
1. XREADGROUP GROUP flush flusher-1 COUNT 5000 STREAMS metrics:pings >
2. XAUTOCLAIM anything pending > 15 min from a dead consumer
3. In memory:
     samples[]  → one doc per entry, _id = entry id
     rollups{}  → keyed (componentId, hourBucket), accumulating counts
4. PingSample.insertMany(samples, { ordered: false })   ← ignore E11000
5. UptimeRollup.bulkWrite(upserts with $inc, guarded by watermark)
6. Component.bulkWrite(lastCheckedAt / responseTimeMs snapshots)
7. XACK the processed ids
8. Loop while the batch was full (drain a backlog in one run)
```

**Idempotency.** Consumer groups are at-least-once: a crash between
step 4 and step 7 causes redelivery. Steps 4 and 6 are naturally
idempotent (`_id` collision; last-write-wins snapshot). Step 5 is not —
`$inc` applied twice is wrong. Guard: each rollup document stores
`lastStreamId`, and the increment is conditional on the incoming batch's
max id being greater:

```ts
{ updateOne: {
    filter: { orgId, componentId, bucket, lastStreamId: { $lt: maxIdInBatch } },
    update: { $inc: {...}, $max: { maxMs }, $set: { lastStreamId: maxIdInBatch } },
    upsert: true,
}}
```

Redis stream ids are monotonic and lexicographically ordered, so `$lt` on
the string is a valid comparison. A redelivered batch matches no
document and increments nothing.

*If you don't want this complexity on day one:* skip the watermark, accept
that a flusher crash can double-count one 10-minute window's samples
(≈ 0.02 % error on a 90-day uptime figure), and write it down as a known
limitation. But the guard is six lines, and "our uptime number is
approximately right" is an awkward sentence in a renewal conversation.

#### 5.4.4 The honest cost

The buffer trades durability for throughput: **up to 10 minutes of
samples can be lost** if Redis dies uncleanly. That is acceptable
precisely because these samples are statistical — a gap costs a few
tenths of a percent of resolution in a historical chart. It is *not*
acceptable for status transitions, which is why those are written to
MongoDB synchronously at the moment they happen (§5.3.4). The rule: state
transitions are durable, the telemetry around them is not.

#### 5.4.5 Retention

| Tier | Granularity | Kept | Mechanism |
|---|---|---|---|
| Raw samples | per check | 90 days | TTL index on `ts` |
| Hourly rollups | 1 h | 90 days | written by flusher |
| Daily rollups | 1 d | 13 months | nightly job aggregating hourly |

Uptime for ≤ 7 days reads hourly buckets; 90 days reads daily buckets.
A 90-day number never touches the raw collection.

---

### 5.5 Authentication

#### 5.5.1 Token design

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, HS256 | **opaque**, 32 random bytes, base64url |
| Lifetime | 15 min | 30 days, rotated on every use |
| Transport | `Authorization: Bearer` | `httpOnly` cookie |
| Storage | client memory only | cookie + Redis whitelist |
| Revocation | expiry, or `tokenVersion` bump | instant (`SREM`) |

**[DECISION] The refresh token is opaque, not a JWT.** A JWT refresh
token carries claims that must be checked against Redis anyway — so the
signature buys nothing, while the decodable payload leaks `userId` and
`orgId` to anyone who reads the cookie. Random bytes with a server-side
lookup is simpler and strictly tighter.

Access claims: `sub`, `org`, `role`, `tv` (tokenVersion), `jti`, `iat`,
`exp`, `iss`, `aud`. `tv` is what makes "disable this user *now*" work
without a per-request Redis lookup: the middleware compares `tv` against
a cached user record, and a mismatch rejects.

#### 5.5.2 Redis session structures

```
session:refresh:{userId}  SET   of sha256(token)          TTL 30d
session:token:{sha256}    HASH  { userId, sessionId, orgId, ip, ua, createdAt }  TTL 30d
session:used:{sha256}     STR   marker for rotated tokens TTL 60s
```

Login → `SADD` + `HSET`. Logout → `SREM` + `DEL`. "Log out everywhere" →
`SMEMBERS` then delete all, one pipeline. This is the brief's design and
it is the right one: revocation is O(1) and the access-token path stays
stateless.

#### 5.5.3 Rotation and reuse detection

Every refresh issues a new token and invalidates the old one. If a token
arrives that is *not* in the whitelist but *is* in `session:used:*`, it
has been replayed — either a stolen token or a client racing itself.
Response: revoke every session for that user and force re-login. The 60 s
`session:used` window is deliberately short enough to bound the false
positives (a client retrying a dropped response) while catching the real
case, where an attacker replays a token minutes or hours later.

#### 5.5.4 Cookie and CSRF

```
Set-Cookie: sp_rt=<token>; HttpOnly; Secure; SameSite=Lax;
            Path=/api/v1/auth; Max-Age=2592000
```

`Path` scoping means the cookie is not attached to the 2,000 rps of
public status requests — a meaningful bandwidth and exposure win.

Because `/auth/refresh` is authenticated by a cookie, it is CSRF-reachable.
Mitigation: `SameSite=Lax` plus a strict `Origin`/`Referer` check on the
refresh and logout endpoints. **[OPEN]** If the admin dashboard is served
from a different origin than the API, `SameSite` must become `None` and a
double-submit CSRF token becomes mandatory — this depends on the hosting
decision (§15).

#### 5.5.5 Passwords

argon2id (`memoryCost: 19456, timeCost: 2, parallelism: 1` — the OWASP
baseline), falling back to bcrypt cost 12 if the native build is a
deployment problem. Minimum 12 characters, checked against a common-password
list, no composition rules. Login returns an identical error and takes
comparable time for "no such user" and "wrong password" — a dummy hash
comparison on the miss path prevents user enumeration by timing.

---

### 5.6 Status aggregation

Overall system status is the **worse of** two independent signals:

```
derived  = worst(component.status for public, active components)
declared = worst(impact → status  for open incidents)
              minor → DEGRADED, major → DEGRADED, critical → DOWN
overall  = worst(derived, declared)
```

Both halves are needed. Machine checks miss things a human knows
("payments are up but settling to the wrong ledger"), and humans miss
things checks catch. Neither is allowed to silently override the other —
and when an admin marks a critical incident, the page says DOWN even if
every ping is green.

The public enum is wider than the component enum, because the interesting
cases are the partial ones:

| Overall | Condition |
|---|---|
| `OPERATIONAL` | everything green, no open incidents |
| `DEGRADED` | any component degraded, or a minor/major incident open |
| `PARTIAL_OUTAGE` | some components down, not all |
| `MAJOR_OUTAGE` | all components down, or a critical incident open |
| `MAINTENANCE` | a scheduled window is active (v1.5) |

Uptime percentage per component over a window:

```
uptime% = 100 × Σ(ok) / Σ(total)
```

counting `DEGRADED` checks as up. **[OPEN]** Some teams count degraded as
partial credit (0.5) — a product decision, not a technical one. Buckets
with zero samples (the component was paused, or the worker was down) are
excluded from both sums rather than counted as downtime: a monitoring
gap is not an outage, and pretending otherwise makes the number a
measure of *our* reliability rather than the customer's.

---

### 5.7 Real-time delivery

**v1: polling with `ETag`.** The page polls `/api/v1/status` every 30 s.
On no change the server answers 304 with no body after a single Redis
`GET`. Worst-case staleness is one cache TTL, 60 s. This is honest, it is
trivially horizontally scalable, and it survives any client.

**v1.5: Server-Sent Events.** `GET /api/v1/status/stream` subscribes to
the Redis channel `events:status`, which the ping worker and the incident
service publish to. Each API pod holds one Redis subscriber connection
and fans out to its own connected clients.

Known costs, decided in advance: SSE holds an open socket per viewer, so
a viral outage means tens of thousands of sockets — capped per pod, with
a `Retry-After` when full, and clients falling back to polling. Browsers
cap HTTP/1.1 connections at ~6 per domain, so SSE needs HTTP/2 at the
edge. And any proxy in front must have response buffering disabled or the
stream silently never arrives.

WebSockets are **not** used: this traffic is strictly one-directional and
SSE reconnects on its own.

---

### 5.8 Subscriptions and notifications (v1.5)

```
POST /api/v1/subscribe  → rate-limited (5/min/IP, 20/day/IP)
                        → create Subscriber{status:'pending'}
                        → enqueue notify:confirm
                        → 202 always, regardless of whether the address existed
```

The response is identical whether or not the address is already
subscribed — otherwise the endpoint is an oracle for "does this person
watch this company's status page."

Incident create/update enqueues `notify:incident`, which batches
confirmed subscribers into chunks of 50, one job per chunk, with
`attempts: 5` and exponential backoff. Every job is idempotent on
`(incidentId, updateId, subscriberId)` recorded in Redis with a 7-day TTL,
because at-least-once delivery plus a provider timeout otherwise means
sending the same outage email three times — during an outage, to people
already annoyed.

Suppression: no more than one email per subscriber per incident per
10 minutes, and nothing at all for an incident that resolves within
2 minutes of being declared. The most common complaint about status page
notifications is volume, not latency.

---

## 6. API contract

### 6.1 Conventions

- Base path `/api/v1`. Breaking changes get `/v2`; `/api/*` without a version 301s to v1.
- All bodies JSON, `Content-Type` enforced, 100 KB limit.
- Validation with **zod** at the route boundary; the inferred type is what the controller receives, so there is exactly one definition of a request shape.
- Public identifiers are slugs. ObjectIds never appear in a public response.
- Timestamps are ISO-8601 UTC with `Z`.
- Pagination is cursor-based (`?cursor=&limit=`, default 20, max 100); offsets skip and duplicate rows when data changes underneath.

### 6.2 Error envelope

```json
{
  "error": {
    "code": "COMPONENT_NOT_FOUND",
    "message": "No component with that identifier.",
    "details": [{ "path": "targetUrl", "message": "must be http or https" }],
    "requestId": "01J9F0Z0X2K3"
  }
}
```

`code` is a stable machine-readable string; `message` is for humans and may
change. Internal errors never leak a stack trace, a Mongo error string, or
a target URL to a public caller.

| Status | Used for |
|---|---|
| 400 | validation failure |
| 401 | missing/expired access token |
| 403 | authenticated but wrong role, or SSRF-blocked target |
| 404 | no such resource *in this org* (never distinguish from "exists elsewhere") |
| 409 | duplicate slug/email, or conflicting incident state |
| 422 | semantically invalid (e.g. resolving an already-resolved incident) |
| 429 | rate limited, with `Retry-After` |
| 503 | dependency down and no stale data available |

### 6.3 Endpoint map

| Method | Path | Access | Limiter | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/status` | public | `public:status` | **cached**, ETag |
| `GET` | `/api/v1/status/components/:slug` | public | `public:status` | single component + 90 d uptime |
| `GET` | `/api/v1/status/stream` | public | — | SSE (v1.5) |
| `GET` | `/api/v1/incidents` | public | `public:status` | paginated, `?status=active\|resolved` |
| `GET` | `/api/v1/incidents/:slug` | public | `public:status` | with full timeline |
| `POST` | `/api/v1/subscribe` | public | `public:subscribe` | v1.5 |
| `GET` | `/api/v1/subscribe/confirm/:token` | public | `public:subscribe` | v1.5 |
| `POST` | `/api/v1/auth/register` | public¹ | `auth:login:ip` | first user only |
| `POST` | `/api/v1/auth/login` | public | `auth:login:*` | sets refresh cookie |
| `POST` | `/api/v1/auth/refresh` | cookie | `auth:login:ip` | rotates |
| `POST` | `/api/v1/auth/logout` | cookie | — | `SREM` |
| `GET` | `/api/v1/auth/me` | JWT | — | |
| `GET` | `/api/v1/auth/sessions` | JWT | — | list + revoke |
| `DELETE` | `/api/v1/auth/sessions/:id` | JWT | — | |
| `GET` | `/api/v1/admin/components` | JWT | `admin:write` | includes private |
| `POST` | `/api/v1/admin/components` | JWT | `admin:write` | SSRF-validated |
| `PATCH` | `/api/v1/admin/components/:id` | JWT | `admin:write` | |
| `DELETE` | `/api/v1/admin/components/:id` | JWT | `admin:write` | soft delete |
| `POST` | `/api/v1/admin/components/:id/check` | JWT | `admin:write` | check now |
| `GET` | `/api/v1/admin/incidents` | JWT | `admin:write` | |
| `POST` | `/api/v1/admin/incidents` | JWT | `admin:write` | invalidates cache |
| `PATCH` | `/api/v1/admin/incidents/:id` | JWT | `admin:write` | appends an update |
| `GET` | `/healthz` | internal | — | process alive |
| `GET` | `/readyz` | internal | — | Mongo + Redis reachable |

¹ open only while the org has zero users; 403 thereafter (FR-A8).

### 6.4 Auth payloads

```http
POST /api/v1/auth/login
{ "email": "ops@acme.com", "password": "..." }

200 OK
Set-Cookie: sp_rt=…; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth; Max-Age=2592000
{
  "accessToken": "eyJ…",
  "expiresIn": 900,
  "user": { "id": "usr_…", "email": "ops@acme.com", "role": "owner" }
}
```

```http
POST /api/v1/auth/refresh        # cookie only, no body
200 OK  → new accessToken + rotated cookie
401     → cookie missing/unknown
401 + all sessions revoked → token was replayed (§5.5.3)
```

### 6.5 The public status payload

The one response shape that matters. Frozen early, versioned by the
`:v1` cache key.

```jsonc
{
  "status": "PARTIAL_OUTAGE",
  "updatedAt": "2026-09-14T10:32:04Z",
  "stale": false,                    // true when served from the stale copy
  "groups": [
    {
      "name": "Core",
      "components": [
        {
          "slug": "payments-api",
          "name": "Payment Gateway API",
          "type": "API",
          "status": "DOWN",
          "responseTimeMs": null,
          "lastCheckedAt": "2026-09-14T10:31:48Z",
          "uptime": { "24h": 97.21, "7d": 99.64, "90d": 99.91 }
        },
        {
          "slug": "dashboard",
          "name": "Dashboard",
          "type": "Website",
          "status": "OPERATIONAL",
          "responseTimeMs": 142,
          "lastCheckedAt": "2026-09-14T10:31:52Z",
          "uptime": { "24h": 100, "7d": 99.99, "90d": 99.97 }
        }
      ]
    }
  ],
  "activeIncidents": [
    {
      "slug": "payment-processing-errors",
      "title": "Elevated error rates on payment processing",
      "status": "IDENTIFIED",
      "impact": "critical",
      "startedAt": "2026-09-14T10:12:00Z",
      "affectedComponents": ["payments-api"],
      "latestUpdate": {
        "message": "Rolled back the 10:05 deploy. Recovery in progress.",
        "status": "IDENTIFIED",
        "timestamp": "2026-09-14T10:28:00Z"
      }
    }
  ]
}
```

`targetUrl`, ObjectIds, error classes, and internal components are absent
by construction — the serializer builds this shape field by field from
the domain objects rather than deleting keys from them (NFR-8). A
contract test asserts that the JSON of a fully-populated fixture contains
none of the forbidden substrings.

---

## 7. Security

### 7.1 Baseline

`helmet` with a strict CSP on the status page · CORS allowlist (public
GETs `*`, admin routes restricted to the dashboard origin, `credentials:
true` only there) · body size limits · `mongo-sanitize` or explicit
casting on every query built from user input · secrets from env only,
never committed, `.env` in `.gitignore` and `.env.example` documenting
every key · dependency audit in CI.

### 7.2 SSRF — the sharp edge

An admin types a URL and **the server fetches it**, from inside the
production network, every 60 seconds, forever. Without a guard this is a
port scanner and a metadata-credential exfiltration tool with a nice UI.

Validation at creation *and* again at request time, since DNS can change
between them:

1. Scheme must be `http` or `https`. No `file:`, `gopher:`, `ftp:`, `data:`.
2. No credentials in the URL (`http://user:pass@…`).
3. Resolve the hostname. Reject if **any** resolved address is in:
   `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`
   (**including `169.254.169.254`, the cloud metadata endpoint**),
   `100.64/10` (CGNAT), `::1`, `fc00::/7`, `fe80::/10`, `0.0.0.0/8`.
4. **Connect to the resolved IP**, not the hostname — a custom
   `lookup` on the agent pins the address that was validated. Otherwise a
   hostname with a 1-second TTL can resolve to a public IP for the check
   and `169.254.169.254` for the fetch. This TOCTOU is how most naive
   SSRF filters are defeated.
5. `maxRedirects: 0`; follow manually, re-running steps 1–4 per hop, max 3.
6. Cap the response at 64 KB and never return its body to any caller.
7. Non-standard ports allowed but logged; ports 22, 25, 3306, 5432, 6379,
   27017 blocked outright — nobody's public health check runs there.

**[DECISION]** For v1 the guard is in-process. The stronger form —
running the ping worker in a network-isolated subnet with an egress-only
NAT and no route to the VPC — is an infrastructure task recorded in §14
as the real long-term fix. Steps 1–7 are the belt; the subnet is the
braces.

A `SELF_HOSTED_ALLOW_PRIVATE=true` escape hatch exists for on-prem
installs that legitimately monitor internal services, defaulting to
false, loudly logged at boot.

### 7.3 Registration and enumeration

Open registration on an admin panel means the first person to find
`/api/v1/auth/register` becomes an administrator. Bootstrap: the endpoint
works only while `users.countDocuments({orgId}) === 0`, and returns 403
afterwards. Additional admins arrive by invite — a single-use token,
24 h TTL, stored hashed.

Every public endpoint that touches an identity (login, subscribe, password
reset if added) returns the same response and takes comparable time for
"exists" and "does not exist".

### 7.4 Data handling

Passwords are argon2id and never logged. Access tokens are never logged,
even at debug (a redacting serializer on the logger covers
`authorization`, `cookie`, `password`, `token`). Subscriber IPs are kept
30 days for abuse forensics then purged. `targetUrl` is admin-visible
only — it often contains a health-check path that is itself a small
information leak.

---

## 8. Failure modes and degradation

The status page's job is to be the last thing standing. Each dependency
has a defined degraded mode rather than a stack trace.

| Failure | Public read | Admin write | Ping engine | Recovery |
|---|---|---|---|---|
| **Redis down** | falls back to Mongo, circuit breaker limits to ~5 queries/s, `Cache-Control: max-age=30` pushes load to the CDN | works; invalidation is a no-op (TTL-less cache is already gone) | queue unavailable, checks pause; status freezes at last known | automatic on reconnect; cache repopulates on first miss |
| **Mongo down** | serves `cache:…:stale`, `"stale": true`, up to 10 min old; 503 if no stale copy | 503 | checks continue, samples buffer in Redis; transitions queued for retry | automatic; flusher drains the backlog |
| **Both down** | 503 with a static body | 503 | stopped | manual |
| **Ping worker dead** | page serves last known status, with `lastCheckedAt` visibly ageing | normal | — | alert when `now - max(lastCheckedAt) > 5 min` |
| **Flusher dead** | current status fine; uptime numbers stop advancing | normal | normal | stream backlog drains on restart; `MAXLEN` caps the loss at ~66 h |
| **Queue backlog** | fine | fine | checks delayed; jitter + deterministic jobIds prevent a stampede on recovery | alert on `waiting > 500` |
| **A target is a tarpit** (accepts, never responds) | fine | fine | one worker slot held for `timeoutMs`, capped by concurrency | timeout is mandatory and bounded |
| **Cache stampede** | one rebuild, everyone else stale | — | — | §5.1.3 |
| **Clock skew across pods** | — | — | — | Redis `TIME` is the single clock (§5.2.2) |

Two rules that fall out of this table and are worth stating on their own:

1. **The public read path must never `await` something that can hang.**
   Every Redis and Mongo call on it carries an explicit timeout
   (`serverSelectionTimeoutMS: 3000`, `commandTimeout: 1000`), because a
   hung connection pool at 2,000 rps exhausts sockets in seconds.
2. **Degradation must be visible.** `"stale": true` renders as "last
   updated 8 minutes ago" on the page. A status page that quietly shows
   old data is worse than one that admits it is struggling.

---

## 9. Observability

**Logging.** `pino`, JSON, one line per request with method, path, status,
duration, `orgId`, `userId`, `requestId`. A `requestId` (ULID) is
generated at the edge, carried in `AsyncLocalStorage`, propagated into
job payloads so a ping's logs join up with the request that triggered it,
and returned in the error envelope so a user can quote it.

**Metrics** (`/metrics`, Prometheus text, internal only):

| Metric | Type | Why |
|---|---|---|
| `http_request_duration_seconds` | histogram | NFR-1 |
| `cache_requests_total{result}` | counter | NFR-2, hit ratio |
| `cache_rebuild_duration_seconds` | histogram | is the miss path getting slow? |
| `ratelimit_rejections_total{bucket}` | counter | abuse, or a limit set too low |
| `ping_checks_total{result}` | counter | engine liveness |
| `ping_duration_seconds{component}` | histogram | the product's own data |
| `queue_depth{queue,state}` | gauge | backlog alert |
| `metrics_stream_length` | gauge | is the flusher keeping up? |
| `flush_batch_size` / `flush_lag_seconds` | histogram | write-behind health |
| `mongo_writes_total{collection}` | counter | proves NFR-4 |

**Alerts** (the short list worth waking someone for): stream length >
100k · queue waiting > 500 for 5 min · no completed ping job in 5 min ·
cache hit ratio < 80 % for 10 min · public 5xx rate > 1 % · `/readyz`
failing on > 1 pod.

**Health.** `/healthz` = the process is alive (no dependency checks — a
liveness probe that checks the database restarts the app when the
database blinks). `/readyz` = Mongo and Redis both answered a ping within
1 s. Kubernetes drains a pod that fails readiness without killing it.

---

## 10. Testing strategy

### 10.1 Unit

Pure logic, no I/O: the hysteresis state machine (every transition, in
both directions, including the reset-on-recovery edge), status
aggregation (`worst-of` with every combination of component states and
incident impacts), uptime math (empty buckets, single sample, partial
hour), SSRF URL validation (a table of ~40 hostile URLs), ETag
generation.

### 10.2 Integration — against real Redis and real Mongo

`testcontainers` (or docker-compose services in CI). **Not `ioredis-mock`:**
the two hardest pieces of this system are Lua scripts and consumer
groups, and a mock either doesn't implement them or implements them
differently, which means the test passes and production doesn't.

Cases that must exist:

- Cache-aside: miss populates, hit skips Mongo (assert with a spy), `DEL` forces a rebuild.
- **Stampede: 200 concurrent requests against a cold key produce exactly one Mongo query** (NFR-3).
- Rate limiter: the *N*+1th request in a window is rejected; one request older than the window slides out and admits a new one; the boundary case that a fixed window would wrongly allow is rejected.
- Limiter concurrency: 50 parallel requests with a limit of 10 admit exactly 10 — the test that fails if the Lua script is ever "optimised" into separate calls.
- Refresh rotation: old token rejected after use; replay revokes the family.
- Flusher: crash-and-redeliver produces the same rollup totals (the idempotency guard).
- Invalidation ordering: a write followed by an immediate read never returns pre-write data.

### 10.3 Contract

Snapshot of the public payload against a fully-populated fixture, plus an
assertion that it contains no ObjectId, no `targetUrl`, no
`passwordHash`, and no internal component (NFR-8). This test is the one
that catches a well-meaning `res.json(component)` in a future PR.

### 10.4 Load

k6 against a seeded 50-component org:
- 2,000 rps on `/api/v1/status` for 5 min → p99 < 50 ms, error rate 0, and **zero Mongo queries after the first**.
- The same with the cache disabled, to measure and document what the cache is actually buying.
- 500 components on a 60 s interval → the sweep completes inside its window and `queue_depth` returns to 0 each cycle.

### 10.5 Chaos

Scripted, run before release: kill Redis mid-load (expect degraded reads,
no 5xx flood) · kill Mongo mid-load (expect stale payloads with
`"stale": true`) · kill the flusher mid-batch (expect no double-counted
rollups) · point a component at a tarpit server that never responds
(expect a bounded worker, not a hung queue).

### 10.6 Tooling

`vitest` + `supertest`, coverage gate 80 % on `services/` and
`middleware/` (the places where bugs are expensive) and no gate on
controllers. CI: lint → typecheck → unit → integration → build.

---

## 11. Repository layout

The brief's structure, with the gaps from §2.4 filled in. Additions and
changes are marked.

```text
statpulse-backend/
├── src/
│   ├── config/
│   │   ├── env.ts                  # + zod-validated env, fails fast at boot
│   │   ├── db.ts                   #   mongoose connection + timeouts
│   │   └── redis.ts                #   ioredis singletons: app, subscriber, bullmq
│   ├── controllers/
│   │   ├── auth.controller.ts
│   │   ├── status.controller.ts
│   │   ├── incident.controller.ts
│   │   ├── component.controller.ts # + admin CRUD (gap #4)
│   │   └── subscriber.controller.ts# + v1.5 (gap #6)
│   ├── middleware/
│   │   ├── auth.middleware.ts      #   JWT verify + RBAC
│   │   ├── cache.middleware.ts     #   cache-aside + ETag
│   │   ├── rateLimiter.ts          #   ZSET sliding window
│   │   ├── tenant.ts               # + resolve org from Host / JWT (gap #3)
│   │   ├── validate.ts             # + zod boundary
│   │   ├── requestContext.ts       # + requestId + AsyncLocalStorage
│   │   └── errorHandler.ts         # + the one place errors become responses
│   ├── models/
│   │   ├── Organization.ts         # + (gap #3)
│   │   ├── User.ts
│   │   ├── Component.ts
│   │   ├── Incident.ts
│   │   ├── PingSample.ts           # + time-series
│   │   ├── UptimeRollup.ts         # +
│   │   └── Subscriber.ts           # + v1.5
│   ├── queues/
│   │   ├── index.ts                # + queue registry + graceful shutdown
│   │   ├── ping.worker.ts          #   the check
│   │   ├── ping.scheduler.ts       # + the 60 s fan-out (§5.3.1)
│   │   ├── flush.worker.ts         # + write-behind drain (gap #7)
│   │   └── notify.worker.ts        # + v1.5
│   ├── routes/
│   │   ├── auth.routes.ts
│   │   ├── status.routes.ts
│   │   ├── incident.routes.ts
│   │   ├── admin.routes.ts         # +
│   │   └── internal.routes.ts      # + healthz / readyz / metrics
│   ├── services/
│   │   ├── ping.service.ts         #   HTTP check execution
│   │   ├── status.service.ts       # + payload composition + aggregation
│   │   ├── cache.service.ts        # + get/rebuild/invalidate, single-flight
│   │   ├── metrics.service.ts      # + XADD, flush, rollups
│   │   ├── token.service.ts        # + issue/rotate/revoke
│   │   └── incident.service.ts     # +
│   ├── lib/
│   │   ├── ssrfGuard.ts            # + §7.2 — the highest-risk file in the repo
│   │   ├── lua/                    # + rateLimit.lua, releaseLock.lua
│   │   ├── logger.ts               # + pino with redaction
│   │   └── errors.ts               # + AppError taxonomy
│   ├── types/
│   ├── app.ts                      #   express wiring, exported un-listened for tests
│   ├── server.ts                   # + listen + graceful shutdown
│   └── worker.ts                   # + the worker process entry point
├── tests/
│   ├── unit/  integration/  contract/  load/
├── scripts/
│   ├── seed.ts                     # + org + admin + demo components
│   └── rollup-daily.ts             # + nightly aggregation (§5.4.5)
├── .env.example
├── docker-compose.yml              #   mongo + redis (+ a tarpit target for tests)
├── Dockerfile
├── tsconfig.json  eslint.config.js  .prettierrc
└── package.json
```

Two structural notes:

- `app.ts` exports the Express app without calling `listen`; `server.ts`
  listens. This is what lets `supertest` drive the whole stack in-process
  without binding a port or leaking a handle between test files.
- `worker.ts` is a separate entry point sharing `src/`, not a separate
  package. One build, one image, `CMD` selects the role.

---

## 12. Configuration

Every variable is validated by zod at boot and the process **exits** on a
bad config rather than discovering it on the first request.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `PORT` | `4000` | |
| `MONGO_URI` | — | required |
| `REDIS_URL` | — | required |
| `JWT_SECRET` | — | required, ≥ 32 bytes; boot fails on the example value |
| `JWT_ACCESS_TTL` | `15m` | |
| `REFRESH_TTL_DAYS` | `30` | |
| `COOKIE_DOMAIN` | — | |
| `CORS_ORIGINS` | — | comma-separated allowlist |
| `TRUST_PROXY` | `1` | must match the real proxy count (§5.2.4) |
| `STATUS_CACHE_TTL_SEC` | `60` | |
| `STATUS_STALE_TTL_SEC` | `600` | |
| `PING_DEFAULT_INTERVAL_SEC` | `60` | |
| `PING_CONCURRENCY` | `20` | |
| `PING_TIMEOUT_MS` | `5000` | per-component override |
| `FLUSH_INTERVAL_MS` | `600000` | 10 min |
| `FLUSH_BATCH_SIZE` | `5000` | |
| `METRICS_STREAM_MAXLEN` | `200000` | |
| `SAMPLE_RETENTION_DAYS` | `90` | |
| `SELF_HOSTED_ALLOW_PRIVATE` | `false` | SSRF escape hatch (§7.2) |
| `SMTP_*` / `EMAIL_PROVIDER_KEY` | — | v1.5 |

---

## 13. Delivery plan

Sequenced so that something demonstrable exists after every phase, and so
that the riskiest pieces (Lua atomicity, the flusher's idempotency, SSRF)
are proven early rather than discovered during hardening. Estimates
assume one developer; they are relative sizes, not commitments.

### Phase 0 — Foundation (~1 day)

TypeScript strict, ESLint/Prettier, `docker-compose` with Mongo + Redis,
env validation, pino + requestId, error handler, `/healthz` + `/readyz`,
graceful shutdown (SIGTERM drains the server, closes queues, then
connections), CI pipeline.

**Done when:** `docker compose up && npm run dev` serves `/readyz` → 200
with both dependencies connected, and CI is green on an empty test suite.

### Phase 1 — Data and tenancy (~1 day)

All seven models with indexes, the `Organization`/tenant middleware, the
seed script, and index creation verified against a real Mongo.

**Done when:** `npm run seed` creates an org, an owner, and five demo
components; `db.components.getIndexes()` matches §4.3; every repository
function requires an `orgId` argument.

### Phase 2 — Auth (~2 days)

Register (first-user-only), login, refresh with rotation, logout, `/me`,
session listing and revocation, RBAC middleware, argon2, the Redis
session structures.

**Done when:** the full happy path works end to end; an access token is
rejected 15 minutes later; a rotated refresh token is rejected on replay
and revokes the family; `SREM` on logout takes effect on the very next
request; timing on login is indistinguishable between an unknown email
and a wrong password.

### Phase 3 — Public read path + cache-aside (~1.5 days)

`status.service` composing the payload, `cache.service` with
single-flight and the stale copy, ETag/304, `GET /api/v1/status` and
`/api/v1/incidents`, the contract test.

**Done when:** NFR-1, NFR-2 and **NFR-3** pass — in particular, the
200-concurrent-miss test shows exactly one Mongo query — and a
`docker stop mongo` still yields a payload with `"stale": true`.

### Phase 4 — Ping engine (~2 days)

BullMQ wiring, the scheduler fan-out with jitter and deterministic
jobIds, `ping.service` with timing and error classification, the
**SSRF guard**, the hysteresis state machine, transition writes and cache
invalidation.

**Done when:** five demo components are checked every 60 ± 10 s; a
component pointed at a deliberately-broken URL goes `DOWN` after exactly
three failures and not before; recovery takes two successes; the SSRF
table test passes including the DNS-rebinding case; the public page
reflects a transition within one cache TTL.

*Highest-risk phase.* Write the SSRF guard and its hostile-URL table
first, before anything calls it.

### Phase 5 — Write-behind metrics and uptime (~2 days)

`XADD` from the ping worker, the flush worker with consumer groups and
`XAUTOCLAIM`, `PingSample` with its TTL index, `UptimeRollup` with the
watermark guard, uptime in the public payload, the nightly daily-rollup
script.

**Done when:** NFR-4 holds — a 30-minute soak with 50 components produces
≤ 3 `bulkWrite` calls and zero per-check writes — and the
kill-the-flusher-mid-batch test produces identical rollup totals on
restart.

### Phase 6 — Incidents and admin CRUD (~1.5 days)

Component CRUD with soft delete and pause, incident create/update/resolve
with timeline append, "check now", invalidation wired through the service
layer, admin listing endpoints.

**Done when:** declaring a critical incident flips the public overall
status to `MAJOR_OUTAGE` on the next read even with every component
green; resolving it stamps `resolvedAt` and drops it out of
`activeIncidents`; deleting a component keeps its samples.

### Phase 7 — Rate limiting and hardening (~1.5 days)

The Lua limiter, all six buckets, headers, `trust proxy` assertion,
helmet/CORS, the security review of §7.

**Done when:** the 50-parallel-requests-limit-10 concurrency test passes,
the fixed-window boundary case is rejected, Redis being down fails open
on public routes and closed on admin writes, and `TRUST_PROXY`
misconfiguration is caught by a test rather than by production.

### Phase 8 — Observability, load, release (~1 day)

Prometheus metrics, alert definitions, the k6 suite, the chaos scripts,
README + runbook.

**Done when:** every NFR in §2.2 has a passing check, and the chaos
scenarios in §10.5 produce the documented degraded behaviour rather than
a 5xx flood.

### Post-v1 backlog

SSE (§5.7) · subscribers and notifications (§5.8) · scheduled maintenance
windows · component dependency graphs (a down database implies a degraded
API) · a real admin dashboard · multi-tenant custom domains with
automated TLS · SLA export.

### Critical path

```
P0 ─► P1 ─► P2 ─────────────────► P6 ─► P7 ─► P8
       └──► P3 ──────────────┐     ▲
       └──► P4 ─► P5 ────────┴─────┘
```

P3 and P4 are independent after P1 and can be parallelised across two
people. P6 needs both (it invalidates the cache and touches component
state); P7 needs the routes to exist.

---

## 14. Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **SSRF via `targetUrl`** | Critical — credential theft from cloud metadata, internal port scanning | Medium without a guard | §7.2, written first, hostile-URL table test; network isolation of the worker as the durable fix |
| Redis is a single point of failure for five subsystems | High — sessions, queue, and buffer all lost together | Low-Medium | AOF `everysec`, no LRU eviction on the shared instance, per-subsystem degradation (§8), managed HA when it justifies the cost |
| Flusher double-counting on redelivery | Medium — uptime numbers quietly wrong, and uptime numbers end up in contracts | Medium if unguarded | Watermark guard + idempotent `_id`, tested by killing it mid-batch |
| `trust proxy` misconfigured at deploy | High — the rate limiter is either useless or a self-DoS | **High** (the single most common deployment mistake here) | Asserted in a test; logged at boot with the resolved client IP of the first request |
| Status page goes down with the service it reports on | Critical to the product's whole premise | Low | Stale cache (§5.1.3), degradation matrix (§8), chaos tests, and — ultimately — hosting the page somewhere with no shared failure domain with the monitored infrastructure |
| Cache invalidation misses leave a stale page during an outage | High — the worst possible time to be wrong | Medium | `DEL` after commit, TTL as a correctness backstop, `updatedAt` shown on the page |
| Notification storms during a long incident | Medium — subscribers unsubscribe exactly when they most need the updates | Medium | Suppression windows, idempotency keys (§5.8) |
| Scope creep into a full status-page SaaS (themes, custom domains, SSO) | Medium — v1 never ships | Medium | §2.3 is a contract; the backlog is where these live |

---

## 15. Decisions taken and questions open

### Taken in this plan **[DECISION]**

1. TypeScript, strict. 2. Everything under `/api/v1`. 3. `Organization`
from day one, one seeded org. 4. Refresh tokens are opaque, not JWTs.
5. Redis Streams, not lists, for the metrics buffer. 6. Polling with
ETag in v1; SSE in v1.5. 7. Registration open for the first user only.
8. One Redis instance with AOF for v1, no eviction policy.
9. MongoDB is the source of truth for state transitions; Redis holds
everything derived, cached, or statistical.

### Needing an answer **[OPEN]**

1. **Tenancy.** One org per deployment, or several behind one API? The
   model carries `orgId` either way, but it decides whether the `Host`
   header routes tenants and whether custom domains + TLS are in scope.
2. **Where the dashboard is served.** Same origin as the API, or separate?
   This decides `SameSite` on the refresh cookie and whether a CSRF token
   is mandatory (§5.5.4).
3. **Notifications in v1, or v1.5?** The rate limiter that protects them
   is already v1. Email delivery adds a provider dependency, double
   opt-in, bounce handling, and unsubscribe compliance — roughly two more
   days.
4. **Does `DEGRADED` count as up in the uptime percentage?** A product
   decision that changes the number customers quote in renewals (§5.6).
5. **Deployment target** (single VPS with compose / a PaaS / Kubernetes)?
   It changes the `trust proxy` value, the readiness probe wiring, and
   whether the flusher's singleton guarantee comes from the platform or
   from the Redis lock.
6. **Data retention** — is 90 days raw / 13 months rolled up the right
   trade, or does an SLA commitment require longer?
