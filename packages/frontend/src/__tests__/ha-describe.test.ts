import { type FlowNode, NodeSchema } from '@flode/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HomeAssistant } from '../ha';
import { HaDescriptions } from '../ha-describe';

const node: FlowNode = {
  id: 'c',
  type: 'condition',
  position: { x: 0, y: 0 },
  data: { condition: 'sun', after: 'sunset' },
};
const hass: HomeAssistant = {
  states: {},
  language: 'de',
  themes: { darkMode: false },
  localize: (key) => key,
  callApi: () => Promise.reject(new Error('no REST')),
  callWS: () => Promise.reject(new Error('no WS')),
};
const own = { title: 'FLODE', detail: undefined };
const host = { append: () => undefined };

/** How HA's rows render: fail, or show `text` in the condition summary. */
let render: 'fail' | 'ok' = 'ok';
let rowsMade = 0;

function fakeElement(tag: string) {
  const box = {
    style: {},
    inert: false,
    setAttribute: () => undefined,
    append: () => undefined,
    remove: () => undefined,
  };
  if (!tag.endsWith('-row')) return box;
  rowsMade++;
  return {
    ...box,
    updateComplete:
      render === 'fail' ? Promise.reject(new Error('render failed')) : Promise.resolve(true),
    shadowRoot: {
      querySelector: (selector: string) =>
        selector === 'ha-automation-condition-summary' ? { label: 'Nach Sonnenuntergang' } : null,
    },
  };
}

/** Lets the queued flush (microtask + awaits) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("HA's step texts", () => {
  beforeEach(() => {
    rowsMade = 0;
    render = 'ok';
    Object.assign(globalThis, {
      document: { createElement: fakeElement },
      customElements: { get: () => class {} },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'customElements');
  });

  it("reads HA's text and tells the canvas", async () => {
    let ready = 0;
    const texts = new HaDescriptions(
      () => ready++,
      () => host
    );
    expect(texts.summary(node, hass, own).title).toBe('FLODE');
    await settle();
    expect(ready).toBe(1);
    expect(texts.summary(node, hass, own).title).toBe('Nach Sonnenuntergang');
  });

  it.each([
    2700,
    [255, 0, 0],
    { hue: 10, saturation: 20 },
  ])('keeps its own text for attribute states HA cannot describe: %j', async (value) => {
    const texts = new HaDescriptions(
      () => undefined,
      () => host
    );
    for (const key of ['from', 'to', 'not_from', 'not_to']) {
      const trigger = NodeSchema.parse({
        ...node,
        type: 'trigger',
        data: {
          trigger: 'state',
          _raw: {
            trigger: 'state',
            entity_id: 'light.test',
            attribute: 'color',
            [key]: value,
          },
        },
      });
      expect(texts.summary(trigger, hass, own)).toBe(own);
    }
    await settle();
    expect(rowsMade).toBe(0);
  });

  it.each(['on', ['on', 'off'], null])('still requests HA text for state value %j', async (to) => {
    const texts = new HaDescriptions(
      () => undefined,
      () => host
    );
    texts.summary(
      { ...node, type: 'trigger', data: { trigger: 'state', entity_id: 'light.test', to } },
      hass,
      own
    );
    await settle();
    expect(rowsMade).toBe(1);
  });

  it('asks again for a row that failed to render, without a re-render loop', async () => {
    render = 'fail';
    let ready = 0;
    const texts = new HaDescriptions(
      () => ready++,
      () => host
    );
    texts.summary(node, hass, own);
    await settle();
    expect([ready, rowsMade]).toEqual([0, 1]);
    render = 'ok';
    texts.summary(node, hass, own);
    await settle();
    expect([ready, rowsMade]).toEqual([1, 2]);
    expect(texts.summary(node, hass, own).title).toBe('Nach Sonnenuntergang');
  });

  it('asks again once the page has a place for the rows', async () => {
    let page: typeof host | null = null;
    const texts = new HaDescriptions(
      () => undefined,
      () => page
    );
    texts.summary(node, hass, own);
    await settle();
    page = host;
    texts.summary(node, hass, own);
    await settle();
    expect(texts.summary(node, hass, own).title).toBe('Nach Sonnenuntergang');
  });
});
