import type { FlowGraph } from '@flode/shared';
import { expect, it } from 'vitest';
import { nodeForPath } from '../config-path';

const graph: FlowGraph = {
  id: '00000000-0000-4000-8000-000000000003',
  name: 'Run',
  version: 1,
  nodes: [
    {
      id: 't',
      type: 'trigger',
      position: { x: 0, y: 0 },
      data: { trigger: 'state', entity_id: 'light.a' },
    },
    {
      id: 'c',
      type: 'condition',
      position: { x: 300, y: 0 },
      data: { condition: 'state', entity_id: 'sun.sun', state: 'below_horizon' },
    },
    { id: 'a', type: 'action', position: { x: 600, y: 0 }, data: { service: 'light.turn_on' } },
    {
      id: 'b',
      type: 'action',
      position: { x: 900, y: 0 },
      data: { _raw: { if: [], then: [{ delay: 1 }] } },
    },
  ],
  edges: [
    { id: 'e1', source: 't', target: 'c' },
    { id: 'e2', source: 'c', target: 'a', sourceHandle: 'true' },
    { id: 'e3', source: 'a', target: 'b' },
  ],
};

it('maps script sequence validation paths to graph cards', () => {
  expect(nodeForPath(graph, 'script', 'sequence/0')).toBe('a');
});
