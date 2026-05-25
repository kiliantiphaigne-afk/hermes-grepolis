/**
 * modules/advisor.js — StrategicAdvisor : moteur de recommandations contextuelles
 *
 * Le cœur de la valeur ajoutée d'Hermes. Génère des recommandations stratégiques
 * adaptées à chaque ville, en fonction :
 * - Du profil du monde (vitesse, système de conquête)
 * - Du score de menace géopolitique (via SituationAnalyzer)
 * - De l'état de la ville (bâtiments, spécialisation, files de construction)
 * - Du rang de la ville (n-ième ville du joueur)
 *
 * Le module écoute :
 * - 'world:profile' → stocker le profil du monde
 * - 'situation:updated' → re-générer les recs pour la ville concernée
 * - 'build:queued' → valider l"action par rapport aux recs
 *
 * Les recommandations sont persistées en mémoire (Map) et exposées via getRecommendations().
 * Les ignorer (dismissRecommendation) les marque localement — elles ne reviennent pas
 * lors de la prochaine mise à jour tant que la situation ne change pas significativement.
 */

import { hermes }  from '../core.js';
import { bridge }  from '../bridge.js';
import { storage } from '../storage.js';
import { knowledge, getCitySpecializations } from '../data/knowledge.js';

// ─── Types de recommandations ─────────────────────────────────────────────────

/**
 * Identifiants de types de recommandations.
 * @enum {string}
 */
const REC_TYPES = {
  SPECIALIZATION: 'specialization',  // Suggérer/changer la spécialisation d"une ville
  BUILD_PRIORITY: 'build_priority',  // Prioriser un bâtiment spécifique
  TROOPS:         'troops',          // Recruter des troupes spécifiques
  DEFENSE:        'defense',         // Alerte défense urgente
  TRADE:          'trade',           // Opportunité commerce
  STRATEGY:       'strategy',        // Conseil stratégique macro
};

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Score de menace au-dessus duquel on émet une rec défense urgente */
const DEFENSE_ALERT_THRESHOLD = 70;

/** Score de menace en dessous duquel on recommande une ville offensive */
const CALM_THRESHOLD = 40;

/** Variation minimale de threatScore pour re-générer les recs (évite le spam) */
const RESCORE_DELTA_THRESHOLD = 10;

// ─── État interne ─────────────────────────────────────────────────────────────

/** @type {import('../bridge.js').WorldProfile|null} */
let _worldProfile = null;

/** @type {string|null} ex: 'speed3_revolt' */
let _worldKey = null;

/** Map<cityId, Recommendation[]> — recs actives par ville */
const _recommendations = new Map();

/** Map<cityId, string> — spécialisations manuelles override */
const _citySpecializations = new Map();

/** Set<recId> — recs ignorées par l'utilisateur */
const _dismissed = new Set();

/** Map<cityId, number> — dernier threatScore utilisé pour générer les recs */
const _lastScoreUsed = new Map();

/** Unsubscribers pour cleanup */
const _subs = [];

/** Compteur d'ID de recommandations */
let _recIdCounter = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Génère un ID unique de recommandation.
 * @returns {string}
 */
function nextRecId() {
  return `rec_${Date.now()}_${++_recIdCounter}`;
}

/**
 * Détermine l'index de la ville dans la liste des villes du joueur (0-based).
 * Retourne -1 si introuvable.
 * @param {string|number} cityId
 * @returns {number}
 */
function getCityIndex(cityId) {
  try {
    const cities = bridge.getCities();
    const idx    = cities.findIndex((c) => String(c.id) === String(cityId));
    return idx;
  } catch {
    return 0;
  }
}

/**
 * Retourne le niveau actuel d'un bâtiment dans une ville.
 * @param {import('../bridge.js').City} city
 * @param {string} buildingName
 * @returns {number}
 */
function getBuildingLevel(city, buildingName) {
  return city.buildings?.[buildingName] ?? 0;
}

/**
 * Retourne l'étape de construction prioritaire selon la stratégie cible.
 * Compare les niveaux actuels avec la build_order de la stratégie.
 *
 * @param {import('../bridge.js').City} city
 * @param {object} strategy - Objet stratégie depuis knowledge.js
 * @returns {{ building: string, targetLevel: number, reason: string }|null}
 */
