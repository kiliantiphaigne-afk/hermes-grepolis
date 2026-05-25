/**
 * core.js — Module central d'Hermes
 *
 * Responsabilités :
 * - EventBus : communication inter-modules sans couplage direct
 * - Module registry : lifecycle (register → start → stop)
 * - Bootstrap : attendre que le jeu soit réellement chargé avant d'init
 * - Logger : logs structurés, persistés, consultables
 *
 * Architecture : tous les modules communiquent via l'EventBus.
 * Aucun module ne doit importer un autre module directement —
 * seulement via hermes.on() / hermes.emit(). Cela permet le hot-reload
 * et le testing unitaire sans le jeu.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const VERSION = '1.0.0';

// Nombre maximum de logs conservés en mémoire (ring buffer).
const MAX_LOGS_IN_MEMORY = 50;

// Niveaux de log (ordre croissant de sévérité).
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// Niveau minimum de log affiché dans la console (DEBUG = tout afficher).
const DEFAULT_LOG_LEVEL = LOG_LEVELS.DEBUG;

// Intervalle de polling pour la détection du chargement du jeu (ms).
// On ne veut pas DDos le thread JS — 500ms est raisonnable.
const GAME_READY_POLL_INTERVAL_MS = 500;

// Timeout maximum pour attendre le chargement du jeu (30s).
// Si le jeu ne charge pas en 30s, il y a un problème.
const GAME_READY_TIMEOUT_MS = 30_000;

// ─── EventBus ────────────────────────────────────────────────────────────────

/**
 * Crée un EventBus léger (pub/sub) pour la communication inter-modules.
 * Pattern Observer classique — pas de dépendances.
 *
 * @returns {object} Instance EventBus
 */
function createEventBus() {
  // Map<eventName, Set<handler>> — Set pour éviter les doublons silencieux.
  const listeners = new Map();

  return {
    /**
     * Souscrit à un événement.
     * @param {string} event - Nom de l'événement (ex: 'hermes:ready')
     * @param {Function} handler - Callback appelé avec les données de l'événement
     * @returns {Function} Fonction de désinscription (appeler pour unsubscribe)
     */
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      // Retourne un unsubscriber pour faciliter le cleanup dans les modules.
      return () => this.off(event, handler);
    },

    /**
     * Désinscrit un handler d'un événement.
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
      if (!listeners.has(event)) return;
      listeners.get(event).delete(handler);
      // Nettoyage : si plus aucun listener, supprimer l'entrée.
      if (listeners.get(event).size === 0) listeners.delete(event);
    },

    /**
     * Publie un événement à tous les abonnés.
     * Les handlers sont appelés de manière synchrone dans l'ordre d'inscription.
     * Les erreurs dans les handlers sont catchées pour ne pas bloquer les autres.
     *
     * @param {string} event
     * @param {*} data - Données passées aux handlers
     */
    emit(event, data) {
      if (!listeners.has(event)) return;
      for (const handler of listeners.get(event)) {
        try {
          handler(data);
        } catch (err) {
          // Ne pas laisser une erreur dans un handler crasher les autres abonnés.
          console.error(`[Hermes/EventBus] Handler error on event "${event}":`, err);
        }
      }
    },

    /**
     * Souscrit à un événement une seule fois, puis se désinscrit automatiquement.
     * @param {string} event
     * @param {Function} handler
     * @returns {Function} Fonction de désinscription anticipée
     */
    once(event, handler) {
      const wrapper = (data) => {
        handler(data);
        this.off(event, wrapper);
      };
      return this.on(event, wrapper);
    },

    /**
     * Retourne le nombre de listeners pour un événement (utile pour le debug).
     * @param {string} event
     * @returns {number}
     */
    listenerCount(event) {
      return listeners.has(event) ? listeners.get(event).size : 0;
    },
  };
}

// ─── Logger ──────────────────────────────────────────────────────────────────

/**
 * Crée un logger structuré avec ring buffer.
 * Les logs sont horodatés, tagués par module, et conservés en mémoire.
 *
 * @param {object} eventBus - Instance EventBus pour émettre les events de log
 * @returns {object} Logger
 */
