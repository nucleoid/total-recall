import { z } from 'zod';
import { TEXT_FIELD_MAX_CHARS } from './http-limits.js';

const uuid = z.string().uuid();
const offsetDateTime = z.string().datetime({ offset: true });
const boundedText = z.string().max(TEXT_FIELD_MAX_CHARS);

function boundedInteger(defaultValue: number, min: number, max: number, name: string) {
  return z.preprocess(
    (value) => value === undefined ? undefined : value,
    z.string()
      .regex(/^\d+$/, `${name} must be an integer`)
      .transform(Number)
      .refine((value) => value >= min && value <= max, `${name} must be between ${min} and ${max}`)
      .default(String(defaultValue))
  );
}

const sortField = z.enum(['created_at', 'updated_at', 'accessed_at', 'access_count', 'relevance']);
const direction = z.enum(['asc', 'desc']);
const activeStatus = z.enum(['active', 'superseded', 'expired', 'all']);
const accessLevel = z.enum(['normal', 'sensitive', 'secret']);

export const memoriesQuerySchema = z.object({
  namespace: boundedText.optional(),
  source: boundedText.optional(),
  tag: z.union([boundedText, z.array(boundedText)]).optional().transform((value) =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value]
  ),
  agent_id: uuid.optional(),
  access_level: accessLevel.optional(),
  created_after: offsetDateTime.optional(),
  created_before: offsetDateTime.optional(),
  active: activeStatus.default('active'),
  sort: sortField.default('created_at'),
  direction: direction.default('desc'),
  limit: boundedInteger(50, 1, 200, 'limit'),
  offset: boundedInteger(0, 0, 10_000, 'offset'),
}).transform(({ tag, ...value }) => tag === undefined ? value : { ...value, tags: tag }).superRefine((value, ctx) => {
  if (value.created_after && value.created_before && Date.parse(value.created_after) > Date.parse(value.created_before)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['created_before'],
      message: 'created_before must be after or equal to created_after',
    });
  }
});

export const mediaStatsQuerySchema = z.object({
  service: boundedText.optional(),
  played_after: offsetDateTime.optional(),
  played_before: offsetDateTime.optional(),
  limit: boundedInteger(10, 1, 50, 'limit').optional(),
}).superRefine((value, ctx) => {
  if (value.played_after && value.played_before && Date.parse(value.played_after) > Date.parse(value.played_before)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['played_before'],
      message: 'played_before must be after or equal to played_after',
    });
  }
});

export const tracesQuerySchema = z.object({
  limit: boundedInteger(20, 1, 100, 'limit'),
  offset: boundedInteger(0, 0, 10_000, 'offset'),
  agent_id: uuid.optional(),
  session_id: boundedText.optional(),
});

export const auditQuerySchema = z.object({
  limit: boundedInteger(50, 1, 200, 'limit'),
  offset: boundedInteger(0, 0, 10_000, 'offset'),
  action: boundedText.optional(),
  agent_id: uuid.optional(),
});

export const mediaEventsQuerySchema = z.object({
  service: boundedText.optional(),
  event_type: boundedText.optional(),
  played_after: offsetDateTime.optional(),
  played_before: offsetDateTime.optional(),
  limit: boundedInteger(50, 1, 500, 'limit'),
  offset: boundedInteger(0, 0, 10_000, 'offset'),
}).superRefine((value, ctx) => {
  if (value.played_after && value.played_before && Date.parse(value.played_after) > Date.parse(value.played_before)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['played_before'],
      message: 'played_before must be after or equal to played_after',
    });
  }
});

export const mediaRollupSchema = z.object({
  batch_size: z.number().int().min(1).max(500).default(50),
}).default({});