function getNextBuildStep(city, strategy) {
  if (!strategy?.build_order) return null;

  for (const step of strategy.build_order) {
    const current = getBuildingLevel(city, step.building);
    if (current < step.target_level) {
      return {
        building:    step.building,
        targetLevel: step.target_level,
        currentLevel: current,
        reason:      step.reason ?? '',
      };
    }
  }
  return null; // Tous les objectifs atteints
}

/**
 * Retrouve la stratégie en cours pour une ville (selon sa spécialisation actuelle).
 * @param {string|number} cityId
 * @param {number} cityIndex
 * @returns {object|null}
 */
function getStrategyForCity(cityId, cityIndex) {
  // Spécialisation manuelle override
  const manualSpec = _citySpecializations.get(String(cityId));
  if (manualSpec) {
    const strats = Object.values(knowledge.strategies ?? {});
    return strats.find((s) => s.city_specialization === manualSpec) ?? null;
  }

  // Stratégie par défaut selon le monde et l'index
  if (!_worldKey) return null;

  const strats = Object.values(knowledge.strategies ?? {}).filter((s) =>
    Array.isArray(s.applicable_worlds) && s.applicable_worlds.includes(_worldKey)
  );

  if (cityIndex === 0) {
    return strats.find((s) => s.city_specialization === 'colony_rush') ?? null;
  }

  // Villes suivantes : préférer offense si calme, defense sinon
  const score = _lastScoreUsed.get(String(cityId)) ?? 0;
  if (score > DEFENSE_ALERT_THRESHOLD) {
    return strats.find((s) => s.city_specialization === 'defense') ?? null;
  }
  return strats.find((s) => s.city_specialization === 'offense') ?? strats[0] ?? null;
}

// ─── Génération des recommandations ──────────────────────────────────────────

/**
 * Génère la liste complète des recommandations pour une ville.
 *
 * @param {import('../bridge.js').City} city - Données de la ville
 * @param {import('../bridge.js').WorldProfile} worldProfile - Profil du monde
 * @param {number} situationScore - Score de menace (0-100)
 * @param {number} cityIndex - Index 0-based de la ville
 * @returns {Array<Recommendation>}
 *
 * @typedef {{ id: string, type: string, message: string, priority: 'urgent'|'high'|'medium'|'low', actions: Array<object>, cityId: string|number, timestamp: number }} Recommendation
 */
