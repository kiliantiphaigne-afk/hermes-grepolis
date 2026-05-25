/**
 * storage.js — Persistance des données entre sessions
 *
 * Utilise GM_setValue / GM_getValue (Tampermonkey) comme backend principal.
 * Fallback sur localStorage si Tampermonkey n'est pas disponible (dev/test).
 *
 * Architecture :
 * - Config  : préférences utilisateur (persiste entre sessions, modifiée rarement)
 * - State   : état runtime de la session courante (peut être remis à zéro)
 * - Logs    : ring buffer des 200 dernières entrées (pour le dashboard)
 * - History : historique des actions par ville (pour la détection de patterns)
 *
 * Sérialisation : JSON. Pas de compression — les données sont légères (<50KB).
 */

// ─── Clés de stockage ─────────────────────────────────────────────────────────

const KEYS = {
  CONFIG:  'hermes_config',
  STATE:   'hermes_state',
  LOGS:    'hermes_logs',
  HISTORY: 'hermes_action_history',
};

// Taille maximale du ring buffer de logs persistés.
const MAX_PERSISTED_LOGS = 200;

// Nombre de jours d'historique à conserver (nettoyage automatique).
const HISTORY_RETENTION_DAYS = 14;

// ─── Config par défaut ────────────────────────────────────────────────────────

/**
 * Configuration par défaut d'Hermes.
 * Chaque valeur peut être surchargée par l'utilisateur via le dashboard.
 *
 * @typedef {object} HermesConfig
 */
const DEFAULT_CONFIG = {
  /** Master switch — permet de couper tout Hermes en un clic. */
  enabled: true,

  /**
   * Efficacité cible : fraction des actions optimales qu'Hermes exécutera.
   * 0.68 = 68% des fermes/constructions possibles, pour paraître humain.
   * Ne pas dépasser 0.85 — au-delà, le pattern devient suspect.
   */
  efficiency: 0.68,

  /** Plage horaire d'activité principale (heure locale du joueur). */
  activeHours: { start: 8, end: 23 },

  /**
   * Active la simulation de pauses repas et nuit.
   * Si false : Hermes travaille à efficacité constante dans activeHours.
   */
  pauseSimulation: true,

  /**
   * Configuration par ville (Map<cityId, CityConfig>).
   * Une CityConfig absente = utiliser les valeurs globales.
   */
  cityConfigs: {},

  farmConfig: {
    /**
     * Action par défaut sur les villages fermiers :
     * - 'auto'   : Hermes choisit (demand si mood > 78, loot si < 50)
     * - 'demand' : toujours réclamer
     * - 'loot'   : toujours piller
     * - 'trade'  : toujours commercer
     */
    defaultAction: 'auto',

    /**
     * Seuil de mood minimal pour agir sur un village.
     * En dessous : Hermes attend que le village récupère.
     */
    minMoodThreshold: 78,

    /** Si true : trier les villages par ressources disponibles (ceux avec le plus en premier). */
    prioritizeHighResources: true,
  },

  buildConfig: {
    /**
     * Template de construction par défaut :
     * - 'auto'    : Hermes décide selon l'état de la ville
     * - string    : nom d'un template custom défini par l'utilisateur
     */
    defaultTemplate: 'auto',

    /** Priorité : construire les bâtiments de ressources en premier si le stock est bas. */
    resourcesFirst: true,
  },

  combatConfig: {
    /** Émettre une notification GM si une attaque entrante est détectée. */
    alertIncoming: true,

    /**
     * Esquive automatique : envoyer les troupes en support vers une ville alliée
     * si une attaque arrive dans moins de 10 minutes.
     * RISQUÉ — désactivé par défaut.
     */
    autoDodge: false,
  },
};

/**
 * État runtime par défaut (réinitialisé à chaque session).
 * @typedef {object} GameSession
 */
const DEFAULT_STATE = {
  /** Timestamp du démarrage de la session courante. */
  sessionStartedAt: null,

  /** ID de la ville actuellement sélectionnée dans le jeu. */
  activeCityId: null,

  /** Nombre d'actions effectuées dans la session courante. */
  actionsThisSession: 0,

  /** Timestamp de la dernière action globale. */
  lastActionAt: null,

  /** Mode pause manuel (activé via le dashboard). */
  manualPause: false,
};

// ─── Adaptateur de stockage ───────────────────────────────────────────────────

