// @vitest-environment happy-dom
/**
 * The panel as a real element in a DOM (happy-dom), without Home Assistant: a flow
 * opened as a draft, edits through the panel's own commands, the canvas it renders.
 */
import type { FlowGraph, FlowNode } from '@flode/shared';
import { SCRIPT_START_TRIGGER } from '@flode/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FlodePanel } from '../flode-panel';
import { isMac, shortcutKeys } from '../shortcuts';
import { t } from '../strings';
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
    isNew: true,
    registryEntry: null,
  };
}

async function mountPanel(flow: OpenFlow, readOnly = false, fileMode = false): Promise<FlodePanel> {
  const panel = new FlodePanel();
  panel.fileMode = fileMode;
  panel.readOnly = readOnly;
  document.body.appendChild(panel);
  await panel.updateComplete;
  // The welcome sheet of a first visit is a dialog: while it shows, shortcuts stay off.
  panel.welcome = null;
  panel['openTab'](flow);
  await panel.updateComplete;
  return panel;
}

function toasts(panel: FlodePanel): string[] {
  const messages: string[] = [];
  panel.addEventListener('hass-notification', (event) => {
    if (event instanceof CustomEvent && typeof event.detail?.message === 'string')
      messages.push(event.detail.message);
  });
  return messages;
}

function cardIds(panel: FlodePanel): string[] {
  const canvas = panel.shadowRoot?.querySelector('flode-canvas');
  return [...(canvas?.shadowRoot?.querySelectorAll('.node[data-node-id]') ?? [])].flatMap((el) =>
    el instanceof HTMLElement && el.dataset.nodeId ? [el.dataset.nodeId] : []
  );
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
  it('opens a draft and renders its cards on the canvas', async () => {
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
    panel['duplicateCard'](action);
    panel['duplicateCard'](action);
    panel['duplicateCard'](action);
    await panel.updateComplete;
    const ids = panel.flow?.graph.nodes.map((node) => node.id) ?? [];
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(cardIds(panel).sort()).toEqual([...ids].sort());
  });

  it('refuses a trigger pasted into a script and says why', async () => {
    const start: FlowNode = { ...trigger, id: 'start', data: { trigger: SCRIPT_START_TRIGGER } };
    const panel = await mountPanel(
      draft('script', [start, action], [{ id: 'e1', source: 'start', target: 'action_1' }])
    );
    const messages = toasts(panel);
    panel['pasteCard'](trigger);
    await panel.updateComplete;
    expect(messages).toEqual([t('en', 'pasteNoTriggerInScript')]);
    expect(panel.flow?.graph.nodes.map((node) => node.id)).toEqual(['start', 'action_1']);
    expect(cardIds(panel)).toEqual(['action_1']);
  });

  it('pastes a copied card into an automation under a new id', async () => {
    const panel = await mountPanel(
      draft(
        'automation',
        [trigger, action],
        [{ id: 'e1', source: 'trigger_1', target: 'action_1' }]
      )
    );
    panel['pasteCard'](action);
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
    panel['duplicateCard'](action);
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
    expect(new FlodePanel().fileMode).toBe(true);
    const panel = await mountPanel(viewingFlow(), true);
    const graph = panel.flow?.graph;
    const tabs = panel.tabs.length;
    panel['duplicateCard'](action);
    panel['removeCard'](action.id);
    panel['toggleCard'](action);
    panel['startNew']();
    panel['saveCopy']();
    panel['startRun'](action.id, 'only');
    const canvas = panel.shadowRoot?.querySelector('flode-canvas');
    canvas?.dispatchEvent(
      new CustomEvent('graph-change', {
        detail: { graph: { ...graph, nodes: [] } },
      })
    );
    await panel['save']();
    await panel.updateComplete;
    expect(panel.flow?.graph).toBe(graph);
    expect(panel.tabs).toHaveLength(tabs);
    expect(panel.runFromId).toBeNull();
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
    const ids = panel['paletteEntries']().map((entry) => entry.id);
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
    flow.isNew = false;
    flow.item.source = { file: 'automations/climate/heating.yaml', id: 'existing' };
    const panel = await mountPanel(flow, false, true);
    const tabs = panel.tabs.length;
    panel['startNew']('automation');
    panel['saveCopy']();
    panel['startRun'](action.id, 'only');
    expect(panel.tabs.length).toBe(tabs);
    expect(panel.runFromId).toBeNull();
    panel['duplicateCard'](action);
    await panel.updateComplete;
    expect(panel.flow?.graph.nodes.length).toBe(3);
    const commands = panel['paletteEntries']().map((entry) => entry.id);
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