function generateRecommendations(city, worldProfile, situationScore, cityIndex) {
  const recs       = [];
  const speed      = Math.round(worldProfile?.speed ?? 1);
  const system     = worldProfile?.system ?? 'revolt';
  const cityIdStr  = String(city.id);

  // ── 1. Spécialisation de la ville ──────────────────────────────────────────

  if (cityIndex === 0) {
    // Première ville = Colony Rush toujours
    const templateId = `colony_rush_speed${speed}`;
    recs.push({
      id:        nextRecId(),
      type:      REC_TYPES.SPECIALIZATION,
      message:   `Ville 1 → Colony Rush. World Speed ${speed}: Harbor 20 en priorité absolue.`,
      priority:  'high',
      cityId:    city.id,
      timestamp: Date.now(),
      actions:   [{
        label:  'Appliquer template Colony Rush',
        event:  'build:setTemplate',
        data:   { cityId: city.id, templateId },
      }],
    });
  } else if (cityIndex >= 1 && situationScore < CALM_THRESHOLD) {
    // Environnement calme → ville offensive recommandée
    recs.push({
      id:        nextRecId(),
      type:      REC_TYPES.SPECIALIZATION,
      message:   `Environnement calme (menace: ${Math.round(situationScore)}) — ville offensive recommandée pour expansion.`,
      priority:  'medium',
      cityId:    city.id,
      timestamp: Date.now(),
      actions:   [{
        label:  'Appliquer template Offense',
        event:  'build:setTemplate',
        data:   { cityId: city.id, templateId: `offense_speed${speed}` },
      }],
    });
  } else if (cityIndex >= 1 && situationScore >= DEFENSE_ALERT_THRESHOLD) {
    // Zone dangereuse → ville défensive recommandée
    recs.push({
      id:        nextRecId(),
      type:      REC_TYPES.SPECIALIZATION,
      message:   `Zone dangereuse (menace: ${Math.round(situationScore)}) — spécialisation défensive recommandée.`,
      priority:  'high',
      cityId:    city.id,
      timestamp: Date.now(),
      actions:   [{
        label:  'Appliquer template Défense',
        event:  'build:setTemplate',
        data:   { cityId: city.id, templateId: 'defense_city' },
      }],
    });
  }

  // ── 2. Défense urgente si menace élevée ────────────────────────────────────

  if (situationScore > DEFENSE_ALERT_THRESHOLD) {
    recs.push({
      id:        nextRecId(),
      type:      REC_TYPES.DEFENSE,
      message:   `Menace élevée (score: ${Math.round(situationScore)}). Basculer vers template Défense et recruter des archers/slingers immédiatement.`,
      priority:  'urgent',
      cityId:    city.id,
      timestamp: Date.now(),
      actions:   [
        {
          label: 'Basculer en mode Défense',
          event: 'build:setTemplate',
          data:  { cityId: city.id, templateId: 'defense_city' },
        },
        {
          label: 'Voir les attaques entrantes',
          event: 'ui:switchTab',
          data:  { tab: 'combat' },
        },
      ],
    });
  }

  // ── 3. Recommandations de build selon la stratégie active ──────────────────

  const strategy = getStrategyForCity(city.id, cityIndex);
  if (strategy) {
    const nextStep = getNextBuildStep(city, strategy);
    if (nextStep) {
      recs.push({
        id:        nextRecId(),
        type:      REC_TYPES.BUILD_PRIORITY,
        message:   `[${strategy.name ?? strategy.city_specialization}] Prochaine étape : ${nextStep.building} → niveau ${nextStep.targetLevel} (actuellement ${nextStep.currentLevel}). ${nextStep.reason}`,
        priority:  'medium',
        cityId:    city.id,
        timestamp: Date.now(),
        actions:   [{
          label: `Construire ${nextStep.building} lv${nextStep.targetLevel}`,
          event: 'build:prioritize',
          data:  { cityId: city.id, building: nextStep.building, targetLevel: nextStep.targetLevel },
        }],
      });
    }

    // Recommandations de troupes si la stratégie en définit
    if (strategy.troop_targets) {
      const missingTroops = Object.entries(strategy.troop_targets)
        .filter(([unit]) => {
          // On ne peut pas connaître les effectifs depuis bridge.getCity() directement,
          // mais on peut signaler les objectifs généraux
          return true;
        })
        .map(([unit, target]) => `${target} ${unit}`)
        .join(', ');

      if (missingTroops && cityIndex === 0) {
        recs.push({
          id:        nextRecId(),
          type:      REC_TYPES.TROOPS,
          message:   `Objectifs de troupes pour Colony Rush : ${missingTroops}.`,
          priority:  'low',
          cityId:    city.id,
          timestamp: Date.now(),
          actions:   [],
        });
      }
    }
  }

  // ── 4. Harbor 20 — rappel critique si ville 1 ─────────────────────────────

  if (cityIndex === 0) {
    const harborLevel = getBuildingLevel(city, 'harbor');
    if (harborLevel < 20) {
      recs.push({
        id:        nextRecId(),
        type:      REC_TYPES.STRATEGY,
        message:   `Harbor actuellement niveau ${harborLevel}/20. C'est la priorité absolue pour débloquer le Colony Ship.`,
        priority:  harborLevel < 10 ? 'high' : 'medium',
        cityId:    city.id,
        timestamp: Date.now(),
        actions:   [{
          label: `Prioriser Harbor → 20`,
          event: 'build:prioritize',
          data:  { cityId: city.id, building: 'harbor', targetLevel: 20 },
        }],
      });
    }
  }

  // ── 5. Conseil macro selon le monde ────────────────────────────────────────

  if (worldProfile?.ww && cityIndex >= 3) {
    recs.push({
      id:        nextRecId(),
      type:      REC_TYPES.STRATEGY,
      message:   `Monde WW actif — envisager de spécialiser cette ville en "Support Merveilles" (Market 30 + Warehouse 30).`,
      priority:  'low',
      cityId:    city.id,
      timestamp: Date.now(),
      actions:   [{
        label: 'Appliquer template WW Support',
        event: 'build:setTemplate',
        data:  { cityId: city.id, templateId: 'ww_support_city' },
      }],
    });
  }

  // Filtrer les recommandations ignorées
  return recs.filter((r) => !_dismissed.has(r.id));
}

