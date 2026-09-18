# StatPulse

**A status page: the page a company puts up to tell its customers "yes,
we know it's broken, and here's what we're doing about it."**

You have almost certainly seen one. When Slack goes down, everybody opens
`status.slack.com`. When a bank's app stops working, its status page is
the thing that says whether it's them or you.

This is a complete, working one — the page customers read, the dashboard
staff use, and the machinery underneath that checks whether things are
actually up.

---

## Table of contents

1. [The problem this solves](#1-the-problem-this-solves)
2. [What it actually does](#2-what-it-actually-does)
3. [Try it in five minutes](#3-try-it-in-five-minutes)
4. [The tech stack, and why each piece](#4-the-tech-stack-and-why-each-piece)
5. [How it all fits together](#5-how-it-all-fits-together)
6. [The five hard problems](#6-the-five-hard-problems)
7. [Full installation guide](#7-full-installation-guide)
8. [Project structure](#8-project-structure)
9. [API reference](#9-api-reference)
10. [Configuration](#10-configuration)
11. [Testing](#11-testing)
12. [Deployment](#12-deployment)
13. [What is deliberately not built](#13-what-is-deliberately-not-built)

---

## 1. The problem this solves

### The situation

Imagine you run an online shop. One morning, payments stop working.

Within ten minutes:

- Customers start emailing you.
- Then they start tweeting at you.
- Your support inbox has 400 messages, all asking the same question.
- Your engineers are trying to fix it, but they keep getting pulled away
  to answer "is it fixed yet?"

What you needed was **one page** that says: _"Payments are down. We know.
We're working on it. Updates every 30 minutes."_ One page, so nobody has
to ask.

### The catch that makes this interesting

Here is the part that turns a simple idea into a real engineering
problem.

**The status page gets the most traffic at exactly the moment your
systems are least able to handle it.**

Normally maybe 5 people a day look at it. During an outage, _thousands of
people per second_ hammer it, refreshing over and over. And they're doing
that while your servers are already struggling — because something is
already broken. That's why they're there.

So a naive status page does this:

```
Outage starts
  → thousands of people refresh the page
  → each refresh asks the database "what's the status?"
  → the database, already unhealthy, collapses under the extra load
  → the status page goes down too
  → now nobody knows anything
```

**A status page that dies alongside the thing it's reporting on is worse
than having no status page at all** — because it destroys trust at the
exact moment trust is the only thing you have left.

Every significant design decision in this project exists to prevent that.

---

## 2. What it actually does

### For the public (no login needed)

| What                 | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| **Status page**      | One screen: is everything working? Green, amber, or red.              |
| **Component detail** | Click any service to see 90 days of uptime, drawn as one bar per day. |
| **Incident history** | Every problem ever declared, with the full timeline of updates.       |

### For staff (login required)

| What                  | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| **Dashboard**         | Live overview — how many services are up, down, average response time. |
| **Manage services**   | Add a URL to monitor, edit it, pause it, or check it right now.        |
| **Declare incidents** | Write what's wrong. It appears on the public page immediately.         |
| **Post updates**      | Add to an incident's timeline as things develop. Mark it resolved.     |
| **Invite colleagues** | Two roles: admins run the service, owners also manage people.          |
| **Manage sessions**   | See every device you're signed in on. Revoke any of them instantly.    |

### The monitoring, running in the background

Every 60 seconds, a background process visits every URL you've registered
and records: did it answer? How fast? What status code?

It's a real HTTP request to a real server. Nothing here is simulated.

---

## 3. Try it in five minutes

**Prerequisites:** Node.js 20+, and either Docker (easiest) or your own
MongoDB and Redis.

```bash
git clone https://github.com/0xAnirudh/StatPulse.git
cd StatPulse
npm install

docker compose up -d        # starts MongoDB + Redis
cp .env.example .env        # then edit JWT_SECRET, see below

npm run seed                # creates an admin + 5 demo services
npm run build               # builds the frontend
npm run dev                 # starts everything
```

Open **http://localhost:4000**

Sign in with the email and password that `npm run seed` printed.

> **Full step-by-step guide with troubleshooting: [section 7](#7-full-installation-guide).**

### What you'll see

The seed adds five real services to monitor — GitHub's API, example.com,
MDN, Cloudflare, and one endpoint that **deliberately always fails** so
you can watch the system detect an outage and report it.

Give it three minutes and that last one turns red on its own.

---

## 4. The tech stack, and why each piece

### The short version

| Layer                  | Technology              | Version   |
| ---------------------- | ----------------------- | --------- |
| Language               | JavaScript (ES modules) | Node 20+  |
| Web server             | Express                 | 5.2       |
| Database               | MongoDB via Mongoose    | 9.10      |
| Cache, queue, counters | Redis via ioredis       | 6.0       |
| Background jobs        | BullMQ                  | 6.3       |
| Frontend               | React + React Router    | 19.3      |
| Build tool             | Vite                    | 8.3       |
| Validation             | Zod                     | 4.6       |
| Auth                   | jsonwebtoken + bcrypt   | 9.0 / 6.0 |
| HTTP checks            | Axios                   | 1.20      |
| Testing                | Vitest + Supertest      | 5.0       |

No UI component library. No CSS framework. No ORM beyond Mongoose.

### Why each one — in plain language

**MongoDB — the filing cabinet.**
Permanent storage. Accounts, the list of services, incidents, historical
uptime. Slow-ish, but nothing is ever lost. This is the _source of
truth_: if Mongo says a service is down, it's down.

**Redis — the sticky note on the monitor.**
An in-memory store. Thousands of times faster than a database, but it
lives in RAM, so a restart can lose recent data. Perfect for things you
need _instantly_ and could rebuild if lost.

Redis does five separate jobs here:

1. **Cache** — holds the ready-made status page so reads never touch Mongo
2. **Rate limiting** — counts requests per visitor to block abuse
3. **Sessions** — the list of valid login sessions, so logout is instant
4. **Job queue** — the to-do list of health checks waiting to run
5. **Metrics buffer** — collects check results to be saved in batches

**BullMQ — the task scheduler.**
Runs jobs in the background on a timer. "Check every service, every 60
seconds" is a BullMQ job. It uses Redis to keep track of what's pending.

**Express — the waiter.**
Takes requests from browsers and returns answers.

**React + Vite — the frontend.**
React builds the interface; Vite compiles it. Chosen because the admin
dashboard has genuine interactive state — forms, modals, live-updating
lists — which is painful in plain HTML and natural in React.

**Zod — the bouncer.**
Checks every incoming request before your code touches it. If someone
sends `timeoutMs: "banana"`, Zod rejects it at the door with a clear
message rather than letting it cause a confusing crash later.

**Vitest + Supertest — the test suite.**
211 automated tests across 16 files. Supertest drives the real API
in-process without needing a server running.

---

## 5. How it all fits together

### Three separate programs

This is **not** one app. It's three programs that share a codebase and
talk through Redis and MongoDB.

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   Visitors ──────►  ┌────────────────────┐                   │
│   (thousands)       │    1. API          │                   │
│                     │    Express :4000   │                   │
│   Staff ──────────► │    serves the UI   │                   │
│                     └─────┬──────────┬───┘                   │
│                           │          │                       │
│              ┌────────────▼──┐  ┌────▼─────────┐             │
│              │    Redis      │  │   MongoDB    │             │
│              │  fast, in RAM │  │  permanent   │             │
│              └──▲─────────▲──┘  └───▲──────▲───┘             │
│                 │         │         │      │                 │
│        ┌────────┴──┐   ┌──┴─────────┴──┐   │                 │
│        │ 2. Checker│   │  3. Flusher   │───┘                 │
│        │ every 60s │   │  every 10 min │                     │
│        └─────┬─────┘   └───────────────┘                     │
│              │                                               │
│              ▼                                               │
│     the URLs being monitored                                 │
│     (github.com, your API, ...)                              │
└──────────────────────────────────────────────────────────────┘
```

**1. The API** — answers browsers. Must be fast, always.

**2. The Checker** — visits every monitored URL every 60 seconds.

**3. The Flusher** — every 10 minutes, takes the pile of check results
out of Redis and writes them to MongoDB in one batch.

### Why split them up?

Checking 200 URLs means 200 network requests, each potentially waiting up
to 5 seconds for a reply. If that happened inside the API, those 200
slow operations would be competing with visitors for the same CPU — and
they'd be _slowest_ during an outage, when every monitored service is
timing out and traffic is at its peak. Exactly the wrong moment.

Kept separate, the checker can be slow, crash, or be restarted, and the
status page never notices.

### What happens when someone loads the status page

```
Browser asks for the status
        │
        ├── Has the browser already got the latest version?  ──► Yes: "304 Not Modified"
        │   (checked using an ETag — a fingerprint of the content)   Nothing sent. Done.
        │
        ├── Is a ready-made copy in Redis?  ──► Yes: send it. ~2 milliseconds. Done.
        │
        └── No copy in Redis:
              ├── Try to claim the "I'll rebuild it" lock
              │     ├── Got it:  ask MongoDB, build the page, save to Redis, send it
              │     └── Didn't:  someone else is already rebuilding.
              │                  Send them the slightly-old copy instead of making them wait.
              └── Done
```

The important line is the last one. **However many people hit the page at
once, MongoDB is asked exactly once.** Everyone else gets served from
Redis. This is tested with 200 simultaneous requests.

### What happens when a check runs

```
Every 60 seconds:
  └── enqueue one job per service
        (spread randomly over 15 seconds so they don't all fire at once)

Each job:
  ├── Safety-check the URL (see section 6.4)
  ├── Make the HTTP request, max 5 seconds
  ├── Record the result in Redis
  └── Has the status actually changed?
        ├── No  (99.9% of the time) → write nothing to the database
        └── Yes → update MongoDB, clear the cache, announce it
```

That "write nothing" line saves roughly **72,000 database writes per
day**. See section 6.3.

---

## 6. The five hard problems

This is the part worth reading if you want to know what's actually
engineered here.

### 6.1 Stopping the page from killing the database

**The problem.** Caching alone doesn't fix the outage stampede. Caches
expire. When one expires during an outage, _every_ waiting request misses
at the same instant and they all rush the database together. The cache
made it worse by synchronising them.

**The fix.** When the cache is empty, requests race for a lock. Exactly
one wins and rebuilds. Everyone else is immediately handed the _previous_
copy — up to ten minutes old, and clearly labelled as such.

```
200 people refresh at once  →  1 database query
```

That's an automated test, not a claim.

**The honesty bit.** When the page serves an old copy, it _says so_:
"showing cached data". A status page quietly showing stale information is
worse than one admitting it's struggling.

### 6.2 Not crying wolf

**The problem.** A single failed check means almost nothing. A dropped
packet, a server restarting, a momentary hiccup — all produce one failed
check from a perfectly healthy service. If the page screams "DOWN!" every
time, people learn to ignore it. Then it's useless during a real outage.

**The fix.** A service must fail **3 checks in a row** before it's
declared down, and succeed **2 in a row** to recover.

The numbers are deliberately lopsided. Declaring an outage is a serious
claim that needs evidence; declaring recovery needs less, because being a
minute slow to say "we're back" costs far less than being wrong about an
outage.

Real example — twelve checks through a bad deployment:

```
✓ ✓ ✗ ✗ ✗ ✗ ✗ ✓ ✓ ✓ ✓ ✓
      └── declared DOWN here (3rd failure)
                      └── declared UP here (2nd success)
```

**Two** status changes, not twelve. A brief blip produces none at all.

### 6.3 Not writing 72,000 records a day

**The problem.** 50 services checked every minute = 72,000 results per
day. Writing each one to MongoDB the moment it happens means a constant
drip of database writes forever, competing with the reads that matter.

**The fix.** Results go into a **Redis Stream** (a fast in-memory log).
Every 10 minutes, the Flusher scoops up everything and writes it to
MongoDB in one batch.

```
72,000 individual writes/day  →  144 batch writes/day
```

**The subtle part.** Redis Streams guarantee "at-least-once" delivery —
if the Flusher crashes between writing and confirming, it gets the same
batch again on restart. Naively re-adding those numbers would **double
your uptime statistics**, and uptime numbers end up in customer contracts.

Two different defences:

- **Individual results** are stored using the Redis message ID as their
  database key. A duplicate simply collides and is skipped.
- **Running totals** can't use that trick (adding twice is just wrong),
  so each total records the highest message ID it has already counted.
  A replay is recognised and ignored.

Tested by deliberately forcing a replay and confirming the totals don't
move.

**The honest trade-off:** if Redis dies uncleanly, up to 10 minutes of
_statistics_ are lost. That's acceptable — they're for charts. Status
_changes_ are written to MongoDB immediately, because those you can't
afford to lose.

### 6.4 Not becoming an attack tool

**The problem, and it's a serious one.** An admin types a URL and this
server fetches it — from inside the production network, every 60 seconds,
forever.

Without protection, someone could enter `http://169.254.169.254/` — a
special address that, on AWS/Google/Azure servers, **hands out cloud
credentials to anything that asks from inside**. Your status page would
cheerfully fetch them.

This attack has a name: **SSRF** (Server-Side Request Forgery).

**The defence, in layers:**

1. Only `http` and `https`. No `file://`, no `gopher://`.
2. No usernames or passwords embedded in the URL.
3. Blocked ports — SSH, databases, mail. No health check runs there.
4. **Blocked address ranges** — private networks (`10.x`, `192.168.x`),
   loopback (`127.0.0.1`), and the cloud metadata address.
5. **Every redirect is re-checked.** A harmless URL that redirects to
   `169.254.169.254` is caught at the second hop.
6. **The clever one:** it connects to the _exact IP address it checked_.

Why #6 matters: normally you'd validate a hostname, then hand that
hostname to the HTTP library, which looks it up _again_. An attacker
controlling that DNS record can answer "safe public address" for the
check and "cloud metadata address" a millisecond later for the actual
fetch. Nothing in the validation was wrong — it validated a different
answer than the one used. This defeats most hand-written SSRF filters.

**55 automated tests** cover this, including that DNS trick.

When you type a blocked URL into the UI, you get this under the field:

> _169.254.169.254 is not a permitted address_

### 6.5 Rate limiting that actually works

**The problem.** The naive approach — "count requests, reset the counter
every minute" — has a hole. Someone can send a full minute's worth at
11:59:59 and another full minute's worth at 12:00:01. Double the intended
rate, delivered as one burst.

Worse: if you write the "check the count, then increase it" logic in
JavaScript, 50 simultaneous requests all read the same count, all see
room, and all get through.

**The fix.** A **sliding window** — remembering the timestamp of every
recent request, and counting how many fall inside the last 60 seconds.
No boundary to exploit.

And it runs as a **Lua script inside Redis**, so all four steps (clean
up, count, decide, record) happen as one indivisible operation. Nothing
can slip between them.

```
50 simultaneous requests, limit of 10  →  exactly 10 allowed
```

That test fails immediately if anyone ever "simplifies" the Lua script
back into separate commands.

**One more decision worth explaining:** if Redis is unreachable, public
requests are **allowed through** rather than blocked. Rate limiting
protects against abuse; refusing everyone because the anti-abuse system
is offline would turn a small problem into a total outage — on a status
page, going dark during someone else's incident. Admin writes fail the
other way (blocked), because the risk there is different.

---

## 7. Full installation guide

### Step 1 — Install Node.js

You need **version 20 or newer**. Check:

```bash
node --version
```

If it's missing or older, get it from [nodejs.org](https://nodejs.org).

### Step 2 — Get the code

```bash
git clone https://github.com/0xAnirudh/StatPulse.git
cd StatPulse
npm install
```

`npm install` reads the project's shopping list and downloads every
library. Takes a minute or two.

### Step 3 — Get MongoDB and Redis running

**Option A — Docker (recommended).** One command starts both:

```bash
docker compose up -d
```

Check they're alive:

```bash
docker ps
```

**Option B — MongoDB Atlas (free cloud database) + local Redis.**

1. Sign up at [mongodb.com/atlas](https://www.mongodb.com/atlas), create
   a free cluster.
2. **Network Access → Add IP Address → add your current IP.** Skipping
   this is the single most common setup failure; you'll get _"Could not
   connect to any servers in your MongoDB Atlas cluster."_
3. Copy the connection string.
4. Install Redis locally: `brew install redis && brew services start redis`
   on macOS.

### Step 4 — Configure

```bash
cp .env.example .env
```

Open `.env` and set two things:

```bash
# Generate a real secret — do not skip this:
#   openssl rand -hex 32
JWT_SECRET=paste-the-generated-value-here

# If using Atlas, paste your connection string:
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/
```

Every other value has a sensible default. [Full list in section 10.](#10-configuration)

> `.env` holds passwords and is **never** committed to git — it's listed
> in `.gitignore`.

### Step 5 — Create the first account and demo data

```bash
npm run seed
```

It prints the login it created:

```
sign in with  admin@statpulse.local / development-password
```

### Step 6 — Build the frontend

```bash
npm run build
```

### Step 7 — Run it

```bash
npm run dev
```

This starts all three programs at once, colour-coded in your terminal.

Open **http://localhost:4000**.

### Troubleshooting

| Symptom                                                            | Cause and fix                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `EADDRINUSE :4000`                                                 | Something else owns port 4000. Set `PORT=4010` in `.env`.                   |
| _"Could not connect to any servers in your MongoDB Atlas cluster"_ | Your IP isn't on the Atlas allow-list. Step 3, Option B, point 2.           |
| `ECONNREFUSED 127.0.0.1:6379`                                      | Redis isn't running. `docker compose up -d` or `brew services start redis`. |
| Page loads but says "Could not reach the status service"           | The API isn't running. Check the `api` lines in your terminal.              |
| Everything works but nothing ever turns green/red                  | The checker isn't running. Look for `worker running` in the terminal.       |
| Blank page at localhost:4000                                       | You skipped `npm run build`.                                                |

### Useful commands

```bash
npm run dev        # run everything (api + checker + frontend hot-reload)
npm run build      # compile the frontend
npm run seed       # create admin + demo services (safe to re-run)
npm test           # run all 211 tests
npm run lint       # check code style
npm run loadtest   # measure performance, and fail if it's too slow
```

---

## 8. Project structure

Five packages in one repository. Each has one clear job.

```
StatPulse/
│
├── packages/
│   │
│   ├── shared/          Pure logic. No database, no network, no clock.
│   │   └── src/
│   │       ├── constants.js   the vocabulary (statuses, impacts)
│   │       ├── status.js      working out the overall status
│   │       ├── health.js      the 3-strikes rule
│   │       └── uptime.js      percentage maths
│   │
│   ├── core/            Shared plumbing used by every program.
│   │   └── src/
│   │       ├── config.js      reads and validates .env
│   │       ├── log.js         structured logging, secrets redacted
│   │       ├── db/mongo.js    MongoDB connection
│   │       ├── redis/         Redis connection, key names, Lua loader
│   │       ├── lua/           the atomic scripts
│   │       ├── models/        the six database schemas
│   │       └── util/ssrf.js   the URL safety guard
│   │
│   ├── api/             Program 1 — the web server.
│   │   └── src/
│   │       ├── app.js         Express setup
│   │       ├── server.js      starts listening
│   │       ├── routes/        URL → handler
│   │       ├── middleware/    auth, validation, rate limiting
│   │       └── services/      the actual logic
│   │
│   ├── jobs/            Programs 2 and 3 — checker and flusher.
│   │   └── src/
│   │       ├── worker.js         entry point
│   │       ├── ping.service.js   makes one HTTP check
│   │       ├── ping.worker.js    decides what a result means
│   │       └── flush.worker.js   batches results into MongoDB
│   │
│   └── web/             The React frontend.
│       └── src/
│           ├── pages/         one file per screen
│           ├── components/    reusable bits
│           └── lib/           API client, auth, formatting
│
├── tests/               211 tests across 16 files
├── docs/architecture.md decisions and why they were made
├── plan.md              the original design document
└── docker-compose.yml   MongoDB + Redis for local development
```

### Why `shared` has no dependencies

The logic worth testing hardest — "is this service down?", "what's the
uptime?" — needs no database, no network, and no clock. Keeping it
dependency-free means those tests run in under a second and can cover
every edge case directly.

---

## 9. API reference

21 endpoints. Everything is under `/api/v1`.

### Public — no authentication

| Method | Path                              | Returns                             |
| ------ | --------------------------------- | ----------------------------------- |
| `GET`  | `/api/v1/status`                  | The whole status page. **Cached.**  |
| `GET`  | `/api/v1/status/components/:slug` | One service + 90 days of history    |
| `GET`  | `/api/v1/incidents`               | Incident list, paginated            |
| `GET`  | `/api/v1/incidents/:slug`         | One incident with its full timeline |

### Authentication

| Method   | Path                         | Purpose                         |
| -------- | ---------------------------- | ------------------------------- |
| `POST`   | `/api/v1/auth/register`      | First account only, then closed |
| `POST`   | `/api/v1/auth/login`         | Sign in                         |
| `POST`   | `/api/v1/auth/refresh`       | Silently renew an expired token |
| `POST`   | `/api/v1/auth/logout`        | Sign out                        |
| `POST`   | `/api/v1/auth/accept-invite` | Redeem an invitation            |
| `GET`    | `/api/v1/auth/me`            | Who am I?                       |
| `GET`    | `/api/v1/auth/sessions`      | List my signed-in devices       |
| `DELETE` | `/api/v1/auth/sessions/:id`  | Revoke one device               |

### Admin — requires a token

| Method   | Path                                   | Purpose                              |
| -------- | -------------------------------------- | ------------------------------------ |
| `GET`    | `/api/v1/admin/components`             | List all services                    |
| `POST`   | `/api/v1/admin/components`             | Add one                              |
| `PATCH`  | `/api/v1/admin/components/:slug`       | Edit one                             |
| `DELETE` | `/api/v1/admin/components/:slug`       | Remove one (history kept)            |
| `POST`   | `/api/v1/admin/components/:slug/check` | Check it right now                   |
| `GET`    | `/api/v1/admin/incidents`              | List incidents                       |
| `POST`   | `/api/v1/admin/incidents`              | Declare one                          |
| `PATCH`  | `/api/v1/admin/incidents/:slug`        | Post an update / resolve             |
| `GET`    | `/api/v1/admin/users`                  | List the team _(owner only)_         |
| `POST`   | `/api/v1/admin/users/invite`           | Invite someone _(owner only)_        |
| `PATCH`  | `/api/v1/admin/users/:id`              | Change role / disable _(owner only)_ |

### Internal

| Method | Path           | Purpose                                         |
| ------ | -------------- | ----------------------------------------------- |
| `GET`  | `/health/live` | Is the process alive? Never touches a database. |
| `GET`  | `/health`      | Are both databases reachable?                   |
| `GET`  | `/metrics`     | Prometheus statistics                           |

### How errors look

Always the same shape, so client code can rely on it:

```json
{
  "error": {
    "code": "target_private_address",
    "message": "169.254.169.254 resolves to a private address",
    "details": [{ "field": "targetUrl", "message": "..." }]
  }
}
```

`code` is stable and safe to write code against. `message` is for humans
and may change.

### How login works

Two tokens, on purpose:

|                   | Access token                 | Refresh token                           |
| ----------------- | ---------------------------- | --------------------------------------- |
| **Format**        | Signed JWT                   | 32 random bytes, meaningless on its own |
| **Lives for**     | 15 minutes                   | 30 days                                 |
| **Stored where**  | Browser memory only          | Secure `httpOnly` cookie                |
| **Sent how**      | `Authorization` header       | Automatically by the browser            |
| **Cancelled how** | Expires, or account disabled | Instantly, server-side                  |

The access token is short-lived so a stolen one is quickly worthless. The
refresh token is **swapped for a new one every time it's used**, which
means if someone steals it and uses it, the system notices a token being
used twice — and destroys every session for that account.

Neither token is ever put in `localStorage`, because anything there can
be read by any script that ends up on the page.

---

## 10. Configuration

Everything lives in `.env`. The app **refuses to start** on a bad value
rather than failing confusingly later.

### Required

| Variable     | What it is                                        |
| ------------ | ------------------------------------------------- |
| `MONGO_URI`  | MongoDB connection string                         |
| `REDIS_URL`  | Redis connection string                           |
| `JWT_SECRET` | Secret for signing tokens. `openssl rand -hex 32` |

### Common

| Variable        | Default       | What it does                             |
| --------------- | ------------- | ---------------------------------------- |
| `PORT`          | `4000`        | Which port the API listens on            |
| `NODE_ENV`      | `development` | `production` enables stricter checks     |
| `LOG_LEVEL`     | `info`        | `debug`, `info`, `warn`, or `error`      |
| `MONGO_DB_NAME` | `statpulse`   | Database name                            |
| `WEB_ORIGIN`    | —             | Allowed browser origins, comma-separated |

### Tuning

| Variable                    | Default  | What it does                                                 |
| --------------------------- | -------- | ------------------------------------------------------------ |
| `STATUS_CACHE_TTL_SEC`      | `60`     | How long the cached page lasts                               |
| `STATUS_STALE_TTL_SEC`      | `600`    | How long the emergency backup copy lasts                     |
| `STATUS_RATE_LIMIT`         | `120`    | Page requests per minute per visitor                         |
| `PING_DEFAULT_INTERVAL_SEC` | `60`     | How often to check each service                              |
| `PING_CONCURRENCY`          | `20`     | How many checks run at once                                  |
| `FLUSH_INTERVAL_MS`         | `600000` | How often to batch-save results (10 min)                     |
| `JWT_ACCESS_TTL`            | `15m`    | Access token lifetime                                        |
| `REFRESH_TTL_DAYS`          | `30`     | Refresh token lifetime                                       |
| `BCRYPT_ROUNDS`             | `12`     | Password hashing strength                                    |
| `ALLOW_PRIVATE_TARGETS`     | `false`  | **Danger.** Allows monitoring internal addresses. See below. |

> **About `ALLOW_PRIVATE_TARGETS`:** turning this on disables the SSRF
> protection from section 6.4. It exists for self-hosted installations
> that genuinely need to monitor services on their own private network.
> It is all-or-nothing — including for redirect destinations — because
> there's no coherent middle ground: if `10.0.0.5` is a legitimate thing
> to monitor, a redirect to it is legitimate too.

---

## 11. Testing

```bash
npm test
```

**211 tests across 16 files.** They run against a _real_ MongoDB and a
_real_ Redis — never mocks — because the two trickiest parts of this
system are Lua scripts and Redis Streams, and a mock either doesn't
implement them or implements them differently. Then the test passes and
production doesn't.

Test databases are separate and forced in configuration (`statpulse_test`
and Redis database 15), with a guard that refuses to run if the target
isn't one of those.

### What's covered

| Area               | What's being proven                                                         |
| ------------------ | --------------------------------------------------------------------------- |
| Status logic       | Every combination of service states and incident severities                 |
| The 3-strikes rule | Every transition, both directions, including resets                         |
| Uptime maths       | Empty data, partial hours, and _not_ reporting 100% for unmeasured services |
| SSRF guard         | 55 hostile URLs, including the DNS-swap trick                               |
| Cache              | 200 simultaneous requests → exactly 1 database query                        |
| Rate limiter       | 50 simultaneous requests, limit 10 → exactly 10 allowed                     |
| Auth               | Token rotation, replay detection, instant revocation                        |
| Batch writer       | Forced replay produces identical totals, not doubled                        |
| Chaos              | Redis killed mid-request — does it degrade or hang?                         |
| Contract           | The public API never leaks internal URLs or database IDs                    |

### Performance

```bash
npm run loadtest
```

Measures the cached read path and **fails** if it misses the target.
Latest run on a laptop:

```
requests/sec   6536
latency p50    6 ms
latency p99    20 ms      target: under 50 ms
errors         0
```

### What breaking looks like

A real example from building this: the first load test scored **0
requests, 100 errors.** The cause was a genuine design flaw — working out
_which organisation_ a request belonged to asked MongoDB _before_ the
cache was read. The "served entirely from Redis" path wasn't. With
MongoDB down, the status page couldn't answer at all. Fixed by caching
that lookup too.

Tests that only pass tell you nothing. That one earned its keep.

---

## 12. Deployment

### Docker

One image, three roles — same code, different start command:

```bash
docker build -t statpulse .

# the web server
docker run -p 4000:4000 --env-file .env statpulse

# the checker and flusher
docker run --env-file .env statpulse node packages/jobs/src/worker.js
```

The image runs as a non-root user and uses `dumb-init` so that shutdown
signals actually reach Node — without it, every deployment would kill
in-flight requests instead of finishing them.

### Before going live

- [ ] `NODE_ENV=production`
- [ ] A real `JWT_SECRET` (startup refuses the example value)
- [ ] MongoDB and Redis reachable, with Redis persistence enabled
- [ ] `WEB_ORIGIN` set to your actual domain
- [ ] `/metrics` blocked at your load balancer — it's internal
- [ ] Health checks wired to `/health/live` (restart) and `/health` (traffic)
- [ ] Run the checker in a network that **cannot** reach your private
      subnet — the real long-term fix for section 6.4

### What happens when things break

Each dependency has a defined degraded behaviour, tested:

| Failure          | Public page                                                 | Admin                |
| ---------------- | ----------------------------------------------------------- | -------------------- |
| **Redis down**   | Rebuilds from MongoDB. Rate limiting allows through.        | Works                |
| **MongoDB down** | Serves the last good copy, labelled _"showing cached data"_ | Refuses writes (503) |
| **Both down**    | `503` with a documented error code                          | `503`                |
| **Checker dead** | Last known status; the "last checked" time visibly ages     | Normal               |
| **Flusher dead** | Current status fine; uptime charts stop advancing           | Normal               |

The difference between `500` and `503` is deliberate. `503` with a
machine-readable code is the _designed_ degraded state. `500` is a bug.
Conflating them means nobody knows which they're looking at.

---

## 13. What is deliberately not built

Being clear about scope is part of the design:

- **Live push updates (SSE/WebSockets)** — the page polls every 30
  seconds and gets an empty "nothing changed" response when nothing has.
  That's cheap, simple, and works everywhere.
- **Email/SMS notifications** — no mail provider is wired up. The rate
  limiter that would protect the subscribe endpoint is already built and
  tested; the delivery side isn't.
- **Scheduled maintenance windows** — the status value exists in the code
  and nothing uses it yet.
- **Multiple companies on one installation** — every record carries an
  organisation ID and every cache key is scoped by it, so the groundwork
  is there. Custom domains and TLS are not.

### Known limitations

- **Invitations are shown on screen, not emailed.** The owner copies the
  link and sends it. The UI says so rather than claiming an email was
  sent that never arrives.
- **Uptime charts start empty.** A freshly installed system has no
  history, so the 90-day bars are mostly grey. That's the design being
  truthful rather than inventing a chart.

---

## Further reading

- **[plan.md](plan.md)** — the original design document, including 14
  gaps found in the initial brief and how each was resolved.
- **[docs/architecture.md](docs/architecture.md)** — decisions that
  weren't obvious, with what they cost.

---

**37 commits · ~11,400 lines · 211 tests · 5 packages**
