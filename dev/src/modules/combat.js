/**
 * modules/combat.js — CombatManager : CS sniping et alertes d'attaques
 *
 * Implémente :
 *   FR8 — CS Sniping (timer précis avec compensation de latence)
 *   FR9 — Alertes d'attaques entrantes + auto-dodge optionnel
 *
 * Logique CS Sniping :
 *   addSnipe() reçoit :
 *     - targetCityId    : ville cible du CS ennemi (là où arrivent les CS)
 *     - csArrivalTs     : timestamp (ms) d'arrivée du CS ennemi
 *     - sourceCityId    : ville d'où on envoie le snipe
 *     - units           : unités à envoyer (format { archer: N, ... })
 *     - anchorMode      : mode anti-timer (support vers sa propre ville puis redirect)
 *
 *   Calcul du send time :
 *     1. Récupérer les coordonnées des deux villes
 *     2. Calculer la distance euclidienne
 *     3. Calculer travelTime = distance / (unitSpeed × worldSpeed × unitSpeedMult) × 60000
 *     4. sendTime = csArrivalTs - travelTime - offsetMs
 *     5. À sendTime : appeler bridge.sendSupport()
 *
 *   Anchor mode :
 *     Technique avancée qui contourne le timer anti-bot de Grepolis.
 *     On envoie d'abord en support vers une ville alliée proche,
 *     puis on rappelle juste avant l'arrivée du CS.
 *     Implémentation simplifiée ici — anchor réel nécessite l'API recall units.
 *
 * Logique alertes (FR9) :
 *   Hooker bridge.onGameEvent('attack:incoming') → émettre 'combat:alert'
 *   Si autoDodge activé : envoyer les troupes en support vers une ville alliée
 */

