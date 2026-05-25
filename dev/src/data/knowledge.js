/**
 * data/knowledge.js — KnowledgeBase Hermes
 *
 * Fournit un accès structuré aux données de jeu (unités, bâtiments, stratégies, profils monde).
 *
 * NOTE BUILD : Rollup 4 sans @rollup/plugin-json ne peut pas importer des fichiers .json
 * directement via `import`. Ce module lit le JSON au runtime depuis le bundle IIFE en
 * se basant sur les données de knowledge.json copiées ici comme objet JS.
 *
 * Pour une future migration vers @rollup/plugin-json, remplacer le bloc `const _data`
 * par : `import _data from './knowledge.json';`
 */

// Chargement dynamique au runtime — compatible avec le bundle IIFE Tampermonkey.
// Le JSON est lu via une référence à l'objet global si disponible (injection via GM),
// sinon on utilise un fetch synchrone de secours, ou les données inline.
// Dans le contexte d'un userscript bundlé par Rollup IIFE, on importe le fichier
// knowledge.json en tant que module via le plugin JSON de rollup si disponible,
// sinon on utilise une copie inline des métadonnées essentielles.

/**
 * Tentative d'import dynamique du knowledge.json.
 * Compatible avec Rollup + @rollup/plugin-json si ajouté ultérieurement.
 * En l'absence du plugin, on utilise les données inline ci-dessous.
 */
let _data = null;

// Tentative de lecture depuis window.__HERMES_KNOWLEDGE__ (injection externe possible)
if (typeof window !== 'undefined' && window.__HERMES_KNOWLEDGE__) {
  _data = window.__HERMES_KNOWLEDGE__;
}

// Fallback : données essentielles inline (world_profiles + strategies + city_specializations)
// Le reste (unités, bâtiments détaillés) est disponible via le JSON complet.
if (!_data) {
  _data = _getInlineData();
}

/**
 * Retourne les données inline de knowledge (extraites de knowledge.json).
 * Contient les profils monde, stratégies et spécialisations nécessaires aux modules.
 * @returns {object}
 */