function createLogger(eventBus) {
  // Ring buffer : Array de taille fixe MAX_LOGS_IN_MEMORY.
  // On utilise un simple tableau + pointeur circulaire.
  const buffer = [];
  let writeIndex = 0;
  let totalCount = 0;

  /**
   * Écrit une entrée de log dans le buffer et la console.
   * @param {string} level - 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
   * @param {string} message
   * @param {*} [data] - Données supplémentaires (objet, erreur, etc.)
   */
  function write(level, message, data) {
    const entry = {
      timestamp: Date.now(),
      level,
      message,
      data: data !== undefined ? data : null,
    };

    // Écriture dans le ring buffer (écrase le plus ancien si plein).
    if (buffer.length < MAX_LOGS_IN_MEMORY) {
      buffer.push(entry);
    } else {
      buffer[writeIndex % MAX_LOGS_IN_MEMORY] = entry;
    }
    writeIndex++;
    totalCount++;

    // Affichage console selon le niveau.
    const prefix = `[Hermes ${level}]`;
    const ts = new Date(entry.timestamp).toTimeString().slice(0, 8);
    const msg = `${prefix} ${ts} ${message}`;

    if (LOG_LEVELS[level] >= DEFAULT_LOG_LEVEL) {
      switch (level) {
        case 'DEBUG': console.debug(msg, data !== undefined ? data : ''); break;
        case 'INFO':  console.info(msg, data !== undefined ? data : '');  break;
        case 'WARN':  console.warn(msg, data !== undefined ? data : '');  break;
        case 'ERROR': console.error(msg, data !== undefined ? data : ''); break;
      }
    }

    // Émettre l'événement log pour que le Dashboard UI puisse l'afficher.
    // On n'émet pas en boucle si EventBus n'est pas encore dispo.
    if (eventBus) {
      eventBus.emit('hermes:log', entry);
    }
  }

  return {
    debug: (msg, data) => write('DEBUG', msg, data),
    info:  (msg, data) => write('INFO', msg, data),
    warn:  (msg, data) => write('WARN', msg, data),
    error: (msg, data) => write('ERROR', msg, data),

    /** Retourne tous les logs du buffer (du plus ancien au plus récent). */
    getAll() {
      if (buffer.length < MAX_LOGS_IN_MEMORY) {
        return [...buffer];
      }
      // Ring buffer plein : reconstruire dans l'ordre chronologique.
      const start = writeIndex % MAX_LOGS_IN_MEMORY;
      return [
        ...buffer.slice(start),
        ...buffer.slice(0, start),
      ];
    },

    /** Vide le buffer. */
    clear() {
      buffer.length = 0;
      writeIndex = 0;
      totalCount = 0;
    },

    /** Nombre total de logs depuis le démarrage (incluant ceux écrasés). */
    get totalCount() { return totalCount; },
  };
}

// ─── Module Registry ─────────────────────────────────────────────────────────

/**
 * Crée le registre des modules Hermes.
 * Un module est un objet avec au moins { name, init() }.
 * Les méthodes optionnelles sont : destroy(), onGameLoaded().
 *
 * Contrat d'un module :
 * - init(hermes) : reçoit l'instance hermes, s'initialise, retourne une Promise
 * - destroy()    : cleanup (remove listeners, clear timers, etc.)
 * - onGameLoaded(bridge) : appelé quand le jeu est prêt, reçoit le bridge
 *
 * @param {object} log - Logger
 * @returns {object} Module registry
 */
