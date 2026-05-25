/**
 * modules/situation.js — SituationAnalyzer : analyse géopolitique temps réel
 *
 * Responsabilités :
 * - Calculer un threatScore (0-100) pour chaque ville du joueur
 * - Analyser les cellules de carte autour de chaque ville pour identifier les menaces
 * - Détecter les patterns d'attaque ennemis (fréquence, horaire)
 * - Émettre 'situation:updated' et 'situation:alert' (si score > 70)
 * - Persister les scores dans storage.state.situationScores
 *
 * Le module se re-analyse automatiquement toutes les ~15min (gaussien σ=2min).
 * Sur événement 'alliance:changed', il re-analyse immédiatement les villes impactées.
 * Sur 'combat:alert', il enregistre le pattern d'attaque ennemi.
 *
 * Ce module est READ-ONLY sur le jeu — il n'émet aucune action.
 */

import { hermes }  from '../core.js';
import { bridge }  from '../bridge.js';
import { human }   from '../engine/human.js';
import { storage } from '../storage.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Rayon d'analyse autour de chaque ville (unités de carte). */
const ANALYSIS_RADIUS = 25;

/** Seuil de score au-dessus duquel une alerte est émise. */
const ALERT_THRESHOLD = 70;

/** Intervalle nominal d'analyse complète (15 minutes en ms). */
const ANALYSIS_INTERVAL_MS = 15 * 60 * 1000;

/** Variance gaussienne de l'intervalle (±2 min / 15 min ≈ 13%). */
const ANALYSIS_VARIANCE_PCT = 2 / 15;

/**
 * Facteurs de relation → multiplicateur de menace.
 * 'war' = menace maximale, 'ally' = aucune menace.
 */
const REL_FACTORS = {
  war:     1.0,
  enemy:   0.7,
  neutral: 0.2,
  nap:     0.05,
  ally:    0.0,
};

/**
 * Nombre minimum d'attaques d'un même joueur pour détecter un pattern.
 */
const PATTERN_MIN_ATTACKS = 3;

// ─── État interne ─────────────────────────────────────────────────────────────

/** Map<cityId, threatScore> — scores courants */
const _scores = new Map();

/** Map<cityId, Threat[]> — listes de menaces par ville */
const _threats = new Map();

/**
 * Map<playerId, PatternRecord> — historique et patterns d'attaque par joueur ennemi
 * @typedef {{ playerId: string, attacks: AttackRecord[], pattern: Pattern|null }} PatternRecord
 * @typedef {{ timestamp: number, toCityId: string|number, units: object }} AttackRecord
 * @typedef {{ preferredHour: number, avgIntervalMs: number, dominantType: string }} Pattern
 */
const _attackPatterns = new Map();

/** Handle du timeout de la prochaine analyse globale */
let _analysisSchedule = null;

/** Unsubscribers pour cleanup */
const _subs = [];

// ─── Calcul du threatScore ────────────────────────────────────────────────────

/**
 * Calcule le score de menace pour une ville donnée.
 * Score = somme pondérée des menaces des cellules voisines.
 * Facteurs : relation diplomatique × distance inverse × taille de la ville.
 *
 * @param {{ id: string|number, x: number, y: number }} city
 * @param {import('../bridge.js').MapCell[]} mapCells - Cellules dans le rayon
 * @param {import('../bridge.js').Relation[]} relations - Relations diplomatiques connues
 * @returns {number} Score dans [0, 100]
 */
