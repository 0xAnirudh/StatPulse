import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Load .env from the repository root, not from the current directory.
 *
 * There is one .env for the whole monorepo, but the working directory
 * depends on how a process was started: `npm run dev --workspace=@statpulse/api`
 * runs in packages/api, the worker in packages/jobs, vitest at the root.
 * Plain `dotenv/config` reads ./.env relative to cwd, so two of those
 * three find nothing and the process exits complaining that MONGO_URI is
 * missing when it is sitting right there.
 *
 * Resolving from this file's own location makes it cwd-independent.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
dotenv.config({ path: join(REPO_ROOT, '.env'), quiet: true });

/**
 * Environment configuration, validated once at boot.
 *
 * Reading process.env directly all over the codebase means a missing
 * variable surfaces as `undefined` at whatever moment that code path
 * first runs - often in production, often as a confusing downstream
 * error. Parsing it here means a misconfigured process refuses to start
 * and says exactly which variable is wrong.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_DB_NAME: z.string().default('statpulse'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),

  /**
   * Access tokens are short-lived on purpose.
   *
   * Nothing checks an access token against a store on the request path -
   * that is the point of a stateless token - so the only thing bounding
   * the damage of a stolen one is how quickly it expires. Fifteen
   * minutes is the compromise: long enough that a dashboard session is
   * not constantly refreshing, short enough that a leaked token is
   * worthless by the time anyone finds it in a log.
   *
   * Revocation that cannot wait fifteen minutes goes through the refresh
   * whitelist instead, which is immediate.
   */
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /**
   * bcrypt work factor.
   *
   * 12 is the production setting. Tests override it to 4 because at 12 a
   * single hash costs roughly a quarter second, and a suite that
   * registers a few dozen users would spend most of its runtime waiting
   * on a deliberately slow function. Lowering it in tests weakens
   * nothing real - it is the same code path, just cheaper - but it must
   * never be lowered outside them, so production refuses anything under
   * 10 below.
   */
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  WEB_ORIGIN: z.string().default(''),

  /**
   * Cache lifetimes.
   *
   * The TTL is not the freshness mechanism - every admin write deletes
   * the key explicitly, so the page is normally current within
   * milliseconds of a change. The TTL is the correctness backstop: if a
   * delete is ever lost to a Redis blip, this is the longest the page
   * can stay wrong.
   *
   * The stale copy lives ten times longer and is only ever read when
   * Mongo cannot be reached. Serving a payload labelled "last updated 8
   * minutes ago" beats serving a 503 from a status page.
   */
  STATUS_CACHE_TTL_SEC: z.coerce.number().int().min(5).max(600).default(60),
  STATUS_STALE_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(600),

  /**
   * Requests a minute, per client, for the public status page.
   *
   * Configurable because the right value is a product judgement, not a
   * constant. 120 is generous for a browser polling every thirty
   * seconds and still bounds a scraper - but everyone behind one
   * corporate NAT shares a bucket, so a large customer reading the page
   * during an outage can look like one very busy client. Raise it if
   * that is your shape of traffic; the endpoint is a Redis GET and the
   * cost of serving it is not the constraint.
   *
   * The load test sets it high deliberately, to measure the read path
   * rather than the limiter.
   */
  STATUS_RATE_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(120),

  PING_DEFAULT_INTERVAL_SEC: z.coerce.number().int().min(30).max(3_600).default(60),
  PING_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(20),
  FLUSH_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),

  /**
   * Allow components to point at private address space.
   *
   * Off by default, and it should stay off anywhere the admin account is
   * not also the server operator. An admin supplies a URL and this
   * server fetches it, from inside the production network, every sixty
   * seconds, forever - which is a port scanner and a path to the cloud
   * metadata endpoint unless something refuses private addresses.
   */
  ALLOW_PRIVATE_TARGETS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${issues.join('\n')}`);
  console.error(`\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production') {
  if (parsed.data.BCRYPT_ROUNDS < 10) {
    console.error(
      `BCRYPT_ROUNDS is ${parsed.data.BCRYPT_ROUNDS} in production. ` +
        `Anything under 10 makes stolen hashes cheap to crack offline.`,
    );
    process.exit(1);
  }
  // The example secret is in the repository, so a deployment still using
  // it has a publicly known signing key. Every token it issues is
  // forgeable by anyone who has read the README.
  if (parsed.data.JWT_SECRET.startsWith('change-me')) {
    console.error(`JWT_SECRET is still the example value. Generate one: openssl rand -hex 32`);
    process.exit(1);
  }
}

export const config = Object.freeze(parsed.data);
export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
