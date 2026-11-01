import { isPlainObject, isTemplateString, toList } from '@flode/shared';

/** Static references used by card validation. */
export type ReferenceRole = 'trigger' | 'condition' | 'action' | 'template';

export interface EntityReference {
  entityId: string;
  role: ReferenceRole;
  service?: string;
}

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
/**
 * Entity ids inside Jinja: `states('x.y')`, `is_state("x.y", …)`, `states.x.y`,
 * `expand('x.y')` … — a domain starts with a letter (never `'0.5'`).
 */
const TEMPLATE_ENTITY =
  /(?:['"]([a-z][a-z_]*\.[a-z0-9_]+)['"])|(?:states\.([a-z][a-z_]*\.[a-z0-9_]+))/g;

/**
 * Domains Home Assistant has entities in. A quoted `x.y` in a template is only
 * taken for an entity with one of these — `'bild.jpg'` or `'example.com'` are
 * not.
 */
const ENTITY_DOMAINS = new Set([
  'ai_task',
  'air_quality',
  'alarm_control_panel',
  'alert',
  'assist_satellite',
  'automation',
  'binary_sensor',
  'button',
  'calendar',
  'camera',
  'climate',
  'conversation',
  'counter',
  'cover',
  'date',
  'datetime',
  'device_tracker',
  'event',
  'fan',
  'geo_location',
  'group',
  'humidifier',
  'image',
  'image_processing',
  'input_boolean',
  'input_button',
  'input_datetime',
  'input_number',
  'input_select',
  'input_text',
  'lawn_mower',
  'light',
  'lock',
  'media_player',
  'notify',
  'number',
  'person',
  'plant',
  'remote',
  'scene',
  'schedule',
  'script',
  'select',
  'sensor',
  'siren',
  'stt',
  'sun',
  'switch',
  'text',
  'time',
  'timer',
  'todo',
  'tts',
  'update',
  'vacuum',
  'valve',
  'wake_word',
  'water_heater',
  'weather',
  'zone',
]);

/** Domains that are not real entities (a service like `notify.mobile_app_x` or `persistent_notification`). */
const NON_ENTITY_DOMAINS = new Set(['notify', 'tts', 'persistent_notification', 'homeassistant']);

function serviceName(service: string): string {
  return service.slice(service.indexOf('.') + 1);
}

function entityIdsIn(value: unknown): string[] {
  return toList(value).flatMap((v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((part) => part.trim())
          .filter((part) => ENTITY_ID.test(part))
      : []
  );
}

export function templateEntityIds(text: string): string[] {
  if (!isTemplateString(text)) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(TEMPLATE_ENTITY)) {
    const id = match[1] ?? match[2];
    const domain = id?.split('.')[0] ?? '';
    if (id && ENTITY_DOMAINS.has(domain) && !NON_ENTITY_DOMAINS.has(domain)) found.add(id);
  }
  return [...found];
}

function stepService(step: Record<string, unknown>): string | undefined {
  const service = step.action ?? step.service;
  return typeof service === 'string' && service.includes('.') && !isTemplateString(service)
    ? service
    : undefined;
}

/** Payloads of a step — values in there are data, never a service call. */
const PAYLOAD_KEYS = new Set(['data', 'data_template', 'event_data', 'variables', 'for_each']);

/** Every service a step calls (`light.turn_on`), also inside blocks — not inside its payload. */
export function collectServices(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isPlainObject(node)) return;
    const service = stepService(node);
    if (service) found.add(service);
    for (const [key, child] of Object.entries(node)) {
      if (!PAYLOAD_KEYS.has(key)) walk(child);
    }
  };
  walk(value);
  return [...found];
}

/** A step, condition or trigger switched off with HA's `enabled: false` — it never runs. */
function isDisabled(step: Record<string, unknown>): boolean {
  return step.enabled === false;
}

/**
 * Collects all entity references of one config. `role` is the section the
 * walk is in; conditions nested inside actions (`if`, `choose`, `condition:`
 * steps) count as conditions.
 */
