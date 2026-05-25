/**
 * modules/world.js — WorldAnalyzer : détection et maintien du profil du monde
 *
 * Responsabilités :
 * - Détecter les paramètres du monde (vitesse, système de conquête, WW, morale)
 * - Construire le worldKey utilisé par les autres modules pour choisir les stratégies
 * - Recommander le template de construction par défaut selon le monde et le rang de la ville
 * - Émettre 'world:profile' et 'world:profile:updated'
 *
 * Ce module ne dépend d'aucun module d'automatisation — uniquement de core, bridge, storage.
 */

import { hermes }  from '../core.js';
import { bridge }  from '../bridge.js';
import { storage } from '../storage.js';
import {
  knowledge,
  getWorldProfile,
  getStrategiesForWorld,
  getRecommendedStrategy,
} from '../data/knowledge.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/**
 * Mapping vitesse → label lisible pour les logs.
 * @type {Object.<number, string>}
 */
const SPEED_LABELS = {
  1: 'Speed 1 (normal)',
  2: 'Speed 2 (rapide)',
  3: 'Speed 3 (très rapide)',
  4: 'Speed 4 (ultra-rapide)',
};

// ─── État interne ─────────────────────────────────────────────────────────────

/** @type {import('../bridge.js').WorldProfile|null} */
let _profile = null;

/** @type {string|null} Ex: 'speed3_revolt' */
let _worldKey = null;

/** Overrides manuels de template par cityIndex */
const _templateOverrides = new Map();

/** Unsubscribers pour les events hermes */
const _subs = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Construit le worldKey depuis un WorldProfile.
 * Formule : `speed${profile.speed}_${profile.system}`
 * Exemples : 'speed3_revolt', 'speed1_conquest'
 *
 * @param {import('../bridge.js').WorldProfile} profile
 * @returns {string}
 */
function buildWorldKey(profile) {
  const speed  = Math.round(profile.speed ?? 1);
  const system = (profile.system ?? 'revolt').toLowerCase();
  return `speed${speed}_${system}`;
}

/**
 * Génère un résumé lisible du profil pour les logs et le dashboard.
 * @param {import('../bridge.js').WorldProfile} profile
 * @param {string} worldKey
 * @returns {string}
 */
function buildSummary(profile, worldKey) {
  const speedLabel = SPEED_LABELS[Math.round(profile.speed)] ?? `Speed ${profile.speed}`;
  const system     = profile.system === 'revolt' ? 'Révolte' : 'Conquête';
  const ww         = profile.ww    ? 'Oui' : 'Non';
  const morale     = profile.morale ? 'Oui' : 'Non';
  const worldData  = getWorldProfile(worldKey);
  const style      = worldData?.play_style ? ` [${worldData.play_style}]` : '';
  return `Monde ${speedLabel}, ${system}, WW: ${ww}, Morale: ${morale}${style}`;
}

/**
 * Détermine l'ID du template de construction recommandé pour une ville.
 * Priorité : override manuel > stratégie KnowledgeBase > fallback générique.
 *
 * @param {number} cityIndex - Index 0-based (0 = première ville)
 * @returns {string} templateId
 */
function resolveTemplateId(cityIndex) {
  // Override manuel de l'utilisateur
  if (_templateOverrides.has(cityIndex)) {
    return _templateOverrides.get(cityIndex);
  }

  if (!_worldKey) return 'auto';

  const strategy = getRecommendedStrategy(_worldKey, cityIndex);
  if (!strategy) return 'auto';

  // L'ID du template suit la convention : {specialization}_speed{N}
  // Ex: 'colony_rush_speed3', 'offense_speed3', 'defense_city'
  const spec  = strategy.city_specialization ?? 'auto';
  const speed = _profile ? Math.round(_profile.speed) : 1;

  if (spec === 'colony_rush') return `colony_rush_speed${speed}`;
  if (spec === 'offense')     return `offense_speed${speed}`;
  if (spec === 'defense')     return 'defense_city';
  if (spec === 'commerce')    return 'commerce_city';
  return spec;
}

// ─── Initialisation / détection ───────────────────────────────────────────────

