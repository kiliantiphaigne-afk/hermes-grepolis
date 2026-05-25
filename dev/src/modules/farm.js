/**
 * modules/farm.js — FarmManager : automatisation des villages fermiers
 *
 * Implémente FR1 (ferme automatique) et FR2 (gestion de la humeur / mood).
 *
 * Logique de décision par village :
 *   estimatedMood >= 85  → LOOT  (piller : rendement max)
 *   78 <= mood < 85      → DEMAND (réclamer : safe)
 *   mood >= 80 + marché  → TRADE  (si disponible)
 *   mood < 78            → SKIP   (attendre récupération)
 *
 * La priority queue globale est triée par cooldownRemaining croissant —
 * on traite d'abord les villages qui sont disponibles maintenant, peu importe
 * la ville à laquelle ils appartiennent.
 */

import { hermes  } from '../core.js';
import { bridge  } from '../bridge.js';
import { human   } from '../engine/human.js';
import { storage } from '../storage.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Récupération de mood : ~0.0408 pts/min (58.835 pts / 24h). */
const MOOD_RECOVERY_PER_MINUTE = 58.835 / (24 * 60);

/** Coût de mood par tranche de 1000 ressources pillées (estimation). */
const LOOT_MOOD_COST_PER_1000 = 10;

/** Mood minimum pour tenter un trade. */
const TRADE_MINIMUM_MOOD = 80;

/** Mood minimum safe pour lancer une demande (demand). */
const DEMAND_SAFE_MOOD = 78;

/** Mood préféré pour piller (loot). */
const LOOT_PREFER_MOOD = 85;

/**
 * Intervalle principal de la loop (ms).
 * Le délai réel est gaussien autour de cette valeur.
 */
const LOOP_INTERVAL_MS = 60_000;

/** Variance des délais gaussiens inter-actions (±20%). */
const ACTION_VARIANCE_PCT = 0.20;

/** Intervalle entre deux actions individuelles dans un cycle (ms). */
const INTER_ACTION_INTERVAL_MS = 4_500;

/** Clé de stockage de l'état des villages. */
const FARM_STATE_KEY = 'hermes_farm_state';

// ─── État interne ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} VillageState
 * @property {number}          lastActionTs   - Timestamp ms de la dernière action
 * @property {'demand'|'loot'|'trade'|null} lastActionType - Type de la dernière action
 * @property {number}          estimatedMood  - Mood estimé couramment (0-100)
 * @property {number}          lastKnownMood  - Mood connu lors de la dernière action
 */

/** Map<villageId (string), VillageState> — état de chaque village. */
let _villageStates = new Map();

/** Handle de la loop principale (objet { cancel, promise } de human.schedule). */
let _loopHandle = null;

/** Flag pour arrêter la loop proprement. */
let _running = false;

/** Statistiques du cycle courant. */
let _stats = {
  totalActions: 0,
  totalResources: { wood: 0, stone: 0, silver: 0 },
  lastCycleTs: null,
  lastCycleCitiesProcessed: 0,
  lastCycleVillagesActed: 0,
  errors: 0,
};

// ─── Persistance ──────────────────────────────────────────────────────────────

/**
 * Charge l'état persisté depuis le storage.
 */
function loadState() {
  try {
    const raw = storage.getConfig()[FARM_STATE_KEY];
    if (raw && typeof raw === 'object') {
      _villageStates = new Map(Object.entries(raw));
    }
  } catch (err) {
    hermes.log.warn('FarmManager: impossible de charger l\'état persisté', err);
    _villageStates = new Map();
  }
}

/**
 * Persiste l'état courant dans le storage.
 */
function saveState() {
  try {
    const plain = Object.fromEntries(_villageStates);
    storage.updateConfig({ [FARM_STATE_KEY]: plain });
  } catch (err) {
    hermes.log.warn('FarmManager: impossible de persister l\'état', err);
  }
}

// ─── Calcul de mood ───────────────────────────────────────────────────────────

/**
 * Estime le mood actuel d'un village à partir de son dernier état connu.
 * Formule : lastMood - lootImpact + (minutesElapsed × MOOD_RECOVERY_PER_MINUTE)
 * Clampé entre 0 et 100.
 *
 * @param {import('../bridge.js').FarmVillage} village - Données bridge du village
 * @returns {number} Mood estimé [0, 100]
 */
function estimatedMood(village) {
  const state = _villageStates.get(String(village.id));

  if (!state) {
    // Pas d'historique → on fait confiance à la valeur bridge directement.
    return Math.max(0, Math.min(100, village.mood ?? 100));
  }

  const minutesElapsed = (Date.now() - state.lastActionTs) / 60_000;
  const recovery = minutesElapsed * MOOD_RECOVERY_PER_MINUTE;

  // L'impact du loot est déjà soustrait lors de l'action — on part du mood post-action.
  const mood = state.estimatedMood + recovery;

  return Math.max(0, Math.min(100, mood));
}

