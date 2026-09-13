import { z } from 'zod';
import { INCIDENT_STATUS, INCIDENT_IMPACT } from '@statpulse/shared';

export const createIncidentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(4_000),
  status: z.enum(Object.values(INCIDENT_STATUS)).optional(),
  impact: z.enum(Object.values(INCIDENT_IMPACT)).optional(),
  // Component slugs, not ids. The admin API speaks the same public
  // vocabulary as the status page.
  affectedComponents: z.array(z.string().trim()).max(50).optional(),
});

export const updateIncidentSchema = z
  .object({
    message: z.string().trim().min(1).max(4_000),
    status: z.enum(Object.values(INCIDENT_STATUS)),
    impact: z.enum(Object.values(INCIDENT_IMPACT)).optional(),
    affectedComponents: z.array(z.string().trim()).max(50).optional(),
  })
  .strict();

export const listIncidentsSchema = z.object({
  status: z.enum(['active', 'resolved', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
