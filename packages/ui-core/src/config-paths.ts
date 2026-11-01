import { isConditionStep, isPlainObject } from '@flode/shared';

/**
 * Maps Home Assistant configuration step paths (`trigger/0`, `condition/0`,
 * `action/1`, `action/0/then/0`, `action/0/if/condition/0`, …) to FLODE node
 * ids by walking the flow graph the same way the native transpiler lays it
 * out:
 *
 * - conditions right after the triggers that continue through only one
 *   output become the top-level `conditions:` block (`condition/N`; a No-only
 *   one as `not: …`);
 * - every other step is part of the `actions:` sequence (`action/N`), where a
 *   condition with a Yes-and-No branch is one `if` step whose branches are
 *   nested (`…/then/K`, `…/else/K`) and the flow continues where both
 *   branches meet; a condition with only a Yes branch nests everything after
 *   it under `then`.
 *
 * Shapes it can't follow (choose blocks, repeats, parallel fan-out, trigger-id
 * routing) resolve to `undefined` — the caller counts those as unmapped.
 */

export interface ConfigGraphNode {
  id: string;
  type?: string;
  /** Card data — tells a condition step of the actions (`isConditionStep`) from an `if`. */
  data?: unknown;
}

export interface ConfigGraphEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
  type?: string;
}

/** Visual-only / back edges that don't describe the forward execution order. */
const IGNORED_EDGE_TYPES = new Set(['hint', 'loop-back', 'choose-chain', 'choose-default']);

export function createConfigPathResolver(
  nodes: readonly ConfigGraphNode[],
  edges: readonly ConfigGraphEdge[]
): (path: string) => string | undefined {
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const dataOf = new Map(nodes.map((n) => [n.id, n.data]));
  const flowEdges = edges.filter((e) => !IGNORED_EDGE_TYPES.has(e.type ?? ''));

  const successors = (id: string, handle?: 'true' | 'false'): string[] =>
    flowEdges
      .filter(
        (e) =>
          e.source === id &&
          (handle === undefined ||
            (handle === 'true' ? e.sourceHandle !== 'false' : e.sourceHandle === 'false'))
      )
      .map((e) => e.target);

  const single = (ids: string[]): string | undefined =>
    new Set(ids).size === 1 ? ids[0] : undefined;

  /** A condition card that HA had in the actions (`- condition: …`), not in `conditions:`. */
  const cameAsStep = (id: string): boolean => {
    const data = dataOf.get(id);
    return isPlainObject(data) && isConditionStep(data);
  };

  /**
   * A condition that HA had as a plain `- condition:` step of the actions and
   * that still has no No path — the transpiler writes it back as that step:
   * it stays in the actions, and the steps after it are its siblings.
   */
  const isPlainStep = (id: string): boolean =>
    typeOf.get(id) === 'condition' && cameAsStep(id) && successors(id, 'false').length === 0;

  /** First node reachable from both `a` and `b` (breadth-first from `a`). */
  const mergePoint = (a: string, b: string): string | undefined => {
    const reach = (start: string) => {
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        queue.push(...successors(id));
      }
      return seen;
    };
    const fromB = reach(b);
    const seen = new Set<string>();
    const queue = [a];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      if (fromB.has(id)) return id;
      queue.push(...successors(id));
    }
    return undefined;
  };

  /** Top-level steps of a sequence starting at `start`, ending before `stop`. */
  const sequenceFrom = (start: string | undefined, stop?: string): string[] => {
    const steps: string[] = [];
    let current = start;
    while (current && current !== stop && !steps.includes(current)) {
      steps.push(current);
      if (typeOf.get(current) === 'condition' && !isPlainStep(current)) {
        const yes = single(successors(current, 'true'));
        const no = single(successors(current, 'false'));
        // Only-Yes branch: everything after is nested under `then`.
        current = yes && no ? mergePoint(yes, no) : undefined;
      } else {
        current = single(successors(current));
      }
    }
    return steps;
  };

  const triggers = nodes.filter((n) => n.type === 'trigger').map((n) => n.id);

  /**
   * The one output a condition right after the triggers continues through —
   * like the transpiler's `extractLeadingConditions`: only Yes (kept as is) or
   * only No (becomes `not: …`); `undefined` when it branches or has neither.
   */
  const leadingHandle = (id: string): 'true' | 'false' | undefined => {
    const handles = new Set(
      flowEdges.filter((e) => e.source === id).map((e) => e.sourceHandle ?? null)
    );
    if (handles.size !== 1) return undefined;
    const [handle] = handles;
    return handle === 'true' || handle === 'false' ? handle : undefined;
  };

  // Top-level `conditions:` — single-output conditions straight after the triggers.
  const topConditions: string[] = [];
  let next = single(triggers.flatMap((id) => successors(id)));
  while (
    next &&
    typeOf.get(next) === 'condition' &&
    !cameAsStep(next) &&
    !topConditions.includes(next)
  ) {
    const handle = leadingHandle(next);
    if (!handle) break;
    topConditions.push(next);
    next = single(successors(next, handle));
  }
  const mainSequence = sequenceFrom(next);

  /** Resolves `…/then/K` / `…/else/K` / `…/if/…` below the `if` step `conditionId`. */
  const resolveNested = (conditionId: string, rest: string[]): string | undefined => {
    const [branch, indexStr, ...deeper] = rest;
    if (branch === undefined || branch === 'if') return conditionId;
    if (branch !== 'then' && branch !== 'else') return undefined;
    const yes = single(successors(conditionId, 'true'));
    const no = single(successors(conditionId, 'false'));
    const stop = yes && no ? mergePoint(yes, no) : undefined;
    const branchSteps = sequenceFrom(branch === 'then' ? yes : no, stop);
    return resolveStep(branchSteps, indexStr, deeper);
  };

  const resolveStep = (
    steps: string[],
    indexStr: string | undefined,
    rest: string[]
  ): string | undefined => {
    const id = steps[Number(indexStr)];
    if (id === undefined) return undefined;
    if (rest.length === 0) return id;
    // A step nested in any other card (a HA block, an opaque repeat …) belongs to that card.
    return typeOf.get(id) === 'condition' && !isPlainStep(id) ? resolveNested(id, rest) : id;
  };

  return (path) => {
    const [root, indexStr, ...rest] = path.split('/');
    switch (root) {
      // Deeper paths (e.g. `condition/0/entity_id/0`) are sub-results of the same step.
      case 'trigger':
        return triggers[Number(indexStr)];
      case 'condition':
        return topConditions[Number(indexStr)];
      case 'action':
        return resolveStep(mainSequence, indexStr, rest);
      default:
        return undefined;
    }
  };
}
