import { z } from 'zod';

export const GitStatusSchema = z.object({
  commit: z.string(),
  short: z.string(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  main: z.string(),
  remote: z.string().nullable(),
  has_origin: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;
export const GitHistorySchema = z.object({
  commits: z.array(
    z.object({
      commit: z.string(),
      short: z.string(),
      date: z.string(),
      subject: z.string(),
    })
  ),
  has_more: z.boolean(),
});
export type GitHistory = z.infer<typeof GitHistorySchema>;
export const GitActionSchema = z.enum(['fetch', 'pull', 'main', 'checkout']);
export type GitAction = z.infer<typeof GitActionSchema>;