/**
 * Crée un adaptateur de stockage qui utilise GM_setValue/GM_getValue
 * avec fallback sur localStorage.
 *
 * Raison du fallback : en développement, le script peut tourner hors
 * Tampermonkey (ex: injection directe pour tester). localStorage permet
 * de tester la logique sans le contexte GM.
 */
function createStorageAdapter() {
  // Détection des APIs Tampermonkey disponibles.
  const hasGM = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';

  if (!hasGM) {
    console.warn('[Hermes/Storage] GM APIs non disponibles — fallback localStorage');
  }

  return {
    /**
     * Lit une valeur par clé.
     * @param {string} key
     * @param {*} defaultValue
     * @returns {*}
     */
    get(key, defaultValue = null) {
      try {
        if (hasGM) {
          const raw = GM_getValue(key, null);
          return raw !== null ? JSON.parse(raw) : defaultValue;
        } else {
          const raw = localStorage.getItem(`__hermes_${key}`);
          return raw !== null ? JSON.parse(raw) : defaultValue;
        }
      } catch (err) {
        console.error(`[Hermes/Storage] get(${key}) failed:`, err);
        return defaultValue;
      }
    },

    /**
     * Écrit une valeur.
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
      try {
        const serialized = JSON.stringify(value);
        if (hasGM) {
          GM_setValue(key, serialized);
        } else {
          localStorage.setItem(`__hermes_${key}`, serialized);
        }
      } catch (err) {
        console.error(`[Hermes/Storage] set(${key}) failed:`, err);
      }
    },

    /**
     * Supprime une valeur.
     * @param {string} key
     */
    remove(key) {
      try {
        if (hasGM) {
          GM_setValue(key, null);
        } else {
          localStorage.removeItem(`__hermes_${key}`);
        }
      } catch (err) {
        console.error(`[Hermes/Storage] remove(${key}) failed:`, err);
      }
    },
  };
}

const adapter = createStorageAdapter();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fusionne profondément deux objets (shallow merge suffisant pour notre config).
 * L'objet 'patch' écrase les clés de 'base', récursivement pour les objets.
 *
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
function deepMerge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && typeof base[key] === 'object' && base[key] !== null) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Retourne un timestamp Unix en jours pour les comparaisons d'historique.
 * @param {number} [timestampMs=Date.now()]
 * @returns {number} Timestamp arrondi au jour
 */
function toDayTimestamp(timestampMs = Date.now()) {
  return Math.floor(timestampMs / 86_400_000) * 86_400_000;
}

// ─── Storage API publique ─────────────────────────────────────────────────────