// ─── Mise à jour des recommandations ─────────────────────────────────────────

/**
 * Re-génère les recommandations pour une ville donnée.
 * Ne re-génère pas si le score n'a pas changé de plus de RESCORE_DELTA_THRESHOLD.
 *
 * @param {string|number} cityId
 * @param {number} threatScore
 * @param {boolean} [force=false] - Forcer même si le delta est faible
 */
function updateRecommendationsForCity(cityId, threatScore, force = false) {
  const prev = _lastScoreUsed.get(String(cityId)) ?? null;
  const delta = prev !== null ? Math.abs(threatScore - prev) : Infinity;

  if (!force && delta < RESCORE_DELTA_THRESHOLD) return;

  _lastScoreUsed.set(String(cityId), threatScore);

  let city;
  try {
    city = bridge.getCity(cityId);
  } catch (err) {
    hermes.log.warn(`StrategicAdvisor: getCity(${cityId}) a échoué`, err);
    return;
  }

  if (!city) {
    hermes.log.warn(`StrategicAdvisor: ville ${cityId} introuvable`);
    return;
  }

  if (!_worldProfile) {
    hermes.log.debug('StrategicAdvisor: worldProfile non disponible — recs différées');
    return;
  }

  const cityIndex = getCityIndex(cityId);
  const recs      = generateRecommendations(city, _worldProfile, threatScore, cityIndex);

  _recommendations.set(String(cityId), recs);

  // Émettre les recs de haute priorité
  for (const rec of recs) {
    if (rec.priority === 'urgent' || rec.priority === 'high') {
      hermes.emit('advisor:recommendation', {
        cityId:   city.id,
        type:     rec.type,
        message:  rec.message,
        priority: rec.priority,
        actions:  rec.actions,
      });
    }
  }
}

// ─── Interface publique ───────────────────────────────────────────────────────

/**
 * StrategicAdvisor — moteur de recommandations Hermes.
 */
