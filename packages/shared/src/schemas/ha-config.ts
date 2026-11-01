import { z } from 'zod';

/** Native POST /api/config/core/check_config response. */
export const HaConfigCheckSchema = z.object({
  result: z.enum(['valid', 'invalid']),
  errors: z.string().nullable(),
  warnings: z.string().nullable().optional(),
});
export type HaConfigCheck = z.infer<typeof HaConfigCheckSchema>;
