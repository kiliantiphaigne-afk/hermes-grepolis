/**
 * modules/build.js — BuildManager : gestion automatique de la construction
 *
 * Implémente FR3 (suivi des templates) et FR4 (décision selon ressources disponibles).
 *
 * Logique :
 *   - Toutes les ~30s, vérifier chaque ville
 *   - Si la file de construction est vide ou courte (< 1 slot utilisé) :
 *     → trouver le prochain bâtiment du template assigné à cette ville
 *     → vérifier les ressources disponibles
 *     → si ok : lancer la construction
 *     → sinon : calculer le temps de retry et l'exposer dans getNextStep()
 *   - Le template peut être adapté selon le worldProfile (listen 'world:profile')
 */

import { hermes  } from '../core.js';
import { bridge  } from '../bridge.js';
import { human   } from '../engine/human.js';
import { storage } from '../storage.js';

// ─── Templates de construction ────────────────────────────────────────────────

/**
 * Chaque template est une liste ordonnée de { building, targetLevel }.
 * Le BuildManager cherche le premier item non encore atteint dans la ville.
 *
 * @type {Object.<string, { name: string, order: Array<{ building: string, targetLevel: number }> }>}
 */
const TEMPLATES = {
  colony_rush_speed3: {
    name: 'Colony Rush (Speed 3)',
    order: [
      { building: 'senate',   targetLevel: 5  },
      { building: 'storage',  targetLevel: 10 },
      { building: 'harbor',   targetLevel: 10 },
      { building: 'farm',     targetLevel: 8  },
      { building: 'barracks', targetLevel: 5  },
      { building: 'harbor',   targetLevel: 20 },
      { building: 'storage',  targetLevel: 20 },
    ],
  },
  colony_rush_speed1: {
    name: 'Colony Rush (Speed 1)',
    order: [
      { building: 'senate',   targetLevel: 10 },
      { building: 'storage',  targetLevel: 15 },
      { building: 'farm',     targetLevel: 12 },
      { building: 'harbor',   targetLevel: 10 },
      { building: 'barracks', targetLevel: 10 },
      { building: 'harbor',   targetLevel: 20 },
    ],
  },
  commerce: {
    name: 'Commerce',
    order: [
      { building: 'senate',   targetLevel: 5  },
      { building: 'storage',  targetLevel: 10 },
      { building: 'farm',     targetLevel: 8  },
      { building: 'market',   targetLevel: 10 },
      { building: 'storage',  targetLevel: 20 },
      { building: 'farm',     targetLevel: 20 },
      { building: 'market',   targetLevel: 20 },
      { building: 'storage',  targetLevel: 30 },
      { building: 'farm',     targetLevel: 45 },
      { building: 'market',   targetLevel: 30 },
    ],
  },
  militaire: {
    name: 'Militaire',
    order: [
      { building: 'senate',   targetLevel: 10 },
      { building: 'barracks', targetLevel: 20 },
      { building: 'harbor',   targetLevel: 15 },
      { building: 'farm',     targetLevel: 25 },
      { building: 'stable',   targetLevel: 10 },
      { building: 'harbor',   targetLevel: 25 },
      { building: 'barracks', targetLevel: 25 },
      { building: 'wall',     targetLevel: 25 },
    ],
  },
  defense: {
    name: 'Défense',
    order: [
      { building: 'senate',   targetLevel: 5  },
      { building: 'barracks', targetLevel: 15 },
      { building: 'wall',     targetLevel: 15 },
      { building: 'farm',     targetLevel: 15 },
      { building: 'barracks', targetLevel: 25 },
      { building: 'wall',     targetLevel: 25 },
      { building: 'harbor',   targetLevel: 10 },
    ],
  },
  mixte: {
    name: 'Mixte',
    order: [
      { building: 'senate',   targetLevel: 5  },
      { building: 'storage',  targetLevel: 10 },
      { building: 'farm',     targetLevel: 10 },
      { building: 'barracks', targetLevel: 10 },
      { building: 'market',   targetLevel: 10 },
      { building: 'harbor',   targetLevel: 10 },
      { building: 'storage',  targetLevel: 20 },
      { building: 'farm',     targetLevel: 20 },
    ],
  },
};

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Intervalle principal de la loop (~30s, gaussien). */
const LOOP_INTERVAL_MS = 30_000;