/**
 * Tente de lire les paramètres du monde depuis le bridge.
 * Retourne true si la détection a réussi.
 * @returns {boolean}
 */
function detectAndApply() {
  let rawProfile;
  try {
    rawProfile = bridge.getWorldSettings();
  } catch (err) {
    hermes.log.error('WorldAnalyzer: getWorldSettings() a échoué', err);
    return false;
  }

  if (!rawProfile) {
    hermes.log.warn('WorldAnalyzer: getWorldSettings() a retourné null — données indisponibles');
    return false;
  }

  const newKey = buildWorldKey(rawProfile);
  const isUpdate = _profile !== null;

  _profile  = rawProfile;
  _worldKey = newKey;

  const summary = buildSummary(_profile, _worldKey);
  hermes.log.info(`WorldAnalyzer: ${summary}`);

  if (isUpdate) {
    hermes.emit('world:profile:updated', { profile: _profile, worldKey: _worldKey });
  } else {
    hermes.emit('world:profile', { profile: _profile, worldKey: _worldKey });
  }

  return true;
}

// ─── Interface publique ───────────────────────────────────────────────────────

/**
 * WorldAnalyzer — détecte et maintient le profil du monde Grepolis.
 */
export const worldAnalyzer = {

  /**
   * Initialise le module : souscrit à game:loaded pour déclencher la détection.
   */
  init() {
    hermes.log.debug('WorldAnalyzer: init');

    // Déclencher la détection dès que le jeu est chargé
    const unsubGameLoaded = hermes.on('game:loaded', () => {
      hermes.log.debug('WorldAnalyzer: game:loaded reçu — détection du profil');
      detectAndApply();
    });
    _subs.push(unsubGameLoaded);

    // Si le jeu est déjà chargé au moment de l'init (ex: hot-reload), tenter immédiatement
    // On essaie une détection directe — elle échouera silencieusement si les données
    // ne sont pas encore disponibles.
    detectAndApply();
  },

  /**
   * Nettoie les subscriptions et remet l'état à zéro.
   */
  destroy() {
    hermes.log.debug('WorldAnalyzer: destroy');
    for (const unsub of _subs) unsub();
    _subs.length = 0;
    _profile  = null;
    _worldKey = null;
    _templateOverrides.clear();
  },

  /**
   * Retourne le profil du monde courant.
   * @returns {import('../bridge.js').WorldProfile|null}
   */
  getProfile() {
    return _profile;
  },

  /**
   * Retourne la clé du monde (ex: 'speed3_revolt').
   * @returns {string|null}
   */
  getWorldKey() {
    return _worldKey;
  },

  /**
   * Retourne le templateId recommandé pour une ville donnée.
   * Le templateId est utilisé par le module build pour choisir l'ordre de construction.
   *
   * @param {number} [cityNumber=1] - Numéro de la ville (1-based, comme le joueur le voit)
   * @returns {string} templateId (ex: 'colony_rush_speed3', 'offense_speed3', 'auto')
   */
  getRecommendedTemplate(cityNumber = 1) {
    const cityIndex = Math.max(0, cityNumber - 1);
    return resolveTemplateId(cityIndex);
  },

  /**
   * Génère un résumé du monde pour affichage dans le dashboard.
   * @returns {string}
   */
  getWorldSummary() {
    if (!_profile || !_worldKey) return 'Monde non détecté';
    return buildSummary(_profile, _worldKey);
  },

  /**
   * Retourne les stratégies disponibles pour le monde courant.
   * @returns {object[]}
   */
  getAvailableStrategies() {
    if (!_worldKey) return [];
    return getStrategiesForWorld(_worldKey);
  },

  /**
   * Force une re-détection du profil du monde.
   * Utile si les données du jeu changent après le chargement initial.
   */
  refresh() {
    hermes.log.debug('WorldAnalyzer: refresh forcé');
    detectAndApply();
  },
};

// ─── Auto-registration ────────────────────────────────────────────────────────

hermes.register('world', {
  init()    { worldAnalyzer.init();    },
  destroy() { worldAnalyzer.destroy(); },
});

export default worldAnalyzer;
