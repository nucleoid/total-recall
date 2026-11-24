import { z } from 'zod';
import { ACCESS_LEVELS, canAccessLevel } from './auth.js';
import type { AccessLevel, AuthContext } from './types.js';

export const synthesisAccessLevelSchema = z.enum(ACCESS_LEVELS);

export function isSubscriptionUsage(budget: { mode?: string }): boolean {
  return budget.mode === 'subscription';
}

export function assertSubscriptionGeneration(
  generation: { provider: string; model: string },
  budget: { mode?: string },
): void {
  if (!isSubscriptionUsage(budget)) return;
  if (generation.provider !== 'openclaw-adapter' || !generation.model.startsWith('openclaw/')) {
    throw new Error('Subscription synthesis requires the approved OpenClaw agent adapter');
  }
}

export function assertSynthesisAuthority(
  auth: AuthContext,
  namespaces: readonly string[],
  requiredAccessLevel: AccessLevel,
): void {
  if (namespaces.length === 0 || namespaces.some(namespace => !auth.namespaces.includes(namespace)) ||
      !canAccessLevel(requiredAccessLevel, auth.maxAccessLevel)) {
    throw new Error('Synthesis key does not authorize the requested namespaces and access-level ceiling');
  }
}

export function maximumAccessLevel(levels: readonly AccessLevel[]): AccessLevel {
  return levels.reduce((maximum, level) => accessRank(level) > accessRank(maximum) ? level : maximum, 'normal');
}

export function accessRank(level: AccessLevel): number {
  return level === 'secret' ? 2 : level === 'sensitive' ? 1 : 0;
}

export function assertDerivedAccessNotDowngraded(
  existingAccessLevel: AccessLevel | undefined,
  requiredAccessLevel: AccessLevel,
): void {
  if (existingAccessLevel !== undefined && accessRank(existingAccessLevel) < accessRank(requiredAccessLevel)) {
    throw new Error('existing_derived_access_too_low');
  }
}
