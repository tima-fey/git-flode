import { z } from 'zod';

export const FileAutomationRefSchema = z.object({ file: z.string(), id: z.string() });
export type FileAutomationRef = z.infer<typeof FileAutomationRefSchema>;

export const FileAutomationListSchema = z.object({
  directory: z.string(),
  items: z.array(FileAutomationRefSchema.extend({ name: z.string() })),
  errors: z.array(z.object({ file: z.string(), error: z.string() })),
});

export const FileAutomationConfigSchema = z.record(z.string(), z.unknown());
