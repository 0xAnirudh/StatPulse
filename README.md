# StatPulse

A public status page, and the thing that keeps it truthful.

When an API goes down its customers stop filing tickets and start
refreshing one page. That page has to answer while the database behind
it is the thing on fire - so it is served from Redis, rebuilt at most
once per expiry however many people are watching, and falls back to a
stale copy rather than a stack trace.

```bash
npm install
docker compose up -d      # mongo + redis
npm run dev               # api on :4000, workers alongside
```

Copy `.env.example` to `.env` first.

See [plan.md](plan.md) for the requirement analysis and the full design.