export const strategicAdvisor = {

  /**
   * Initialise le module : souscrit aux événements sources.
   */
  init() {
    hermes.log.debug('StrategicAdvisor: init');

    // Recevoir le profil du monde
    const unsubWorld = hermes.on('world:profile', ({ profile, worldKey }) => {
      _worldProfile = profile;
      _worldKey     = worldKey;
      hermes.log.debug(`StrategicAdvisor: profil monde reçu (${worldKey})`);
      // Déclencher une mise à jour forcée de toutes les villes connues
      for (const [cityId] of _recommendations) {
        const score = _lastScoreUsed.get(cityId) ?? 0;
        updateRecommendationsForCity(cityId, score, true);
      }
    });
    _subs.push(unsubWorld);

    // Mise à jour si le profil change en cours de session
    const unsubWorldUpd = hermes.on('world:profile:updated', ({ profile, worldKey }) => {
      _worldProfile = profile;
      _worldKey     = worldKey;
    });
    _subs.push(unsubWorldUpd);

    // Recevoir les mises à jour de situation pour chaque ville
    const unsubSituation = hermes.on('situation:updated', ({ cityId, threatScore }) => {
      updateRecommendationsForCity(cityId, threatScore);
    });
    _subs.push(unsubSituation);

    // Valider les actions de construction par rapport aux recs
    const unsubBuild = hermes.on('build:queued', ({ cityId, building, level }) => {
      const recs = _recommendations.get(String(cityId)) ?? [];
      const matching = recs.find(
        (r) => r.type === REC_TYPES.BUILD_PRIORITY &&
               r.actions?.some((a) => a.data?.building === building)
      );
      if (matching) {
        hermes.log.info(`StrategicAdvisor: action build:queued valide — ${building} lv${level} aligné avec rec`);
      }
    });
    _subs.push(unsubBuild);

    // Au chargement du jeu : générer les recs initiales pour toutes les villes
    const unsubGameLoaded = hermes.on('game:loaded', () => {
      if (!_worldProfile) return;
      try {
        const cities = bridge.getCities();
        for (const city of cities) {
          updateRecommendationsForCity(city.id, 0, true);
        }
      } catch (err) {
        hermes.log.warn('StrategicAdvisor: getCities() a échoué au game:loaded', err);
      }
    });
    _subs.push(unsubGameLoaded);
  },

  /**
   * Nettoie les subscriptions et l'état.
   */
  destroy() {
    hermes.log.debug('StrategicAdvisor: destroy');
    for (const unsub of _subs) unsub();
    _subs.length = 0;
    _recommendations.clear();
    _citySpecializations.clear();
    _dismissed.clear();
    _lastScoreUsed.clear();
    _worldProfile = null;
    _worldKey     = null;
  },

  /**
   * Retourne les recommandations actives pour une ville.
   * @param {string|number} cityId
   * @returns {Recommendation[]}
   */
  getRecommendations(cityId) {
    return _recommendations.get(String(cityId)) ?? [];
  },

  /**
   * Retourne toutes les recommandations pour toutes les villes.
   * @returns {Map<string, Recommendation[]>}
   */
  getAllRecommendations() {
    return new Map(_recommendations);
  },

  /**
   * Retourne la spécialisation actuelle d'une ville.
   * Priorité : override manuel > déduction depuis le profil monde + index.
   * @param {string|number} cityId
   * @returns {string} Identifiant de spécialisation (ex: 'colony_rush', 'offense', 'defense')
   */
  getCitySpecialization(cityId) {
    if (_citySpecializations.has(String(cityId))) {
      return _citySpecializations.get(String(cityId));
    }
    const cityIndex = getCityIndex(cityId);
    if (cityIndex === 0) return 'colony_rush';
    const score = _lastScoreUsed.get(String(cityId)) ?? 0;
    return score > DEFENSE_ALERT_THRESHOLD ? 'defense' : 'offense';
  },

  /**
   * Définit manuellement la spécialisation d'une ville.
   * @param {string|number} cityId
   * @param {string} spec - Identifiant de spécialisation
   */
  setCitySpecialization(cityId, spec) {
    _citySpecializations.set(String(cityId), spec);
    hermes.log.info(`StrategicAdvisor: spécialisation manuelle ville ${cityId} → ${spec}`);
    // Re-générer les recs avec la nouvelle spécialisation
    const score = _lastScoreUsed.get(String(cityId)) ?? 0;
    updateRecommendationsForCity(cityId, score, true);
  },

  /**
   * Marque une recommandation comme ignorée par l'utilisateur.
   * Elle ne réapparaîtra pas lors de la prochaine mise à jour.
   * @param {string} recId
   */
  dismissRecommendation(recId) {
    _dismissed.add(recId);
    hermes.log.debug(`StrategicAdvisor: rec ${recId} ignorée`);
    // Retirer des listes actives
    for (const [cityId, recs] of _recommendations) {
      _recommendations.set(cityId, recs.filter((r) => r.id !== recId));
    }
  },

  /**
   * Force une re-génération des recommandations pour toutes les villes.
   */
  refreshAll() {
    for (const [cityId] of _recommendations) {
      const score = _lastScoreUsed.get(cityId) ?? 0;
      updateRecommendationsForCity(cityId, score, true);
    }
  },

  /**
   * Retourne les types de recommandations disponibles (utile pour le dashboard).
   * @returns {object}
   */
  getRecTypes() {
    return { ...REC_TYPES };
  },
};

// ─── Auto-registration ────────────────────────────────────────────────────────

hermes.register('advisor', {
  init()    { strategicAdvisor.init();    },
  destroy() { strategicAdvisor.destroy(); },
});

export default strategicAdvisor;
