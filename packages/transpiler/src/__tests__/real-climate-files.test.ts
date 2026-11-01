import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAutomationConfigSchema } from '@flode/shared';
import { describe, expect, it } from 'vitest';
import { FlowTranspiler } from '../FlowTranspiler';
import { internalKeysIn, normalizeHaConfig } from '../ha-equal';
import { YamlParser } from '../parser/YamlParser';
import { buildAutomationSaveConfig } from '../save-config';
import { loadHaYaml } from '../yaml';

const directory = join(__dirname, '../../../../dev/container/fixtures/automations/climate');
const parser = new YamlParser({ keepBlocks: true });

for (const { file, count, style } of [
  { file: 'heating.yaml', count: 5, style: 'trigger' },
  { file: 'ventilation.yaml', count: 7, style: 'triggers' },
]) {
  const path = join(directory, file);
  const original = readFileSync(path, 'utf8');
  const entries: unknown = loadHaYaml(original);
  if (!Array.isArray(entries)) throw new Error(`${file} must contain an automation list`);
  const configs = entries.map((entry: unknown) => FileAutomationConfigSchema.parse(entry));

  describe(`real ${file}`, () => {
    it('retains independent entries and the original HA syntax', () => {
      expect(configs).toHaveLength(count);
      expect(new Set(configs.map((config) => config.id)).size).toBe(count);
      expect(configs.every((config) => style in config)).toBe(true);
      expect(original).not.toMatch(/&(?:gt|lt);/);
    });

    for (const config of configs) {
      it(`round-trips ${config.id} without losing automation semantics`, async () => {
        const result = await parser.parse(JSON.stringify(config));
        expect(result.success).toBe(true);
        expect(result.errors ?? []).toEqual([]);
        expect(result.warnings ?? []).toEqual([]);
        expect(result.graph?.name).toBe(config.alias);
        expect(result.graph?.nodes.length).toBeGreaterThan(0);
        if (!result.graph) throw new Error('No parsed graph');
        const saved = buildAutomationSaveConfig(new FlowTranspiler(), result.graph, {
          alias: result.graph.name,
          description: result.graph.description ?? '',
        });
        expect(saved.success).toBe(true);
        expect(saved.errors ?? []).toEqual([]);
        expect(internalKeysIn(saved.config)).toEqual([]);
        expect(normalizeHaConfig(saved.config)).toEqual(normalizeHaConfig(config));
      });
    }
  });
}