/** Variance gaussienne de la loop. */
const LOOP_VARIANCE_PCT = 0.15;

/** Clé storage pour les templates assignés par ville. */
const BUILD_ASSIGNMENTS_KEY = 'hermes_build_assignments';

/**
 * Nombre de slots de construction occupés à partir duquel on ne relance rien.
 * Grepolis autorise généralement 1 ou 2 slots (selon senate level).
 */
const MAX_QUEUE_LENGTH = 1;

/**
 * Production de ressources estimée par défaut (pts/h) quand on n'a pas les vraies données.
 * Utilisée pour calculer timeNeeded.
 */
const DEFAULT_PRODUCTION_PER_HOUR = { wood: 500, stone: 500, silver: 200 };

// ─── État interne ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} BuildAssignment
 * @property {string} templateId  - Identifiant du template
 * @property {number} assignedAt  - Timestamp d'assignation
 */

/** Map<cityId (string), BuildAssignment> */
let _assignments = new Map();

/** WorldProfile courant (mis à jour via event 'world:profile'). */
let _worldProfile = null;

/** Handle de la loop principale. */
let _loopHandle = null;

/** Flag de fonctionnement. */
let _running = false;

/** Statistiques globales. */
let _stats = {
  totalQueued:  0,
  totalSkipped: 0,
  errors:       0,
};

// ─── Persistance ──────────────────────────────────────────────────────────────

function loadAssignments() {
  try {
    const raw = storage.getConfig()[BUILD_ASSIGNMENTS_KEY];
    if (raw && typeof raw === 'object') {
      _assignments = new Map(Object.entries(raw));
    }
  } catch (err) {
    hermes.log.warn('BuildManager: impossible de charger les assignations', err);
    _assignments = new Map();
  }
}

function saveAssignments() {
  try {
    storage.updateConfig({ [BUILD_ASSIGNMENTS_KEY]: Object.fromEntries(_assignments) });
  } catch (err) {
    hermes.log.warn('BuildManager: impossible de persister les assignations', err);
  }
}

// ─── Sélection automatique de template ───────────────────────────────────────

/**
 * Choisit un template adapté à la ville selon le worldProfile et l'état de la ville.
 * Appelé si aucun template n'est assigné manuellement.
 *
 * @param {import('../bridge.js').City} city
 * @returns {string} ID du template
 */
function autoSelectTemplate(city) {
  const config = storage.getConfig();
  const defaultTemplate = config.buildConfig?.defaultTemplate ?? 'auto';

  if (defaultTemplate !== 'auto') {
    return defaultTemplate;
  }

  // Logique de sélection automatique selon le monde.
  if (_worldProfile) {
    const speed = _worldProfile.speed ?? 1;
    if (speed >= 3) return 'colony_rush_speed3';
    if (speed === 1) return 'colony_rush_speed1';
  }

  // Par défaut : template mixte (polyvalent).
  return 'mixte';
}

// ─── Coût de construction ─────────────────────────────────────────────────────

/**
 * Estimations des coûts de construction par bâtiment/niveau.
 * Ces valeurs sont approximatives — Grepolis utilise des formules complexes.
 * L'important est d'avoir un ordre de grandeur pour le timeNeeded.
 *
 * @param {string} building
 * @param {number} level - Niveau cible
 * @returns {{ wood: number, stone: number, silver: number }}
 */