/**
 * Calcule l'impact sur le mood d'une action de loot.
 * Basé sur les ressources disponibles (estimation du pillage).
 *
 * @param {import('../bridge.js').FarmVillage} village
 * @returns {number} Points de mood perdus (négatif)
 */
function lootMoodImpact(village) {
  const totalRes = (village.resources?.wood ?? 0)
    + (village.resources?.stone ?? 0)
    + (village.resources?.silver ?? 0);
  return Math.ceil(totalRes / 1000) * LOOT_MOOD_COST_PER_1000;
}

// ─── Décision d'action ────────────────────────────────────────────────────────

/**
 * Détermine l'action à effectuer sur un village selon son mood estimé.
 * Retourne null si le village doit être ignoré.
 *
 * @param {import('../bridge.js').FarmVillage} village
 * @param {import('../bridge.js').City}        city       - Ville parent (pour vérifier le marché)
 * @returns {{ action: 'demand'|'loot'|'trade', reason: string }|null}
 */
function decideAction(village, city) {
  const config = storage.getConfig();
  const farmConfig = config.farmConfig ?? {};
  const minMood = farmConfig.minMoodThreshold ?? DEMAND_SAFE_MOOD;
  const defaultAction = farmConfig.defaultAction ?? 'auto';

  const mood = estimatedMood(village);

  // Vérification du cooldown (si le bridge dit qu'il y a encore un cooldown).
  if (village.cooldownRemaining > 0) {
    return null;
  }

  // Mood trop bas : village boudeur, on attend.
  if (mood < minMood) {
    const minutesToRecover = (minMood - mood) / MOOD_RECOVERY_PER_MINUTE;
    hermes.log.debug(
      `FarmManager: village ${village.id} mood trop bas (${mood.toFixed(1)}) — attente ${minutesToRecover.toFixed(0)} min`,
    );
    return null;
  }

  // Mode forcé par l'utilisateur.
  if (defaultAction !== 'auto') {
    // Vérification de sécurité : ne pas lootter si mood insuffisant.
    if (defaultAction === 'loot' && mood < DEMAND_SAFE_MOOD) return null;
    if (defaultAction === 'trade' && mood < TRADE_MINIMUM_MOOD) return null;
    return { action: defaultAction, reason: `mode forcé: ${defaultAction}` };
  }

  // Mode auto : décision par seuils.
  const hasMarket = (city?.buildings?.market ?? 0) > 0;

  if (mood >= LOOT_PREFER_MOOD) {
    return { action: 'loot', reason: `mood élevé (${mood.toFixed(1)} >= ${LOOT_PREFER_MOOD})` };
  }

  if (mood >= TRADE_MINIMUM_MOOD && hasMarket) {
    return { action: 'trade', reason: `mood intermédiaire + marché disponible` };
  }

  if (mood >= DEMAND_SAFE_MOOD) {
    return { action: 'demand', reason: `mood safe (${mood.toFixed(1)} >= ${DEMAND_SAFE_MOOD})` };
  }

  return null;
}

// ─── Exécution d'une action ───────────────────────────────────────────────────

/**
 * Exécute une action farming sur un village et met à jour l'état interne.
 *
 * @param {import('../bridge.js').City}        city
 * @param {import('../bridge.js').FarmVillage} village
 * @param {'demand'|'loot'|'trade'}            action
 * @returns {Promise<boolean>} true si l'action a réussi
 */
async function executeAction(city, village, action) {
  try {
    const success = await bridge.farmVillage(city.id, village.id, action);

    if (!success) {
      hermes.log.warn(`FarmManager: bridge.farmVillage a retourné false pour village ${village.id}`);
      _stats.errors++;
      return false;
    }

    // Calculer le mood post-action.
    const moodBefore = estimatedMood(village);
    let moodAfter = moodBefore;
    if (action === 'loot') {
      moodAfter = Math.max(0, moodBefore - lootMoodImpact(village));
    }
    // demand et trade ont peu/pas d'impact sur le mood.

    // Mise à jour de l'état du village.
    _villageStates.set(String(village.id), {
      lastActionTs:   Date.now(),
      lastActionType: action,
      estimatedMood:  moodAfter,
      lastKnownMood:  village.mood,
    });

    // Mise à jour des stats globales.
    _stats.totalActions++;
    _stats.totalResources.wood   += village.resources?.wood   ?? 0;
    _stats.totalResources.stone  += village.resources?.stone  ?? 0;
    _stats.totalResources.silver += village.resources?.silver ?? 0;

    // Enregistrement pour HumanEngine.
    human.recordAction(`farm:${action}`, city.id);
    storage.recordAction(`farm:${action}`, city.id, {
      villageId: village.id,
      mood:      village.mood,
      resources: village.resources,
    });

    // Événement pour les autres modules (MarketManager écoute 'farm:action').
    hermes.emit('farm:action', {
      cityId:    city.id,
      villageId: village.id,
      action,
      resources: village.resources,
      mood:      moodAfter,
    });

    hermes.log.info(
      `FarmManager: ${action} → ${village.name} (city: ${city.name}) | mood estimé: ${moodAfter.toFixed(1)}`,
    );

    return true;
  } catch (err) {
    hermes.log.error(`FarmManager: erreur sur executeAction village ${village.id}`, err);
    _stats.errors++;
    return false;
  }
}