function calcThreatScore(city, mapCells, relations) {
  let score = 0;

  for (const cell of mapCells) {
    // Distance euclidienne entre la ville et la cellule
    const dist = Math.sqrt((cell.x - city.x) ** 2 + (cell.y - city.y) ** 2);
    if (dist > ANALYSIS_RADIUS) continue;

    // Ignorer les cellules sans joueur (cases vides, PNJ)
    if (!cell.playerId) continue;

    // Trouver la relation diplomatique avec ce joueur
    const rel       = relations.find((r) => r.playerId === cell.playerId);
    const relType   = rel?.type ?? 'neutral';
    const relFactor = REL_FACTORS[relType] ?? REL_FACTORS.neutral;

    // Ignorer les alliés
    if (relFactor === 0) continue;

    // Plus la ville ennemie est proche, plus la menace est grande
    const distFactor = Math.max(0, 1 - dist / ANALYSIS_RADIUS);

    // Plus la ville ennemie est puissante, plus la menace est grande
    const sizeFactor = Math.min(1, (cell.cityPoints ?? 0) / 5000);

    score += relFactor * distFactor * sizeFactor * 100;
  }

  // Ajouter un bonus de menace si le joueur a des patterns d'attaque établis
  // contre cette ville spécifiquement
  for (const [, patternRec] of _attackPatterns) {
    if (patternRec.pattern && patternRec.attacks.some((a) => a.toCityId == city.id)) {
      // +15 pour un attaquant récurrent avec pattern confirmé
      score += 15;
      break;
    }
  }

  return Math.min(100, score);
}

/**
 * Construit la liste des menaces identifiées pour une ville.
 * @param {{ id: string|number, x: number, y: number }} city
 * @param {import('../bridge.js').MapCell[]} mapCells
 * @param {import('../bridge.js').Relation[]} relations
 * @returns {Array<{ playerId, playerName, allianceName, distance, relType, cityPoints, score }>}
 */
function buildThreatList(city, mapCells, relations) {
  const threats = [];

  for (const cell of mapCells) {
    if (!cell.playerId) continue;
    const rel       = relations.find((r) => r.playerId === cell.playerId);
    const relType   = rel?.type ?? 'neutral';
    const relFactor = REL_FACTORS[relType] ?? REL_FACTORS.neutral;
    if (relFactor === 0) continue;

    const dist        = Math.sqrt((cell.x - city.x) ** 2 + (cell.y - city.y) ** 2);
    if (dist > ANALYSIS_RADIUS) continue;

    const distFactor  = Math.max(0, 1 - dist / ANALYSIS_RADIUS);
    const sizeFactor  = Math.min(1, (cell.cityPoints ?? 0) / 5000);
    const threatScore = relFactor * distFactor * sizeFactor * 100;

    if (threatScore > 1) {
      threats.push({
        playerId:     cell.playerId,
        playerName:   cell.playerName ?? 'Inconnu',
        allianceName: cell.allianceName ?? null,
        distance:     Math.round(dist * 10) / 10,
        relType,
        cityPoints:   cell.cityPoints ?? 0,
        score:        Math.round(threatScore),
      });
    }
  }

  // Trier par score décroissant
  threats.sort((a, b) => b.score - a.score);
  return threats.slice(0, 10); // Garder les 10 menaces les plus significatives
}

// ─── Analyse par ville ────────────────────────────────────────────────────────

/**
 * Analyse la situation géopolitique pour une ville spécifique.
 * Met à jour _scores et _threats, émet les événements appropriés.
 *
 * @param {{ id: string|number, x: number, y: number, name: string }} city
 * @returns {Promise<void>}
 */
async function analyzeCity(city) {
  try {
    const [mapCells, relations] = await Promise.all([
      Promise.resolve().then(() => bridge.getMapData(city.x, city.y, ANALYSIS_RADIUS)),
      Promise.resolve().then(() => bridge.getPlayerRelations()),
    ]);

    const threatScore = calcThreatScore(city, mapCells, relations);
    const threats     = buildThreatList(city, mapCells, relations);

    const prev = _scores.get(String(city.id));
    _scores.set(String(city.id), threatScore);
    _threats.set(String(city.id), threats);

    // Recommandations à émettre (délégué à l'advisor via l'event)
    hermes.emit('situation:updated', {
      cityId:      city.id,
      cityName:    city.name,
      threatScore,
      threats,
      prevScore:   prev ?? null,
    });

    // Alerte si score élevé
    if (threatScore > ALERT_THRESHOLD) {
      hermes.log.warn(`SituationAnalyzer: alerte menace ville ${city.name} (score: ${Math.round(threatScore)})`);
      hermes.emit('situation:alert', {
        cityId:     city.id,
        cityName:   city.name,
        threatScore,
        reason:     `Score de menace élevé : ${Math.round(threatScore)}/100`,
      });
    }
  } catch (err) {
    hermes.log.error(`SituationAnalyzer: erreur analyse ville ${city.id}`, err);
  }
}