function estimateBuildCost(building, level) {
  // Formule générique : coût augmente exponentiellement avec le niveau.
  const base = {
    senate:   { wood: 80,  stone: 60,  silver: 40  },
    farm:     { wood: 100, stone: 80,  silver: 0   },
    storage:  { wood: 60,  stone: 100, silver: 0   },
    barracks: { wood: 120, stone: 100, silver: 60  },
    harbor:   { wood: 120, stone: 100, silver: 60  },
    market:   { wood: 80,  stone: 100, silver: 40  },
    wall:     { wood: 50,  stone: 150, silver: 50  },
    stable:   { wood: 100, stone: 80,  silver: 60  },
  }[building] ?? { wood: 80, stone: 80, silver: 40 };

  const multiplier = Math.pow(1.35, level - 1);
  return {
    wood:   Math.ceil(base.wood   * multiplier),
    stone:  Math.ceil(base.stone  * multiplier),
    silver: Math.ceil(base.silver * multiplier),
  };
}

/**
 * Estime en minutes le temps nécessaire pour accumuler les ressources manquantes.
 *
 * @param {{ wood: number, stone: number, silver: number }} needed
 * @param {{ wood: number, stone: number, silver: number }} available
 * @returns {number} Minutes estimées
 */
function estimateTimeNeeded(needed, available) {
  const missingWood   = Math.max(0, needed.wood   - available.wood);
  const missingStone  = Math.max(0, needed.stone  - available.stone);
  const missingSilver = Math.max(0, needed.silver - available.silver);

  const prod = DEFAULT_PRODUCTION_PER_HOUR;

  const hoursWood   = missingWood   / (prod.wood   / 60);
  const hoursStone  = missingStone  / (prod.stone  / 60);
  const hoursSilver = missingSilver / (prod.silver / 60);

  return Math.ceil(Math.max(hoursWood, hoursStone, hoursSilver));
}

// ─── Logique de construction par ville ───────────────────────────────────────

/**
 * @typedef {object} NextStep
 * @property {string}      building      - Bâtiment à construire
 * @property {number}      level         - Niveau cible
 * @property {string}      reason        - Explication lisible
 * @property {number|null} estimatedTime - Minutes avant que les ressources soient dispo (null = dispo maintenant)
 * @property {string|null} templateId    - Template utilisé
 * @property {boolean}     canBuildNow   - true si les ressources sont suffisantes
 */

/**
 * Détermine la prochaine étape de construction pour une ville.
 *
 * @param {import('../bridge.js').City} city
 * @returns {NextStep|null} null si le template est complété ou si aucun template n'est assigné
 */
function computeNextStep(city) {
  // Résoudre le template.
  const assignment = _assignments.get(String(city.id));
  const templateId = assignment?.templateId ?? autoSelectTemplate(city);
  const template   = TEMPLATES[templateId];

  if (!template) {
    hermes.log.warn(`BuildManager: template inconnu "${templateId}" pour ville ${city.id}`);
    return null;
  }

  const currentBuildings = city.buildings ?? {};

  // Chercher la première étape non encore complétée.
  for (const step of template.order) {
    const currentLevel = currentBuildings[step.building] ?? 0;
    if (currentLevel >= step.targetLevel) continue; // Déjà construit.

    // La prochaine étape à construire est level+1 depuis le niveau actuel.
    const nextLevel = currentLevel + 1;
    const cost      = estimateBuildCost(step.building, nextLevel);
    const resources = city.resources ?? { wood: 0, stone: 0, silver: 0 };

    const hasResources = resources.wood   >= cost.wood
      && resources.stone  >= cost.stone
      && resources.silver >= cost.silver;

    const estimatedTime = hasResources
      ? null
      : estimateTimeNeeded(cost, resources);

    return {
      building:      step.building,
      level:         nextLevel,
      reason:        `Template "${template.name}" — étape suivante`,
      estimatedTime,
      templateId,
      canBuildNow:   hasResources,
    };
  }

  // Template entièrement complété.
  hermes.log.info(`BuildManager: template "${templateId}" complété pour ville ${city.id}`);
  return null;
}

/**
 * Tente de lancer la construction pour une ville donnée.
 *
 * @param {import('../bridge.js').City} city
 * @returns {Promise<void>}
 */