export function collectReferences(config: Record<string, unknown>): EntityReference[] {
  const refs: EntityReference[] = [];
  const seen = new Set<string>();
  const add = (ref: EntityReference) => {
    const key = `${ref.entityId}|${ref.role}|${ref.service ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  const walkTemplates = (value: unknown) => {
    if (typeof value === 'string') {
      for (const entityId of templateEntityIds(value)) add({ entityId, role: 'template' });
    } else if (Array.isArray(value)) {
      value.forEach(walkTemplates);
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(walkTemplates);
    }
  };

  const walkTrigger = (trigger: unknown) => {
    if (!isPlainObject(trigger) || isDisabled(trigger)) return;
    for (const entityId of entityIdsIn(trigger.entity_id)) add({ entityId, role: 'trigger' });
    if (isPlainObject(trigger.target)) {
      for (const entityId of entityIdsIn(trigger.target.entity_id)) {
        add({ entityId, role: 'trigger' });
      }
    }
    // `zone` triggers: the person/device is `entity_id`, the zone is a trigger input too.
    for (const entityId of entityIdsIn(trigger.zone)) add({ entityId, role: 'trigger' });
    walkTemplates(trigger);
  };

  const walkCondition = (condition: unknown) => {
    if (typeof condition === 'string') {
      walkTemplates(condition);
      return;
    }
    if (!isPlainObject(condition) || isDisabled(condition)) return;
    for (const entityId of entityIdsIn(condition.entity_id)) add({ entityId, role: 'condition' });
    if (isPlainObject(condition.target)) {
      for (const entityId of entityIdsIn(condition.target.entity_id)) {
        add({ entityId, role: 'condition' });
      }
    }
    for (const entityId of entityIdsIn(condition.zone)) add({ entityId, role: 'condition' });
    toList(condition.conditions).forEach(walkCondition);
    walkTemplates(condition);
  };

  const walkActions = (actions: unknown) => {
    for (const step of toList(actions)) walkAction(step);
  };

  const walkAction = (step: unknown) => {
    if (!isPlainObject(step) || isDisabled(step)) return;
    const service = stepService(step);
    if (service) {
      const targets = [
        ...entityIdsIn(step.entity_id),
        ...(isPlainObject(step.target) ? entityIdsIn(step.target.entity_id) : []),
        ...(isPlainObject(step.data) ? entityIdsIn(step.data.entity_id) : []),
      ];
      const [domain] = service.split('.');
      // `script.my_script` / `automation.trigger` style: the called script is the target.
      if (
        domain === 'script' &&
        !['turn_on', 'turn_off', 'toggle', 'reload'].includes(serviceName(service))
      ) {
        add({ entityId: service, role: 'action', service: 'script.turn_on' });
      }
      for (const entityId of targets) add({ entityId, role: 'action', service });
    }
    if (typeof step.scene === 'string' && ENTITY_ID.test(step.scene)) {
      add({ entityId: step.scene, role: 'action', service: 'scene.turn_on' });
    }
    // A bare condition step (`- condition: state …`).
    if (typeof step.condition === 'string') walkCondition(step);
    // Wait-for-trigger / wait-template
    toList(step.wait_for_trigger).forEach(walkTrigger);
    if (typeof step.wait_template === 'string') walkTemplates(step.wait_template);
    // if / then / else
    if (step.if !== undefined) {
      toList(step.if).forEach(walkCondition);
      walkActions(step.then);
      walkActions(step.else);
    }
    // choose
    for (const option of toList(step.choose)) {
      if (!isPlainObject(option)) continue;
      toList(option.conditions).forEach(walkCondition);
      walkActions(option.sequence);
    }
    walkActions(step.default);
    // repeat
    if (isPlainObject(step.repeat)) {
      toList(step.repeat.while).forEach(walkCondition);
      toList(step.repeat.until).forEach(walkCondition);
      walkActions(step.repeat.sequence);
      walkTemplates(step.repeat.for_each);
    }
    // parallel / sequence blocks
    for (const branch of toList(step.parallel)) {
      if (isPlainObject(branch) && branch.sequence !== undefined) walkActions(branch.sequence);
      else walkAction(branch);
    }
    walkActions(step.sequence);
    // Templates inside data/variables/messages still count as reads.
    walkTemplates(step.data);
    walkTemplates(step.variables);
    walkTemplates(step.value_template);
  };

  toList(config.triggers ?? config.trigger).forEach(walkTrigger);
  toList(config.conditions ?? config.condition).forEach(walkCondition);
  walkActions(config.actions ?? config.action ?? config.sequence);
  walkTemplates(config.variables);
  return refs;
}
