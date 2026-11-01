import type { TemplateConnection } from '@flode/ui-core';
import { SUMMARY_TRANSLATION_CATEGORIES } from '@flode/ui-core';
/**
 * The slice of Home Assistant's frontend objects FLODE 3 uses. HA passes
 * `hass` into the panel element; everything else (ha-selector, ha-icon,
 * ha-button …) is HA's own web components from the same document.
 */

export interface HassEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
}

/** A field of a service as HA's registry describes it (`services.yaml`). */
export interface HassServiceField {
  name?: string;
  selector?: { number?: { unit_of_measurement?: string } | null } & Record<string, unknown>;
  /** Set on a section (e.g. `advanced_fields`), which groups further fields. */
  fields?: Record<string, HassServiceField>;
}

export interface HassService {
  name?: string;
  fields?: Record<string, HassServiceField>;
}

export interface HomeAssistant {
  user?: { is_admin: boolean };
  states: Record<string, HassEntityState>;
  language: string;
  /** The user's profile formats (Profile → Number / Time format). */
  locale?: { language: string; number_format?: string; time_format?: string };
  themes: { darkMode: boolean };
  localize: (key: string, ...args: unknown[]) => string;
  callApi: <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<T>;
  callWS: <T>(message: Record<string, unknown> & { type: string }) => Promise<T>;
  services?: Record<string, Record<string, HassService>>;
  devices?: Record<string, { name?: string | null; name_by_user?: string | null }>;
  areas?: Record<string, { name: string }>;
  entities?: Record<string, { area_id?: string | null; device_id?: string | null }>;
  config?: { components: string[]; time_zone?: string };
  /** HA's websocket connection (live subscriptions such as `render_template`). */
  connection?: TemplateConnection;
  /** Loads an HA backend translation category (`services`, `title` …) into `localize`. */
  loadBackendTranslation?: (category: string) => Promise<unknown>;
  /** Sidebar setting: `always_hidden` when the user hid it (long-press on "Home Assistant"). */
  dockedSidebar?: 'docked' | 'always_hidden' | 'auto';
  kioskMode?: boolean;
  /** Loads a panel's UI strings into `localize` (HA does this per panel). */
  loadFragmentTranslation?: (fragment: string) => Promise<unknown>;
}