async function processCity(city) {
  try {
    // Vérifier que la file de construction a de la place.
    const queueLength = city.queue?.length ?? 0;
    if (queueLength >= MAX_QUEUE_LENGTH) {
      hermes.log.debug(
        `BuildManager: ville ${city.id} — file pleine (${queueLength} items)`,
      );
      return;
    }

    // Vérifier les conditions humaines.
    if (!human.canAct('build', city.id)) {
      hermes.log.debug(`BuildManager: ville ${city.id} — human.canAct false`);
      return;
    }

    const nextStep = computeNextStep(city);
    if (!nextStep) return; // Template complété ou indisponible.

    if (!nextStep.canBuildNow) {
      hermes.log.debug(
        `BuildManager: ville ${city.id} — ressources insuffisantes pour ${nextStep.building} lvl${nextStep.level}. Attente ~${nextStep.estimatedTime} min`,
      );
      _stats.totalSkipped++;
      return;
    }

    // Lancer la construction.
    const success = await bridge.buildBuilding(city.id, nextStep.building, nextStep.level);

    if (success) {
      _stats.totalQueued++;
      human.recordAction('build', city.id);
      storage.recordAction('build', city.id, {
        building: nextStep.building,
        level:    nextStep.level,
      });

      hermes.emit('build:queued', {
        cityId:   city.id,
        building: nextStep.building,
        level:    nextStep.level,
      });

      hermes.log.info(
        `BuildManager: construction lancée — ${nextStep.building} lvl${nextStep.level} (ville ${city.name})`,
      );
    } else {
      hermes.log.warn(
        `BuildManager: bridge.buildBuilding a retourné false pour ${nextStep.building} lvl${nextStep.level} (ville ${city.id})`,
      );
      _stats.errors++;
    }
  } catch (err) {
    hermes.log.error(`BuildManager: erreur processCity ville ${city.id}`, err);
    _stats.errors++;
  }
}

// ─── Cycle principal ──────────────────────────────────────────────────────────

/**
 * Exécute un cycle de vérification pour toutes les villes.
 * @returns {Promise<void>}
 */
async function runCycle() {
  hermes.log.debug('BuildManager: démarrage cycle de construction');

  let cities;
  try {
    cities = bridge.getCities();
  } catch (err) {
    hermes.log.error('BuildManager: bridge.getCities a levé une exception', err);
    return;
  }

  if (!cities || cities.length === 0) {
    hermes.log.debug('BuildManager: aucune ville trouvée');
    return;
  }

  // Traiter les villes séquentiellement avec délai entre chaque.
  for (let i = 0; i < cities.length; i++) {
    if (!_running) break;

    if (i > 0) {
      // Délai court entre les villes (évite les actions simultanées).
      const { promise } = human.schedule(() => {}, 2_000, 0.20);
      await promise;
    }

    await processCity(cities[i]);
  }

  hermes.log.debug('BuildManager: cycle terminé');
}

/**
 * Planifie le prochain cycle (self-rescheduling).
 */
function scheduleNextCycle() {
  if (!_running) return;

  _loopHandle = human.schedule(async () => {
    if (!_running) return;
    try {
      await runCycle();
    } catch (err) {
      hermes.log.error('BuildManager: erreur non gérée dans runCycle', err);
    }
    scheduleNextCycle();
  }, LOOP_INTERVAL_MS, LOOP_VARIANCE_PCT);
}

// ─── Détection de fin de construction via Backbone ────────────────────────────

/**
 * Écoute les événements 'construction:complete' émis par le bridge.
 * Retransmet comme 'build:complete' enrichi.
 */
function handleConstructionComplete(data) {
  if (!data || !data.cityId) return;

  let city;
  try {
    city = bridge.getCity(data.cityId);
  } catch {
    city = null;
  }

  // Chercher quel bâtiment vient de passer de niveau.
  // data.buildings est la map complète après la construction.
  hermes.emit('build:complete', {
    cityId:    data.cityId,
    buildings: data.buildings,
  });

  hermes.log.info(`BuildManager: construction terminée dans ville ${data.cityId}`);
}

