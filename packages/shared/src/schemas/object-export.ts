import { z } from 'zod';

export const ObjectExportResultSchema = z.object({
  directory: z.string(),
  integrations: z.number().int().nonnegative(),
  devices: z.number().int().nonnegative(),
  entities: z.number().int().nonnegative(),
  helpers: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
export type ObjectExportResult = z.infer<typeof ObjectExportResultSchema>;