// ─── Analyse globale ──────────────────────────────────────────────────────────

/**
 * Lance une analyse complète de toutes les villes du joueur.
 * Séquentielle pour éviter de saturer le bridge.
 *
 * @returns {Promise<void>}
 */
async function runFullAnalysis() {
  let cities;
  try {
    cities = bridge.getCities();
  } catch (err) {
    hermes.log.error('SituationAnalyzer: getCities() a échoué', err);
    return;
  }

  if (!cities || cities.length === 0) {
    hermes.log.warn('SituationAnalyzer: aucune ville trouvée');
    return;
  }

  hermes.log.debug(`SituationAnalyzer: analyse de ${cities.length} ville(s)`);

  for (const city of cities) {
    await analyzeCity(city);
  }

  // Persister les scores dans le storage
  try {
    const scoresObj = Object.fromEntries(_scores);
    storage.updateState({ situationScores: scoresObj });
  } catch (err) {
    hermes.log.warn('SituationAnalyzer: impossible de persister les scores', err);
  }
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Planifie la prochaine analyse globale avec délai gaussien (~15min ±2min).
 */
function scheduleNextAnalysis() {
  if (_analysisSchedule) {
    _analysisSchedule.cancel();
    _analysisSchedule = null;
  }

  _analysisSchedule = human.schedule(async () => {
    if (!hermes.isRunning) return;
    await runFullAnalysis();
    scheduleNextAnalysis(); // Boucle
  }, ANALYSIS_INTERVAL_MS, ANALYSIS_VARIANCE_PCT);
}

// ─── Gestion des patterns d'attaque ──────────────────────────────────────────

/**
 * Enregistre une attaque entrante et met à jour les patterns du joueur attaquant.
 * @param {import('../bridge.js').Attack} attack
 */
function recordAttack(attack) {
  if (!attack?.fromCityId) return;

  // On utilise fromCityId comme proxy du joueur (faute d'un playerId direct dans Attack)
  const key = String(attack.fromCityId);

  if (!_attackPatterns.has(key)) {
    _attackPatterns.set(key, {
      playerId: key,
      attacks:  [],
      pattern:  null,
    });
  }

  const record = _attackPatterns.get(key);
  record.attacks.push({
    timestamp: Date.now(),
    toCityId:  attack.toCityId,
    units:     attack.units ?? {},
    arrivalTime: attack.arrivalTime,
  });

  // Garder seulement les 20 dernières attaques
  if (record.attacks.length > 20) {
    record.attacks = record.attacks.slice(-20);
  }

  // Tenter de détecter un pattern si assez d'attaques
  if (record.attacks.length >= PATTERN_MIN_ATTACKS) {
    record.pattern = detectPattern(record.attacks);
  }
}

/**
 * Analyse les attaques d'un joueur et détecte des patterns.
 * @param {AttackRecord[]} attacks
 * @returns {Pattern|null}
 */
function detectPattern(attacks) {
  if (attacks.length < PATTERN_MIN_ATTACKS) return null;

  // Calculer l'heure préférée d'attaque (mode des heures)
  const hourCounts = new Array(24).fill(0);
  for (const atk of attacks) {
    const h = new Date(atk.timestamp).getHours();
    hourCounts[h]++;
  }
  const preferredHour = hourCounts.indexOf(Math.max(...hourCounts));

  // Calculer l'intervalle moyen entre attaques
  const intervals = [];
  const sorted = [...attacks].sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(sorted[i].timestamp - sorted[i - 1].timestamp);
  }
  const avgIntervalMs = intervals.length > 0
    ? intervals.reduce((s, v) => s + v, 0) / intervals.length
    : 0;

  // Type d'attaque dominant (présence de LS / CS / troupes terrestres)
  const unitCounts = {};
  for (const atk of attacks) {
    for (const [unit, count] of Object.entries(atk.units ?? {})) {
      if (count > 0) unitCounts[unit] = (unitCounts[unit] ?? 0) + count;
    }
  }
  const dominantType = Object.keys(unitCounts).sort((a, b) => unitCounts[b] - unitCounts[a])[0] ?? 'unknown';

  return { preferredHour, avgIntervalMs, dominantType };
}