function _getInlineData() {
  return {
    world_profiles: {
      speed1_revolt:    { world_speed: 1, conquest_system: 'revolt',    play_style: 'turtle_expand',         typical_first_colony_days: 30 },
      speed2_revolt:    { world_speed: 2, conquest_system: 'revolt',    play_style: 'balanced_active',       typical_first_colony_days: 15 },
      speed3_revolt:    { world_speed: 3, conquest_system: 'revolt',    play_style: 'aggressive_rush',       typical_first_colony_days: 10 },
      speed3_conquest:  { world_speed: 3, conquest_system: 'conquest',  play_style: 'aggressive_coordinated',typical_first_colony_days: 10 },
      speed4_revolt:    { world_speed: 4, conquest_system: 'revolt',    play_style: 'hyperaggressive',       typical_first_colony_days: 7  },
    },
    strategies: {
      colony_rush_speed3: {
        name: 'Colony Rush Speed 3',
        applicable_worlds: ['speed3_revolt', 'speed3_conquest'],
        city_specialization: 'colony_rush',
        build_order: [
          { building: 'senate',    target_level: 5,  priority: 1, reason: 'Débloque tout, accélère la construction' },
          { building: 'warehouse', target_level: 10, priority: 2, reason: 'Stocker les ressources pour Harbor' },
          { building: 'harbor',    target_level: 10, priority: 3, reason: 'Débloquer fire ships' },
          { building: 'farm',      target_level: 8,  priority: 4, reason: 'Population pour troupes défensives' },
          { building: 'barracks',  target_level: 5,  priority: 5, reason: 'Slingers pour la défense' },
          { building: 'harbor',    target_level: 20, priority: 6, reason: 'CIBLE PRINCIPALE — débloque Colony Ship' },
          { building: 'warehouse', target_level: 20, priority: 7, reason: 'Stocker 30 000 de chaque ressource pour le CS' },
          { building: 'farm',      target_level: 15, priority: 8, reason: 'Population pour bateaux + CS (170 pop)' },
        ],
        troop_targets: { slinger: 600, bireme: 25, colony_ship: 1 },
      },
      colony_rush_speed1: {
        name: 'Colony Rush Speed 1',
        applicable_worlds: ['speed1_revolt'],
        city_specialization: 'colony_rush',
        build_order: [
          { building: 'senate',    target_level: 10, priority: 1, reason: 'Accélérer la construction sur le long terme' },
          { building: 'warehouse', target_level: 15, priority: 2, reason: 'Grand stockage' },
          { building: 'harbor',    target_level: 20, priority: 3, reason: 'Colony Ship — cible finale' },
          { building: 'barracks',  target_level: 12, priority: 4, reason: 'Swordsmen pour défense' },
          { building: 'wall',      target_level: 15, priority: 5, reason: 'Mur important sur monde lent' },
          { building: 'farm',      target_level: 20, priority: 6, reason: 'Population pour armée + CS' },
        ],
        troop_targets: { sword: 200, slinger: 400, bireme: 50, colony_ship: 1 },
      },
      offense_speed3: {
        name: 'Ville Offensive Speed 3',
        applicable_worlds: ['speed3_revolt', 'speed3_conquest'],
        city_specialization: 'offense',
        build_order: [
          { building: 'senate',    target_level: 10, priority: 1, reason: '' },
          { building: 'farm',      target_level: 30, priority: 2, reason: 'Maximiser la population' },
          { building: 'barracks',  target_level: 25, priority: 3, reason: 'Slingers et hoplites rapidement' },
          { building: 'stable',    target_level: 10, priority: 4, reason: 'Horsemen pour nukes rapides' },
          { building: 'harbor',    target_level: 25, priority: 5, reason: 'Triremes pour attaques navales' },
          { building: 'warehouse', target_level: 25, priority: 6, reason: '' },
          { building: 'academy',   target_level: 20, priority: 7, reason: 'Technologies offensives' },
        ],
        troop_targets: { slinger: 800, horseman: 150, trireme: 50 },
      },
      defense_city: {
        name: 'Ville Défensive',
        applicable_worlds: ['speed1_revolt', 'speed2_revolt', 'speed3_revolt', 'speed3_conquest'],
        city_specialization: 'defense',
        build_order: [
          { building: 'senate',    target_level: 10, priority: 1, reason: '' },
          { building: 'wall',      target_level: 25, priority: 2, reason: '+150% défense — priorité absolue' },
          { building: 'farm',      target_level: 35, priority: 3, reason: 'Masse de troupes défensives' },
          { building: 'barracks',  target_level: 25, priority: 4, reason: 'Production troupes défensives' },
          { building: 'harbor',    target_level: 20, priority: 5, reason: 'Biremes pour défense navale' },
          { building: 'warehouse', target_level: 25, priority: 6, reason: '' },
        ],
        troop_targets: { slinger: 600, hoplite: 400, sword: 300, archer: 200, bireme: 100 },
      },
      commerce_city: {
        name: 'Ville Commerce',
        applicable_worlds: ['speed1_revolt', 'speed2_revolt', 'speed3_revolt'],
        city_specialization: 'commerce',
        build_order: [
          { building: 'senate',    target_level: 10, priority: 1, reason: '' },
          { building: 'market',    target_level: 30, priority: 2, reason: 'Capacité de trade maximale' },
          { building: 'warehouse', target_level: 30, priority: 3, reason: 'Stocker maximum de ressources' },
          { building: 'farm',      target_level: 30, priority: 4, reason: '' },
          { building: 'harbor',    target_level: 15, priority: 5, reason: 'Trade avec îles voisines' },
        ],
        troop_targets: { bireme: 50, slinger: 200 },
      },
      ww_support_city: {
        name: 'Support Merveilles du Monde',
        applicable_worlds: ['speed1_revolt', 'speed2_revolt'],
        city_specialization: 'ww_support',
        build_order: [
          { building: 'senate',    target_level: 15, priority: 1, reason: '' },
          { building: 'market',    target_level: 30, priority: 2, reason: '' },
          { building: 'warehouse', target_level: 30, priority: 3, reason: '' },
          { building: 'farm',      target_level: 40, priority: 4, reason: '' },
        ],
        troop_targets: { bireme: 100, slinger: 300 },
      },
    },
    city_specializations: {
      colony_rush: { label: 'Colony Rush',          description: 'Première ville orientée colonisation rapide.' },
      offense:     { label: 'Ville Offensive',      description: 'Ville dédiée aux attaques.' },
      defense:     { label: 'Ville Défensive',      description: 'Ville fortifiée pour défendre les alliés.' },
      commerce:    { label: 'Ville Commerce',       description: 'Optimisée pour le trade.' },
      cave:        { label: 'Ville Cave',           description: 'Protège l\'argent stratégique.' },
      ww_support:  { label: 'Support Merveilles',   description: 'Dédiée à l\'alimentation des WW.' },
    },
  };
}

/**
 * Base de connaissances complète : profils monde, stratégies, spécialisations.
 * @type {object}
 */
export const knowledge = _data;

/**
 * Retourne le profil d'un monde donné depuis la KnowledgeBase.
 * @param {string} worldKey - Ex: 'speed3_revolt'
 * @returns {object|null}
 */
export function getWorldProfile(worldKey) {
  return knowledge.world_profiles?.[worldKey] ?? null;
}

/**
 * Retourne les stratégies applicables pour un worldKey.
 * @param {string} worldKey
 * @returns {object[]} Liste de stratégies (objets) applicables à ce monde
 */
export function getStrategiesForWorld(worldKey) {
  const strategies = knowledge.strategies ?? {};
  return Object.values(strategies).filter((s) =>
    Array.isArray(s.applicable_worlds) && s.applicable_worlds.includes(worldKey)
  );
}

/**
 * Retourne la stratégie recommandée pour une ville selon son numéro (index 0-based).
 * La ville 0 = première ville = toujours Colony Rush si applicable.
 * @param {string} worldKey
 * @param {number} cityIndex - Index 0-based de la ville
 * @returns {object|null} Stratégie recommandée
 */
export function getRecommendedStrategy(worldKey, cityIndex) {
  const strategies = getStrategiesForWorld(worldKey);

  // Première ville : Colony Rush si disponible pour ce monde
  if (cityIndex === 0) {
    const rush = strategies.find((s) => s.city_specialization === 'colony_rush');
    if (rush) return rush;
  }

  // Villes suivantes : selon l'ordre
  const nonRush = strategies.filter((s) => s.city_specialization !== 'colony_rush');
  return nonRush[0] ?? null;
}

/**
 * Retourne les spécialisations de ville disponibles.
 * @returns {object} Map<specializationId, specializationData>
 */
export function getCitySpecializations() {
  return knowledge.city_specializations ?? {};
}

export default knowledge;
