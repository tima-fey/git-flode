import deCommon from './de/common.json';
import deNodes from './de/nodes.json';
import enCommon from './en/common.json';
import enNodes from './en/nodes.json';
import esCommon from './es/common.json';
import esNodes from './es/nodes.json';
import frCommon from './fr/common.json';
import frNodes from './fr/nodes.json';
import itCommon from './it/common.json';
import itNodes from './it/nodes.json';
import nlCommon from './nl/common.json';
import nlNodes from './nl/nodes.json';
import ptCommon from './pt/common.json';
import ptNodes from './pt/nodes.json';

/**
 * The `common` and `nodes` i18next namespaces — node summaries, block names
 * and shared labels. Every FLODE UI merges these into its own i18next setup.
 */
export const coreResources = {
  de: { common: deCommon, nodes: deNodes },
  en: { common: enCommon, nodes: enNodes },
  nl: { common: nlCommon, nodes: nlNodes },
  fr: { common: frCommon, nodes: frNodes },
  es: { common: esCommon, nodes: esNodes },
  it: { common: itCommon, nodes: itNodes },
  pt: { common: ptCommon, nodes: ptNodes },
} as const;

export type CoreLanguage = keyof typeof coreResources;
