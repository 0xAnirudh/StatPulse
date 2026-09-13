import { ApiError, config, parseTarget, resolveTarget, UnsafeTargetError } from '@statpulse/core';
import { Component } from '@statpulse/core/models';
import { invalidateStatus } from '@statpulse/core';
import { slugify } from '../schemas/component.js';

/**
 * Component administration.
 *
 * Every mutation ends with a cache invalidation, and it happens here
 * rather than in the controller - so that anything which changes what
 * the public page would say invalidates it, regardless of which route
 * called it.
 */

/**
 * Validate a target before it is ever stored.
 *
 * Checked again at request time by the checker, because DNS changes.
 * Doing it here as well means an admin gets a clear error while they are
 * looking at the form, rather than a component that silently never goes
 * green.
 */
async function assertTargetAllowed(targetUrl) {
  try {
    const url = parseTarget(targetUrl);
    await resolveTarget(url, { allowPrivate: config.ALLOW_PRIVATE_TARGETS });
  } catch (err) {
    if (err instanceof UnsafeTargetError) {
      throw ApiError.forbidden(`target_${err.reason}`, err.message);
    }
    throw err;
  }
}

async function uniqueSlug(orgId, desired) {
  let slug = desired;
  for (let n = 2; n < 100; n += 1) {
    const clash = await Component.exists({ orgId, slug });
    if (!clash) return slug;
    slug = `${desired}-${n}`;
  }
  throw ApiError.conflict('slug_exhausted', 'Could not derive a unique identifier for that name');
}

export async function listComponents(org, { includeHidden = true } = {}) {
  const filter = { orgId: org._id, deletedAt: null };
  if (!includeHidden) filter.isPublic = true;
  return Component.find(filter).sort({ displayOrder: 1, name: 1 }).lean();
}

export async function createComponent(org, input) {
  await assertTargetAllowed(input.targetUrl);

  const slug = await uniqueSlug(org._id, input.slug ?? slugify(input.name));

  try {
    const component = await Component.create({ ...input, slug, orgId: org._id });
    await invalidateStatus(org);
    return component;
  } catch (err) {
    if (err.code === 11000) {
      throw ApiError.conflict('slug_taken', 'A component with that identifier already exists');
    }
    throw err;
  }
}

export async function updateComponent(org, slug, input) {
  if (input.targetUrl) await assertTargetAllowed(input.targetUrl);

  const component = await Component.findOneAndUpdate(
    { orgId: org._id, slug, deletedAt: null },
    { $set: input },
    { new: true, runValidators: true },
  );

  // 404 rather than 403 for a component in another org. Distinguishing
  // "does not exist" from "exists but is not yours" confirms the
  // existence of other tenants' resources.
  if (!component) throw ApiError.notFound('component_not_found', 'No such component');

  await invalidateStatus(org);
  return component;
}

/**
 * Soft delete.
 *
 * A hard delete would orphan ninety days of uptime history, and uptime
 * history is what a customer quotes back at you during a renewal. The
 * slug is released so the name can be reused.
 */
export async function deleteComponent(org, slug) {
  const component = await Component.findOne({ orgId: org._id, slug, deletedAt: null });
  if (!component) throw ApiError.notFound('component_not_found', 'No such component');

  component.deletedAt = new Date();
  component.isActive = false;
  component.slug = `${slug}-deleted-${Date.now()}`;
  await component.save();

  await invalidateStatus(org);
  return component;
}

/** The admin view - everything, including what the public page hides. */
export function toAdminJson(component) {
  return {
    slug: component.slug,
    name: component.name,
    description: component.description ?? null,
    group: component.group ?? null,
    type: component.type,
    targetUrl: component.targetUrl,
    method: component.method,
    expectedStatusCodes: component.expectedStatusCodes,
    timeoutMs: component.timeoutMs,
    degradedAboveMs: component.degradedAboveMs,
    checkIntervalSec: component.checkIntervalSec,
    status: component.status,
    statusChangedAt: component.statusChangedAt ?? null,
    lastCheckedAt: component.lastCheckedAt ?? null,
    responseTimeMs: component.responseTimeMs ?? null,
    isActive: component.isActive,
    isPublic: component.isPublic,
    displayOrder: component.displayOrder,
  };
}
