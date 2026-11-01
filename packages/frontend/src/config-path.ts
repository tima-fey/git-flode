import type { FlowGraph } from '@flode/shared';
import { createConfigPathResolver } from '@flode/ui-core';
import { branchCardForPath, cachedBranchView } from './branch-view';
import type { FlowKind } from './ha';

/** Locate the innermost card named by a Home Assistant validation path. */
export function nodeForPath(graph: FlowGraph, kind: FlowKind, path: string): string | undefined {
  const normalized = kind === 'script' ? path.replace(/^sequence\//, 'action/') : path;
  const resolve = createConfigPathResolver(graph.nodes, graph.edges);
  return branchCardForPath(cachedBranchView(graph), normalized, resolve) ?? resolve(normalized);
}