// ─── Souscriptions aux événements ─────────────────────────────────────────────

const _unsubs = [];

function attachListeners() {
  _unsubs.push(hermes.on('hermes:ready', () => {
    hermes.log.info('BuildManager: hermes:ready — démarrage loop');
    scheduleNextCycle();
  }));

  _unsubs.push(hermes.on('hermes:stopped', () => {
    if (_loopHandle) _loopHandle.cancel();
    _running = false;
  }));

  _unsubs.push(hermes.on('game:loaded', () => {
    loadAssignments();
  }));

  // Mise à jour du worldProfile pour adapter les templates.
  _unsubs.push(hermes.on('world:profile', ({ profile }) => {
    if (profile) {
      _worldProfile = profile;
      hermes.log.debug('BuildManager: worldProfile mis à jour', profile);
    }
  }));

  // Réagir à la fin d'une construction (re-planifier immédiatement si besoin).
  _unsubs.push(hermes.on('construction:complete', handleConstructionComplete));
}

function detachListeners() {
  for (const unsub of _unsubs) unsub();
  _unsubs.length = 0;
}

// ─── Interface publique ───────────────────────────────────────────────────────

export const buildManager = {

  /**
   * Initialise le BuildManager.
   */
  init() {
    hermes.log.info('BuildManager: init');
    loadAssignments();
    _running = true;
    attachListeners();

    if (hermes.isRunning) {
      scheduleNextCycle();
    }
  },

  /**
   * Arrête proprement le BuildManager.
   */
  destroy() {
    hermes.log.info('BuildManager: destroy');
    _running = false;
    if (_loopHandle) {
      _loopHandle.cancel();
      _loopHandle = null;
    }
    detachListeners();
    saveAssignments();
  },

  /**
   * Retourne le statut global du module.
   * @returns {object}
   */
  getStatus() {
    let citiesCount = 0;
    try {
      citiesCount = bridge.getCities()?.length ?? 0;
    } catch { /* bridge pas encore prêt */ }

    return {
      running:            _running,
      citiesManaged:      citiesCount,
      assignmentsCount:   _assignments.size,
      worldProfile:       _worldProfile,
      stats:              { ..._stats },
    };
  },

  /**
   * Retourne tous les templates disponibles.
   * @returns {typeof TEMPLATES}
   */
  getTemplates() {
    return TEMPLATES;
  },

  /**
   * Assigne un template à une ville.
   * @param {string|number} cityId
   * @param {string}        templateId - Clé dans TEMPLATES
   */
  assignTemplate(cityId, templateId) {
    if (!TEMPLATES[templateId]) {
      hermes.log.warn(`BuildManager: template inconnu "${templateId}"`);
      return;
    }
    _assignments.set(String(cityId), {
      templateId,
      assignedAt: Date.now(),
    });
    saveAssignments();
    hermes.log.info(`BuildManager: template "${templateId}" assigné à la ville ${cityId}`);
  },

  /**
   * Retourne la prochaine étape de construction pour une ville.
   * @param {string|number} cityId
   * @returns {NextStep|null}
   */
  getNextStep(cityId) {
    let city;
    try {
      city = bridge.getCity(cityId);
    } catch (err) {
      hermes.log.warn(`BuildManager: getNextStep — bridge.getCity(${cityId}) a échoué`, err);
      return null;
    }
    if (!city) return null;
    return computeNextStep(city);
  },

  /**
   * Force un cycle immédiat.
   * @returns {Promise<void>}
   */
  async forceRun() {
    hermes.log.info('BuildManager: forceRun demandé');
    if (_loopHandle) {
      _loopHandle.cancel();
      _loopHandle = null;
    }
    await runCycle();
    scheduleNextCycle();
  },
};

// ─── Auto-registration ────────────────────────────────────────────────────────

hermes.register('build', {
  init()    { buildManager.init();    },
  destroy() { buildManager.destroy(); },
});

export default buildManager;
