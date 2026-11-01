// @vitest-environment happy-dom
/**
 * The panel as a real element in a DOM (happy-dom), without Home Assistant: a flow
 * opened from an existing file, edits through the panel's own commands, the canvas it renders.
 */
import type { FlowGraph, FlowNode } from '@flode/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FlodePanel } from '../flode-panel';
import { isMac, shortcutKeys } from '../shortcuts';
import type { OpenFlow } from '../tabs';

const trigger: FlowNode = {
  id: 'trigger_1',
  type: 'trigger',
  position: { x: 0, y: 0 },
  data: { trigger: 'state', entity_id: 'binary_sensor.movement', to: 'on' },
};
const action: FlowNode = {
  id: 'action_1',
  type: 'action',
  position: { x: 360, y: 0 },
  data: { service: 'light.turn_on', target: { entity_id: 'light.kitchen' } },
};
function draft(
  kind: 'automation' | 'script',
  nodes: FlowNode[],
  edges: FlowGraph['edges']
): OpenFlow {
  return {
    item: {
      source: { file: 'automations/example.yaml', id: 'existing' },
      kind,
      entityId: '',
      configId: 'draft',
      name: 'Draft',
      enabled: true,
      lastTriggered: null,
    },
    graph: {
      id: '00000000-0000-4000-8000-000000000002',
      version: 1,
      name: 'Draft',
      nodes,
      edges,
      metadata: { mode: 'single', ...(kind === 'script' ? { kind } : {}) },
    },
    fileDirectory: '/project',
    fileVersion: 'version',
  };
}
async function mountPanel(flow: OpenFlow, readOnly = false): Promise<FlodePanel> {
  const panel = new FlodePanel();
  panel.readOnly = readOnly;
  document.body.appendChild(panel);
  await panel.updateComplete;
  // The welcome sheet of a first visit is a dialog: while it shows, shortcuts stay off.
  panel.welcome = null;
  panel.tabs = [
    { id: 'existing-tab', flow, past: [], future: [], saveState: 'saved', selectedId: null },
  ];
  panel.activeTabId = 'existing-tab';
  panel.flow = flow;
  panel.showHome = false;
  await panel.updateComplete;
  return panel;
}
function cardIds(panel: FlodePanel): string[] {
  const canvas = panel.shadowRoot?.querySelector('flode-canvas');
  return [...(canvas?.shadowRoot?.querySelectorAll('.node[data-node-id]') ?? [])].flatMap((el) =>
    el instanceof HTMLElement && el.dataset.nodeId ? [el.dataset.nodeId] : []
  );
}
async function paletteIds(panel: FlodePanel): Promise<string[]> {
  pressOnWindow('k', true);
  await panel.updateComplete;
  const palette = panel.shadowRoot?.querySelector('flode-palette');
  if (!palette?.open) throw new Error('Missing open command palette');
  return palette.entries.map((entry) => entry.id);
}
/** A key as the user presses it, on the window (where HA and the panel listen). */
function pressOnWindow(key: string, mod = false): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      metaKey: mod && isMac(),
      ctrlKey: mod && !isMac(),
      bubbles: true,
      cancelable: true,
    })
  );
}
afterEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
});
describe('panel in the DOM', () => {
  it('renders an existing automation tab and its cards on the canvas', async () => {
    const panel = await mountPanel(
      draft(
        'automation',
        [trigger, action],
        [{ id: 'e1', source: 'trigger_1', target: 'action_1' }]
      )
    );
    expect(panel.flow?.graph.nodes).toHaveLength(2);
    expect(cardIds(panel).sort()).toEqual(['action_1', 'trigger_1']);
  });
  it('gives every duplicate its own id, also two in the same millisecond, and draws them', async () => {
    const panel = await mountPanel(
      draft(
        'automation',
        [trigger, action],
        [{ id: 'e1', source: 'trigger_1', target: 'action_1' }]
      )
    );
    panel.selectedId = action.id;
    pressOnWindow('d', true);
    panel.selectedId = action.id;
    pressOnWindow('d', true);
    panel.selectedId = action.id;
    pressOnWindow('d', true);
    await panel.updateComplete;
    const ids = panel.flow?.graph.nodes.map((node) => node.id) ?? [];
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(cardIds(panel).sort()).toEqual([...ids].sort());
  });
  it('pastes a copied card into an automation under a new id', async () => {
    const panel = await mountPanel(
      draft(
        'automation',
        [trigger, action],
        [{ id: 'e1', source: 'trigger_1', target: 'action_1' }]
      )
    );
    panel.selectedId = action.id;
    pressOnWindow('c', true);
    pressOnWindow('v', true);
    await panel.updateComplete;
    const ids = panel.flow?.graph.nodes.map((node) => node.id) ?? [];
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
  it('closes the card menu on Escape', async () => {
    const panel = await mountPanel(
      draft(
        'automation',
        [trigger, action],
        [{ id: 'e1', source: 'trigger_1', target: 'action_1' }]
      )
    );
    panel.canvasMenu = {
      nodeId: 'action_1',
      clientX: 10,
      clientY: 10,
      position: { x: 0, y: 0 },
    };
    await panel.updateComplete;
    const menu = () => panel.shadowRoot?.querySelector('.work > ha-dropdown') ?? null;
    expect(menu()).not.toBeNull();
    // The entries carry their shortcut as a hint, "delete" the Backspace key (#32, #35).
    const hints = [...(menu()?.querySelectorAll('[slot="details"]') ?? [])].map((el) =>
      el.textContent?.trim()
    );
    expect(hints).toContain(shortcutKeys('delete'));
    pressOnWindow('Escape');
    await panel.updateComplete;
    expect(panel.canvasMenu).toBeNull();
    expect(menu()).toBeNull();
  });
  it('undoes a duplicate with the undo shortcut and redraws the canvas', async () => {
    const panel = await mountPanel(
      draft(
        'automation',
        [trigger, action],
        [{ id: 'e1', source: 'trigger_1', target: 'action_1' }]
      )
    );
    panel.selectedId = action.id;
    pressOnWindow('d', true);
    await panel.updateComplete;
    expect(cardIds(panel)).toHaveLength(3);
    pressOnWindow('z', true);
    await panel.updateComplete;
    expect(panel.flow?.graph.nodes).toHaveLength(2);
    expect(cardIds(panel).sort()).toEqual(['action_1', 'trigger_1']);
  });
});
describe('viewing mode', () => {
  const viewingFlow = () =>
    draft('automation', [trigger, action], [{ id: 'e1', source: trigger.id, target: action.id }]);
  it('supports viewing mode and blocks document edits through commands and events', async () => {
    const panel = await mountPanel(viewingFlow(), true);
    const graph = panel.flow?.graph;
    const tabs = panel.tabs.length;
    panel.selectedId = action.id;
    pressOnWindow('d', true);
    panel.shadowRoot
      ?.querySelector('flode-inspector')
      ?.dispatchEvent(new CustomEvent('delete', { detail: { id: action.id } }));
    pressOnWindow('e', true);
    const canvas = panel.shadowRoot?.querySelector('flode-canvas');
    canvas?.dispatchEvent(
      new CustomEvent('graph-change', {
        detail: { graph: { ...graph, nodes: [] } },
      })
    );
    pressOnWindow('s', true);
    await panel.updateComplete;
    expect(panel.flow?.graph).toBe(graph);
    expect(panel.tabs).toHaveLength(tabs);
    expect(cardIds(panel).sort()).toEqual([action.id, trigger.id]);
  });
  it('blocks mutation shortcuts and omits editing palette commands', async () => {
    const panel = await mountPanel(viewingFlow(), true);
    panel.selectedId = action.id;
    const graph = panel.flow?.graph;
    for (const key of ['d', 'e', 'v', 's', 'z', 'b']) pressOnWindow(key, true);
    await panel.updateComplete;
    expect(panel.flow?.graph).toBe(graph);
    expect(panel.addOpen).toBe(false);
    const ids = await paletteIds(panel);
    expect(ids).toContain('fit');
    expect(ids).toContain('showYaml');
    for (const id of [
      'new',
      'save',
      'saveCopy',
      'duplicate',
      'runFrom',
      'merge',
      'importYaml',
      'tidy',
    ])
      expect(ids).not.toContain(id);
  });
  it('keeps card inspection without editable forms, run buttons, or layout handles', async () => {
    const panel = await mountPanel(viewingFlow(), true);
    panel.selectedId = action.id;
    await panel.updateComplete;
    const canvas = panel.shadowRoot?.querySelector('flode-canvas');
    const inspector = panel.shadowRoot?.querySelector('flode-inspector');
    await inspector?.updateComplete;
    expect(canvas?.readOnly).toBe(true);
    expect(inspector?.readOnly).toBe(true);
    expect(inspector?.shadowRoot?.querySelector('pre')?.textContent).toContain('light.turn_on');
    expect(inspector?.shadowRoot?.querySelector('ha-icon-button')).toBeNull();
    expect(canvas?.shadowRoot?.querySelector('.add-next')).toBeNull();
    expect(panel.shadowRoot?.querySelector('.toolbar .save')).toBeNull();
  });
});
describe('existing-file editing', () => {
  it('allows graph edits but blocks new automations, copies, and execution', async () => {
    const flow = draft(
      'automation',
      [trigger, action],
      [{ id: 'e1', source: trigger.id, target: action.id }]
    );
    flow.item.source = { file: 'automations/climate/heating.yaml', id: 'existing' };
    const panel = await mountPanel(flow);
    const tabs = panel.tabs.length;
    expect(panel.tabs.length).toBe(tabs);
    panel.selectedId = action.id;
    pressOnWindow('d', true);
    await panel.updateComplete;
    expect(panel.flow?.graph.nodes.length).toBe(3);
    const commands = await paletteIds(panel);
    for (const id of [
      'new',
      'newScript',
      'saveCopy',
      'importYaml',
      'importJson',
      'merge',
      'runOnly',
      'runFrom',
    ])
      expect(commands).not.toContain(id);
  });
});
