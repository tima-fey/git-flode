import { z } from 'zod';

export const ProjectTestResultSchema = z.object({
  success: z.boolean(),
  exit_code: z.number().int(),
  timed_out: z.boolean(),
  truncated: z.boolean(),
  output: z.string(),
  duration: z.number().nonnegative(),
});
export type ProjectTestResult = z.infer<typeof ProjectTestResultSchema>;
