import { z } from 'zod';

export const GitStatusSchema = z.object({
  directory: z.string(),
  commit: z.string(),
  short: z.string(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  prod: z.string(),
  remote_main: z.string().nullable(),
  remote_prod: z.string().nullable(),
  incoming: z.number().int().nonnegative(),
  merge_to_revert: z.string().nullable(),
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
export const GitActionSchema = z.enum([
  'fetch',
  'merge',
  'prod',
  'checkout',
  'commit',
  'push',
  'revert',
]);
export type GitAction = z.infer<typeof GitActionSchema>;

export const GitChangesSchema = z.object({
  files: z.array(z.string()),
  diff: z.string(),
  version: z.string(),
  truncated: z.boolean(),
});
export type GitChanges = z.infer<typeof GitChangesSchema>;
export const GitCommitDetailsSchema = z.object({
  expected_changes: z.string(),
  message: z.string(),
});
export type GitCommitDetails = z.infer<typeof GitCommitDetailsSchema>;
