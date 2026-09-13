import { z } from 'zod';
import { COMPONENT_TYPES } from '@statpulse/shared';

/**
 * A URL-safe identifier derived from a name.
 *
 * Generated rather than asked for, because an admin adding a component
 * mid-incident should not have to think about it - but it is stored, not
 * recomputed, so renaming "Payments API" to "Billing API" does not break
 * every bookmark and subscriber reference pointing at the old slug.
 */
export function slugify(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const statusCodes = z.array(z.number().int().min(100).max(599)).min(1).max(20);

export const createComponentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/)
    .max(60)
    .optional(),
  description: z.string().trim().max(500).optional(),
  group: z.string().trim().max(60).optional(),
  type: z.enum(COMPONENT_TYPES),
  targetUrl: z.string().trim().min(1),
  method: z.enum(['GET', 'HEAD']).optional(),
  expectedStatusCodes: statusCodes.optional(),
  timeoutMs: z.number().int().min(1_000).max(15_000).optional(),
  degradedAboveMs: z.number().int().min(1).optional(),
  checkIntervalSec: z.number().int().min(30).max(3_600).optional(),
  isPublic: z.boolean().optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().int().optional(),
});

// Every field optional, but at least one present - a PATCH with an empty
// body is a mistake, not a no-op worth pretending succeeded.
export const updateComponentSchema = createComponentSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
