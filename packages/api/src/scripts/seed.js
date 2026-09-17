import {
  config,
  log,
  connectMongo,
  connectRedis,
  disconnectMongo,
  disconnectRedis,
} from '@statpulse/core';
import { Organization, User, Component } from '@statpulse/core/models';
import bcrypt from 'bcrypt';

/**
 * Seed a usable development installation.
 *
 * Idempotent: run it as often as you like. Everything is an upsert keyed
 * on something stable, so a second run updates rather than duplicates,
 * and an existing password is never overwritten - nobody wants their
 * local login reset because they re-ran the seed.
 *
 * The demo components point at real public endpoints on purpose. Ones
 * that resolve to private space would be refused by the SSRF guard,
 * which is correct and also a confusing first experience.
 */

const DEMO_COMPONENTS = [
  {
    name: 'Public API',
    slug: 'public-api',
    group: 'Core',
    type: 'API',
    targetUrl: 'https://api.github.com/',
    degradedAboveMs: 800,
    displayOrder: 1,
  },
  {
    name: 'Website',
    slug: 'website',
    group: 'Core',
    type: 'Website',
    targetUrl: 'https://example.com/',
    degradedAboveMs: 1_200,
    displayOrder: 2,
  },
  {
    name: 'Documentation',
    slug: 'documentation',
    group: 'Support',
    type: 'Website',
    targetUrl: 'https://developer.mozilla.org/',
    degradedAboveMs: 2_000,
    displayOrder: 3,
  },
  {
    name: 'Webhook Delivery',
    slug: 'webhook-delivery',
    group: 'Support',
    type: 'Webhook',
    targetUrl: 'https://httpbin.org/status/200',
    degradedAboveMs: 2_500,
    displayOrder: 4,
  },
  {
    // Deliberately broken, so there is something to watch go DOWN and
    // something for the hysteresis to be visibly not-hasty about.
    name: 'Legacy Exports',
    slug: 'legacy-exports',
    group: 'Support',
    type: 'API',
    targetUrl: 'https://httpbin.org/status/503',
    expectedStatusCodes: [200],
    displayOrder: 5,
  },
];

const ADMIN_EMAIL = process.env.SEED_EMAIL ?? 'admin@statpulse.local';
const ADMIN_PASSWORD = process.env.SEED_PASSWORD ?? 'development-password';

async function seed() {
  if (config.NODE_ENV === 'production') {
    // The demo password is in this file, in the repository.
    throw new Error('refusing to seed a production database');
  }

  await Promise.all([connectMongo({ maxAttempts: 3 }), connectRedis()]);

  const org = await Organization.findOneAndUpdate(
    { slug: 'default' },
    { $setOnInsert: { name: 'StatPulse', slug: 'default', hosts: [] } },
    { upsert: true, returnDocument: 'after' },
  );

  const existing = await User.findOne({ orgId: org._id, email: ADMIN_EMAIL });
  if (existing) {
    log.info('admin already exists, leaving it alone', { email: ADMIN_EMAIL });
  } else {
    await User.create({
      orgId: org._id,
      email: ADMIN_EMAIL,
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, config.BCRYPT_ROUNDS),
      role: 'owner',
      status: 'active',
    });
    /**
     * console, not the logger.
     *
     * The logger redacts anything called `password`, which is exactly
     * right everywhere else and exactly wrong here - the whole purpose
     * of this line is to tell a developer how to log in, and the first
     * run printed "[redacted]" at them.
     */
    log.info('admin created', { email: ADMIN_EMAIL });
    console.log(`\n  sign in with  ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}\n`);
  }

  for (const component of DEMO_COMPONENTS) {
    await Component.findOneAndUpdate(
      { orgId: org._id, slug: component.slug },
      { $set: { ...component, orgId: org._id } },
      { upsert: true, returnDocument: 'after' },
    );
  }

  log.info('seeded', { org: org.slug, components: DEMO_COMPONENTS.length });
}

seed()
  .then(async () => {
    await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
    process.exit(0);
  })
  .catch(async (err) => {
    log.error('seed failed', { err: err.message });
    await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
    process.exit(1);
  });