/** HA's description of a service (`light.turn_on`), if it has one. */
export function serviceInfo(hass: HomeAssistant, service: string): HassService | undefined {
  const [domain = '', name = ''] = service.split('.');
  return hass.services?.[domain]?.[name];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function friendlyName(hass: HomeAssistant | undefined, entityId: string): string {
  const name = hass?.states[entityId]?.attributes.friendly_name;
  return typeof name === 'string' ? name : entityId;
}

export type FlowKind = 'automation' | 'script';

export interface AutomationListItem {
  /** File provenance; independent of HA entity/config identifiers. */
  source?: import('@flode/shared').FileAutomationRef;
  /** Automation or script — they have separate config APIs and ids. */
  kind: FlowKind;
  entityId: string;
  /** Config id (`id:` in automations.yaml) — what the config API takes. */
  configId: string;
  name: string;
  enabled: boolean;
  lastTriggered: string | null;
}

type FlowRef = Pick<AutomationListItem, 'kind' | 'configId'>;

/**
 * The name a flow is edited and saved under: the config's own `alias`. The
 * entity's name is only the fallback for a config without one; after a rename
 * in the entity registry it differs, and saving must not write it over the alias.
 */
export function flowName(config: Record<string, unknown>, entityName: string): string {
  return typeof config.alias === 'string' && config.alias.trim() !== '' ? config.alias : entityName;
}

/** The same automation/script — items are re-created on rename or save, so not by identity. */
export function sameFlow(a: FlowRef | undefined, b: FlowRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.kind === b.kind && a.configId === b.configId;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A short fingerprint of a config as HA has it stored. FLODE remembers it
 * when opening or saving a flow; a different one later means the flow was
 * changed in HA meanwhile (HA's editor, YAML, another window).
 */
export function configFingerprint(config: Record<string, unknown>): string {
  const text = stableJson(config);
  // FNV-1a (32 bit) plus the length — enough to tell two versions apart.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${hash.toString(36)}`;
}

/** Made from a blueprint — its steps live in the blueprint, only its inputs in the config. */
export function usesBlueprint(config: Record<string, unknown>): boolean {
  return 'use_blueprint' in config;
}

interface CardHelpers {
  createCardElement: (config: { type: string }) => Promise<{
    constructor: { getConfigElement?: () => Promise<unknown> };
  }>;
}

declare global {
  interface Window {
    loadCardHelpers?: () => Promise<CardHelpers>;
  }
}

let selectorLoad: Promise<boolean> | null = null;

async function probeHaSelector(): Promise<boolean> {
  try {
    const helpers = await window.loadCardHelpers?.();
    const card = await helpers?.createCardElement({ type: 'button' });
    await card?.constructor.getConfigElement?.();
  } catch {
    // Falls through to the definition check.
  }
  return customElements.get('ha-selector') !== undefined;
}

/**
 * HA registers `ha-selector` lazily; opening a card editor forces it
 * (same probe the current FLODE uses). Resolves `false` when it can't.
 */
export function ensureHaSelector(): Promise<boolean> {
  if (customElements.get('ha-selector')) return Promise.resolve(true);
  selectorLoad ??= probeHaSelector();
  return selectorLoad;
}

interface RouteLoader {
  routerOptions: { routes: Record<string, { load: () => Promise<unknown> }> };
}

const AUTOMATION_EDITOR_TAGS = [
  'ha-script-editor',
  'ha-script-fields',
  'ha-automation-trigger-editor',
  'ha-automation-condition-editor',
  'ha-automation-action-editor',
  'ha-automation-trigger',
  'ha-automation-condition',
  'ha-automation-action',
];

let editorLoad: Promise<boolean> | null = null;

async function loadAutomationEditors(): Promise<boolean> {
  try {
    // HA only registers its automation editors inside the config panel. Resolve
    // that panel's route loaders the way HA itself does when you open
    // Settings → Automations — nothing gets rendered.
    await customElements.whenDefined('partial-panel-resolver');
    const resolver = document.createElement('partial-panel-resolver') as unknown as {
      _getRoutes: (panels: Record<string, unknown>) => RouteLoader['routerOptions'];
    };
    const routes = resolver._getRoutes({
      flode_config: { url_path: 'flode_config', component_name: 'config' },
    }).routes;
    await routes.flode_config?.load();
    await customElements.whenDefined('ha-panel-config');
    const config = document.createElement('ha-panel-config') as unknown as RouteLoader;
    await config.routerOptions.routes.automation?.load();
    await config.routerOptions.routes.script?.load();
  } catch {
    // Falls through to the definition check — the inspector keeps the YAML editor.
  }
  return AUTOMATION_EDITOR_TAGS.every((tag) => customElements.get(tag) !== undefined);
}

/**
 * HA's own trigger/condition/action editors and add dialogs — the forms of
 * Settings → Automations. Resolves `false` if this HA version can't provide them.
 */
export function ensureAutomationEditors(hass: HomeAssistant | undefined): Promise<boolean> {
  // The editors' labels live in the config panel's translation fragment.
  editorLoad ??= Promise.all([
    AUTOMATION_EDITOR_TAGS.every((tag) => customElements.get(tag))
      ? Promise.resolve(true)
      : loadAutomationEditors(),
    hass?.loadFragmentTranslation?.('config').catch(() => undefined),
  ]).then(([ready]) => {
    // Not ready (yet): the next caller tries again instead of getting `false` forever.
    if (!ready) editorLoad = null;
    return ready;
  });
  return editorLoad;
}

const translationsLoaded = new Set<string>();

/** HA's own names for services, triggers, conditions and integrations (once per language). */
export function loadSummaryTranslations(hass: HomeAssistant): void {
  if (translationsLoaded.has(hass.language)) return;
  translationsLoaded.add(hass.language);
  for (const category of SUMMARY_TRANSLATION_CATEGORIES) {
    void hass.loadBackendTranslation?.(category).catch(() => undefined);
  }
}

// ---- automation settings: HA's own rename + mode dialogs --------------------

/** Automation-level settings HA's dialogs edit (alias/description, mode/max). */
export interface AutomationSettings {
  alias: string;
  description: string;
  mode: string;
  max?: number;
  max_exceeded?: string;
  /** Scripts only (HA's rename dialog offers it for scripts). */
  icon?: string;
}

type DialogKind = 'alias' | 'mode';

/** HA's editor element per flow kind and the names its dialog methods use. */
const EDITOR = {
  automation: {
    tag: 'ha-automation-editor',
    alias: '_promptAutomationAlias',
    mode: '_promptAutomationMode',
    idKey: 'automationId',
    save: '_saveAutomation',
  },
  script: {
    tag: 'ha-script-editor',
    alias: '_promptScriptAlias',
    mode: '_promptScriptMode',
    idKey: 'scriptId',
    save: '_saveScript',
  },
} as const satisfies Record<FlowKind, Record<string, string>>;

/** Identity supplied to HA's native settings dialog. */
function editorIdentity(flowKind: FlowKind, configId: string | undefined): Record<string, unknown> {
  return { [EDITOR[flowKind].idKey]: configId, registryEntry: undefined, entityRegistry: [] };
}

/**
 * Runs one of HA's automation-editor dialog methods (rename, mode, "unsaved
 * changes"). They're methods of HA's own editor that read and write
 * `this.config` etc.; `host` stands in for that editor (it must be in the
 * document so HA's dialog event reaches `home-assistant`). Returns what the
 * method resolved plus the host carrying the edited state.
 */
async function runEditorDialog(
  hass: HomeAssistant,
  host: HTMLElement,
  flowKind: FlowKind,
  method: string,
  state: Record<string, unknown>
): Promise<{ result: unknown; editor: HTMLElement; changed: boolean } | null> {
  if (!(await ensureAutomationEditors(hass))) return null;
  const run: unknown = customElements.get(EDITOR[flowKind].tag)?.prototype[method];
  if (typeof run !== 'function') return null;
  let changed = false;
  const legacy = Object.fromEntries(
    Object.entries(state).flatMap(([key, value]) => {
      const old = LEGACY_EDITOR_FIELDS[key];
      return old ? [[old, value]] : [];
    })
  );
  const editor = Object.assign(
    host,
    state,
    { _dirty: false, ...legacy },
    {
      hass,
      _updateDirtyState: () => {
        changed = true;
      },
      // HA 2026.10's "unsaved changes" dialog calls this on "Don't save"; without it the promise never resolves.
      _markDirtyStateClean: () => undefined,
      requestUpdate: () => undefined,
    }
  );
  initialEditorState.set(editor, state);
  const wasDirty = Reflect.get(editor, '_dirty') === true;
  const result: unknown = await Reflect.apply(run, editor, []);
  // HA before 2026.9 marks the change with `this._dirty = true` instead of `_updateDirtyState()`.
  if (!wasDirty && Reflect.get(editor, '_dirty') === true) changed = true;
  return { result, editor, changed };
}

/**
 * HA renamed its editors' internal fields in 2026.9 (`_config` → `config` …).
 * The dialogs of both generations read and write their own names, so FLODE
 * sets both and reads back whichever the dialog changed.
 */
const LEGACY_EDITOR_FIELDS: Record<string, string> = {
  config: '_config',
  entityRegistryUpdate: '_entityRegistryUpdate',
  registryEntry: '_registryEntry',
  currentEntityId: '_entityId',
  isDirtyState: '_dirty',
  entityRegCreated: '_entityRegCreated',
};
const initialEditorState = new WeakMap<HTMLElement, Record<string, unknown>>();

function editorField(editor: HTMLElement, name: string): unknown {
  const current: unknown = Reflect.get(editor, name);
  const oldName = LEGACY_EDITOR_FIELDS[name];
  if (!oldName) return current;
  const old: unknown = Reflect.get(editor, oldName);
  const initial = initialEditorState.get(editor)?.[name];
  return old !== undefined && old !== initial ? old : current;
}

function settingsFrom(editor: HTMLElement, fallback: AutomationSettings): AutomationSettings {
  const config = editorField(editor, 'config');
  if (!isRecord(config)) return fallback;
  return {
    alias: typeof config.alias === 'string' ? config.alias : fallback.alias,
    description: typeof config.description === 'string' ? config.description : '',
    mode: typeof config.mode === 'string' ? config.mode : 'single',
    max: typeof config.max === 'number' ? config.max : undefined,
    max_exceeded: typeof config.max_exceeded === 'string' ? config.max_exceeded : undefined,
    icon: typeof config.icon === 'string' && config.icon ? config.icon : undefined,
  };
}

/**
 * Opens HA's own "rename" (name, description, area, category, labels) or
 * "mode" dialog — the ones of Settings → Automations. Resolves the edited
 * settings, or `null` when cancelled.
 */
export async function promptAutomationDialog(
  hass: HomeAssistant,
  host: HTMLElement,
  target: { flowKind: FlowKind; configId: string | undefined },
  kind: DialogKind,
  settings: AutomationSettings
): Promise<{ settings: AutomationSettings } | null> {
  const config = { ...settings };
  const run = await runEditorDialog(hass, host, target.flowKind, EDITOR[target.flowKind][kind], {
    ...editorIdentity(target.flowKind, target.configId),
    config,
  });
  if (!run?.changed) return null;
  return {
    settings: settingsFrom(run.editor, settings),
  };
}

/**
 * HA's own "unsaved changes" dialog (Save / Discard / Cancel), as HA's
 * editor shows it when leaving. `save` runs when the user picks Save, with
 * the name etc. entered there. Resolves `true` to go on (saved or
 * discarded), `false` to stay.
 */
export async function confirmUnsavedChanges(
  hass: HomeAssistant,
  host: HTMLElement,
  options: {
    flowKind: FlowKind;
    /** `undefined` for a flow that isn't in HA yet. */
    configId: string | undefined;
    settings: AutomationSettings;
    save: (settings: AutomationSettings) => Promise<boolean>;
  }
): Promise<boolean> {
  const run = await runEditorDialog(hass, host, options.flowKind, 'confirmUnsavedChanged', {
    ...editorIdentity(options.flowKind, options.configId),
    isDirtyState: true,
    config: { ...options.settings },
    [EDITOR[options.flowKind].save]: async function (this: HTMLElement) {
      const ok = await options.save(settingsFrom(this, options.settings));
      if (!ok) throw new Error('save failed');
    },
  });
  return run?.result === true;
}

/** Readable text for errors from `hass.callApi` / `callWS` (HA puts the reason in `body.message`). */
export function errorMessage(error: unknown): string {
  if (isRecord(error)) {
    const body = error.body;
    if (isRecord(body) && typeof body.message === 'string') return body.message;
    if (typeof error.message === 'string') return error.message;
    if (typeof error.error === 'string') return error.error;
  }
  return error instanceof Error ? error.message : String(error);
}
