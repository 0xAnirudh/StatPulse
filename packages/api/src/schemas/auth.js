import { z } from 'zod';

/**
 * bcrypt hashes at most the first 72 *bytes* of a password and silently
 * ignores the rest. Two different 100-character passwords sharing a
 * 72-byte prefix therefore produce the same hash, and a user who
 * believes a long passphrase is stronger would be wrong in a way nothing
 * tells them about.
 *
 * The check is on byte length, not character count: a passphrase with
 * any non-ASCII character reaches 72 bytes well before 72 characters.
 */
const BCRYPT_MAX_BYTES = 72;

/**
 * Twelve characters and no composition rules.
 *
 * Length is what defeats an offline attack on a stolen hash. Requiring a
 * digit and a symbol mostly produces Password1! and a sticky note, which
 * is why every current guideline drops the rules and raises the floor.
 */
const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= BCRYPT_MAX_BYTES, {
    message: `Password must be at most ${BCRYPT_MAX_BYTES} bytes (bcrypt ignores anything beyond that)`,
  });

const email = z.string().trim().toLowerCase().email('Must be a valid email address').max(254);

export const registerSchema = z.object({ email, password });

// Deliberately not the registration schema. Tightening the rules later
// must not lock existing accounts out of logging in, so login accepts
// whatever is stored and lets the lookup fail.
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

export const inviteSchema = z.object({
  email,
  role: z.enum(['owner', 'admin']).default('admin'),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1, 'An invitation token is required'),
  password,
});

export const updateUserSchema = z
  .object({
    role: z.enum(['owner', 'admin']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