function createModuleRegistry(log) {
  // Map<name, { module, initialized }> — ordre d'insertion = ordre d'init.
  const modules = new Map();

  return {
    /**
     * Enregistre un module. Doit être appelé AVANT start().
     * @param {string} name - Identifiant unique du module
     * @param {object} module - Objet module avec au moins { init }
     */
    register(name, module) {
      if (modules.has(name)) {
        log.warn(`Module "${name}" déjà enregistré — ignoré.`);
        return;
      }
      if (typeof module.init !== 'function') {
        throw new Error(`Module "${name}" doit exposer une méthode init()`);
      }
      modules.set(name, { module, initialized: false });
      log.debug(`Module enregistré : ${name}`);
    },

    /**
     * Initialise tous les modules enregistrés dans l'ordre d'insertion.
     * Si un module échoue, on log l'erreur et on continue (fail-safe).
     *
     * @param {object} hermes - Instance publique Hermes passée aux modules
     * @returns {Promise<void>}
     */
    async startAll(hermes) {
      for (const [name, entry] of modules) {
        if (entry.initialized) continue;
        try {
          log.debug(`Démarrage module : ${name}`);
          await entry.module.init(hermes);
          entry.initialized = true;
          log.info(`Module prêt : ${name}`);
        } catch (err) {
          log.error(`Échec init module "${name}" — continuité assurée`, err);
        }
      }
    },

    /**
     * Notifie tous les modules que le jeu est chargé.
     * @param {object} bridge - Instance GameBridge
     */
    async notifyGameLoaded(bridge) {
      for (const [name, entry] of modules) {
        if (!entry.initialized) continue;
        if (typeof entry.module.onGameLoaded !== 'function') continue;
        try {
          await entry.module.onGameLoaded(bridge);
        } catch (err) {
          log.error(`Erreur onGameLoaded dans "${name}"`, err);
        }
      }
    },

    /**
     * Arrête tous les modules dans l'ordre inverse (LIFO).
     * @returns {Promise<void>}
     */
    async stopAll() {
      const entries = [...modules.entries()].reverse();
      for (const [name, entry] of entries) {
        if (!entry.initialized) continue;
        if (typeof entry.module.destroy !== 'function') continue;
        try {
          await entry.module.destroy();
          entry.initialized = false;
          log.debug(`Module arrêté : ${name}`);
        } catch (err) {
          log.error(`Erreur destroy module "${name}"`, err);
        }
      }
    },

    /** Liste les modules enregistrés et leur état. */
    status() {
      return [...modules.entries()].map(([name, { initialized }]) => ({
        name,
        initialized,
      }));
    },
  };
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Détecte quand Grepolis est réellement prêt pour les interactions.
 *
 * Grepolis charge en plusieurs phases :
 * 1. DOM ready → window.Game existe (mais données pas encore chargées)
 * 2. Backbone collections chargées → Game.village_data ou MM.models disponibles
 * 3. Jeu interactif → l'interface répond, les modèles sont hydratés
 *
 * On attend la phase 3 avant d'initialiser les modules qui dépendent des données.
 * Cette détection est robuste : elle essaie plusieurs chemins car Grepolis
 * change ses internals selon les versions et les mondes.
 *
 * @param {object} log - Logger
 * @returns {Promise<void>} Resolve quand le jeu est prêt
 */
function waitForGameReady(log) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    /**
     * Vérifie si le jeu est chargé selon plusieurs heuristiques.
     * Retourne true si on peut considérer le jeu comme opérationnel.
     */
    function isGameReady() {
      // Le namespace principal doit exister.
      if (typeof window.Game === 'undefined') return false;

      // Au moins un de ces objets doit être hydraté.
      // Grepolis.com v2 utilise MM.models, certains mondes ont village_data.
      const checks = [
        // Backbone collections des villes du joueur.
        () => window.Game.village_data && Object.keys(window.Game.village_data).length > 0,
        // Format alternatif (certains mondes).
        () => window.MM && window.MM.models && window.MM.models.town_list,
        // Dernier recours : le menu de navigation est rendu (UI prête).
        () => document.querySelector('#menu_village_view') !== null,
        // Autre indicateur UI : la barre de ressources est visible.
        () => document.querySelector('.resources') !== null,
      ];

      return checks.some((check) => {
        try {
          return Boolean(check());
        } catch {
          return false;
        }
      });
    }

    const pollId = setInterval(() => {
      // Timeout : le jeu prend trop de temps.
      if (Date.now() - startTime > GAME_READY_TIMEOUT_MS) {
        clearInterval(pollId);
        reject(new Error(`Timeout : jeu non chargé après ${GAME_READY_TIMEOUT_MS}ms`));
        return;
      }

      if (isGameReady()) {
        clearInterval(pollId);
        log.info('Jeu Grepolis détecté comme chargé');
        resolve();
      }
    }, GAME_READY_POLL_INTERVAL_MS);

    // Vérification immédiate (si le script est injecté tard, le jeu est déjà prêt).
    if (isGameReady()) {
      clearInterval(pollId);
      log.info('Jeu Grepolis déjà chargé au démarrage');
      resolve();
    }
  });
}