export const storage = {

  // ── Config ────────────────────────────────────────────────────────────────

  /**
   * Retourne la configuration complète (persistée + defaults pour les valeurs manquantes).
   * @returns {HermesConfig}
   */
  getConfig() {
    const persisted = adapter.get(KEYS.CONFIG, {});
    // Merge profond : les nouvelles clés de DEFAULT_CONFIG apparaissent après une MAJ.
    return deepMerge(DEFAULT_CONFIG, persisted);
  },

  /**
   * Remplace entièrement la configuration.
   * @param {HermesConfig} config
   */
  setConfig(config) {
    adapter.set(KEYS.CONFIG, config);
  },

  /**
   * Met à jour partiellement la configuration (merge profond).
   * Exemple : storage.updateConfig({ farmConfig: { minMoodThreshold: 70 } })
   *
   * @param {Partial<HermesConfig>} partial
   * @returns {HermesConfig} Nouvelle config complète
   */
  updateConfig(partial) {
    const current = this.getConfig();
    const updated = deepMerge(current, partial);
    this.setConfig(updated);
    return updated;
  },

  /**
   * Réinitialise la configuration aux valeurs par défaut.
   */
  resetConfig() {
    adapter.remove(KEYS.CONFIG);
  },

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * Retourne l'état runtime de la session.
   * @returns {GameSession}
   */
  getState() {
    const persisted = adapter.get(KEYS.STATE, {});
    return { ...DEFAULT_STATE, ...persisted };
  },

  /**
   * Remplace entièrement l'état.
   * @param {GameSession} state
   */
  setState(state) {
    adapter.set(KEYS.STATE, state);
  },

  /**
   * Met à jour partiellement l'état (shallow merge suffisant pour le state).
   * @param {Partial<GameSession>} partial
   * @returns {GameSession}
   */
  updateState(partial) {
    const current = this.getState();
    const updated = { ...current, ...partial };
    this.setState(updated);
    return updated;
  },

  /**
   * Réinitialise l'état (nouvelle session).
   */
  resetState() {
    adapter.set(KEYS.STATE, {
      ...DEFAULT_STATE,
      sessionStartedAt: Date.now(),
    });
  },

  // ── Logs ──────────────────────────────────────────────────────────────────

  /**
   * Ajoute une entrée de log dans le ring buffer persisté.
   * @param {{ timestamp: number, level: string, message: string, data: * }} entry
   */
  addLog(entry) {
    const logs = this.getLogs();
    logs.push(entry);
    // Ring buffer : on ne garde que les MAX_PERSISTED_LOGS plus récents.
    const trimmed = logs.slice(-MAX_PERSISTED_LOGS);
    adapter.set(KEYS.LOGS, trimmed);
  },

  /**
   * Retourne tous les logs persistés (du plus ancien au plus récent).
   * @returns {Array<{ timestamp: number, level: string, message: string, data: * }>}
   */
  getLogs() {
    return adapter.get(KEYS.LOGS, []);
  },

  /**
   * Vide le buffer de logs persistés.
   */
  clearLogs() {
    adapter.set(KEYS.LOGS, []);
  },

  // ── Action History ────────────────────────────────────────────────────────

  /**
   * Enregistre une action dans l'historique.
   * Utilisé par HumanEngine pour l'analyse de patterns et la détection d'anomalies.
   *
   * @param {string}       type   - Type d'action ('farm:demand', 'build', 'trade', etc.)
   * @param {string|number} cityId - ID de la ville concernée
   * @param {object}       [data]  - Données supplémentaires (village ID, bâtiment, etc.)
   */
  recordAction(type, cityId, data = {}) {
    const history = adapter.get(KEYS.HISTORY, {});
    const key = String(cityId);

    if (!history[key]) history[key] = [];

    history[key].push({
      type,
      timestamp: Date.now(),
      ...data,
    });

    // Nettoyage : supprimer les entrées plus anciennes que HISTORY_RETENTION_DAYS.
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86_400_000;
    history[key] = history[key].filter((r) => r.timestamp >= cutoff);

    adapter.set(KEYS.HISTORY, history);
  },

  /**
   * Retourne l'historique des actions pour une ville sur une période donnée.
   *
   * @param {string|number} cityId - ID de la ville
   * @param {number}        [days=7] - Nombre de jours à remonter
   * @returns {Array<{ type: string, timestamp: number }>}
   */
  getActionHistory(cityId, days = 7) {
    const history = adapter.get(KEYS.HISTORY, {});
    const key = String(cityId);
    if (!history[key]) return [];

    const cutoff = Date.now() - days * 86_400_000;
    return history[key].filter((r) => r.timestamp >= cutoff);
  },

  /**
   * Retourne un résumé statistique de l'historique d'une ville.
   * Utile pour HumanEngine (ajuster l'efficacité selon l'activité récente).
   *
   * @param {string|number} cityId
   * @param {number} [days=7]
   * @returns {{ total: number, byType: Object.<string, number>, perDay: number }}
   */
  getActionStats(cityId, days = 7) {
    const records = this.getActionHistory(cityId, days);
    const byType = {};
    for (const r of records) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
    }
    return {
      total:  records.length,
      byType,
      perDay: Math.round(records.length / days),
    };
  },

  /**
   * Vide l'historique complet (toutes villes).
   */
  clearHistory() {
    adapter.remove(KEYS.HISTORY);
  },

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /**
   * Retourne les métadonnées de stockage pour le dashboard.
   * @returns {{ configSize: number, logsCount: number, historyDays: number }}
   */
  diagnostics() {
    const config  = adapter.get(KEYS.CONFIG, null);
    const logs    = adapter.get(KEYS.LOGS, []);
    const history = adapter.get(KEYS.HISTORY, {});

    const totalHistoryEntries = Object.values(history)
      .reduce((sum, arr) => sum + arr.length, 0);

    return {
      configSize:            JSON.stringify(config ?? {}).length,
      logsCount:             logs.length,
      totalHistoryEntries,
      citiesInHistory:       Object.keys(history).length,
    };
  },
};

export default storage;
