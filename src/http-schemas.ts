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