// ─── Interface publique ───────────────────────────────────────────────────────

/**
 * SituationAnalyzer — analyse géopolitique temps réel pour Hermes.
 */
export const situationAnalyzer = {

  /**
   * Initialise le module : souscrit aux événements, planifie la première analyse.
   */
  init() {
    hermes.log.debug('SituationAnalyzer: init');

    // Démarrer l'analyse après que le jeu est chargé
    const unsubGameLoaded = hermes.on('game:loaded', () => {
      hermes.log.debug('SituationAnalyzer: game:loaded — lancement analyse initiale');
      runFullAnalysis().then(() => scheduleNextAnalysis());
    });
    _subs.push(unsubGameLoaded);

    // Re-analyser immédiatement si les relations d'alliance changent
    const unsubAlliance = hermes.on('alliance:changed', ({ playerId }) => {
      hermes.log.debug(`SituationAnalyzer: alliance:changed pour ${playerId} — re-analyse`);
      runFullAnalysis();
    });
    _subs.push(unsubAlliance);

    // Enregistrer les attaques entrantes pour la détection de patterns
    const unsubCombat = hermes.on('combat:alert', ({ attack }) => {
      if (attack) {
        recordAttack(attack);
        hermes.log.debug(`SituationAnalyzer: attaque enregistrée depuis ville ${attack.fromCityId}`);
      }
    });
    _subs.push(unsubCombat);

    // Aussi écouter les attaques depuis le bridge
    const unsubAttack = hermes.on('attack:incoming', (attack) => {
      recordAttack(attack);
    });
    _subs.push(unsubAttack);
  },

  /**
   * Nettoie le module : annule le scheduling et les subscriptions.
   */
  destroy() {
    hermes.log.debug('SituationAnalyzer: destroy');
    if (_analysisSchedule) {
      _analysisSchedule.cancel();
      _analysisSchedule = null;
    }
    for (const unsub of _subs) unsub();
    _subs.length = 0;
    _scores.clear();
    _threats.clear();
    _attackPatterns.clear();
  },

  /**
   * Retourne le score de menace courant pour une ville.
   * @param {string|number} cityId
   * @returns {number} Score dans [0, 100], ou 0 si inconnu
   */
  getThreatScore(cityId) {
    return _scores.get(String(cityId)) ?? 0;
  },

  /**
   * Retourne tous les scores de menace.
   * @returns {Map<string, number>} Map<cityId, threatScore>
   */
  getAllScores() {
    return new Map(_scores);
  },

  /**
   * Retourne la liste des menaces identifiées pour une ville.
   * @param {string|number} cityId
   * @returns {Array<object>} Liste de menaces triée par score décroissant
   */
  getThreats(cityId) {
    return _threats.get(String(cityId)) ?? [];
  },

  /**
   * Retourne le record de patterns d'attaque pour un joueur donné.
   * @param {string|number} playerId
   * @returns {PatternRecord|null}
   */
  getAttackPatterns(playerId) {
    return _attackPatterns.get(String(playerId)) ?? null;
  },

  /**
   * Retourne tous les patterns d'attaque connus.
   * @returns {Map<string, PatternRecord>}
   */
  getAllAttackPatterns() {
    return new Map(_attackPatterns);
  },

  /**
   * Déclenche une analyse complète immédiate (hors du cycle normal).
   * @returns {Promise<void>}
   */
  async forceAnalysis() {
    hermes.log.info('SituationAnalyzer: analyse forcée');
    await runFullAnalysis();
  },

  /**
   * Indique si une ville est en état d'alerte (score > ALERT_THRESHOLD).
   * @param {string|number} cityId
   * @returns {boolean}
   */
  isAlert(cityId) {
    return this.getThreatScore(cityId) > ALERT_THRESHOLD;
  },
};

// ─── Auto-registration ────────────────────────────────────────────────────────

hermes.register('situation', {
  init()    { situationAnalyzer.init();    },
  destroy() { situationAnalyzer.destroy(); },
});

export default situationAnalyzer;