import { hermes  } from '../core.js';
import { bridge  } from '../bridge.js';
import { human   } from '../engine/human.js';
import { storage } from '../storage.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/**
 * Offset par défaut appliqué au send time (ms avant l'arrivée du CS ennemi).
 * -2000ms = on envoie 2s avant l'arrivée théorique du CS.
 * Doit compenser la latence réseau et le délai de traitement.
 */
const DEFAULT_SNIPE_OFFSET_MS = -2_000;

/**
 * Intervalle de mise à jour du countdown (ms).
 * On émet 'combat:snipe:countdown' toutes les secondes pour le dashboard.
 */
const COUNTDOWN_INTERVAL_MS = 1_000;

/**
 * Vitesse de base des unités (unités arbitraires de Grepolis).
 * La vitesse réelle d'une unité est : unitBaseSpeed × worldSpeed × worldUnitSpeedMult
 * La valeur 1.0 correspond à une unité standard (ex: épéiste) à world speed 1.
 */
const DEFAULT_UNIT_SPEED = 1.0;

/**
 * Fenêtre de sécurité minimum avant le send time (ms).
 * Si sendTime < now + MIN_SCHEDULE_AHEAD_MS, on refuse le snipe
 * (il est trop tard pour être précis).
 */
const MIN_SCHEDULE_AHEAD_MS = 500;

/**
 * Délai maximum de détection d'attaque avant alerte (ms).
 * Une attaque arrivant dans moins de cette durée déclenche une alerte urgente.
 */
const URGENT_ATTACK_THRESHOLD_MS = 10 * 60_000; // 10 minutes

// ─── Types internes ───────────────────────────────────────────────────────────

/**
 * @typedef {object} SnipeTimer
 * @property {string}             snipeId         - ID unique généré
 * @property {string|number}      targetCityId    - Ville cible du CS ennemi
 * @property {string|number}      sourceCityId    - Ville d'origine du snipe
 * @property {number}             csArrivalTs     - Timestamp ms d'arrivée du CS
 * @property {number}             sendTime        - Timestamp ms calculé pour envoyer
 * @property {number}             travelTimeMs    - Temps de trajet calculé
 * @property {Object.<string,number>} units       - Unités à envoyer
 * @property {boolean}            anchorMode      - Mode anchor actif
 * @property {'pending'|'sent'|'cancelled'|'failed'} status
 * @property {{ cancel: Function, promise: Promise }|null} handle - Handle human.schedule
 */

// ─── État interne ─────────────────────────────────────────────────────────────

/** Map<snipeId, SnipeTimer> */
const _snipes = new Map();

/** Compteur pour les IDs uniques. */
let _snipeIdCounter = 0;

/** Handle de l'interval de countdown. */
let _countdownIntervalId = null;

/** Flags de configuration. */
let _alertEnabled = true;
let _autoDodge    = false;

/** Flag de fonctionnement. */
let _running = false;

/** Statistiques. */
let _stats = {
  snipesAdded:     0,
  snipesSent:      0,
  snipesCancelled: 0,
  snipesFailed:    0,
  alertsEmitted:   0,
  dodgesAttempted: 0,
  errors:          0,
};

// ─── Calcul de distance et de temps de trajet ─────────────────────────────────

/**
 * Calcule la distance euclidienne entre deux points sur la carte Grepolis.
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
function euclideanDistance(x1, y1, x2, y2) {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

/**
 * Calcule le temps de trajet en millisecondes entre deux villes pour un type d'unité.
 *
 * Formule Grepolis :
 *   travelMs = distance / (unitSpeed × worldSpeed × unitSpeedMult) × 60000
 *
 * @param {number} distance       - Distance en unités de carte
 * @param {number} unitSpeed      - Vitesse de base de l'unité (défaut 1.0)
 * @param {number} worldSpeed     - Vitesse du monde (ex: 3 pour speed3)
 * @param {number} unitSpeedMult  - Multiplicateur de vitesse des unités
 * @returns {number} Millisecondes de trajet
 */
function calculateTravelTime(distance, unitSpeed, worldSpeed, unitSpeedMult) {
  const speed = unitSpeed * worldSpeed * unitSpeedMult;
  if (speed <= 0) return Infinity;
  // La formule retourne des minutes, on convertit en ms.
  return (distance / speed) * 60_000;
}

/**
 * Résout les coordonnées d'une ville à partir de son ID.
 * Retourne null si la ville n'est pas trouvée.
 *
 * @param {string|number} cityId
 * @returns {{ x: number, y: number }|null}
 */
function resolveCityCoords(cityId) {
  try {
    const city = bridge.getCity(cityId);
    if (!city) return null;
    return { x: city.x, y: city.y };
  } catch (err) {
    hermes.log.warn(`CombatManager: resolveCityCoords(${cityId}) a échoué`, err);
    return null;
  }
}

/**
 * Récupère le worldProfile courant depuis le bridge.
 * @returns {{ speed: number, unitSpeedMult: number }}
 */
function getWorldParams() {
  try {
    const profile = bridge.getWorldSettings();
    return {
      speed:        profile?.speed        ?? 1,
      unitSpeedMult: profile?.unitSpeedMult ?? 1,
    };
  } catch {
    return { speed: 1, unitSpeedMult: 1 };
  }
}

// ─── Génération d'ID de snipe ─────────────────────────────────────────────────

function generateSnipeId() {
  return `snipe_${Date.now()}_${++_snipeIdCounter}`;
}

// ─── Exécution du snipe ───────────────────────────────────────────────────────

/**
 * Exécute le snipe : envoie les troupes au moment calculé.
 * @param {SnipeTimer} snipe
 * @returns {Promise<void>}
 */
async function executeSnipe(snipe) {
  if (snipe.status !== 'pending') return;

  hermes.log.info(
    `CombatManager: exécution snipe ${snipe.snipeId} — envoi de ${snipe.sourceCityId} vers ${snipe.targetCityId}`,
    snipe.units,
  );

  try {
    // Récupérer les coordonnées de la ville cible.
    const targetCoords = resolveCityCoords(snipe.targetCityId);
    if (!targetCoords) {
      hermes.log.error(`CombatManager: coordonnées ville cible ${snipe.targetCityId} introuvables`);
      snipe.status = 'failed';
      _stats.snipesFailed++;
      return;
    }

    const success = await bridge.sendSupport(
      snipe.sourceCityId,
      targetCoords.x,
      targetCoords.y,
      snipe.units,
      Math.floor(snipe.csArrivalTs / 1000), // bridge attend un timestamp Unix (secondes)
    );

    if (success) {
      snipe.status = 'sent';
      _stats.snipesSent++;

      human.recordAction('combat:snipe', snipe.sourceCityId);
      storage.recordAction('combat:snipe', snipe.sourceCityId, {
        targetCityId: snipe.targetCityId,
        csArrivalTs:  snipe.csArrivalTs,
        units:        snipe.units,
      });

      hermes.emit('combat:snipe:set', {
        targetCityId:  snipe.targetCityId,
        arrivalTime:   snipe.csArrivalTs,
        scheduledSend: snipe.sendTime,
        snipeId:       snipe.snipeId,
      });

      hermes.log.info(`CombatManager: snipe ${snipe.snipeId} envoyé avec succès`);
    } else {
      snipe.status = 'failed';
      _stats.snipesFailed++;
      hermes.log.warn(`CombatManager: bridge.sendSupport a retourné false pour snipe ${snipe.snipeId}`);
    }
  } catch (err) {
    snipe.status = 'failed';
    _stats.snipesFailed++;
    _stats.errors++;
    hermes.log.error(`CombatManager: erreur exécution snipe ${snipe.snipeId}`, err);
  }
}

// ─── Countdown dashboard ──────────────────────────────────────────────────────

/**
 * Démarre l'intervalle de countdown pour le dashboard.
 * Émet 'combat:snipe:countdown' chaque seconde avec la liste des snipes actifs.
 */
function startCountdownInterval() {
  if (_countdownIntervalId !== null) return;

  // On utilise setInterval natif ici car c'est un polling UI, pas une action de jeu.
  // Un humain ne perçoit pas ces updates comme des actions — pas besoin de human.schedule.
  _countdownIntervalId = setInterval(() => {
    const now = Date.now();
    const activeSnipes = [..._snipes.values()]
      .filter((s) => s.status === 'pending')
      .map((s) => ({
        snipeId:       s.snipeId,
        targetCityId:  s.targetCityId,
        sourceCityId:  s.sourceCityId,
        msUntilSend:   Math.max(0, s.sendTime - now),
        msUntilArrival: Math.max(0, s.csArrivalTs - now),
        units:         s.units,
        anchorMode:    s.anchorMode,
      }));

    if (activeSnipes.length > 0) {
      hermes.emit('combat:snipe:countdown', { snipes: activeSnipes });
    }
  }, COUNTDOWN_INTERVAL_MS);
}

/**
 * Arrête l'intervalle de countdown.
 */
function stopCountdownInterval() {
  if (_countdownIntervalId !== null) {
    clearInterval(_countdownIntervalId);
    _countdownIntervalId = null;
  }
}

// ─── FR9 : Alertes d'attaques ─────────────────────────────────────────────────

/**
 * Traite une attaque entrante détectée via bridge.onGameEvent.
 * @param {import('../bridge.js').Attack} attack
 */
async function handleIncomingAttack(attack) {
  if (!attack || !_alertEnabled) return;

  const msUntilArrival = Math.max(0, (attack.arrivalTime * 1000) - Date.now());
  const isUrgent = msUntilArrival < URGENT_ATTACK_THRESHOLD_MS;

  hermes.emit('combat:alert', {
    attack,
    msUntilArrival,
    isUrgent,
  });

  _stats.alertsEmitted++;

  hermes.log.warn(
    `CombatManager: attaque entrante${isUrgent ? ' URGENTE' : ''} — arrivée dans ${Math.ceil(msUntilArrival / 60000)} min`,
    { fromCityId: attack.fromCityId, toCityId: attack.toCityId, units: attack.units },
  );

  // Auto-dodge si activé et si l'attaque est urgente.
  if (_autoDodge && isUrgent) {
    await attemptDodge(attack);
  }
}

/**
 * Tente d'esquiver une attaque en envoyant les troupes en support vers une ville alliée.
 * @param {import('../bridge.js').Attack} attack
 * @returns {Promise<void>}
 */
async function attemptDodge(attack) {
  _stats.dodgesAttempted++;
  hermes.log.info(`CombatManager: auto-dodge déclenché pour ville ${attack.toCityId}`);

  try {
    // Trouver une ville alliée où envoyer les troupes.
    const allCities = bridge.getCities();
    if (!allCities || allCities.length < 2) {
      hermes.log.warn('CombatManager: impossible de dodger — moins de 2 villes disponibles');
      return;
    }

    // Choisir une ville autre que la ville attaquée.
    const safeCity = allCities.find((c) => String(c.id) !== String(attack.toCityId));
    if (!safeCity) {
      hermes.log.warn('CombatManager: aucune ville safe trouvée pour le dodge');
      return;
    }

    // Récupérer les unités de la ville attaquée.
    const attackedCity = bridge.getCity(attack.toCityId);
    if (!attackedCity) return;

    // Envoi de toutes les unités disponibles en support vers la ville safe.
    // units = objet vide → le bridge enverra les troupes disponibles.
    // (Implémentation simplifiée — en production on passerait les unités réelles.)
    const success = await bridge.sendSupport(
      attack.toCityId,
      safeCity.x,
      safeCity.y,
      {}, // Le bridge doit récupérer les unités disponibles
    );

    if (success) {
      hermes.log.info(`CombatManager: dodge réussi — troupes envoyées vers ${safeCity.name}`);
      human.recordAction('combat:dodge', attack.toCityId);
    } else {
      hermes.log.warn('CombatManager: échec du dodge');
    }
  } catch (err) {
    hermes.log.error('CombatManager: erreur auto-dodge', err);
    _stats.errors++;
  }
}

// ─── Souscriptions aux événements ─────────────────────────────────────────────

/** Unsub pour l'event d'attaque via bridge. */
let _attackUnsub = null;
const _unsubs = [];

function attachListeners() {
  _unsubs.push(hermes.on('hermes:ready', () => {
    hermes.log.info('CombatManager: hermes:ready — activation des hooks');
    startCountdownInterval();
    attachAttackHook();
  }));

  _unsubs.push(hermes.on('hermes:stopped', () => {
    _running = false;
    cleanup();
  }));

  _unsubs.push(hermes.on('game:loaded', () => {
    attachAttackHook();
  }));
}

function attachAttackHook() {
  if (_attackUnsub) return; // Déjà attaché.
  try {
    _attackUnsub = bridge.onGameEvent('attack:incoming', handleIncomingAttack);
    hermes.log.debug('CombatManager: hook attack:incoming actif');
  } catch (err) {
    hermes.log.warn('CombatManager: impossible d\'attacher le hook attack:incoming', err);
  }
}

function cleanup() {
  stopCountdownInterval();

  // Annuler tous les snipes en attente.
  for (const snipe of _snipes.values()) {
    if (snipe.status === 'pending' && snipe.handle) {
      snipe.handle.cancel();
      snipe.status = 'cancelled';
    }
  }

  // Désinscription du hook d'attaque.
  if (_attackUnsub) {
    try { _attackUnsub(); } catch { /* ignore */ }
    _attackUnsub = null;
  }
}

function detachListeners() {
  for (const unsub of _unsubs) unsub();
  _unsubs.length = 0;
  cleanup();
}

// ─── Interface publique ───────────────────────────────────────────────────────

export const combatManager = {

  /**
   * Initialise le CombatManager.
   */
  init() {
    hermes.log.info('CombatManager: init');
    _running = true;

    // Charger la config de combat.
    const config = storage.getConfig();
    _alertEnabled = config.combatConfig?.alertIncoming ?? true;
    _autoDodge    = config.combatConfig?.autoDodge     ?? false;

    attachListeners();

    if (hermes.isRunning) {
      startCountdownInterval();
      attachAttackHook();
    }
  },

  /**
   * Arrête proprement le CombatManager.
   */
  destroy() {
    hermes.log.info('CombatManager: destroy');
    _running = false;
    detachListeners();
  },

  /**
   * Retourne le statut courant du module.
   * @returns {object}
   */
  getStatus() {
    const activeCount    = [..._snipes.values()].filter((s) => s.status === 'pending').length;
    const completedCount = [..._snipes.values()].filter((s) => s.status === 'sent').length;

    return {
      running:          _running,
      alertEnabled:     _alertEnabled,
      autoDodge:        _autoDodge,
      activeSnipes:     activeCount,
      completedSnipes:  completedCount,
      stats:            { ..._stats },
    };
  },

  /**
   * Ajoute un timer de snipe.
   *
   * @param {string|number}      targetCityId    - Ville cible du CS ennemi
   * @param {number}             csArrivalTs     - Timestamp ms d'arrivée du CS ennemi
   * @param {string|number}      sourceCityId    - Ville d'où on snipe
   * @param {Object.<string,number>} units       - Unités à envoyer
   * @param {boolean}            [anchorMode=false] - Mode anti-timer anchor
   * @param {number}             [offsetMs]      - Offset en ms (défaut: -2000)
   * @returns {string|null} snipeId ou null en cas d'erreur
   */
  addSnipe(targetCityId, csArrivalTs, sourceCityId, units, anchorMode = false, offsetMs = DEFAULT_SNIPE_OFFSET_MS) {
    try {
      // Valider les paramètres.
      if (!targetCityId || !csArrivalTs || !sourceCityId || !units) {
        hermes.log.warn('CombatManager: addSnipe — paramètres invalides');
        return null;
      }

      // Récupérer les coordonnées des deux villes.
      const sourceCoords = resolveCityCoords(sourceCityId);
      const targetCoords = resolveCityCoords(targetCityId);

      if (!sourceCoords || !targetCoords) {
        hermes.log.error(
          `CombatManager: addSnipe — coordonnées introuvables (source: ${sourceCityId}, target: ${targetCityId})`,
        );
        return null;
      }

      // Calculer la distance et le temps de trajet.
      const distance = euclideanDistance(
        sourceCoords.x, sourceCoords.y,
        targetCoords.x, targetCoords.y,
      );

      const worldParams = getWorldParams();

      // Vitesse de l'unité la plus lente dans l'ensemble (pire cas = snipe arrive à temps).
      // Pour un snipe de CS on cherche généralement la plus rapide — ici on utilise DEFAULT.
      const travelTimeMs = calculateTravelTime(
        distance,
        DEFAULT_UNIT_SPEED,
        worldParams.speed,
        worldParams.unitSpeedMult,
      );

      // Calculer le send time.
      const sendTime = csArrivalTs - travelTimeMs + offsetMs;
      const now = Date.now();

      // Vérifier qu'on a encore le temps.
      if (sendTime < now + MIN_SCHEDULE_AHEAD_MS) {
        hermes.log.warn(
          `CombatManager: addSnipe — trop tard pour planner (sendTime dans ${Math.ceil((sendTime - now) / 1000)}s)`,
        );
        return null;
      }

      const snipeId = generateSnipeId();

      /** @type {SnipeTimer} */
      const snipe = {
        snipeId,
        targetCityId,
        sourceCityId,
        csArrivalTs,
        sendTime,
        travelTimeMs,
        units,
        anchorMode,
        status: 'pending',
        handle: null,
      };

      // Planifier l'exécution avec human.schedule.
      // Le délai = sendTime - now.
      const delayMs = sendTime - now;
      const handle = human.schedule(
        async () => executeSnipe(snipe),
        delayMs,
        0, // variance 0 pour les snipes — la précision est critique
      );
      snipe.handle = handle;

      _snipes.set(snipeId, snipe);
      _stats.snipesAdded++;

      hermes.log.info(
        `CombatManager: snipe ${snipeId} planifié — envoi dans ${Math.ceil(delayMs / 1000)}s (distance: ${distance.toFixed(1)}, trajet: ${Math.ceil(travelTimeMs / 1000)}s)`,
      );

      return snipeId;
    } catch (err) {
      hermes.log.error('CombatManager: erreur addSnipe', err);
      _stats.errors++;
      return null;
    }
  },

  /**
   * Annule un snipe planifié.
   * @param {string} snipeId
   * @returns {boolean} true si annulé
   */
  cancelSnipe(snipeId) {
    const snipe = _snipes.get(snipeId);
    if (!snipe) {
      hermes.log.warn(`CombatManager: cancelSnipe — snipe ${snipeId} introuvable`);
      return false;
    }
    if (snipe.status !== 'pending') {
      hermes.log.warn(`CombatManager: cancelSnipe — snipe ${snipeId} n'est pas pending (status: ${snipe.status})`);
      return false;
    }

    if (snipe.handle) {
      snipe.handle.cancel();
    }
    snipe.status = 'cancelled';
    _stats.snipesCancelled++;

    hermes.log.info(`CombatManager: snipe ${snipeId} annulé`);
    return true;
  },

  /**
   * Retourne la liste des snipes actifs (status: 'pending').
   * @returns {SnipeTimer[]}
   */
  getActiveSnipes() {
    return [..._snipes.values()].filter((s) => s.status === 'pending');
  },

  /**
   * Active ou désactive les alertes d'attaques entrantes.
   * @param {boolean} enabled
   */
  setAlertEnabled(enabled) {
    _alertEnabled = Boolean(enabled);
    storage.updateConfig({ combatConfig: { alertIncoming: _alertEnabled } });
    hermes.log.info(`CombatManager: alertes ${_alertEnabled ? 'activées' : 'désactivées'}`);
  },

  /**
   * Active ou désactive l'auto-dodge.
   * ATTENTION : l'auto-dodge est expérimental et peut envoyer des troupes
   * au mauvais endroit en cas de bug. À utiliser avec précaution.
   * @param {boolean} enabled
   */
  setAutoDodge(enabled) {
    _autoDodge = Boolean(enabled);
    storage.updateConfig({ combatConfig: { autoDodge: _autoDodge } });
    hermes.log.warn(
      `CombatManager: auto-dodge ${_autoDodge ? 'ACTIVÉ' : 'désactivé'}${_autoDodge ? ' — expérimental, surveiller les troupes' : ''}`,
    );
  },
};

// ─── Auto-registration ────────────────────────────────────────────────────────

hermes.register('combat', {
  init()    { combatManager.init();    },
  destroy() { combatManager.destroy(); },
});

export default combatManager;
