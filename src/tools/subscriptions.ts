import { z } from 'zod';
import type { AuthContext } from '../types.js';
import {
  createSubscription,
  disableSubscription,
  listSubscriptions,
  SUBSCRIPTION_DEFAULT_THRESHOLD,
  SUBSCRIPTION_MAX_NAMESPACES,
  SUBSCRIPTION_QUERY_MAX_CHARS,
} from '../subscriptions.js';
import { TEXT_FIELD_MAX_CHARS } from '../http-limits.js';

export const agentSubscribeSchema = z.object({
  query: z.string().min(1).max(SUBSCRIPTION_QUERY_MAX_CHARS),
  webhook_url: z.string().url().max(4096),
  namespaces: z.array(z.string().min(1).max(TEXT_FIELD_MAX_CHARS)).min(1).max(SUBSCRIPTION_MAX_NAMESPACES)
    .refine(values => new Set(values).size === values.length, 'Subscription namespaces must be unique').optional(),
  threshold: z.number().min(0).max(1).default(SUBSCRIPTION_DEFAULT_THRESHOLD),
  exclude_self: z.boolean().default(true),
  idempotency_key: z.string().min(1).max(512),
  agent_name: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).optional(),
}).strict();

export const agentListSubscriptionsSchema = z.object({}).strict();
export const agentUnsubscribeSchema = z.object({ id: z.string().uuid() }).strict();

export async function agentSubscribe(params: z.infer<typeof agentSubscribeSchema>, auth: AuthContext) {
  return createSubscription(params, auth);
}
export async function agentListSubscriptions(_params: z.infer<typeof agentListSubscriptionsSchema>, auth: AuthContext) {
  return listSubscriptions(auth);
}
export async function agentUnsubscribe(params: z.infer<typeof agentUnsubscribeSchema>, auth: AuthContext) {
  return disableSubscription(params.id, auth);
}
