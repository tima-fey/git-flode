import { describe, expect, it } from 'vitest';
import { createConfigPathResolver } from '../config-paths';

const n = (id: string, type: string) => ({ id, type });
const e = (source: string, target: string, sourceHandle?: string) => ({
  source,
  target,
  sourceHandle,
});

describe('createConfigPathResolver', () => {
  it('linear flow: top-level condition, then delay and action share the action index', () => {
    // Time Condition & Delay: trigger → condition(yes only) → delay → action
    const resolve = createConfigPathResolver(
      [n('t', 'trigger'), n('c', 'condition'), n('d', 'delay'), n('a', 'action')],
      [e('t', 'c'), e('c', 'd', 'true'), e('d', 'a')]
    );
    expect(resolve('trigger/0')).toBe('t');
    expect(resolve('condition/0')).toBe('c');
    expect(resolve('condition/0/entity_id/0')).toBe('c');
    expect(resolve('action/0')).toBe('d');
    expect(resolve('action/1')).toBe('a');
    expect(resolve('action/2')).toBeUndefined();
  });

  it('a leading condition continuing only via No is a top-level (not) condition', () => {
    // The transpiler writes it as `conditions: [{condition: not, …}]`.
    const resolve = createConfigPathResolver(
      [n('t', 'trigger'), n('c', 'condition'), n('a', 'action')],
      [e('t', 'c'), e('c', 'a', 'false')]
    );
    expect(resolve('condition/0')).toBe('c');
    expect(resolve('action/0')).toBe('a');
  });

  it('a leading condition with an unlabelled output is a step, as in the transpiler', () => {
    const resolve = createConfigPathResolver(
      [n('t', 'trigger'), n('c', 'condition'), n('a', 'action')],
      [e('t', 'c'), e('c', 'a')]
    );
    expect(resolve('condition/0')).toBeUndefined();
    expect(resolve('action/0')).toBe('c');
  });

  it('if/else in the sequence: branches nest, flow continues at the merge node', () => {
    // trigger → cond(yes: x, no: y) → both → z
    const resolve = createConfigPathResolver(
      [n('t', 'trigger'), n('c', 'condition'), n('x', 'action'), n('y', 'action'), n('z', 'delay')],
      [e('t', 'c'), e('c', 'x', 'true'), e('c', 'y', 'false'), e('x', 'z'), e('y', 'z')]
    );
    expect(resolve('action/0')).toBe('c');
    expect(resolve('action/0/if/condition/0')).toBe('c');
    expect(resolve('action/0/then/0')).toBe('x');
    expect(resolve('action/0/else/0')).toBe('y');
    expect(resolve('action/1')).toBe('z');
    expect(resolve('condition/0')).toBeUndefined();
  });

  it('mid-flow condition with only a Yes branch nests the rest under then', () => {
    // trigger → a → cond(yes) → b → c2
    const resolve = createConfigPathResolver(
      [
        n('t', 'trigger'),
        n('a', 'action'),
        n('c', 'condition'),
        n('b', 'action'),
        n('b2', 'action'),
      ],
      [e('t', 'a'), e('a', 'c'), e('c', 'b', 'true'), e('b', 'b2')]
    );
    expect(resolve('action/0')).toBe('a');
    expect(resolve('action/1')).toBe('c');
    expect(resolve('action/1/then/0')).toBe('b');
    expect(resolve('action/1/then/1')).toBe('b2');
    expect(resolve('action/2')).toBeUndefined();
  });

  it('ignores visual-only edges and unknown roots', () => {
    const resolve = createConfigPathResolver(
      [n('t', 'trigger'), n('a', 'action')],
      [e('t', 'a'), { source: 'a', target: 't', type: 'hint' }]
    );
    expect(resolve('action/0')).toBe('a');
    expect(resolve('sequence/0')).toBeUndefined();
  });
});

describe('createConfigPathResolver: condition steps of the actions', () => {
  it('keeps them in the actions; the steps after them are siblings', () => {
    // As the transpiler writes it: `actions: [{condition: …}, {action: …}]`.
    const resolve = createConfigPathResolver(
      [
        n('t', 'trigger'),
        { id: 'c', type: 'condition', data: { condition: 'state', _step: true } },
        n('a', 'action'),
      ],
      [e('t', 'c'), e('c', 'a', 'true')]
    );
    expect(resolve('condition/0')).toBeUndefined();
    expect(resolve('action/0')).toBe('c');
    expect(resolve('action/0/entity_id/0')).toBe('c');
    expect(resolve('action/1')).toBe('a');
  });
});