// ─── Priority queue ───────────────────────────────────────────────────────────

/**
 * @typedef {object} QueueEntry
 * @property {import('../bridge.js').City}        city
 * @property {import('../bridge.js').FarmVillage} village
 * @property {number}                              cooldownRemaining
 * @property {{ action: string, reason: string }|null} decision
 */

/**
 * Construit la priority queue globale de tous les villages de toutes les villes,
 * triée par cooldownRemaining croissant.
 * Seuls les villages avec une décision d'action sont inclus.
 *
 * @returns {QueueEntry[]}
 */
function buildPriorityQueue() {
  const queue = [];

  let cities;
  try {
    cities = bridge.getCities();
  } catch (err) {
    hermes.log.error('FarmManager: bridge.getCities a levé une exception', err);
    return [];
  }

  if (!cities || cities.length === 0) {
    hermes.log.debug('FarmManager: aucune ville trouvée');
    return [];
  }

  for (const city of cities) {
    if (!city) continue;

    let villages;
    try {
      villages = bridge.getFarmingVillages(city.id);
    } catch (err) {
      hermes.log.warn(`FarmManager: getFarmingVillages(${city.id}) a levé une exception`, err);
      continue;
    }

    if (!villages || villages.length === 0) continue;

    for (const village of villages) {
      if (!village) continue;

      const decision = decideAction(village, city);
      // On inclut même les villages sans décision pour le tracking,
      // mais on ne les mettra pas dans la queue d'action.
      if (!decision) continue;

      // Vérification human.canAct avant d'ajouter à la queue.
      if (!human.canAct('farm', city.id)) continue;

      queue.push({
        city,
        village,
        cooldownRemaining: village.cooldownRemaining ?? 0,
        decision,
      });
    }
  }

  // Trier : les villages disponibles maintenant d'abord (cooldown = 0),
  // puis par cooldown croissant.
  queue.sort((a, b) => a.cooldownRemaining - b.cooldownRemaining);

  return queue;
}

// ─── Cycle principal ──────────────────────────────────────────────────────────

/**
 * Exécute un cycle complet de farming.
 * Construit la priority queue, puis exécute les actions avec des délais gaussiens.
 *
 * @param {boolean} [force=false] - Si true, bypass les vérifications human.canAct
 * @returns {Promise<void>}
 */
async function runCycle(force = false) {
  hermes.log.debug('FarmManager: démarrage cycle de farming');

  const queue = buildPriorityQueue();

  if (queue.length === 0) {
    hermes.log.debug('FarmManager: queue vide — aucun village à traiter');
    _stats.lastCycleTs = Date.now();
    _stats.lastCycleCitiesProcessed = 0;
    _stats.lastCycleVillagesActed = 0;
    return;
  }

  hermes.log.info(`FarmManager: ${queue.length} villages à traiter dans ce cycle`);

  const citiesInCycle = new Set();
  let villagesActed = 0;

  // Exécution séquentielle avec délais gaussiens entre chaque action.
  for (let i = 0; i < queue.length; i++) {
    if (!_running) break; // Arrêt propre si destroy() a été appelé.

    const entry = queue[i];
    const { city, village, decision } = entry;

    // Re-vérification du cooldown (il peut avoir changé depuis la construction de la queue).
    if (village.cooldownRemaining > 0 && !force) continue;

    // Délai gaussien entre actions (sauf avant la première).
    if (i > 0) {
      const { promise } = human.schedule(() => {}, INTER_ACTION_INTERVAL_MS, ACTION_VARIANCE_PCT);
      await promise;
      if (!_running) break;
    }

    const success = await executeAction(city, village, decision.action);
    if (success) {
      citiesInCycle.add(city.id);
      villagesActed++;
    }
  }

  // Persistance de l'état après le cycle.
  saveState();

  _stats.lastCycleTs = Date.now();
  _stats.lastCycleCitiesProcessed = citiesInCycle.size;
  _stats.lastCycleVillagesActed = villagesActed;

  hermes.emit('farm:cycle:end', {
    citiesProcessed: citiesInCycle.size,
    totalResources:  { ..._stats.totalResources },
    villagesActed,
  });

  hermes.log.info(
    `FarmManager: cycle terminé — ${villagesActed} actions sur ${citiesInCycle.size} villes`,
  );
}