// ─── Hermes Core — Instance publique ─────────────────────────────────────────

/**
 * Crée et retourne l'instance publique d'Hermes.
 * C'est le point d'entrée unique pour tous les modules.
 *
 * @returns {object} Instance Hermes
 */
function createHermes() {
  const eventBus = createEventBus();
  // Le logger est créé sans EventBus d'abord pour éviter la circularité,
  // puis on lui passe l'EventBus une fois les deux créés.
  const log = createLogger(null);
  // On patch le log pour qu`il émette sur l'EventBus maintenant qu`il est dispo.
  // (Hack propre : on réassigne la référence interne via closure.)
  const logWithBus = createLogger(eventBus);

  const registry = createModuleRegistry(logWithBus);

  let _isRunning = false;
  let _bridge = null; // Sera set par le module bridge après son init.

  const hermes = {
    version: VERSION,

    // ── EventBus (interface directe) ──────────────────────────────────────
    on:   (event, handler) => eventBus.on(event, handler),
    off:  (event, handler) => eventBus.off(event, handler),
    emit: (event, data)    => eventBus.emit(event, data),
    once: (event, handler) => eventBus.once(event, handler),

    // ── Module lifecycle ──────────────────────────────────────────────────

    /**
     * Enregistre un module dans le registry.
     * @param {string} name
     * @param {object} module - { init(hermes), destroy?(), onGameLoaded?(bridge) }
     */
    register(name, module) {
      registry.register(name, module);
    },

    /**
     * Démarre Hermes : initialise les modules, attend le jeu, notifie.
     * @returns {Promise<void>}
     */
    async start() {
      if (_isRunning) {
        logWithBus.warn('Hermes déjà en cours — appel start() ignoré');
        return;
      }

      logWithBus.info(`Hermes v${VERSION} démarrage…`);

      // Phase 1 : initialisation des modules (certains n'ont pas besoin du jeu).
      await registry.startAll(hermes);

      // Phase 2 : attendre que le jeu soit réellement chargé.
      try {
        await waitForGameReady(logWithBus);
      } catch (err) {
        logWithBus.error('Impossible de détecter le chargement du jeu', err);
        // On continue quand même — certains modules peuvent fonctionner sans.
      }

      // Phase 3 : notifier les modules que le jeu est prêt.
      eventBus.emit('game:loaded', { timestamp: Date.now() });
      await registry.notifyGameLoaded(_bridge);

      _isRunning = true;

      // Émettre l'event de readiness pour les modules qui attendent.
      eventBus.emit('hermes:ready', { version: VERSION, timestamp: Date.now() });
      logWithBus.info('Hermes prêt');
    },

    /**
     * Arrête Hermes proprement.
     * @returns {Promise<void>}
     */
    async stop() {
      if (!_isRunning) return;
      logWithBus.info('Hermes arrêt…');
      await registry.stopAll();
      _isRunning = false;
      eventBus.emit('hermes:stopped', { timestamp: Date.now() });
      logWithBus.info('Hermes arrêté');
    },

    // ── State ─────────────────────────────────────────────────────────────

    get isRunning() { return _isRunning; },

    /**
     * Permet au module bridge de s'enregistrer pour que les autres modules
     * puissent le recevoir via onGameLoaded(bridge).
     * @param {object} bridge
     */
    setBridge(bridge) {
      _bridge = bridge;
    },

    /** Expose le bridge pour les modules qui en ont besoin après init. */
    get bridge() { return _bridge; },

    // ── Logger (interface directe) ────────────────────────────────────────
    log: logWithBus,

    /** Status de debug : liste les modules et leur état. */
    status() {
      return {
        version: VERSION,
        isRunning: _isRunning,
        modules: registry.status(),
        logCount: logWithBus.totalCount,
      };
    },
  };

  return hermes;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const hermes = createHermes();
export default hermes;