// ─── Loop principale ──────────────────────────────────────────────────────────

/**
 * Planifie le prochain cycle de farming avec un délai gaussien.
 * La loop se réenclenche automatiquement après chaque cycle.
 */
function scheduleNextCycle() {
  if (!_running) return;

  _loopHandle = human.schedule(async () => {
    if (!_running) return;
    try {
      await runCycle();
    } catch (err) {
      hermes.log.error('FarmManager: erreur non gérée dans runCycle', err);
    }
    // Planifier le prochain cycle après la fin de celui-ci.
    scheduleNextCycle();
  }, LOOP_INTERVAL_MS, ACTION_VARIANCE_PCT);
}

// ─── Souscriptions aux événements ─────────────────────────────────────────────

/** Références aux unsubscribers pour le cleanup. */
const _unsubs = [];

function attachListeners() {
  // Démarrer la loop quand Hermes est prêt.
  _unsubs.push(hermes.on('hermes:ready', () => {
    hermes.log.info('FarmManager: hermes:ready reçu — démarrage loop');
    scheduleNextCycle();
  }));

  // Arrêt propre.
  _unsubs.push(hermes.on('hermes:stopped', () => {
    if (_loopHandle) _loopHandle.cancel();
    _running = false;
  }));

  // Sync de l'état initial au chargement du jeu.
  _unsubs.push(hermes.on('game:loaded', () => {
    hermes.log.debug('FarmManager: game:loaded — sync état initial');
    loadState();
  }));
}

function detachListeners() {
  for (const unsub of _unsubs) unsub();
  _unsubs.length = 0;
}

// ─── Interface publique ───────────────────────────────────────────────────────

export const farmManager = {

  /**
   * Initialise le FarmManager : charge l'état, attache les listeners, démarre si Hermes est déjà prêt.
   */
  init() {
    hermes.log.info('FarmManager: init');
    loadState();
    _running = true;
    attachListeners();

    // Si Hermes est déjà lancé (module chargé tardivement), démarrer immédiatement.
    if (hermes.isRunning) {
      scheduleNextCycle();
    }
  },

  /**
   * Arrête proprement le FarmManager : annule la loop et désinscrit les listeners.
   */
  destroy() {
    hermes.log.info('FarmManager: destroy');
    _running = false;
    if (_loopHandle) {
      _loopHandle.cancel();
      _loopHandle = null;
    }
    detachListeners();
    saveState();
  },

  /**
   * Retourne le statut courant du module.
   * @returns {{ citiesTracked: number, villagesTracked: number, lastCycleTs: number|null, stats: object }}
   */
  getStatus() {
    let citiesTracked = 0;
    try {
      const cities = bridge.getCities();
      citiesTracked = cities?.length ?? 0;
    } catch {
      // bridge peut ne pas être disponible
    }

    return {
      citiesTracked,
      villagesTracked: _villageStates.size,
      lastCycleTs:     _stats.lastCycleTs,
      running:         _running,
      stats: {
        totalActions:               _stats.totalActions,
        totalResources:             { ..._stats.totalResources },
        lastCycleCitiesProcessed:   _stats.lastCycleCitiesProcessed,
        lastCycleVillagesActed:     _stats.lastCycleVillagesActed,
        errors:                     _stats.errors,
      },
    };
  },

  /**
   * Force un cycle immédiat, bypasse les délais humains.
   * @returns {Promise<void>}
   */
  async forceRun() {
    hermes.log.info('FarmManager: forceRun demandé');
    if (_loopHandle) {
      _loopHandle.cancel();
      _loopHandle = null;
    }
    await runCycle(true);
    scheduleNextCycle();
  },

  /**
   * Retourne l'état estimé d'un village spécifique.
   * @param {string|number} villageId
   * @returns {VillageState|null}
   */
  getVillageState(villageId) {
    return _villageStates.get(String(villageId)) ?? null;
  },
};

// ─── Auto-registration ────────────────────────────────────────────────────────

hermes.register('farm', {
  init()    { farmManager.init();    },
  destroy() { farmManager.destroy(); },
});

export default farmManager;
