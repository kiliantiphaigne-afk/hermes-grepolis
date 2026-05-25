// ==UserScript==
// @name         Hermes — Grepolis Assistant
// @namespace    https://github.com/hermes-grepolis
// @version      1.0.5
// @description  Intelligent automation for Grepolis — farming, building, combat, strategy advisor
// @author       Hermes
// @match        *://*.grepolis.com/game/*
// @match        *://*.grepolis.com/game/
// @match        *://grepolis.com/game/*
// @include      *://*.grepolis.com/game*
// @include      *://grepolis.com/game*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/kiliantiphaigne-afk/hermes-grepolis/main/dist/hermes.user.js
// @downloadURL  https://raw.githubusercontent.com/kiliantiphaigne-afk/hermes-grepolis/main/dist/hermes.user.js
// ==/UserScript==
(function () {
  'use strict';

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
        // Le DOM doit être disponible (document-start peut être appelé trop tôt).
        if (!document.body) return false;

        // Critère fort : town_list hydraté avec au moins 1 ville.
        try {
          const tl = window.MM && window.MM.models && window.MM.models.town_list;
          if (tl && tl.models && tl.models.length > 0) return true;
          if (tl && typeof tl.length === 'number' && tl.length > 0) return true;
        } catch { /* continue */ }

        // Game.townId défini = on est dans une ville spécifique = jeu opérationnel.
        try {
          if (window.Game && window.Game.townId && window.Game.townId > 0) return true;
        } catch { /* continue */ }

        // Fallback UI : barre de ressources ou toolbar = jeu interactif.
        try {
          if (document.querySelector('.resources_bar') !== null) return true;
          if (document.querySelector('#toolbar_activity_feed') !== null) return true;
          if (document.querySelector('.gp-icon-wood') !== null) return true;
          if (document.querySelector('#ui_box') !== null) return true;
        } catch { /* continue */ }

        return false;
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

  const hermes = createHermes();

  /**
   * bridge.js — GameBridge : l'interface entre Hermes et Grepolis
   *
   * PIÈCE CRITIQUE — lire attentivement avant de modifier.
   *
   * Ce module est la seule couche qui parle directement aux internals de Grepolis.
   * Tout le reste d'Hermes passe par ce bridge.
   *
   * Principes fondamentaux :
   * 1. Ne JAMAIS faire de requêtes AJAX directes. Passer par les méthodes natives.
   * 2. Toujours wrapper dans try/catch — les internals changent sans préavis.
   * 3. Si un objet n'existe pas : log warn + retourner null/[] + continuer.
   * 4. Les actions repassent exactement par les mêmes chemins que l'UI native.
   *
   * Architecture Grepolis (Backbone.js) :
   * - window.Game       : namespace principal, hydraté au chargement
   * - window.MM         : Module Manager, contient les collections Backbone
   * - MM.models         : Collections (town_list, island_towns, player_data…)
   * - MM.models.town_list.models : Array de Backbone.Model représentant les villes
   * - Chaque modèle Backbone expose .get('attribute'), .toJSON(), .collection
   * - Les actions passent par des vues Backbone (BuildingPlaceView, etc.) ou
   *   directement via des GameDataHelperFunctions
   */


  // ─── Utilitaires internes ─────────────────────────────────────────────────────

  /**
   * Tente d'accéder à un chemin profond dans un objet sans lever d'exception.
   * Exemple : safeGet(window, 'MM.models.town_list.models')
   *
   * @param {object} root - Objet racine
   * @param {string} path - Chemin pointé (ex: 'MM.models.town_list')
   * @returns {*} Valeur ou undefined si le chemin n'existe pas
   */
  function safeGet(root, path) {
    try {
      return path.split('.').reduce((obj, key) => (obj != null ? obj[key] : undefined), root);
    } catch {
      return undefined;
    }
  }

  /**
   * Calcule les millisecondes restantes avant un timestamp Unix (secondes).
   * @param {number} unixTimestamp - Timestamp en secondes
   * @returns {number} Millisecondes restantes (0 si passé)
   */
  function msUntil(unixTimestamp) {
    return Math.max(0, unixTimestamp * 1000 - Date.now());
  }

  // ─── Référence à unsafeWindow (page réelle, hors sandbox Tampermonkey) ──────
  // unsafeWindow est injecté par Tampermonkey via @grant unsafeWindow.
  // Si absent, on tombe sur window qui est déjà un proxy de la page.
  const _uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // ─── Résolution des objets Backbone ──────────────────────────────────────────

  /**
   * Répertoire des chemins connus vers les objets Grepolis.
   * Ces chemins varient selon la version du jeu — on essaie plusieurs alternatives.
   *
   * Structure mise à jour lors de la détection (voir probe()).
   */
  const PATHS = {
    // Collections de villes du joueur — toutes les variantes connues de Grepolis
    townList: [
      'MM.models.town_list',
      'MM.models.towns',
      'MM.models.player_towns',
      'Game.models.town_list',
      'Game.town_list',
      'GameModels.town_list',
    ],
    // Données de village fermier (farm villages sur les îles)
    farmVillages: [
      'MM.models.farm_towns',
      'MM.models.farm_villages',
      'Game.models.farm_towns',
    ],
    // Données du monde (vitesse, système, etc.)
    worldSettings: [
      'Game.world_config',
      'Game.game_data',
      'MM.models.game_data',
      'MM.models.world_settings',
      'GameConfig',
    ],
    // Attaques entrantes
    attacks: [
      'MM.models.town_overviews',
      'MM.models.unit_movements',
      'MM.models.movements',
    ],
    // Relations joueur (alliance, guerres, NAP)
    relations: [
      'MM.models.player_relations',
      'MM.models.alliance_relations',
      'MM.models.diplomacy',
    ],
  };

  /**
   * Résout le premier chemin valide dans une liste de chemins alternatifs.
   * @param {string[]} paths - Chemins à essayer dans l'ordre
   * @returns {*} Premier objet trouvé, ou null
   */
  function resolveFirst(paths) {
    for (const path of paths) {
      const obj = safeGet(window, path);
      if (obj !== undefined && obj !== null) return obj;
    }
    return null;
  }

  // ─── Parsers de modèles Backbone ─────────────────────────────────────────────

  /**
   * Convertit un modèle Backbone de ville en objet City Hermes.
   * @param {object} model - Backbone.Model
   * @returns {import('./types').City|null}
   */
  function parseTownModel(model) {
    if (!model) return null;
    try {
      // Backbone.Model expose get() pour accéder aux attributs.
      const id   = model.get('id')   ?? model.id;
      const name = model.get('name') ?? model.get('town_name') ?? `Ville ${id}`;
      const x    = model.get('x')    ?? model.get('coord_x');
      const y    = model.get('y')    ?? model.get('coord_y');

      // Ressources — peuvent être dans un sous-objet ou à plat.
      const resources = parseResources(model);

      // Bâtiments — map { nom: niveau }.
      const buildings = parseBuildings(model);

      // File de construction.
      const queue = parseBuildQueue(model);

      // Population.
      const population = {
        current: model.get('pop')     ?? model.get('population')     ?? 0,
        max:     model.get('pop_max') ?? model.get('population_max') ?? 0,
      };

      // Spécialisation de ville (certains mondes).
      const specialization = model.get('town_type') ?? model.get('spec') ?? null;

      return { id, name, x, y, resources, buildings, queue, population, specialization };
    } catch (err) {
      hermes.log.warn('parseTownModel error', err);
      return null;
    }
  }

  /**
   * Extrait les ressources d'un modèle de ville.
   * Grepolis stocke parfois les ressources dans un sous-modèle ou à plat.
   * @param {object} model
   * @returns {{ wood: number, stone: number, silver: number }}
   */
  function parseResources(model) {
    // Tentative 1 : attribut 'resources' (objet ou Backbone.Model).
    const resObj = model.get('resources');
    if (resObj && typeof resObj === 'object') {
      const get = typeof resObj.get === 'function'
        ? (k) => resObj.get(k)
        : (k) => resObj[k];
      return {
        wood:   parseInt(get('wood') ?? 0, 10),
        stone:  parseInt(get('stone') ?? 0, 10),
        silver: parseInt(get('silver') ?? get('favor') ?? 0, 10),
      };
    }
    // Tentative 2 : attributs directs sur le modèle de ville.
    return {
      wood:   parseInt(model.get('wood')   ?? 0, 10),
      stone:  parseInt(model.get('stone')  ?? 0, 10),
      silver: parseInt(model.get('silver') ?? model.get('favor') ?? 0, 10),
    };
  }

  /**
   * Extrait la map des bâtiments (nom → niveau) d'un modèle de ville.
   * @param {object} model
   * @returns {Object.<string, number>}
   */
  function parseBuildings(model) {
    const buildings = {};
    // Tentative 1 : attribut 'buildings' (objet).
    const raw = model.get('buildings');
    if (raw && typeof raw === 'object') {
      const src = typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
      for (const [name, level] of Object.entries(src)) {
        buildings[name] = parseInt(level, 10) || 0;
      }
      return buildings;
    }
    // Tentative 2 : clés directes sur le modèle avec pattern 'building_*'.
    // Grepolis utilise parfois 'farm', 'storage', 'main' comme clés directes.
    const knownBuildings = [
      'main', 'farm', 'storage', 'place', 'lumber', 'stoner', 'ironer',
      'market', 'docks', 'barracks', 'temple', 'wall', 'hide', 'theater',
      'thermal', 'library', 'lighthouse', 'tower', 'statue', 'oracle',
    ];
    for (const name of knownBuildings) {
      const level = model.get(name) ?? model.get(`building_${name}`);
      if (level !== undefined) buildings[name] = parseInt(level, 10) || 0;
    }
    return buildings;
  }

  /**
   * Parse un objet ville plain (Game.village_data ou équivalent) en City Hermes.
   * Utilisé quand les données ne sont pas dans une collection Backbone.
   * @param {object} data - Plain object
   * @returns {import('./types').City|null}
   */
  function parsePlainTownData(data) {
    if (!data || typeof data !== 'object') return null;
    try {
      const id   = data.id   ?? data.town_id  ?? data.village_id;
      const name = data.name ?? data.town_name ?? `Ville ${id}`;
      const x    = data.x   ?? data.coord_x   ?? data.island_x;
      const y    = data.y   ?? data.coord_y   ?? data.island_y;
      if (id == null) return null;
      return {
        id,
        name,
        x: x ?? 0,
        y: y ?? 0,
        resources: {
          wood:   parseInt(data.wood   ?? 0, 10),
          stone:  parseInt(data.stone  ?? 0, 10),
          silver: parseInt(data.silver ?? data.iron ?? 0, 10),
        },
        buildings:      data.buildings      ?? {},
        queue:          data.building_queue ?? [],
        population:     { current: data.pop ?? 0, max: data.pop_max ?? 0 },
        specialization: data.town_type      ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extrait la file de construction d'une ville.
   * @param {object} model
   * @returns {Array<{building: string, level: number, completesAt: number}>}
   */
  function parseBuildQueue(model) {
    const queue = [];
    const raw = model.get('building_queue') ?? model.get('build_queue') ?? [];
    const items = Array.isArray(raw) ? raw
      : (typeof raw.models !== 'undefined' ? raw.models : []);

    for (const item of items) {
      const data = typeof item.get === 'function' ? item.toJSON() : item;
      queue.push({
        building:    data.building ?? data.type ?? 'unknown',
        level:       parseInt(data.level ?? data.to ?? 0, 10),
        completesAt: parseInt(data.end_at ?? data.complete_at ?? 0, 10),
      });
    }
    return queue;
  }

  /**
   * Convertit un modèle de village fermier en objet FarmVillage Hermes.
   * @param {object} model - Backbone.Model
   * @returns {import('./types').FarmVillage|null}
   */
  function parseFarmVillageModel(model) {
    if (!model) return null;
    try {
      const id       = model.get('id') ?? model.id;
      const name     = model.get('name') ?? `Village ${id}`;
      const mood     = parseInt(model.get('mood') ?? 100, 10);
      // Timestamps en secondes Unix.
      const lastDemandTs  = model.get('last_demand_sent_at') ?? 0;
      const lastLootTs    = model.get('last_loot_sent_at')   ?? 0;
      // Cooldown restant (en ms pour faciliter l'usage dans HumanEngine).
      const cooldownTs    = model.get('next_action_at') ?? model.get('cooldown_end') ?? 0;

      const resources = {
        wood:   parseInt(model.get('wood')  ?? 0, 10),
        stone:  parseInt(model.get('stone') ?? 0, 10),
        silver: parseInt(model.get('iron')  ?? model.get('silver') ?? 0, 10),
      };

      return {
        id,
        name,
        mood,
        lastDemand:         lastDemandTs,
        lastLoot:           lastLootTs,
        resources,
        cooldownRemaining:  msUntil(cooldownTs),
      };
    } catch (err) {
      hermes.log.warn('parseFarmVillageModel error', err);
      return null;
    }
  }

  // ─── Scanner global — trouve les villes n'importe où dans window ─────────────

  /**
   * Retourne le player_id du joueur courant depuis window.Game ou MM.
   * @returns {number|string|null}
   */
  function getCurrentPlayerId() {
    try {
      return _uw.Game?.player_id
        ?? _uw.Game?.id
        ?? _uw.MM?.models?.player?.id
        ?? _uw.MM?.models?.player_data?.models?.[0]?.get?.('id')
        ?? null;
    } catch { return null; }
  }

  /**
   * Vérifie si un plain object ressemble à une ville Grepolis quelconque.
   * @param {*} o
   * @returns {boolean}
   */
  function looksLikeTown(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const hasId   = 'id' in o || 'town_id' in o || 'village_id' in o;
    const hasName = 'name' in o && o.name && typeof o.name === 'string' && o.name.length > 0;
    const hasPos  = 'x' in o || 'y' in o || 'coord_x' in o || 'island_x' in o;
    return hasId && hasName && hasPos;
  }

  /**
   * Vérifie si un plain object est une ville appartenant au joueur courant.
   * Les villes propres ont des données de ressources / bâtiments / population.
   * @param {*} o
   * @param {number|string|null} playerId - ID du joueur courant
   * @returns {boolean}
   */
  function looksLikeOwnTown(o, playerId) {
    if (!looksLikeTown(o)) return false;

    // Filtre par player_id si disponible
    if (playerId != null) {
      const townPlayerId = o.player_id ?? o.owner_id ?? o.user_id;
      if (townPlayerId != null && String(townPlayerId) !== String(playerId)) return false;
    }

    // Les villes propres ont des ressources OU des données de population
    const hasResources  = 'wood' in o || 'stone' in o || 'iron' in o || 'silver' in o
                       || (o.resources && typeof o.resources === 'object');
    const hasPopulation = 'pop' in o || 'population' in o || 'pop_max' in o;
    const hasBuildings  = 'buildings' in o || 'main' in o || 'farm' in o || 'barracks' in o;

    return hasResources || hasPopulation || hasBuildings;
  }

  /**
   * Extrait les données brutes d'un modèle (Backbone ou plain object).
   * @param {*} m
   * @returns {object|null}
   */
  function extractRaw(m) {
    if (!m) return null;
    try {
      if (typeof m.toJSON === 'function') return m.toJSON();
      if (typeof m.get    === 'function') {
        return {
          id:   m.get('id')   ?? m.id,
          name: m.get('name') ?? m.get('town_name'),
          x:    m.get('x')    ?? m.get('coord_x'),
          y:    m.get('y')    ?? m.get('coord_y'),
          wood: m.get('wood'), stone: m.get('stone'), iron: m.get('iron'),
          pop:  m.get('pop'),  pop_max: m.get('pop_max'),
        };
      }
      return m;
    } catch { return null; }
  }

  /**
   * Scan récursif de l'arbre de propriétés d'un objet.
   * Retourne uniquement les villes appartenant au joueur courant.
   * @param {*}      root
   * @param {number} maxDepth
   * @param {WeakSet} seen
   * @param {number|string|null} playerId
   * @returns {object[]}
   */
  function deepScanForTowns(root, maxDepth = 4, seen = new WeakSet(), playerId = null) {
    const found = [];
    if (!root || typeof root !== 'object') return found;
    try { if (seen.has(root)) return found; seen.add(root); } catch { return found; }

    // Cas 1 : collection Backbone (a .models array)
    if (Array.isArray(root.models) && root.models.length > 0) {
      const sample = extractRaw(root.models[0]);
      if (sample && looksLikeOwnTown(sample, playerId)) {
        for (const m of root.models) {
          const raw = extractRaw(m);
          if (raw && looksLikeOwnTown(raw, playerId)) found.push(raw);
        }
        if (found.length > 0) return found;
      }
    }

    // Cas 2 : tableau direct
    if (Array.isArray(root) && root.length > 0) {
      const sample = extractRaw(root[0]);
      if (sample && looksLikeOwnTown(sample, playerId)) {
        for (const m of root) {
          const raw = extractRaw(m);
          if (raw && looksLikeOwnTown(raw, playerId)) found.push(raw);
        }
        if (found.length > 0) return found;
      }
    }

    // Cas 3 : map { "12345": { name, x, y, wood... } } — uniquement villes propres
    const entries = Object.entries(root);
    if (entries.length > 0 && entries.length < 200) {
      const candidates = [];
      for (const [, val] of entries) {
        if (looksLikeOwnTown(val, playerId)) candidates.push(val);
      }
      // Au moins 1 ville propre trouvée dans cette map
      if (candidates.length > 0) {
        found.push(...candidates);
        return found;
      }
    }

    // Descente récursive
    if (maxDepth > 0) {
      for (const [, val] of Object.entries(root)) {
        if (!val || typeof val !== 'object') continue;
        if (val instanceof Node || val instanceof Window) continue;
        try {
          const sub = deepScanForTowns(val, maxDepth - 1, seen, playerId);
          if (sub.length > 0) return sub; // Stop dès qu'on trouve
        } catch { /* propriété inaccessible */ }
      }
    }

    return found;
  }

  /**
   * Scan exhaustif de window pour trouver LES VILLES DU JOUEUR uniquement.
   * Filtre par player_id et par présence de données propres (ressources/bâtiments).
   * @returns {object[]}
   */
  function findTownsAnywhere() {
    const playerId = getCurrentPlayerId();
    const seen     = new WeakSet();

    // 1. Namespaces Grepolis connus en priorité
    for (const ns of ['MM', 'Game', 'GameData', 'GrepolisGame', 'Backbone']) {
      try {
        const obj = _uw[ns];
        if (!obj) continue;
        const towns = deepScanForTowns(obj, 4, seen, playerId);
        if (towns.length > 0) {
          hermes.log.info(`findTownsAnywhere: ${towns.length} villes trouvées dans window.${ns}`);
          return towns;
        }
      } catch { /* skip */ }
    }

    // 2. Scan de TOUS les globals (lent — dernier recours)
    try {
      for (const key of Object.keys(_uw)) {
        if (/^(jQuery|_|\$|React|angular|google|webkit|chrome|FB|__|document|window|console)/i.test(key)) continue;
        try {
          const val = _uw[key];
          if (!val || typeof val !== 'object') continue;
          const towns = deepScanForTowns(val, 3, seen, playerId);
          if (towns.length > 0) {
            hermes.log.info(`findTownsAnywhere: ${towns.length} villes trouvées dans window.${key}`);
            return towns;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return [];
  }

  /**
   * Extrait le town_id depuis le DOM (dropdown villes, data-attributes, URL).
   * @returns {string|null}
   */
  function getTownIdFromDOM() {
    try {
      // Selector dropdown de ville
      const sel = document.querySelector('select[name="town"], #town_select, .town_name_selector');
      if (sel && sel.value) return String(sel.value);

      // data-town-id sur un élément racine
      const el = document.querySelector('[data-town-id], [data-city-id], [data-village-id]');
      if (el) return el.dataset.townId ?? el.dataset.cityId ?? el.dataset.villageId ?? null;

      // Game.townId via unsafeWindow
      const tid = _uw.Game && _uw.Game.townId;
      if (tid) return String(tid);
    } catch { /* skip */ }
    return null;
  }

  // ─── XHR Interceptor — capture les données de ville depuis les réponses AJAX ──

  /**
   * Cache des données de villes capturées via XHR.
   * Clé = String(townId), valeur = plain data object.
   */
  const _townCache = new Map();

  /**
   * Parcourt récursivement un objet JSON pour extraire les données de villes.
   * Grepolis envoie les données dans des structures variables selon l'endpoint.
   * @param {*} data
   * @param {number} [depth=0] — évite les boucles infinies
   */
  function extractTownsFromResponse(data, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 5) return;

    // Pattern 1 : tableau de villes directement
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === 'object' && (item.id || item.town_id) && item.name) {
          const id = String(item.id ?? item.town_id);
          _townCache.set(id, item);
        }
      }
      return;
    }

    // Pattern 2 : { town_list: [...] } ou { towns: [...] } ou { player_towns: [...] }
    for (const key of ['town_list', 'towns', 'player_towns', 'own_towns', 'villages']) {
      if (data[key]) {
        extractTownsFromResponse(data[key], depth + 1);
      }
    }

    // Pattern 3 : map { "12345": { name, x, y, ... } } — clés numériques = IDs de villes
    const entries = Object.entries(data);
    if (entries.length > 0 && entries.length < 200) {
      for (const [key, val] of entries) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const hasId   = val.id || val.town_id || /^\d+$/.test(key);
          const hasName = val.name || val.town_name;
          const hasPos  = val.x !== undefined || val.coord_x !== undefined || val.island_x !== undefined;
          if (hasId && hasName && hasPos) {
            const id = String(val.id ?? val.town_id ?? key);
            _townCache.set(id, { ...val, id });
          }
          // Descendre dans les objets imbriqués
          if (val.data || val.payload || val.result || val.response) {
            extractTownsFromResponse(val, depth + 1);
          }
        }
      }
    }

    // Pattern 4 : wrapper standard Grepolis { data: { ... } }
    if (data.data)     extractTownsFromResponse(data.data,    depth + 1);
    if (data.payload)  extractTownsFromResponse(data.payload, depth + 1);
    if (data.result)   extractTownsFromResponse(data.result,  depth + 1);
    if (data.response) extractTownsFromResponse(data.response,depth + 1);
  }

  /**
   * Installe les hooks XHR et fetch pour capturer les réponses Grepolis.
   * Doit être appelé le plus tôt possible (avant les premières requêtes du jeu).
   */
  function installXHRHook() {
    try {
      // On utilise _uw (unsafeWindow) pour hooker le vrai XHR de la page,
      // pas celui du sandbox Tampermonkey.
      const XHRProto = _uw.XMLHttpRequest.prototype;
      const _origOpen = XHRProto.open;
      const _origSend = XHRProto.send;

      XHRProto.open = function (method, url, ...args) {
        this._hermesUrl = String(url ?? '');
        return _origOpen.call(this, method, url, ...args);
      };

      XHRProto.send = function (...args) {
        this.addEventListener('load', function () {
          try {
            if (!this.responseText || this.responseText.length > 2_000_000) return;
            const json = JSON.parse(this.responseText);
            const before = _townCache.size;
            extractTownsFromResponse(json);
            if (_townCache.size > before) {
              hermes.emit('bridge:towns:updated', { count: _townCache.size });
            }
          } catch { /* pas du JSON — ignorer */ }
        });
        return _origSend.call(this, ...args);
      };

      // ── Hook fetch (via unsafeWindow) ──────────────────────────────────────
      if (typeof _uw.fetch === 'function') {
        const _origFetch = _uw.fetch.bind(_uw);
        _uw.fetch = async function (...args) {
          const response = await _origFetch(...args);
          try {
            const clone = response.clone();
            clone.text().then((text) => {
              if (!text || text.length > 2_000_000) return;
              const json = JSON.parse(text);
              const before = _townCache.size;
              extractTownsFromResponse(json);
              if (_townCache.size > before) {
                hermes.emit('bridge:towns:updated', { count: _townCache.size });
              }
            }).catch(() => {});
          } catch { /* pas du JSON */ }
          return response;
        };
      }

      hermes.log.info('XHR/fetch hooks installés — capture des données Grepolis active');
    } catch (err) {
      hermes.log.warn('installXHRHook failed', err);
    }
  }

  // ─── Event Hooks Backbone ─────────────────────────────────────────────────────

  /**
   * Active les hooks sur les collections Backbone pour remonter les events Grepolis
   * sous forme d'events Hermes normalisés.
   *
   * Backbone émet des events 'change', 'add', 'remove' sur ses collections.
   * On écoute ces events et on les traduit pour les modules Hermes.
   */
  function attachBackboneHooks() {
    const townList = resolveFirst(PATHS.townList);

    if (townList && typeof townList.on === 'function') {
      // Ressources changées (farming, production, commerce).
      townList.on('change:resources change:wood change:stone change:silver', (model) => {
        hermes.emit('city:resources:changed', {
          cityId: model.get('id') ?? model.id,
          resources: parseResources(model),
        });
      });

      // File de construction mise à jour.
      townList.on('change:building_queue change:build_queue', (model) => {
        hermes.emit('construction:complete', {
          cityId:   model.get('id') ?? model.id,
          buildings: parseBuildings(model),
        });
      });

      hermes.log.debug('Hooks Backbone town_list actifs');
    } else {
      hermes.log.warn(`Impossible d'hooker town_list — collection non trouvée`);
    }

    // Hook sur les mouvements de troupes (attaques entrantes).
    const movements = resolveFirst(PATHS.attacks);
    if (movements && typeof movements.on === 'function') {
      movements.on('add', (model) => {
        const isIncoming = model.get('enemy') ?? model.get('is_attack') ?? false;
        if (isIncoming) {
          hermes.emit('attack:incoming', parseAttackModel(model));
        }
      });
      hermes.log.debug('Hooks Backbone unit_movements actifs');
    } else {
      hermes.log.warn(`Impossible d'hooker unit_movements — collection non trouvée`);
    }
  }

  /**
   * Parse un modèle d'attaque Backbone.
   * @param {object} model
   * @returns {import('./types').Attack}
   */
  function parseAttackModel(model) {
    return {
      id:           model.get('id') ?? model.id,
      fromCityId:   model.get('town_id_origin') ?? model.get('from_id'),
      toCityId:     model.get('town_id_target') ?? model.get('to_id'),
      arrivalTime:  model.get('arrival_time') ?? 0,
      units:        model.get('units') ?? {},
      isIncoming:   true,
    };
  }

  // ─── API publique du bridge ───────────────────────────────────────────────────

  /**
   * GameBridge — interface entre Hermes et les internals Grepolis.
   * @type {import('./types').Bridge}
   */
  const bridge = {

    // ── Data readers ──────────────────────────────────────────────────────────

    /**
     * Retourne toutes les villes du joueur avec leurs données courantes.
     * @returns {import('./types').City[]}
     */
    getCities() {
      try {
        const playerId = getCurrentPlayerId();

        // ── 1. Backbone town_list — source canonique (propres villes uniquement) ──
        const townList = resolveFirst(PATHS.townList);
        if (townList) {
          const models = townList.models ?? (Array.isArray(townList) ? townList : []);
          if (models.length > 0) {
            let cities = models.map(parseTownModel).filter(Boolean);
            if (cities.length === 0) cities = models.map(parsePlainTownData).filter(Boolean);
            if (cities.length > 0) return cities;
          }
          if (!Array.isArray(townList) && !townList.models) {
            const cities = Object.values(townList)
              .filter((v) => v && typeof v === 'object')
              .map(parsePlainTownData).filter(Boolean);
            if (cities.length > 0) return cities;
          }
        }

        // ── 2. Chemins plain object — filtrer par player_id ───────────────────
        for (const path of ['Game.village_data','Game.player.towns','Game.player_data.towns']) {
          const data = safeGet(_uw, path);
          if (data && typeof data === 'object') {
            const entries = Array.isArray(data) ? data : Object.values(data);
            const cities  = entries
              .filter((e) => !playerId || !e?.player_id || String(e.player_id) === String(playerId))
              .map(parsePlainTownData).filter(Boolean);
            if (cities.length > 0) return cities;
          }
        }

        // ── 3. Cache XHR — filtrer par player_id ─────────────────────────────
        if (_townCache.size > 0) {
          const cities = Array.from(_townCache.values())
            .filter((e) => !playerId || !e?.player_id || String(e.player_id) === String(playerId))
            .map(parsePlainTownData).filter(Boolean);
          if (cities.length > 0) return cities;
        }

        // ── 4. Scan global — cherche les villes avec données propres ──────────
        const scanned = findTownsAnywhere(); // déjà filtré par player_id + own data
        if (scanned.length > 0) {
          const cities = scanned.map(parsePlainTownData).filter(Boolean);
          if (cities.length > 0) {
            hermes.log.info(`getCities: ${cities.length} villes via scan global`);
            return cities;
          }
        }

        // ── 5. Fallback DOM ───────────────────────────────────────────────────
        const domTownId = getTownIdFromDOM();
        if (domTownId) {
          hermes.log.warn(`getCities: fallback DOM townId=${domTownId}`);
          return [{ id: domTownId, name: `Ville ${domTownId}`, x: 0, y: 0,
                    resources: { wood: 0, stone: 0, silver: 0 },
                    buildings: {}, queue: [], population: { current: 0, max: 0 },
                    specialization: null }];
        }

        hermes.log.warn('getCities: aucune ville trouvée');
        return [];
      } catch (err) {
        hermes.log.error('getCities failed', err);
        return [];
      }
    },

    /**
     * Retourne une ville par son ID.
     * @param {string|number} cityId
     * @returns {import('./types').City|null}
     */
    getCity(cityId) {
      try {
        const townList = resolveFirst(PATHS.townList);
        if (!townList) return null;
        // Backbone.Collection.get() recherche par ID.
        const model = typeof townList.get === 'function'
          ? townList.get(cityId)
          : (townList.models ?? []).find((m) => m.get('id') === cityId || m.id === cityId);
        return parseTownModel(model);
      } catch (err) {
        hermes.log.error(`getCity(${cityId}) failed`, err);
        return null;
      }
    },

    /**
     * Retourne les villages fermiers associés à une ville.
     * Les farm villages sont liés à l'île sur laquelle se trouve la ville.
     *
     * @param {string|number} cityId
     * @returns {import('./types').FarmVillage[]}
     */
    getFarmingVillages(cityId) {
      try {
        const farmList = resolveFirst(PATHS.farmVillages);
        if (!farmList) {
          hermes.log.warn('getFarmingVillages: farm_towns non trouvé');
          return [];
        }
        const models = farmList.models ?? Object.values(farmList);

        // Filtrer les villages liés à la ville (par town_id ou island).
        const city = this.getCity(cityId);
        const filtered = city
          ? models.filter((m) => {
              const linkedId = m.get('linked_town_id') ?? m.get('town_id');
              return linkedId == cityId; // == intentionnel (int vs string)
            })
          : models;

        return filtered
          .map(parseFarmVillageModel)
          .filter(Boolean);
      } catch (err) {
        hermes.log.error(`getFarmingVillages(${cityId}) failed`, err);
        return [];
      }
    },

    /**
     * Retourne les paramètres du monde (vitesse, système, etc.).
     * @returns {import('./types').WorldProfile|null}
     */
    getWorldSettings() {
      try {
        const config = resolveFirst(PATHS.worldSettings);
        if (!config) {
          hermes.log.warn('getWorldSettings: world_config non trouvé');
          return null;
        }
        const get = typeof config.get === 'function' ? (k) => config.get(k) : (k) => config[k];

        return {
          speed:           parseFloat(get('speed') ?? get('world_speed') ?? 1),
          system:          get('unit_system') ?? get('system') ?? 'normal',
          ww:              Boolean(get('ww') ?? get('world_wonder') ?? false),
          morale:          Boolean(get('morale') ?? true),
          unitSpeedMult:   parseFloat(get('unit_speed') ?? 1),
          maxAllianceSize: parseInt(get('alliance_limit') ?? get('max_alliance_size') ?? 100, 10),
        };
      } catch (err) {
        hermes.log.error('getWorldSettings failed', err);
        return null;
      }
    },

    /**
     * Retourne les cellules de carte autour d'une position.
     * Utile pour l'analyse tactique (identifier les cibles, les alliés proches).
     *
     * NOTE : L'accès à la carte complète est limité dans Grepolis —
     * seule la zone chargée est disponible. On interroge MM.models.map_data.
     *
     * @param {number} x - Coordonnée X du centre
     * @param {number} y - Coordonnée Y du centre
     * @param {number} radius - Rayon de recherche
     * @returns {import('./types').MapCell[]}
     */
    getMapData(x, y, radius) {
      try {
        const mapData = safeGet(window, 'MM.models.map_data')
          ?? safeGet(window, 'Game.map_data');
        if (!mapData) return [];

        const models = mapData.models ?? Object.values(mapData);
        const results = [];

        for (const model of models) {
          const cx = model.get('x') ?? model.get('coord_x');
          const cy = model.get('y') ?? model.get('coord_y');
          if (cx === undefined || cy === undefined) continue;
          // Filtre par rayon (distance de Chebyshev pour les grilles hex-like).
          if (Math.abs(cx - x) > radius || Math.abs(cy - y) > radius) continue;

          results.push({
            x:           cx,
            y:           cy,
            playerId:    model.get('player_id') ?? model.get('pid'),
            playerName:  model.get('player_name') ?? model.get('pname'),
            allianceId:  model.get('alliance_id') ?? model.get('aid'),
            allianceName:model.get('alliance_name') ?? model.get('aname'),
            cityPoints:  parseInt(model.get('points') ?? 0, 10),
          });
        }
        return results;
      } catch (err) {
        hermes.log.error('getMapData failed', err);
        return [];
      }
    },

    /**
     * Retourne les relations du joueur (alliance, guerre, NAP, neutralité).
     * @returns {import('./types').Relation[]}
     */
    getPlayerRelations() {
      try {
        const relations = resolveFirst(PATHS.relations);
        if (!relations) return [];

        const models = relations.models ?? Object.values(relations);
        return models.map((model) => ({
          playerId:    model.get('player_id') ?? model.id,
          playerName:  model.get('player_name') ?? '',
          allianceId:  model.get('alliance_id'),
          type:        model.get('relation_type') ?? model.get('type') ?? 'neutral',
        })).filter((r) => r.playerId !== undefined);
      } catch (err) {
        hermes.log.error('getPlayerRelations failed', err);
        return [];
      }
    },

    /**
     * Retourne les attaques entrantes en cours.
     * @returns {import('./types').Attack[]}
     */
    getIncomingAttacks() {
      try {
        const movements = resolveFirst(PATHS.attacks);
        if (!movements) return [];

        const models = movements.models ?? Object.values(movements);
        return models
          .filter((m) => {
            const isEnemy = m.get('enemy') ?? m.get('is_attack');
            return Boolean(isEnemy);
          })
          .map(parseAttackModel);
      } catch (err) {
        hermes.log.error('getIncomingAttacks failed', err);
        return [];
      }
    },

    // ── Action executors ──────────────────────────────────────────────────────

    /**
     * Lance une action de farming sur un village fermier.
     * Reproduit exactement ce que fait le code natif de Grepolis quand le joueur
     * clique sur "Réclamer" ou "Piller".
     *
     * Le jeu appelle en interne une vue Backbone qui trigge la requête serveur.
     * On reproduit ce comportement en appelant le même handler.
     *
     * @param {string|number} cityId      - ID de la ville depuis laquelle agir
     * @param {string|number} villageId   - ID du village fermier
     * @param {'demand'|'loot'|'trade'}  type - Type d'action
     * @returns {Promise<boolean>} true si l'action a été envoyée
     */
    async farmVillage(cityId, villageId, type) {
      try {
        // Vérifier que le village existe et est prêt.
        const villages = this.getFarmingVillages(cityId);
        const village = villages.find((v) => v.id == villageId);
        if (!village) {
          hermes.log.warn(`farmVillage: village ${villageId} non trouvé dans ville ${cityId}`);
          return false;
        }
        if (village.cooldownRemaining > 0) {
          hermes.log.debug(`farmVillage: village ${villageId} en cooldown (${village.cooldownRemaining}ms)`);
          return false;
        }

        // Chercher la vue ou le contrôleur natif responsable du farming.
        // Grepolis expose souvent cela via window.GameDataHelperFunctions ou
        // via la collection farm_towns elle-même.
        const farmList = resolveFirst(PATHS.farmVillages);
        const model = farmList && (typeof farmList.get === 'function'
          ? farmList.get(villageId)
          : (farmList.models ?? []).find((m) => m.id == villageId));

        if (!model) {
          hermes.log.warn(`farmVillage: modèle Backbone ${villageId} non trouvé`);
          return false;
        }

        // Méthode 1 : le modèle lui-même expose une méthode d'action.
        if (typeof model[type] === 'function') {
          await new Promise((resolve) => model[type]({ town_id: cityId }, resolve));
          hermes.log.info(`farmVillage: ${type} envoyé → village ${villageId}`);
          return true;
        }

        // Méthode 2 : passer par une commande globale Grepolis.
        const cmd = safeGet(window, 'GameDataHelperFunctions.farmTown')
          ?? safeGet(window, 'GPWindowMgr.farmAction');
        if (typeof cmd === 'function') {
          cmd({ town_id: cityId, farm_town_id: villageId, action: type });
          hermes.log.info(`farmVillage: ${type} via GPWindowMgr → village ${villageId}`);
          return true;
        }

        hermes.log.warn(`farmVillage: aucun mécanisme d'action trouvé pour ${type}`);
        return false;
      } catch (err) {
        hermes.log.error(`farmVillage(${cityId}, ${villageId}, ${type}) failed`, err);
        return false;
      }
    },

    /**
     * Lance une construction dans une ville.
     * Reproduit l'action "Construire" depuis la vue BuildingPlace.
     *
     * @param {string|number} cityId    - ID de la ville
     * @param {string}        building  - Nom du bâtiment (ex: 'storage', 'farm')
     * @param {number}        level     - Niveau cible (niveau actuel + 1 généralement)
     * @returns {Promise<boolean>}
     */
    async buildBuilding(cityId, building, level) {
      try {
        // Méthode 1 : via BuildingPlaceView (vue native).
        const BuildingPlace = safeGet(window, 'Views.BuildingPlaceView')
          ?? safeGet(window, 'GPWindowMgr.BuildingPlaceView');
        if (BuildingPlace && typeof BuildingPlace.build === 'function') {
          BuildingPlace.build({ town_id: cityId, building, level });
          hermes.log.info(`buildBuilding: ${building} lvl${level} → ville ${cityId}`);
          return true;
        }

        // Méthode 2 : via le modèle de ville Backbone.
        const townList = resolveFirst(PATHS.townList);
        const model = townList && (typeof townList.get === 'function'
          ? townList.get(cityId)
          : null);
        if (model && typeof model.buildBuilding === 'function') {
          model.buildBuilding(building, level);
          hermes.log.info(`buildBuilding: ${building} lvl${level} via model`);
          return true;
        }

        hermes.log.warn(`buildBuilding: aucun mécanisme trouvé pour construire ${building}`);
        return false;
      } catch (err) {
        hermes.log.error(`buildBuilding(${cityId}, ${building}, ${level}) failed`, err);
        return false;
      }
    },

    /**
     * Envoie des ressources d'une ville à une autre.
     * Utilise le système de commerce interne du jeu.
     *
     * @param {string|number} fromCityId
     * @param {string|number} toCityId
     * @param {{ wood: number, stone: number, silver: number }} resources
     * @returns {Promise<boolean>}
     */
    async sendTrade(fromCityId, toCityId, resources) {
      try {
        const TradeView = safeGet(window, 'Views.TradeCenterView')
          ?? safeGet(window, 'GPWindowMgr.TradeCenterView');
        if (TradeView && typeof TradeView.send === 'function') {
          TradeView.send({
            town_id_origin: fromCityId,
            town_id_target: toCityId,
            resources,
          });
          hermes.log.info(`sendTrade: ${JSON.stringify(resources)} → ville ${toCityId}`);
          return true;
        }

        // Fallback via commande globale.
        const tradeCmd = safeGet(window, 'GameDataHelperFunctions.sendTrade');
        if (typeof tradeCmd === 'function') {
          tradeCmd(fromCityId, toCityId, resources);
          return true;
        }

        hermes.log.warn('sendTrade: aucun mécanisme de commerce trouvé');
        return false;
      } catch (err) {
        hermes.log.error('sendTrade failed', err);
        return false;
      }
    },

    /**
     * Envoie du soutien (troupes) vers une position.
     *
     * @param {string|number}  fromCityId   - Ville d'origine
     * @param {number}         targetX      - Coordonnée X cible
     * @param {number}         targetY      - Coordonnée Y cible
     * @param {Object.<string, number>} units - Unités { archer: 5, sword: 10 }
     * @param {number}         [arrivalTime] - Timestamp Unix d'arrivée souhaité (optionnel)
     * @returns {Promise<boolean>}
     */
    async sendSupport(fromCityId, targetX, targetY, units, arrivalTime) {
      try {
        const SupportView = safeGet(window, 'Views.AttackView')
          ?? safeGet(window, 'GPWindowMgr.AttackView');
        if (SupportView && typeof SupportView.sendSupport === 'function') {
          SupportView.sendSupport({
            town_id: fromCityId,
            target_x: targetX,
            target_y: targetY,
            units,
            arrival_time: arrivalTime,
            attack_type: 'support',
          });
          hermes.log.info(`sendSupport: ${JSON.stringify(units)} → (${targetX},${targetY})`);
          return true;
        }

        hermes.log.warn('sendSupport: aucun mécanisme de support trouvé');
        return false;
      } catch (err) {
        hermes.log.error('sendSupport failed', err);
        return false;
      }
    },

    // ── Event hooks ───────────────────────────────────────────────────────────

    /**
     * Souscrit à un event de jeu normalisé.
     * Events disponibles :
     * - 'city:resources:changed' : { cityId, resources }
     * - 'attack:incoming'        : Attack
     * - 'construction:complete'  : { cityId, buildings }
     * - 'alliance:updated'       : données alliance
     *
     * @param {string}   eventType
     * @param {Function} handler
     * @returns {Function} Fonction de désinscription
     */
    onGameEvent(eventType, handler) {
      return hermes.on(eventType, handler);
    },

    // ── Diagnostic ────────────────────────────────────────────────────────────

    /**
     * Diagnostic complet de la structure Grepolis — à appeler depuis la console :
     *   window.Hermes.bridge.probe()
     * Affiche tout ce qui est disponible et tente de trouver les villes.
     */
    probe() {
      console.group('%c[HERMES] Bridge Diagnostic', 'color:#4ade80;font-weight:bold');

      // window.Game
      if (typeof window.Game !== 'undefined') {
        console.log('✅ window.Game trouvé. Clés:', Object.keys(window.Game));
        if (window.Game.village_data) {
          const towns = Object.values(window.Game.village_data);
          console.log(`  ✅ village_data: ${towns.length} villes`, towns[0] ?? '(vide)');
        } else {
          console.warn('  ❌ Game.village_data absent');
        }
        if (window.Game.player) {
          console.log('  ✅ Game.player:', Object.keys(window.Game.player ?? {}));
        }
      } else {
        console.warn('❌ window.Game non trouvé');
      }

      // window.MM
      if (typeof window.MM !== 'undefined') {
        console.log('✅ window.MM trouvé');
        if (window.MM.models) {
          console.log('  MM.models keys:', Object.keys(window.MM.models));
          const tl = window.MM.models.town_list;
          if (tl) {
            console.log(`  ✅ MM.models.town_list: ${tl.models?.length ?? 'N/A'} modèles`, tl);
          } else {
            console.warn('  ❌ MM.models.town_list absent');
          }
        } else {
          console.warn('  ❌ MM.models absent');
        }
      } else {
        console.warn('❌ window.MM non trouvé');
      }

      // Résultat getCities
      const cities = bridge.getCities();
      if (cities.length > 0) {
        console.log(`✅ getCities(): ${cities.length} villes trouvées`, cities);
      } else {
        console.error('❌ getCities(): aucune ville — structure Grepolis non reconnue');
        // Dump global pour aider au debug
        console.log('Globals disponibles (filtrés):', Object.keys(window).filter(
          (k) => /game|village|town|model|backbone|mm|grepolis/i.test(k)
        ));
      }

      console.groupEnd();
      return { game: !!window.Game, mm: !!window.MM, cities };
    },

    // ── Init ──────────────────────────────────────────────────────────────────

    /**
     * Initialise le bridge : probe les objets Grepolis, attache les hooks.
     * Appelé par core.js lors du bootstrap.
     */
    init() {
      hermes.log.info('GameBridge: initialisation…');

      // Installer le hook XHR/fetch en premier pour capturer les données dès maintenant.
      installXHRHook();

      // Écouter l'event de mise à jour du cache pour re-render le dashboard.
      hermes.on('bridge:towns:updated', ({ count }) => {
        hermes.log.info(`Bridge: ${count} villes capturées via AJAX`);
        hermes.emit('hermes:cities:ready', { count });
      });

      // Log console pour diagnostiquer la structure Grepolis.
      console.group('[HERMES Bridge] Structure Grepolis');
      try {
        if (typeof window.Game !== 'undefined') {
          console.log('window.Game keys:', Object.keys(window.Game).slice(0, 30).join(', '));
          if (window.Game.townId) console.log('Game.townId:', window.Game.townId);
        } else {
          console.warn('window.Game: absent');
        }
        if (typeof window.MM !== 'undefined' && window.MM.models) {
          console.log('MM.models keys:', Object.keys(window.MM.models).join(', '));
        } else {
          console.warn('window.MM: absent');
        }
      } catch (e) { console.warn('Bridge diagnostic error', e); }
      console.groupEnd();

      // Attacher les hooks Backbone.
      attachBackboneHooks();

      // Enregistrer le bridge dans hermes pour que les modules puissent y accéder.
      hermes.setBridge(bridge);

      hermes.log.info('GameBridge: prêt — hook XHR actif');
    },
  };

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

  // ─── Storage API publique ─────────────────────────────────────────────────────

  const storage = {

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
      const trimmed = logs.slice(-200);
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

  /**
   * engine/human.js — HumanEngine : moteur anti-détection
   *
   * Le problème qu'on résout : les bots de jeu navigateur sont détectés parce qu'ils
   * agissent de manière trop régulière, trop rapide, ou à des horaires impossibles.
   * Un humain réel : actions irrégulières, pauses repas, ralentissements le soir,
   * inactivité la nuit, jours de repos occasionnels.
   *
   * Ce module rend le comportement d'Hermes statistiquement indistinguable d'un humain.
   *
   * Implémentation :
   * - Délais gaussiens (Box-Muller) : variance naturelle autour d'un temps cible
   * - Profil journalier : génération pseudo-aléatoire mais reproductible des pauses
   * - Rate limiting : jamais plus vite qu'un humain ne pourrait faire
   * - Efficacité dégressive : moins actif la nuit/fin de soirée
   *
   * IMPORTANT : les seuils ici sont conservateurs par design.
   * Ne pas les augmenter sans comprendre les conséquences.
   */


  // ─── Constants ────────────────────────────────────────────────────────────────

  /**
   * Intervalle minimum entre deux actions critiques sur la même ville (ms).
   * "Critique" = farming, construction, commerce, combat.
   * Un humain ne peut pas interagir avec la même ville toutes les 4s.
   */
  const MIN_INTERVAL_SAME_CITY_MS = 4_000;

  /**
   * Maximum d'actions critiques par minute, toutes villes confondues.
   * Un joueur rapide fait ~10-15 actions/min sur Grepolis. 20 est déjà élevé.
   */
  const MAX_ACTIONS_PER_MINUTE = 20;

  /** Activité nocturne : fraction de l'efficacité normale (10%). */
  const NIGHT_ACTIVITY_FACTOR = 0.10;

  /** Activité pendant les pauses : fraction de l'efficacité (5% = quasi stop). */
  const PAUSE_ACTIVITY_FACTOR = 0.05;

  /**
   * Variance par défaut des délais gaussiens (±15% autour de la cible).
   * Exemple : cible 10s → délai entre ~7s et ~13s dans 95% des cas.
   */
  const DEFAULT_VARIANCE_PCT = 0.15;

  // ─── Gaussian random ──────────────────────────────────────────────────────────

  /**
   * Génère un nombre aléatoire suivant une distribution normale (gaussienne).
   * Algorithme Box-Muller — classique, rapide, précis.
   *
   * La distribution normale rend les délais d'Hermes indistinguables statistiquement
   * d'un humain : la plupart des actions autour de la moyenne, quelques outliers
   * naturels (moment d'inattention, notification extérieure, etc.).
   *
   * @param {number} mean   - Valeur centrale (ex: délai cible en ms)
   * @param {number} stdDev - Écart-type (dispersion)
   * @returns {number}
   */
  function gaussianRandom(mean, stdDev) {
    // Box-Muller transform : convertit deux uniformes en deux normaux.
    // On utilise seulement la première valeur (simple et suffisant).
    const u1 = Math.random();
    const u2 = Math.random();
    // Protection contre log(0) — Math.random() peut retourner 0.
    const safeU1 = Math.max(1e-10, u1);
    const z = Math.sqrt(-2 * Math.log(safeU1)) * Math.cos(2 * Math.PI * u2);

    // Résultat brut (peut être très éloigné de la moyenne — tail gaussienne).
    const raw = mean + stdDev * z;

    // Clamp : on refuse les délais inférieurs à 30% de la cible ou supérieurs à 250%.
    // Ces extremes n'existent pas chez un humain normal (trop rapide = impossible,
    // trop lent = l'utilisateur a quitté la page).
    return Math.max(mean * 0.30, Math.min(mean * 2.50, raw));
  }

  // ─── Profil journalier ────────────────────────────────────────────────────────

  /**
   * Génère le profil d'activité du jour courant.
   * Le profil est pseudo-aléatoire mais stable pour un jour donné :
   * utiliser la date comme seed (via un hash simple) garantit que les pauses
   * ne changent pas toutes les secondes, mais différent bien d'un jour à l'autre.
   *
   * @typedef {object} DailyProfile
   * @property {Array<{ start: number, end: number }>} pauses - Pauses (heures décimales)
   *
   * @returns {DailyProfile}
   */
  function generateDailyProfile() {
    // "Seed" basé sur la date (YYYYMMDD) — stable toute la journée.
    const today = new Date();
    const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    // Générateur pseudo-aléatoire déterministe (LCG simple).
    // Pas besoin de cryptographie — juste de la variabilité reproductible.
    let rng = seed;
    function nextRng() {
      rng = (rng * 1664525 + 1013904223) & 0xffffffff;
      return (rng >>> 0) / 0xffffffff; // [0, 1]
    }

    storage.getConfig();
    const pauses = [];

    // Pause déjeuner : autour de 12h30 ± 30 min, durée 20-45 min.
    const lunchCenter = 12.5;
    const lunchOffset = (nextRng() - 0.5) * 1.0; // ±30min
    const lunchStart  = lunchCenter + lunchOffset;
    const lunchDur    = 20 + nextRng() * 25;      // 20-45 min
    pauses.push({
      start: lunchStart,
      end:   lunchStart + lunchDur / 60,
    });

    // Pause dîner : autour de 19h30 ± 30 min, durée 20-45 min.
    const dinnerCenter = 19.5;
    const dinnerOffset = (nextRng() - 0.5) * 1.0;
    const dinnerStart  = dinnerCenter + dinnerOffset;
    const dinnerDur    = 20 + nextRng() * 25;
    pauses.push({
      start: dinnerStart,
      end:   dinnerStart + dinnerDur / 60,
    });

    // Pause courte aléatoire (café, toilettes...) : 5-15 min, dans l'après-midi.
    if (nextRng() > 0.4) { // 60% de chance d'avoir une pause courte
      const shortStart = 14 + nextRng() * 3; // entre 14h et 17h
      const shortDur   = 5 + nextRng() * 10;
      pauses.push({
        start: shortStart,
        end:   shortStart + shortDur / 60,
      });
    }

    return { pauses };
  }

  // ─── Rate limiter ─────────────────────────────────────────────────────────────

  /**
   * Crée un rate limiter par ville.
   * Deux contraintes simultanées :
   * 1. Une ville ne peut avoir qu'une action toutes les MIN_INTERVAL_SAME_CITY_MS
   * 2. Le système global ne peut dépasser MAX_ACTIONS_PER_MINUTE
   */
  function createRateLimiter() {
    // Map<cityId, timestamp> — timestamp de la dernière action par ville.
    const lastActionByCity = new Map();

    // Fenêtre glissante pour le rate global : queue des timestamps des 60 dernières secondes.
    const globalWindow = [];

    return {
      /**
       * Vérifie si une action peut être exécutée sur une ville.
       * @param {string|number} cityId
       * @returns {boolean}
       */
      canAct(cityId) {
        const now = Date.now();

        // Contrainte 1 : cooldown par ville.
        const lastCity = lastActionByCity.get(String(cityId)) ?? 0;
        if (now - lastCity < MIN_INTERVAL_SAME_CITY_MS) return false;

        // Contrainte 2 : rate global (fenêtre glissante 60s).
        // Purger les entrées plus vieilles que 60s.
        const cutoff = now - 60_000;
        while (globalWindow.length > 0 && globalWindow[0] < cutoff) {
          globalWindow.shift();
        }
        if (globalWindow.length >= MAX_ACTIONS_PER_MINUTE) return false;

        return true;
      },

      /**
       * Enregistre une action (met à jour les compteurs).
       * Appeler APRÈS avoir exécuté l'action.
       * @param {string|number} cityId
       */
      record(cityId) {
        const now = Date.now();
        lastActionByCity.set(String(cityId), now);
        globalWindow.push(now);
      },

      /**
       * Temps d'attente estimé avant de pouvoir agir sur une ville (ms).
       * @param {string|number} cityId
       * @returns {number}
       */
      waitTime(cityId) {
        const now = Date.now();
        const lastCity = lastActionByCity.get(String(cityId)) ?? 0;
        const cityWait = Math.max(0, MIN_INTERVAL_SAME_CITY_MS - (now - lastCity));

        const cutoff = now - 60_000;
        const activeCount = globalWindow.filter((t) => t >= cutoff).length;
        const globalWait = activeCount >= MAX_ACTIONS_PER_MINUTE
          ? Math.max(0, globalWindow[0] + 60_000 - now) // attendre que la fenêtre expire
          : 0;

        return Math.max(cityWait, globalWait);
      },

      /** Stats de debug. */
      stats() {
        const now = Date.now();
        const cutoff = now - 60_000;
        return {
          actionsLastMinute: globalWindow.filter((t) => t >= cutoff).length,
          citiesTracked: lastActionByCity.size,
        };
      },
    };
  }

  // ─── HumanEngine ──────────────────────────────────────────────────────────────

  // Instances internes — initialisées au premier appel (lazy).
  let _dailyProfile = null;
  let _profileDate  = null;
  const rateLimiter = createRateLimiter();

  /**
   * Retourne le profil du jour (recalculé si la date a changé).
   * @returns {DailyProfile}
   */
  function getDailyProfile() {
    const today = new Date().toDateString();
    if (_dailyProfile === null || _profileDate !== today) {
      _dailyProfile = generateDailyProfile();
      _profileDate = today;
    }
    return _dailyProfile;
  }

  /**
   * Convertit l'heure locale courante en décimal.
   * Exemple : 14h30 → 14.5
   * @returns {number}
   */
  function currentHourDecimal() {
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  }

  // ─── Export ────────────────────────────────────────────────────────────────────

  const human = {

    // ── Scheduling ────────────────────────────────────────────────────────────

    /**
     * Planifie l'exécution d'une fonction après un délai gaussien.
     * Le délai réel varie autour de targetMs selon une distribution normale.
     *
     * @param {Function} fn          - Fonction à exécuter
     * @param {number}   targetMs    - Délai cible en millisecondes
     * @param {number}   [variancePct=0.15] - Variance relative (0.15 = ±15%)
     * @returns {{ promise: Promise, cancel: Function }}
     */
    schedule(fn, targetMs, variancePct = DEFAULT_VARIANCE_PCT) {
      const stdDev  = targetMs * variancePct;
      const delay   = gaussianRandom(targetMs, stdDev);

      let timeoutId = null;
      let cancelled = false;

      const promise = new Promise((resolve, reject) => {
        timeoutId = setTimeout(async () => {
          if (cancelled) return resolve(null);
          try {
            const result = await fn();
            resolve(result);
          } catch (err) {
            reject(err);
          }
        }, delay);
      });

      return {
        promise,
        cancel() {
          cancelled = true;
          if (timeoutId !== null) clearTimeout(timeoutId);
        },
        /** Délai effectif choisi (utile pour le debug). */
        delay,
      };
    },

    /**
     * Exécute une séquence d'actions avec des intervalles gaussiens entre chacune.
     * L'intervalle entre deux actions est gaussien autour de baseIntervalMs.
     *
     * Usage : scheduleSequence([farmFn1, farmFn2, farmFn3], 8000)
     * → exécute les 3 actions avec ~8s ± 15% entre chacune.
     *
     * @param {Function[]} actions       - Liste de fonctions à exécuter
     * @param {number}     baseIntervalMs - Intervalle cible entre actions
     * @returns {Promise<void>}
     */
    async scheduleSequence(actions, baseIntervalMs) {
      for (let i = 0; i < actions.length; i++) {
        // Pas de délai avant la première action — l'appelant gère le timing initial.
        if (i > 0) {
          const { promise } = this.schedule(() => {}, baseIntervalMs);
          await promise;
        }
        try {
          await actions[i]();
        } catch (err) {
          // Une action qui échoue ne bloque pas la suite.
          console.error('[Hermes/HumanEngine] Action in sequence failed:', err);
        }
      }
    },

    // ── Contrôle d'activité ───────────────────────────────────────────────────

    /**
     * Vérifie si l'heure courante est dans la plage d'activité configurée.
     * @returns {boolean}
     */
    isActiveHour() {
      const config = storage.getConfig();
      const hour = currentHourDecimal();
      const { start, end } = config.activeHours;
      return hour >= start && hour < end;
    },

    /**
     * Vérifie si Hermes est actuellement dans une pause simulée (repas, café...).
     * @returns {boolean}
     */
    isInPause() {
      if (!storage.getConfig().pauseSimulation) return false;
      const state = storage.getState();
      if (state.manualPause) return true;

      const hour    = currentHourDecimal();
      const profile = getDailyProfile();
      return profile.pauses.some((p) => hour >= p.start && hour < p.end);
    },

    /**
     * Vérifie si Hermes peut effectuer une action d'un type donné.
     * Combine toutes les contraintes : activation, pauses, rate limits.
     *
     * @param {'farm'|'build'|'trade'|'combat'|string} actionType
     * @param {string|number} [cityId] - Si fourni, vérifie aussi le cooldown par ville
     * @returns {boolean}
     */
    canAct(actionType, cityId) {
      const config = storage.getConfig();

      // Master switch.
      if (!config.enabled) return false;

      // Plage horaire.
      if (!this.isActiveHour()) return false;

      // Pause en cours (réduction massive de l'activité, pas arrêt total).
      if (this.isInPause() && Math.random() > PAUSE_ACTIVITY_FACTOR) return false;

      // Nuit : activité très réduite.
      const hour = currentHourDecimal();
      const { start, end } = config.activeHours;
      const isNight = hour < start || hour >= end;
      if (isNight && Math.random() > NIGHT_ACTIVITY_FACTOR) return false;

      // Rate limiter par ville (si cityId fourni).
      if (cityId !== undefined && !rateLimiter.canAct(cityId)) return false;

      // Efficacité globale : parfois ne rien faire intentionnellement.
      const eff = this.getCurrentEfficiency();
      if (Math.random() > eff) return false;

      return true;
    },

    /**
     * Enregistre une action effectuée (pour le rate limiter et l'historique).
     * @param {string}       actionType
     * @param {string|number} [cityId]
     */
    recordAction(actionType, cityId) {
      if (cityId !== undefined) {
        rateLimiter.record(cityId);
      }
      storage.updateState({
        actionsThisSession: (storage.getState().actionsThisSession ?? 0) + 1,
        lastActionAt: Date.now(),
      });
      if (cityId !== undefined) {
        storage.recordAction(actionType, cityId);
      }
    },

    // ── Profil d'activité ─────────────────────────────────────────────────────

    /**
     * Retourne le multiplicateur d'activité pour l'heure courante.
     * 1.0 = pleine activité, 0.0 = inactivité totale.
     *
     * Le profil suit une courbe sinusoïdale : actif en journée,
     * progressivement moins actif en soirée, inactif la nuit.
     *
     * @returns {number} Multiplicateur dans [0, 1]
     */
    getActivityMultiplier() {
      const config = storage.getConfig();
      const hour   = currentHourDecimal();
      const { start, end } = config.activeHours;

      // Nuit totale.
      if (hour < start || hour >= end) return NIGHT_ACTIVITY_FACTOR;

      // Pause en cours.
      if (this.isInPause()) return PAUSE_ACTIVITY_FACTOR;

      // Normaliser l'heure dans [0, 1] pour la période active.
      const t = (hour - start) / (end - start);

      // Courbe en cloche : maximum vers 40% de la journée (milieu de journée),
      // ralentissement progressif le soir.
      // sin(π*t)^0.5 donne une courbe plate en milieu de journée et douce aux extrêmes.
      const curve = Math.pow(Math.sin(Math.PI * t), 0.5);

      // Floor à 0.3 : même en début/fin de journée on reste actif à 30%.
      return Math.max(0.3, curve);
    },

    // ── Efficacité effective ──────────────────────────────────────────────────

    /**
     * Calcule l'efficacité effective courante d'Hermes.
     * Combine l'efficacité configurée et le multiplicateur d'activité horaire.
     *
     * Exemple : config.efficiency=0.68, activityMultiplier=0.7 (fin de soirée)
     * → efficiency effective = 0.68 * 0.7 = 0.476 (47.6% des actions exécutées)
     *
     * @returns {number} Efficacité dans [0, 1]
     */
    getCurrentEfficiency() {
      const config     = storage.getConfig();
      const baseEff    = config.efficiency ?? 0.68;
      const multiplier = this.getActivityMultiplier();
      return baseEff * multiplier;
    },

    // ── Rate limiter (exposition) ─────────────────────────────────────────────

    /**
     * Temps d'attente estimé avant de pouvoir agir sur une ville.
     * @param {string|number} cityId
     * @returns {number} Millisecondes à attendre (0 si peut agir maintenant)
     */
    waitTimeFor(cityId) {
      return rateLimiter.waitTime(cityId);
    },

    // ── Diagnostics ───────────────────────────────────────────────────────────

    /**
     * Retourne les statistiques courantes du moteur (pour le dashboard).
     * @returns {object}
     */
    diagnostics() {
      const profile = getDailyProfile();
      return {
        isActiveHour:       this.isActiveHour(),
        isInPause:          this.isInPause(),
        currentHour:        Math.round(currentHourDecimal() * 100) / 100,
        activityMultiplier: Math.round(this.getActivityMultiplier() * 100) / 100,
        currentEfficiency:  Math.round(this.getCurrentEfficiency() * 100) / 100,
        scheduledPauses:    profile.pauses.map((p) => ({
          start: `${Math.floor(p.start)}h${Math.round((p.start % 1) * 60).toString().padStart(2, '0')}`,
          end:   `${Math.floor(p.end)}h${Math.round((p.end % 1) * 60).toString().padStart(2, '0')}`,
        })),
        rateLimiter:        rateLimiter.stats(),
      };
    },

    // ── Gaussian random exposé pour tests ─────────────────────────────────────
    _gaussianRandom: gaussianRandom,
  };

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
  const knowledge = _data;

  /**
   * Retourne le profil d'un monde donné depuis la KnowledgeBase.
   * @param {string} worldKey - Ex: 'speed3_revolt'
   * @returns {object|null}
   */
  function getWorldProfile(worldKey) {
    return knowledge.world_profiles?.[worldKey] ?? null;
  }

  /**
   * Retourne les stratégies applicables pour un worldKey.
   * @param {string} worldKey
   * @returns {object[]} Liste de stratégies (objets) applicables à ce monde
   */
  function getStrategiesForWorld(worldKey) {
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
  function getRecommendedStrategy(worldKey, cityIndex) {
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
  let _worldKey$1 = null;

  /** Overrides manuels de template par cityIndex */
  const _templateOverrides = new Map();

  /** Unsubscribers pour les events hermes */
  const _subs$3 = [];

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

    if (!_worldKey$1) return 'auto';

    const strategy = getRecommendedStrategy(_worldKey$1, cityIndex);
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
    _worldKey$1 = newKey;

    const summary = buildSummary(_profile, _worldKey$1);
    hermes.log.info(`WorldAnalyzer: ${summary}`);

    if (isUpdate) {
      hermes.emit('world:profile:updated', { profile: _profile, worldKey: _worldKey$1 });
    } else {
      hermes.emit('world:profile', { profile: _profile, worldKey: _worldKey$1 });
    }

    return true;
  }

  // ─── Interface publique ───────────────────────────────────────────────────────

  /**
   * WorldAnalyzer — détecte et maintient le profil du monde Grepolis.
   */
  const worldAnalyzer = {

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
      _subs$3.push(unsubGameLoaded);

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
      for (const unsub of _subs$3) unsub();
      _subs$3.length = 0;
      _profile  = null;
      _worldKey$1 = null;
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
      return _worldKey$1;
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
      if (!_profile || !_worldKey$1) return 'Monde non détecté';
      return buildSummary(_profile, _worldKey$1);
    },

    /**
     * Retourne les stratégies disponibles pour le monde courant.
     * @returns {object[]}
     */
    getAvailableStrategies() {
      if (!_worldKey$1) return [];
      return getStrategiesForWorld(_worldKey$1);
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


  // ─── Constantes ───────────────────────────────────────────────────────────────

  /** Récupération de mood : ~0.0408 pts/min (58.835 pts / 24h). */
  const MOOD_RECOVERY_PER_MINUTE = 58.835 / (24 * 60);

  /** Coût de mood par tranche de 1000 ressources pillées (estimation). */
  const LOOT_MOOD_COST_PER_1000 = 10;

  /** Mood minimum pour tenter un trade. */
  const TRADE_MINIMUM_MOOD$1 = 80;

  /** Mood minimum safe pour lancer une demande (demand). */
  const DEMAND_SAFE_MOOD = 78;

  /** Mood préféré pour piller (loot). */
  const LOOT_PREFER_MOOD = 85;

  /**
   * Intervalle principal de la loop (ms).
   * Le délai réel est gaussien autour de cette valeur.
   */
  const LOOP_INTERVAL_MS$1 = 60_000;

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
  let _loopHandle$1 = null;

  /** Flag pour arrêter la loop proprement. */
  let _running$3 = false;

  /** Statistiques du cycle courant. */
  let _stats$3 = {
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
      if (defaultAction === 'trade' && mood < TRADE_MINIMUM_MOOD$1) return null;
      return { action: defaultAction, reason: `mode forcé: ${defaultAction}` };
    }

    // Mode auto : décision par seuils.
    const hasMarket = (city?.buildings?.market ?? 0) > 0;

    if (mood >= LOOT_PREFER_MOOD) {
      return { action: 'loot', reason: `mood élevé (${mood.toFixed(1)} >= ${LOOT_PREFER_MOOD})` };
    }

    if (mood >= TRADE_MINIMUM_MOOD$1 && hasMarket) {
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
        _stats$3.errors++;
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
      _stats$3.totalActions++;
      _stats$3.totalResources.wood   += village.resources?.wood   ?? 0;
      _stats$3.totalResources.stone  += village.resources?.stone  ?? 0;
      _stats$3.totalResources.silver += village.resources?.silver ?? 0;

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
      _stats$3.errors++;
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
  async function runCycle$1(force = false) {
    hermes.log.debug('FarmManager: démarrage cycle de farming');

    const queue = buildPriorityQueue();

    if (queue.length === 0) {
      hermes.log.debug('FarmManager: queue vide — aucun village à traiter');
      _stats$3.lastCycleTs = Date.now();
      _stats$3.lastCycleCitiesProcessed = 0;
      _stats$3.lastCycleVillagesActed = 0;
      return;
    }

    hermes.log.info(`FarmManager: ${queue.length} villages à traiter dans ce cycle`);

    const citiesInCycle = new Set();
    let villagesActed = 0;

    // Exécution séquentielle avec délais gaussiens entre chaque action.
    for (let i = 0; i < queue.length; i++) {
      if (!_running$3) break; // Arrêt propre si destroy() a été appelé.

      const entry = queue[i];
      const { city, village, decision } = entry;

      // Re-vérification du cooldown (il peut avoir changé depuis la construction de la queue).
      if (village.cooldownRemaining > 0 && !force) continue;

      // Délai gaussien entre actions (sauf avant la première).
      if (i > 0) {
        const { promise } = human.schedule(() => {}, INTER_ACTION_INTERVAL_MS, ACTION_VARIANCE_PCT);
        await promise;
        if (!_running$3) break;
      }

      const success = await executeAction(city, village, decision.action);
      if (success) {
        citiesInCycle.add(city.id);
        villagesActed++;
      }
    }

    // Persistance de l'état après le cycle.
    saveState();

    _stats$3.lastCycleTs = Date.now();
    _stats$3.lastCycleCitiesProcessed = citiesInCycle.size;
    _stats$3.lastCycleVillagesActed = villagesActed;

    hermes.emit('farm:cycle:end', {
      citiesProcessed: citiesInCycle.size,
      totalResources:  { ..._stats$3.totalResources },
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
  function scheduleNextCycle$1() {
    if (!_running$3) return;

    _loopHandle$1 = human.schedule(async () => {
      if (!_running$3) return;
      try {
        await runCycle$1();
      } catch (err) {
        hermes.log.error('FarmManager: erreur non gérée dans runCycle', err);
      }
      // Planifier le prochain cycle après la fin de celui-ci.
      scheduleNextCycle$1();
    }, LOOP_INTERVAL_MS$1, ACTION_VARIANCE_PCT);
  }

  // ─── Souscriptions aux événements ─────────────────────────────────────────────

  /** Références aux unsubscribers pour le cleanup. */
  const _unsubs$3 = [];

  function attachListeners$3() {
    // Démarrer la loop quand Hermes est prêt.
    _unsubs$3.push(hermes.on('hermes:ready', () => {
      hermes.log.info('FarmManager: hermes:ready reçu — démarrage loop');
      scheduleNextCycle$1();
    }));

    // Arrêt propre.
    _unsubs$3.push(hermes.on('hermes:stopped', () => {
      if (_loopHandle$1) _loopHandle$1.cancel();
      _running$3 = false;
    }));

    // Sync de l'état initial au chargement du jeu.
    _unsubs$3.push(hermes.on('game:loaded', () => {
      hermes.log.debug('FarmManager: game:loaded — sync état initial');
      loadState();
    }));
  }

  function detachListeners$3() {
    for (const unsub of _unsubs$3) unsub();
    _unsubs$3.length = 0;
  }

  // ─── Interface publique ───────────────────────────────────────────────────────

  const farmManager = {

    /**
     * Initialise le FarmManager : charge l'état, attache les listeners, démarre si Hermes est déjà prêt.
     */
    init() {
      hermes.log.info('FarmManager: init');
      loadState();
      _running$3 = true;
      attachListeners$3();

      // Si Hermes est déjà lancé (module chargé tardivement), démarrer immédiatement.
      if (hermes.isRunning) {
        scheduleNextCycle$1();
      }
    },

    /**
     * Arrête proprement le FarmManager : annule la loop et désinscrit les listeners.
     */
    destroy() {
      hermes.log.info('FarmManager: destroy');
      _running$3 = false;
      if (_loopHandle$1) {
        _loopHandle$1.cancel();
        _loopHandle$1 = null;
      }
      detachListeners$3();
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
        lastCycleTs:     _stats$3.lastCycleTs,
        running:         _running$3,
        stats: {
          totalActions:               _stats$3.totalActions,
          totalResources:             { ..._stats$3.totalResources },
          lastCycleCitiesProcessed:   _stats$3.lastCycleCitiesProcessed,
          lastCycleVillagesActed:     _stats$3.lastCycleVillagesActed,
          errors:                     _stats$3.errors,
        },
      };
    },

    /**
     * Force un cycle immédiat, bypasse les délais humains.
     * @returns {Promise<void>}
     */
    async forceRun() {
      hermes.log.info('FarmManager: forceRun demandé');
      if (_loopHandle$1) {
        _loopHandle$1.cancel();
        _loopHandle$1 = null;
      }
      await runCycle$1(true);
      scheduleNextCycle$1();
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
  let _worldProfile$1 = null;

  /** Handle de la loop principale. */
  let _loopHandle = null;

  /** Flag de fonctionnement. */
  let _running$2 = false;

  /** Statistiques globales. */
  let _stats$2 = {
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
    if (_worldProfile$1) {
      const speed = _worldProfile$1.speed ?? 1;
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
    const templateId = assignment?.templateId ?? autoSelectTemplate();
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
        _stats$2.totalSkipped++;
        return;
      }

      // Lancer la construction.
      const success = await bridge.buildBuilding(city.id, nextStep.building, nextStep.level);

      if (success) {
        _stats$2.totalQueued++;
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
        _stats$2.errors++;
      }
    } catch (err) {
      hermes.log.error(`BuildManager: erreur processCity ville ${city.id}`, err);
      _stats$2.errors++;
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
      if (!_running$2) break;

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
    if (!_running$2) return;

    _loopHandle = human.schedule(async () => {
      if (!_running$2) return;
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

  const _unsubs$2 = [];

  function attachListeners$2() {
    _unsubs$2.push(hermes.on('hermes:ready', () => {
      hermes.log.info('BuildManager: hermes:ready — démarrage loop');
      scheduleNextCycle();
    }));

    _unsubs$2.push(hermes.on('hermes:stopped', () => {
      if (_loopHandle) _loopHandle.cancel();
      _running$2 = false;
    }));

    _unsubs$2.push(hermes.on('game:loaded', () => {
      loadAssignments();
    }));

    // Mise à jour du worldProfile pour adapter les templates.
    _unsubs$2.push(hermes.on('world:profile', ({ profile }) => {
      if (profile) {
        _worldProfile$1 = profile;
        hermes.log.debug('BuildManager: worldProfile mis à jour', profile);
      }
    }));

    // Réagir à la fin d'une construction (re-planifier immédiatement si besoin).
    _unsubs$2.push(hermes.on('construction:complete', handleConstructionComplete));
  }

  function detachListeners$2() {
    for (const unsub of _unsubs$2) unsub();
    _unsubs$2.length = 0;
  }

  // ─── Interface publique ───────────────────────────────────────────────────────

  const buildManager = {

    /**
     * Initialise le BuildManager.
     */
    init() {
      hermes.log.info('BuildManager: init');
      loadAssignments();
      _running$2 = true;
      attachListeners$2();

      if (hermes.isRunning) {
        scheduleNextCycle();
      }
    },

    /**
     * Arrête proprement le BuildManager.
     */
    destroy() {
      hermes.log.info('BuildManager: destroy');
      _running$2 = false;
      if (_loopHandle) {
        _loopHandle.cancel();
        _loopHandle = null;
      }
      detachListeners$2();
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
        running:            _running$2,
        citiesManaged:      citiesCount,
        assignmentsCount:   _assignments.size,
        worldProfile:       _worldProfile$1,
        stats:              { ..._stats$2 },
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

  /**
   * modules/market.js — MarketManager : gestion du marché et des échanges
   *
   * Implémente :
   *   FR5 — Auto-trade avec les villages fermiers (après chaque farm:action)
   *   FR6 — Équilibrage inter-villes (toutes les ~30 min)
   *   FR7 — Alertes offres or (hook sur market:gold_offer)
   *
   * Logique FR5 (farm trade) :
   *   Après réception de 'farm:action', si l"action était un trade (ou si le village
   *   a mood > TRADE_MINIMUM_MOOD et que le marché est disponible), déclencher le trade.
   *
   * Logique FR6 (équilibrage inter-villes) :
   *   Scanner surplus/déficit de ressources entre toutes les villes.
   *   Envoyer des transferts de la ville la plus riche vers la plus pauvre
   *   pour chaque ressource, en respectant une marge de sécurité.
   *
   * Logique FR7 (offres or) :
   *   Hooker bridge.onGameEvent('market:gold_offer'), évaluer le ratio,
   *   logguer et émettre 'market:gold:opportunity' si le ratio est favorable.
   */


  // ─── Constantes ───────────────────────────────────────────────────────────────

  /** Mood minimum pour un trade avec un village fermier. */
  const TRADE_MINIMUM_MOOD = 80;

  /**
   * Intervalle d'équilibrage inter-villes (~30 min ± 5 min gaussien).
   * Suffisamment rare pour ne pas stresser le serveur.
   */
  const BALANCE_INTERVAL_MS  = 30 * 60_000;
  const BALANCE_VARIANCE_PCT = 0.17; // ±17% ≈ ±5 min sur 30 min

  /**
   * Fraction de stockage maximale à envoyer lors d'un équilibrage.
   * On n'envoie jamais plus de 40% des ressources d'une ville en une fois.
   */
  const MAX_TRANSFER_FRACTION = 0.40;

  /**
   * Ratio or/ressources par défaut pour considérer une offre comme favorable.
   * Modifiable via setGoldRatioThreshold().
   */
  const DEFAULT_GOLD_RATIO = 1.5;

  /**
   * Marge de sécurité de stockage : on ne transfère que si la ville source
   * a plus de cette fraction de sa capacité.
   */
  const MIN_STORAGE_FRACTION_TO_TRANSFER = 0.30;

  /** Délai entre deux trades successifs dans un cycle d'équilibrage (ms). */
  const INTER_TRADE_DELAY_MS = 5_000;

  // ─── État interne ─────────────────────────────────────────────────────────────

  /** Handle de la loop d'équilibrage. */
  let _balanceLoopHandle = null;

  /** Seuil de ratio or courant (configurable). */
  let _goldRatioThreshold = DEFAULT_GOLD_RATIO;

  /** Souscriptions Backbone pour market:gold_offer. */
  let _goldOfferUnsub = null;

  /** Flag de fonctionnement. */
  let _running$1 = false;

  /** Statistiques. */
  let _stats$1 = {
    lastTradeTs:         null,
    tradesExecuted:      0,
    goldOpportunities:   0,
    balanceCyclesRun:    0,
    errors:              0,
  };

  // ─── FR5 : Auto-trade avec villages fermiers ──────────────────────────────────

  /**
   * Déclenché après chaque 'farm:action'.
   * Si l'action était un trade, il est déjà fait.
   * Si le village a mood > TRADE_MINIMUM_MOOD et le marché dispo, on peut faire un trade.
   *
   * @param {{ cityId, villageId, action, resources, mood }} farmEvent
   */
  async function handleFarmAction(farmEvent) {
    if (!farmEvent) return;

    const { cityId, villageId, action, mood } = farmEvent;

    // Le trade a déjà été effectué par FarmManager si action === 'trade'.
    // On ne double pas l'action ici.
    if (action === 'trade') return;

    // Vérifier le mood post-action.
    if ((mood ?? 0) < TRADE_MINIMUM_MOOD) return;

    // Vérifier que la ville a un marché.
    let city;
    try {
      city = bridge.getCity(cityId);
    } catch (err) {
      hermes.log.warn('MarketManager: bridge.getCity a levé une exception', err);
      return;
    }

    if (!city) return;
    const marketLevel = city.buildings?.market ?? 0;
    if (marketLevel === 0) return;

    // Vérifier le stockage : pas la peine de trader si plein.
    const storage_ = city.buildings?.storage ?? 1;
    // Estimation grossière : storage level * 1000 = capacité.
    const storageCapacity = storage_ * 1000;
    const totalResources  = (city.resources?.wood ?? 0)
      + (city.resources?.stone ?? 0)
      + (city.resources?.silver ?? 0);

    if (totalResources >= storageCapacity * 0.90) {
      hermes.log.debug(`MarketManager: ville ${cityId} quasi-pleine — trade fermier ignoré`);
      return;
    }

    if (!human.canAct('trade', cityId)) return;

    // Récupérer les ressources du village.
    let villages;
    try {
      villages = bridge.getFarmingVillages(cityId);
    } catch (err) {
      hermes.log.warn('MarketManager: getFarmingVillages a levé une exception', err);
      return;
    }

    const village = (villages ?? []).find((v) => String(v.id) === String(villageId));
    if (!village || !village.resources) return;

    const resources = village.resources;
    // Vérifier qu'il y a quelque chose à trader.
    if ((resources.wood ?? 0) + (resources.stone ?? 0) + (resources.silver ?? 0) === 0) return;

    try {
      // Le "trade' avec un village fermier passe par bridge.farmVillage avec type 'trade'.
      const success = await bridge.farmVillage(cityId, villageId, 'trade');
      if (success) {
        _stats$1.tradesExecuted++;
        _stats$1.lastTradeTs = Date.now();
        human.recordAction('trade', cityId);
        storage.recordAction('market:farm_trade', cityId, { villageId, resources });

        hermes.emit('market:trade', {
          fromId:    villageId,
          toId:      cityId,
          resources,
          type:      'farm_village',
        });

        hermes.log.info(
          `MarketManager: trade fermier — village ${villageId} → ville ${cityId}`,
          resources,
        );
      } else {
        _stats$1.errors++;
      }
    } catch (err) {
      hermes.log.error('MarketManager: erreur trade fermier', err);
      _stats$1.errors++;
    }
  }

  // ─── FR6 : Équilibrage inter-villes ──────────────────────────────────────────

  /**
   * @typedef {object} ResourceBalance
   * @property {string} cityId
   * @property {number} wood
   * @property {number} stone
   * @property {number} silver
   * @property {number} total
   */

  /**
   * Scanne les ressources de toutes les villes et détermine les transferts à effectuer.
   * Retourne une liste de transferts { fromId, toId, resources }.
   *
   * Stratégie : pour chaque ressource, trouver la ville la plus riche (surplus)
   * et la plus pauvre (déficit), calculer le delta, envoyer une fraction.
   *
   * @param {import('../bridge.js').City[]} cities
   * @returns {Array<{ fromId: string|number, toId: string|number, resources: object }>}
   */
  function computeTransfers(cities) {
    if (!cities || cities.length < 2) return [];

    const transfers = [];

    // Calculer les ressources disponibles pour chaque ville.
    /** @type {ResourceBalance[]} */
    const balances = cities.map((city) => ({
      cityId: city.id,
      wood:   city.resources?.wood   ?? 0,
      stone:  city.resources?.stone  ?? 0,
      silver: city.resources?.silver ?? 0,
      total:  (city.resources?.wood ?? 0) + (city.resources?.stone ?? 0) + (city.resources?.silver ?? 0),
    }));

    const resourceTypes = ['wood', 'stone', 'silver'];

    for (const res of resourceTypes) {
      // Trier par quantité de cette ressource (décroissant).
      const sorted = [...balances].sort((a, b) => b[res] - a[res]);
      const richest = sorted[0];
      const poorest = sorted[sorted.length - 1];

      // Ignorer si la différence est trop faible.
      const delta = richest[res] - poorest[res];
      if (delta < 500) continue; // Moins de 500 unités de différence → pas la peine.

      // Calculer la quantité à transférer : au max MAX_TRANSFER_FRACTION du surplus.
      const transferAmount = Math.floor(
        Math.min(
          delta * 0.5,                                // moitié de la différence
          richest[res] * MAX_TRANSFER_FRACTION,       // max de la ville source
        ),
      );

      if (transferAmount < 100) continue; // Trop petit pour être utile.

      // Vérifier que la ville source a assez de surplus.
      const storageFraction = richest[res] / Math.max(1, richest.total);
      if (storageFraction < MIN_STORAGE_FRACTION_TO_TRANSFER) continue;

      // Construire le paquet de ressources à envoyer.
      const resources = { wood: 0, stone: 0, silver: 0 };
      resources[res] = transferAmount;

      transfers.push({
        fromId:    richest.cityId,
        toId:      poorest.cityId,
        resources,
      });
    }

    return transfers;
  }

  /**
   * Exécute le cycle d'équilibrage inter-villes.
   * @returns {Promise<void>}
   */
  async function runBalanceCycle() {
    hermes.log.debug('MarketManager: démarrage cycle équilibrage');

    let cities;
    try {
      cities = bridge.getCities();
    } catch (err) {
      hermes.log.error('MarketManager: bridge.getCities a levé une exception', err);
      return;
    }

    if (!cities || cities.length < 2) {
      hermes.log.debug('MarketManager: moins de 2 villes — équilibrage ignoré');
      return;
    }

    const transfers = computeTransfers(cities);

    if (transfers.length === 0) {
      hermes.log.debug('MarketManager: aucun transfert nécessaire');
      return;
    }

    hermes.log.info(`MarketManager: ${transfers.length} transferts planifiés`);

    for (let i = 0; i < transfers.length; i++) {
      if (!_running$1) break;

      const tx = transfers[i];

      if (!human.canAct('trade', tx.fromId)) {
        hermes.log.debug(`MarketManager: human.canAct false pour ville ${tx.fromId} — transfert ignoré`);
        continue;
      }

      // Délai entre trades.
      if (i > 0) {
        const { promise } = human.schedule(() => {}, INTER_TRADE_DELAY_MS, 0.20);
        await promise;
        if (!_running$1) break;
      }

      try {
        const success = await bridge.sendTrade(tx.fromId, tx.toId, tx.resources);
        if (success) {
          _stats$1.tradesExecuted++;
          _stats$1.lastTradeTs = Date.now();
          human.recordAction('trade', tx.fromId);
          storage.recordAction('market:balance_trade', tx.fromId, {
            toId:      tx.toId,
            resources: tx.resources,
          });

          hermes.emit('market:trade', {
            fromId:    tx.fromId,
            toId:      tx.toId,
            resources: tx.resources,
            type:      'balance',
          });

          hermes.log.info(
            `MarketManager: transfert ${tx.fromId} → ${tx.toId}`,
            tx.resources,
          );
        } else {
          _stats$1.errors++;
          hermes.log.warn(`MarketManager: bridge.sendTrade a retourné false pour ${tx.fromId} → ${tx.toId}`);
        }
      } catch (err) {
        hermes.log.error('MarketManager: erreur sendTrade', err);
        _stats$1.errors++;
      }
    }

    _stats$1.balanceCyclesRun++;
    hermes.log.debug('MarketManager: cycle équilibrage terminé');
  }

  /**
   * Planifie le prochain cycle d'équilibrage (self-rescheduling).
   */
  function scheduleNextBalance() {
    if (!_running$1) return;

    _balanceLoopHandle = human.schedule(async () => {
      if (!_running$1) return;
      try {
        await runBalanceCycle();
      } catch (err) {
        hermes.log.error('MarketManager: erreur non gérée dans runBalanceCycle', err);
      }
      scheduleNextBalance();
    }, BALANCE_INTERVAL_MS, BALANCE_VARIANCE_PCT);
  }

  // ─── FR7 : Alertes offres or ──────────────────────────────────────────────────

  /**
   * Évalue une offre or reçue du bridge et émet une alerte si le ratio est favorable.
   *
   * @param {object} offerData - Données de l'offre (format Grepolis natif)
   */
  function handleGoldOffer(offerData) {
    if (!offerData) return;

    try {
      // Format attendu : { goldAmount, resourceType, resourceAmount, playerId }
      const { goldAmount, resourceAmount, resourceType } = offerData;

      if (!goldAmount || !resourceAmount) return;

      const ratio = resourceAmount / goldAmount;

      hermes.log.info(
        `MarketManager: offre or détectée — ${goldAmount} or ↔ ${resourceAmount} ${resourceType ?? 'res'} (ratio: ${ratio.toFixed(2)})`,
        offerData,
      );

      if (ratio >= _goldRatioThreshold) {
        _stats$1.goldOpportunities++;

        hermes.emit('market:gold:opportunity', {
          goldAmount,
          resourceAmount,
          resourceType,
          ratio,
          offerData,
        });

        hermes.log.info(
          `MarketManager: offre or favorable (ratio ${ratio.toFixed(2)} >= ${_goldRatioThreshold}) — opportunité signalée`,
        );
      }
    } catch (err) {
      hermes.log.warn('MarketManager: erreur lors du traitement de l\'offre or', err);
    }
  }

  /**
   * Attache le hook sur les événements 'market:gold_offer' via bridge.onGameEvent.
   */
  function attachGoldOfferHook() {
    try {
      _goldOfferUnsub = bridge.onGameEvent('market:gold_offer', handleGoldOffer);
      hermes.log.debug('MarketManager: hook market:gold_offer actif');
    } catch (err) {
      hermes.log.warn('MarketManager: impossible d\'attacher le hook gold_offer', err);
    }
  }

  function detachGoldOfferHook() {
    if (_goldOfferUnsub) {
      try {
        _goldOfferUnsub();
      } catch { /* ignore */ }
      _goldOfferUnsub = null;
    }
  }

  // ─── Souscriptions aux événements ─────────────────────────────────────────────

  const _unsubs$1 = [];

  function attachListeners$1() {
    // Démarrer la loop d'équilibrage quand Hermes est prêt.
    _unsubs$1.push(hermes.on('hermes:ready', () => {
      hermes.log.info('MarketManager: hermes:ready — démarrage loop équilibrage');
      scheduleNextBalance();
      attachGoldOfferHook();
    }));

    _unsubs$1.push(hermes.on('hermes:stopped', () => {
      if (_balanceLoopHandle) _balanceLoopHandle.cancel();
      _running$1 = false;
      detachGoldOfferHook();
    }));

    // Réagir aux actions de farming pour les trades fermiers.
    _unsubs$1.push(hermes.on('farm:action', handleFarmAction));
  }

  function detachListeners$1() {
    for (const unsub of _unsubs$1) unsub();
    _unsubs$1.length = 0;
    detachGoldOfferHook();
  }

  // ─── Interface publique ───────────────────────────────────────────────────────

  const marketManager = {

    /**
     * Initialise le MarketManager.
     */
    init() {
      hermes.log.info('MarketManager: init');
      _running$1 = true;
      attachListeners$1();

      if (hermes.isRunning) {
        scheduleNextBalance();
        attachGoldOfferHook();
      }
    },

    /**
     * Arrête proprement le MarketManager.
     */
    destroy() {
      hermes.log.info('MarketManager: destroy');
      _running$1 = false;
      if (_balanceLoopHandle) {
        _balanceLoopHandle.cancel();
        _balanceLoopHandle = null;
      }
      detachListeners$1();
    },

    /**
     * Retourne le statut courant du module.
     * @returns {{ lastTradeTs: number|null, tradesExecuted: number, goldOpportunities: number }}
     */
    getStatus() {
      return {
        running:           _running$1,
        lastTradeTs:       _stats$1.lastTradeTs,
        tradesExecuted:    _stats$1.tradesExecuted,
        goldOpportunities: _stats$1.goldOpportunities,
        balanceCyclesRun:  _stats$1.balanceCyclesRun,
        goldRatioThreshold: _goldRatioThreshold,
        errors:            _stats$1.errors,
      };
    },

    /**
     * Définit le seuil de ratio or/ressources pour les alertes.
     * Un ratio plus bas = plus d'alertes (offres moins bonnes acceptées).
     * @param {number} ratio - Ex: 1.5 = 1 or pour 1.5 ressources minimum
     */
    setGoldRatioThreshold(ratio) {
      if (typeof ratio !== 'number' || ratio <= 0) {
        hermes.log.warn('MarketManager: setGoldRatioThreshold — valeur invalide', ratio);
        return;
      }
      _goldRatioThreshold = ratio;
      hermes.log.info(`MarketManager: seuil ratio or mis à jour → ${ratio}`);
    },
  };

  // ─── Auto-registration ────────────────────────────────────────────────────────

  hermes.register('market', {
    init()    { marketManager.init();    },
    destroy() { marketManager.destroy(); },
  });

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


  // ─── Constantes ───────────────────────────────────────────────────────────────

  /**
   * Offset par défaut appliqué au send time (ms avant l'arrivée du CS ennemi).
   * -2000ms = on envoie 2s avant l'arrivée théorique du CS.
   * Doit compenser la latence réseau et le délai de traitement.
   */
  const DEFAULT_SNIPE_OFFSET_MS = -2e3;

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

  const combatManager = {

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
  const _subs$2 = [];

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
  const situationAnalyzer = {

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
      _subs$2.push(unsubGameLoaded);

      // Re-analyser immédiatement si les relations d'alliance changent
      const unsubAlliance = hermes.on('alliance:changed', ({ playerId }) => {
        hermes.log.debug(`SituationAnalyzer: alliance:changed pour ${playerId} — re-analyse`);
        runFullAnalysis();
      });
      _subs$2.push(unsubAlliance);

      // Enregistrer les attaques entrantes pour la détection de patterns
      const unsubCombat = hermes.on('combat:alert', ({ attack }) => {
        if (attack) {
          recordAttack(attack);
          hermes.log.debug(`SituationAnalyzer: attaque enregistrée depuis ville ${attack.fromCityId}`);
        }
      });
      _subs$2.push(unsubCombat);

      // Aussi écouter les attaques depuis le bridge
      const unsubAttack = hermes.on('attack:incoming', (attack) => {
        recordAttack(attack);
      });
      _subs$2.push(unsubAttack);
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
      for (const unsub of _subs$2) unsub();
      _subs$2.length = 0;
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
  const _subs$1 = [];

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
    worldProfile?.system ?? 'revolt';
    String(city.id);

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
  const strategicAdvisor = {

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
      _subs$1.push(unsubWorld);

      // Mise à jour si le profil change en cours de session
      const unsubWorldUpd = hermes.on('world:profile:updated', ({ profile, worldKey }) => {
        _worldProfile = profile;
        _worldKey     = worldKey;
      });
      _subs$1.push(unsubWorldUpd);

      // Recevoir les mises à jour de situation pour chaque ville
      const unsubSituation = hermes.on('situation:updated', ({ cityId, threatScore }) => {
        updateRecommendationsForCity(cityId, threatScore);
      });
      _subs$1.push(unsubSituation);

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
      _subs$1.push(unsubBuild);

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
      _subs$1.push(unsubGameLoaded);
    },

    /**
     * Nettoie les subscriptions et l'état.
     */
    destroy() {
      hermes.log.debug('StrategicAdvisor: destroy');
      for (const unsub of _subs$1) unsub();
      _subs$1.length = 0;
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

  /**
   * ui/styles.js — Styles CSS du panneau Hermes
   *
   * Injecte une balise <style> dans le DOM avec l'ensemble des styles du panneau.
   *
   * Thème : sombre (fond #1a1a2e, accents vert #4ade80) — discret dans Grepolis.
   * Le panneau est flottant (position: fixed), draggable, et contient des tabs.
   *
   * Conventions de nommage CSS : .hermes-* (namespace pour éviter les conflits avec Grepolis)
   */

  /** ID de la balise <style> injectée. Permet de ne pas injecter deux fois. */
  const STYLE_ID = 'hermes-styles';

  // ─── CSS ──────────────────────────────────────────────────────────────────────

  const CSS = `
/* ── Reset ciblé — uniquement dans .hermes-panel ── */
.hermes-panel *,
.hermes-panel *::before,
.hermes-panel *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* ── Panneau principal ── */
.hermes-panel {
  position: fixed;
  top: 60px;
  right: 16px;
  z-index: 999999;
  width: 380px;
  min-width: 320px;
  max-width: 480px;
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(74, 222, 128, 0.1);
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  font-size: 12px;
  color: #e2e8f0;
  user-select: none;
  transition: opacity 0.2s ease;
}

.hermes-panel.hermes-hidden {
  display: none;
}

.hermes-panel.hermes-minimized .hermes-tabs,
.hermes-panel.hermes-minimized .hermes-tab-content {
  display: none;
}

/* ── Header ── */
.hermes-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #0f0f23;
  border-bottom: 1px solid #2a2a4a;
  border-radius: 8px 8px 0 0;
  cursor: grab;
}

.hermes-header:active {
  cursor: grabbing;
}

.hermes-title {
  font-size: 13px;
  font-weight: 700;
  color: #4ade80;
  letter-spacing: 0.05em;
  flex: 1;
}

.hermes-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.hermes-status-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.hermes-status-badge.status-active {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
  border: 1px solid rgba(74, 222, 128, 0.3);
}

.hermes-status-badge.status-active::before {
  background: #4ade80;
  box-shadow: 0 0 4px #4ade80;
  animation: hermes-pulse 2s infinite;
}

.hermes-status-badge.status-paused {
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(251, 191, 36, 0.3);
}

.hermes-status-badge.status-paused::before {
  background: #fbbf24;
}

.hermes-status-badge.status-stopped {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.hermes-status-badge.status-stopped::before {
  background: #ef4444;
}

@keyframes hermes-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.hermes-btn-icon {
  background: transparent;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  color: #94a3b8;
  cursor: pointer;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

.hermes-btn-icon:hover {
  background: #2a2a4a;
  color: #e2e8f0;
  border-color: #4a4a6a;
}

.hermes-close-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.5);
}

/* ── Tabs ── */
.hermes-tabs {
  display: flex;
  background: #0f0f1e;
  border-bottom: 1px solid #2a2a4a;
  overflow-x: auto;
  scrollbar-width: none;
}

.hermes-tabs::-webkit-scrollbar {
  display: none;
}

.hermes-tab {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 500;
  color: #64748b;
  cursor: pointer;
  border: none;
  background: transparent;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
  position: relative;
}

.hermes-tab:hover {
  color: #94a3b8;
}

.hermes-tab.active {
  color: #4ade80;
  border-bottom-color: #4ade80;
}

/* Badge de notification sur un tab */
.hermes-tab-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ef4444;
  border: 1px solid #1a1a2e;
  display: none;
}

.hermes-tab-badge.visible {
  display: block;
}

.hermes-tab-badge.warn {
  background: #fbbf24;
}

/* ── Contenu des tabs ── */
.hermes-tab-content {
  max-height: 420px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #2a2a4a transparent;
}

.hermes-tab-content::-webkit-scrollbar {
  width: 4px;
}

.hermes-tab-content::-webkit-scrollbar-track {
  background: transparent;
}

.hermes-tab-content::-webkit-scrollbar-thumb {
  background: #2a2a4a;
  border-radius: 2px;
}

.hermes-tab-panel {
  display: none;
  padding: 12px;
}

.hermes-tab-panel.active {
  display: block;
}

/* ── Sections / Cards ── */
.hermes-section {
  margin-bottom: 12px;
}

.hermes-section:last-child {
  margin-bottom: 0;
}

.hermes-section-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #64748b;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.hermes-section-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #1e1e3a;
}

.hermes-card {
  background: #0f0f1e;
  border: 1px solid #1e1e3a;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
  transition: border-color 0.15s;
}

.hermes-card:hover {
  border-color: #2a2a4a;
}

.hermes-card:last-child {
  margin-bottom: 0;
}

.hermes-card.alert {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.05);
}

.hermes-card.warn {
  border-color: rgba(251, 191, 36, 0.4);
  background: rgba(251, 191, 36, 0.04);
}

.hermes-card.ok {
  border-color: rgba(74, 222, 128, 0.3);
}

/* ── Statistiques (grille KPI) ── */
.hermes-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}

.hermes-stat {
  background: #0f0f1e;
  border: 1px solid #1e1e3a;
  border-radius: 6px;
  padding: 8px 10px;
  text-align: center;
}

.hermes-stat-value {
  font-size: 18px;
  font-weight: 700;
  color: #4ade80;
  line-height: 1.2;
}

.hermes-stat-label {
  font-size: 9px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 2px;
}

/* ── Liste de villes ── */
.hermes-city-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 5px;
  transition: background 0.1s;
}

.hermes-city-row:hover {
  background: #1e1e3a;
}

.hermes-city-name {
  flex: 1;
  font-weight: 500;
  font-size: 12px;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hermes-city-meta {
  font-size: 10px;
  color: #64748b;
}

/* ── Badges de statut ── */
.hermes-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}

.hermes-badge.green  { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
.hermes-badge.orange { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
.hermes-badge.red    { background: rgba(239, 68, 68, 0.15);  color: #ef4444; }
.hermes-badge.gray   { background: rgba(100, 116, 139, 0.15); color: #64748b; }

/* ── Barre de progression (mood, menace) ── */
.hermes-progress {
  width: 100%;
  height: 4px;
  background: #1e1e3a;
  border-radius: 2px;
  overflow: hidden;
  margin: 4px 0;
}

.hermes-progress-bar {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.hermes-progress-bar.green  { background: #4ade80; }
.hermes-progress-bar.orange { background: #fbbf24; }
.hermes-progress-bar.red    { background: #ef4444; }

/* ── Toggle switch ── */
.hermes-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  cursor: pointer;
}

.hermes-toggle-track {
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: #2a2a4a;
  border: 1px solid #3a3a5a;
  position: relative;
  transition: background 0.2s;
  flex-shrink: 0;
}

.hermes-toggle-track.on {
  background: rgba(74, 222, 128, 0.3);
  border-color: #4ade80;
}

.hermes-toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #64748b;
  transition: transform 0.2s, background 0.2s;
}

.hermes-toggle-track.on .hermes-toggle-thumb {
  transform: translateX(16px);
  background: #4ade80;
}

.hermes-toggle-label {
  font-size: 12px;
  color: #e2e8f0;
  flex: 1;
}

/* ── Inputs et sliders ── */
.hermes-field {
  margin-bottom: 10px;
}

.hermes-label {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 4px;
}

.hermes-label-value {
  color: #4ade80;
  font-weight: 600;
}

.hermes-input {
  width: 100%;
  background: #0f0f1e;
  border: 1px solid #2a2a4a;
  border-radius: 5px;
  color: #e2e8f0;
  padding: 6px 8px;
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s;
}

.hermes-input:focus {
  border-color: #4ade80;
}

.hermes-range {
  width: 100%;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: #2a2a4a;
  outline: none;
  cursor: pointer;
}

.hermes-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #4ade80;
  cursor: pointer;
  border: 2px solid #1a1a2e;
  box-shadow: 0 0 4px rgba(74, 222, 128, 0.5);
}

.hermes-range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #4ade80;
  cursor: pointer;
  border: 2px solid #1a1a2e;
}

.hermes-select {
  width: 100%;
  background: #0f0f1e;
  border: 1px solid #2a2a4a;
  border-radius: 5px;
  color: #e2e8f0;
  padding: 6px 8px;
  font-size: 12px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s;
}

.hermes-select:focus {
  border-color: #4ade80;
}

.hermes-select option {
  background: #1a1a2e;
}

/* ── Boutons ── */
.hermes-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  line-height: 1;
}

.hermes-btn.primary {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.3);
}

.hermes-btn.primary:hover {
  background: rgba(74, 222, 128, 0.25);
  border-color: rgba(74, 222, 128, 0.5);
}

.hermes-btn.secondary {
  background: #1e1e3a;
  color: #94a3b8;
  border-color: #2a2a4a;
}

.hermes-btn.secondary:hover {
  background: #2a2a4a;
  color: #e2e8f0;
}

.hermes-btn.danger {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
}

.hermes-btn.danger:hover {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.5);
}

.hermes-btn.full-width {
  width: 100%;
}

.hermes-btn-group {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

/* ── Village row (farming) ── */
.hermes-village-row {
  padding: 8px 0;
  border-bottom: 1px solid #1e1e3a;
}

.hermes-village-row:last-child {
  border-bottom: none;
}

.hermes-village-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.hermes-village-name {
  font-size: 11px;
  color: #e2e8f0;
  font-weight: 500;
}

.hermes-village-cooldown {
  font-size: 10px;
  color: #64748b;
  font-feature-settings: 'tnum';
}

/* ── Logs ── */
.hermes-logs-container {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 10px;
  line-height: 1.5;
}

.hermes-log-entry {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(30, 30, 58, 0.5);
}

.hermes-log-time {
  color: #64748b;
  flex-shrink: 0;
}

.hermes-log-level {
  flex-shrink: 0;
  font-weight: 700;
  width: 36px;
}

.hermes-log-level.DEBUG { color: #64748b; }
.hermes-log-level.INFO  { color: #38bdf8; }
.hermes-log-level.WARN  { color: #fbbf24; }
.hermes-log-level.ERROR { color: #ef4444; }

.hermes-log-msg {
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hermes-logs-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.hermes-logs-filter {
  display: flex;
  gap: 4px;
}

.hermes-filter-btn {
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid #2a2a4a;
  background: transparent;
  color: #64748b;
  transition: background 0.1s, color 0.1s;
}

.hermes-filter-btn.active {
  background: #2a2a4a;
  color: #e2e8f0;
}

.hermes-filter-btn.active.DEBUG { color: #64748b; }
.hermes-filter-btn.active.INFO  { color: #38bdf8; }
.hermes-filter-btn.active.WARN  { color: #fbbf24; }
.hermes-filter-btn.active.ERROR { color: #ef4444; }

/* ── Recommandations (Advisor) ── */
.hermes-rec {
  background: #0f0f1e;
  border: 1px solid #1e1e3a;
  border-left: 3px solid #2a2a4a;
  border-radius: 0 6px 6px 0;
  padding: 8px 10px;
  margin-bottom: 8px;
}

.hermes-rec:last-child {
  margin-bottom: 0;
}

.hermes-rec.priority-urgent { border-left-color: #ef4444; }
.hermes-rec.priority-high   { border-left-color: #fbbf24; }
.hermes-rec.priority-medium { border-left-color: #38bdf8; }
.hermes-rec.priority-low    { border-left-color: #4a4a6a; }

.hermes-rec-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.hermes-rec-message {
  font-size: 11px;
  color: #cbd5e1;
  line-height: 1.4;
  flex: 1;
}

.hermes-rec-dismiss {
  background: transparent;
  border: none;
  color: #4a4a6a;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  flex-shrink: 0;
  transition: color 0.1s;
}

.hermes-rec-dismiss:hover {
  color: #64748b;
}

/* ── Countdown (combat) ── */
.hermes-countdown {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 14px;
  font-weight: 700;
  color: #ef4444;
  font-feature-settings: 'tnum';
}

.hermes-countdown.safe {
  color: #4ade80;
}

.hermes-countdown.warning {
  color: #fbbf24;
  animation: hermes-blink 0.8s step-end infinite;
}

@keyframes hermes-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ── Notification popup ── */
.hermes-notification {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000001;
  padding: 10px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  animation: hermes-slide-in 0.2s ease;
  max-width: 320px;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

.hermes-notification.info  { background: #1e2a4a; color: #38bdf8; border: 1px solid #2a3a6a; }
.hermes-notification.warn  { background: #2a2010; color: #fbbf24; border: 1px solid #4a3a10; }
.hermes-notification.error { background: #2a1010; color: #ef4444; border: 1px solid #4a2020; }

@keyframes hermes-slide-in {
  from { transform: translateX(110%); opacity: 0; }
  to   { transform: translateX(0);    opacity: 1; }
}

/* ── Tooltips ── */
.hermes-tooltip-wrapper {
  position: relative;
  display: inline-flex;
}

.hermes-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: #0f0f23;
  border: 1px solid #2a2a4a;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 10px;
  color: #e2e8f0;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 10;
}

.hermes-tooltip-wrapper:hover .hermes-tooltip {
  opacity: 1;
}

/* ── Séparateur ── */
.hermes-divider {
  height: 1px;
  background: #1e1e3a;
  margin: 10px 0;
}

/* ── Texte utilitaires ── */
.hermes-text-muted   { color: #64748b; font-size: 10px; }
.hermes-text-accent  { color: #4ade80; }
.hermes-text-warn    { color: #fbbf24; }
.hermes-text-danger  { color: #ef4444; }

/* ── Formulaire snipe ── */
.hermes-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hermes-form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.hermes-form-row.single {
  grid-template-columns: 1fr;
}

/* ── Indicateur de chargement ── */
.hermes-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: #64748b;
  font-size: 11px;
  gap: 8px;
}

.hermes-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid #2a2a4a;
  border-top-color: #4ade80;
  border-radius: 50%;
  animation: hermes-spin 0.8s linear infinite;
}

@keyframes hermes-spin {
  to { transform: rotate(360deg); }
}

/* ── Vide / placeholder ── */
.hermes-empty {
  padding: 16px;
  text-align: center;
  color: #64748b;
  font-size: 11px;
}
`;

  // ─── Injection ────────────────────────────────────────────────────────────────

  /**
   * Injecte les styles CSS du panneau Hermes dans le DOM.
   * Idempotent : si les styles sont déjà présents, ne fait rien.
   */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return; // Déjà injecté
    }

    // GM_addStyle bypasse le CSP de Grepolis (injecté par Tampermonkey lui-même).
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(CSS);
      // Marqueur pour éviter la double injection
      const marker = document.createElement('meta');
      marker.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(marker);
      return;
    }

    // Fallback : injection manuelle via <style> dans <head> ou <html>
    const style = document.createElement('style');
    style.id    = STYLE_ID;
    style.type  = 'text/css';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * Retire les styles injectés du DOM.
   * Appelé lors du destroy du dashboard.
   */
  function removeStyles() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
  }

  /**
   * ui/dashboard.js — Dashboard Hermes : panneau de contrôle flottant
   *
   * Interface complète d'Hermes injectée dans le DOM de Grepolis.
   * Panneau HTML flottant, draggable, avec 6 tabs :
   *   Overview | Farm | Build | Combat | Advisor | Logs
   *
   * Réactivité : le dashboard s'abonne aux events Hermes et se met à jour automatiquement.
   * Il est le SEUL module qui manipule le DOM.
   *
   * Architecture :
   * - buildHTML()           → génère la structure HTML complète
   * - setupDrag()           → gestion du drag (mousedown/mousemove/mouseup)
   * - setupEventListeners() → listeners UI (tabs, toggles, boutons)
   * - subscribeToEvents()   → souscription aux events Hermes pour réactivité
   * - Renderers par tab     → renderOverview(), renderFarm(), etc.
   */


  // ─── Constantes ───────────────────────────────────────────────────────────────

  const PANEL_ID       = 'hermes-panel';
  const NOTIF_DURATION = 3500; // ms d'affichage des notifications

  /** Ordre des tabs */
  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'farm',     label: 'Farm'     },
    { id: 'build',    label: 'Build'    },
    { id: 'combat',   label: 'Combat'   },
    { id: 'advisor',  label: 'Advisor'  },
    { id: 'logs',     label: 'Logs'     },
  ];

  // ─── État interne ─────────────────────────────────────────────────────────────

  let _activeTab      = 'overview';
  let _isMinimized    = false;
  let _panelEl        = null;
  let _notifTimeout   = null;

  /** Ring buffer des 50 derniers logs affichés */
  const _logBuffer    = [];
  const LOG_BUFFER_MAX = 50;

  /** Filtre de niveau de log actif dans l'onglet Logs */
  let _logFilter      = 'ALL';

  /** Map<snipeId, { countdown: HTMLElement, arrivalMs: number, timerHandle }> */
  const _snipeCountdowns  = new Map();

  /** Unsubscribers pour cleanup */
  const _subs = [];

  // ─── HTML Builder ─────────────────────────────────────────────────────────────

  /**
   * Génère la structure HTML complète du panneau.
   * @returns {string} HTML string
   */
  function buildHTML() {
    const tabButtons = TABS.map((t) => `
    <button class="hermes-tab${t.id === _activeTab ? ' active' : ''}" data-tab="${t.id}">
      ${t.label}
      <span class="hermes-tab-badge" data-badge="${t.id}"></span>
    </button>
  `).join('');

    const tabPanels = TABS.map((t) => `
    <div class="hermes-tab-panel${t.id === _activeTab ? ' active' : ''}" id="hermes-tab-${t.id}">
      <div class="hermes-loading"><div class="hermes-spinner"></div>Chargement…</div>
    </div>
  `).join('');

    return `
    <div class="hermes-panel" id="${PANEL_ID}">
      <div class="hermes-header">
        <span class="hermes-title">⚡ HERMES</span>
        <span class="hermes-status-badge status-active" id="hermes-status-badge">ACTIF</span>
        <button class="hermes-btn-icon hermes-minimize-btn" id="hermes-minimize-btn" title="Réduire">−</button>
        <button class="hermes-btn-icon hermes-close-btn" id="hermes-close-btn" title="Arrêter Hermes">×</button>
      </div>
      <div class="hermes-tabs" id="hermes-tabs-bar">
        ${tabButtons}
      </div>
      <div class="hermes-tab-content" id="hermes-tab-content">
        ${tabPanels}
      </div>
    </div>
  `;
  }

  // ─── Helpers DOM ──────────────────────────────────────────────────────────────

  /** @param {string} id @returns {HTMLElement|null} */
  const $ = (id)       => document.getElementById(id);
  /** @param {string} sel @param {Element} [root] @returns {HTMLElement|null} */
  const $q  = (sel, root = document) => root.querySelector(sel);
  /** @param {string} sel @param {Element} [root] @returns {NodeListOf<Element>} */
  const $qa = (sel, root = document) => root.querySelectorAll(sel);

  /**
   * Formate un timestamp ms en HH:MM:SS restant.
   * @param {number} ms
   * @returns {string}
   */
  function formatCountdown(ms) {
    if (ms <= 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = s % 60;
    return [h, m, sc].map((v) => String(v).padStart(2, '0')).join(':');
  }

  /**
   * Formate un timestamp ms en HH:MM:SS (heure absolue).
   * @param {number} ms - Timestamp unix ms
   * @returns {string}
   */
  function formatTime(ms) {
    return new Date(ms).toTimeString().slice(0, 8);
  }

  // ─── Renderers des tabs ───────────────────────────────────────────────────────

  /**
   * Rend le contenu de l'onglet Overview.
   */
  function renderOverview() {
    const panel = $('hermes-tab-overview');
    if (!panel) return;

    let cities = [];
    try { cities = bridge.getCities(); } catch { /* no-op */ }

    const state  = storage.getState();
    const config = storage.getConfig();

    const efficiency  = Math.round(config.efficiency * 100);
    const cityCount   = cities.length;
    const actionsN    = state.actionsThisSession ?? 0;
    const masterOn    = config.enabled;

    const cityRows = cities.map((city) => `
    <div class="hermes-city-row">
      <span class="hermes-city-name">${escHtml(city.name)}</span>
      <span class="hermes-city-meta">${city.x}:${city.y}</span>
      <span class="hermes-badge gray" data-threat-badge="${city.id}">−</span>
    </div>
  `).join('') || `<div class="hermes-empty">Aucune ville détectée</div>`;

    panel.innerHTML = `
    <div class="hermes-stats-grid">
      <div class="hermes-stat">
        <div class="hermes-stat-value">${efficiency}%</div>
        <div class="hermes-stat-label">Efficacité</div>
      </div>
      <div class="hermes-stat">
        <div class="hermes-stat-value">${cityCount}</div>
        <div class="hermes-stat-label">Villes</div>
      </div>
      <div class="hermes-stat">
        <div class="hermes-stat-value">${actionsN}</div>
        <div class="hermes-stat-label">Actions</div>
      </div>
    </div>

    <div class="hermes-section">
      <div class="hermes-toggle" id="hermes-master-toggle">
        <div class="hermes-toggle-track${masterOn ? ' on' : ''}" id="hermes-toggle-track">
          <div class="hermes-toggle-thumb"></div>
        </div>
        <span class="hermes-toggle-label">Hermes ${masterOn ? 'actif' : 'en pause'}</span>
      </div>
    </div>

    <div class="hermes-section">
      <div class="hermes-section-title">Villes</div>
      ${cityRows}
    </div>

    <div class="hermes-section">
      <div class="hermes-field">
        <div class="hermes-label">
          <span>Efficacité</span>
          <span class="hermes-label-value" id="eff-display">${efficiency}%</span>
        </div>
        <input type="range" class="hermes-range" id="hermes-efficiency-range"
          min="10" max="95" step="1" value="${efficiency}">
      </div>
    </div>
  `;

    // Master toggle listener
    const toggle = $('hermes-master-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const cfg = storage.getConfig();
        storage.updateConfig({ enabled: !cfg.enabled });
        renderOverview();
        updateStatusBadge();
      });
    }

    // Efficiency slider
    const range = $('hermes-efficiency-range');
    if (range) {
      range.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const display = $('eff-display');
        if (display) display.textContent = `${val}%`;
        storage.updateConfig({ efficiency: val / 100 });
      });
    }
  }

  /**
   * Rend le contenu de l'onglet Farm.
   */
  function renderFarm() {
    const panel = $('hermes-tab-farm');
    if (!panel) return;

    let cities = [];
    try { cities = bridge.getCities(); } catch { /* no-op */ }

    if (cities.length === 0) {
      panel.innerHTML = '<div class="hermes-empty">Aucune ville détectée</div>';
      return;
    }

    const cityBlocks = cities.map((city) => {
      let villages = [];
      try { villages = bridge.getFarmingVillages(city.id); } catch { /* no-op */ }

      const villageRows = villages.map((v) => {
        const moodColor  = v.mood >= 80 ? 'green' : v.mood >= 60 ? 'orange' : 'red';
        const moodPct    = Math.max(0, Math.min(100, v.mood));
        const cdLeft     = v.cooldownRemaining ?? 0;
        const cdDisplay  = cdLeft > 0 ? formatCountdown(cdLeft) : '—';

        return `
        <div class="hermes-village-row" data-village-id="${v.id}">
          <div class="hermes-village-header">
            <span class="hermes-village-name">${escHtml(v.name)}</span>
            <span class="hermes-village-cooldown" data-cooldown="${v.id}">${cdDisplay}</span>
          </div>
          <div class="hermes-progress">
            <div class="hermes-progress-bar ${moodColor}" style="width:${moodPct}%"></div>
          </div>
          <div class="hermes-text-muted">Mood: ${v.mood}% · Wood: ${v.resources?.wood ?? 0} Stone: ${v.resources?.stone ?? 0}</div>
        </div>
      `;
      }).join('') || `<div class="hermes-text-muted" style="padding:6px 0">Aucun village</div>`;

      return `
      <div class="hermes-card">
        <div class="hermes-section-title">${escHtml(city.name)}</div>
        ${villageRows}
      </div>
    `;
    }).join('');

    panel.innerHTML = `
    <div class="hermes-section">
      ${cityBlocks}
    </div>
    <div class="hermes-btn-group">
      <button class="hermes-btn secondary full-width" id="hermes-farm-force">
        Forcer un cycle
      </button>
    </div>
  `;

    $('hermes-farm-force')?.addEventListener('click', () => {
      hermes.emit('farm:forceCycle', {});
      dashboard.showNotification('Cycle forcé lancé', 'info');
    });
  }

  /**
   * Rend le contenu de l'onglet Build.
   */
  function renderBuild() {
    const panel = $('hermes-tab-build');
    if (!panel) return;

    let cities = [];
    try { cities = bridge.getCities(); } catch { /* no-op */ }

    if (cities.length === 0) {
      panel.innerHTML = '<div class="hermes-empty">Aucune ville détectée</div>';
      return;
    }

    const cityCards = cities.map((city) => {
      const nextQ = city.queue?.[0];
      const nextStep = nextQ
        ? `${nextQ.building} → lv${nextQ.level} (fin: ${formatTime(nextQ.completesAt * 1000)})`
        : 'File vide';

      const templateOptions = [
        { id: 'auto',               label: 'Automatique' },
        { id: 'colony_rush_speed3', label: 'Colony Rush x3' },
        { id: 'colony_rush_speed1', label: 'Colony Rush x1' },
        { id: 'offense_speed3',     label: 'Offense x3' },
        { id: 'defense_city',       label: 'Défense' },
        { id: 'commerce_city',      label: 'Commerce' },
      ].map((t) => `<option value="${t.id}">${t.label}</option>`).join('');

      return `
      <div class="hermes-card">
        <div class="hermes-section-title">${escHtml(city.name)}</div>
        <div class="hermes-text-muted" style="margin-bottom:6px">Prochain: ${escHtml(nextStep)}</div>
        <div class="hermes-field">
          <div class="hermes-label"><span>Template actif</span></div>
          <select class="hermes-select" data-city-id="${city.id}">
            ${templateOptions}
          </select>
        </div>
      </div>
    `;
    }).join('');

    panel.innerHTML = cityCards;

    // Listeners template change
    for (const sel of $qa('.hermes-select[data-city-id]', panel)) {
      sel.addEventListener('change', (e) => {
        hermes.emit('build:setTemplate', {
          cityId:     e.target.dataset.cityId,
          templateId: e.target.value,
        });
      });
    }
  }

  /**
   * Rend le contenu de l'onglet Combat.
   */
  function renderCombat() {
    const panel = $('hermes-tab-combat');
    if (!panel) return;

    let attacks = [];
    try { attacks = bridge.getIncomingAttacks(); } catch { /* no-op */ }

    const attackRows = attacks.map((atk) => {
      const msLeft   = Math.max(0, atk.arrivalTime * 1000 - Date.now());
      const cdClass  = msLeft < 5 * 60 * 1000 ? 'warning' : msLeft < 15 * 60 * 1000 ? 'warning' : 'safe';
      return `
      <div class="hermes-card alert">
        <div class="hermes-village-header">
          <span class="hermes-text-muted">Ville ${atk.toCityId}</span>
          <span class="hermes-countdown ${cdClass}" data-attack-countdown="${atk.id}">
            ${formatCountdown(msLeft)}
          </span>
        </div>
        <div class="hermes-text-muted">Depuis ville ${atk.fromCityId}</div>
      </div>
    `;
    }).join('') || `<div class="hermes-empty">Aucune attaque entrante</div>`;

    let cities = [];
    try { cities = bridge.getCities(); } catch { /* no-op */ }

    const cityOptions = cities.map((c) =>
      `<option value="${c.id}">${escHtml(c.name)}</option>`
    ).join('');

    panel.innerHTML = `
    <div class="hermes-section">
      <div class="hermes-section-title">Attaques entrantes</div>
      ${attackRows}
    </div>

    <div class="hermes-section">
      <div class="hermes-section-title">Ajouter un snipe</div>
      <div class="hermes-card">
        <div class="hermes-form">
          <div class="hermes-form-row">
            <div class="hermes-field">
              <div class="hermes-label"><span>Ville cible</span></div>
              <select class="hermes-select" id="snipe-city">
                ${cityOptions}
              </select>
            </div>
            <div class="hermes-field">
              <div class="hermes-label"><span>Ville source</span></div>
              <select class="hermes-select" id="snipe-source">
                ${cityOptions}
              </select>
            </div>
          </div>
          <div class="hermes-form-row single">
            <div class="hermes-field">
              <div class="hermes-label"><span>Arrivée CS (HH:MM:SS)</span></div>
              <input type="text" class="hermes-input" id="snipe-arrival" placeholder="23:59:00">
            </div>
          </div>
          <button class="hermes-btn primary full-width" id="hermes-add-snipe">
            + Ajouter snipe
          </button>
        </div>
      </div>
    </div>

    <div class="hermes-section" id="hermes-snipes-list">
      <div class="hermes-section-title">Snipes actifs</div>
      <div class="hermes-empty">Aucun snipe configuré</div>
    </div>
  `;

    // Listener ajout snipe
    $('hermes-add-snipe')?.addEventListener('click', () => {
      const cityId   = $('snipe-city')?.value;
      const sourceId = $('snipe-source')?.value;
      const arrival  = $('snipe-arrival')?.value?.trim();

      if (!cityId || !arrival) {
        dashboard.showNotification('Remplissez la ville cible et l\'heure d\'arrivée', 'warn');
        return;
      }

      // Parser l'heure HH:MM:SS en timestamp ms
      const today  = new Date();
      const [h, m, s] = arrival.split(':').map(Number);
      const arrivalMs = new Date(
        today.getFullYear(), today.getMonth(), today.getDate(), h, m, s
      ).getTime();

      const snipeId = `snipe_${Date.now()}`;
      hermes.emit('combat:snipe:add', { snipeId, cityId, sourceCityId: sourceId, arrivalMs });
      renderSnipe(snipeId, cityId, arrivalMs);
    });

    // Démarrer les countdowns des attaques existantes
    startAttackCountdowns(attacks);
  }

  /**
   * Ajoute un snipe dans la liste UI et démarre son countdown.
   * @param {string} snipeId
   * @param {string|number} cityId
   * @param {number} arrivalMs
   */
  function renderSnipe(snipeId, cityId, arrivalMs) {
    const list = $('hermes-snipes-list');
    if (!list) return;

    // Retirer le placeholder "Aucun snipe"
    const empty = $q('.hermes-empty', list);
    if (empty) empty.remove();

    const card = document.createElement('div');
    card.className = 'hermes-card';
    card.id        = `snipe-card-${snipeId}`;
    card.innerHTML = `
    <div class="hermes-village-header">
      <span class="hermes-text-muted">Ville ${cityId}</span>
      <span class="hermes-countdown" id="snipe-cd-${snipeId}">
        ${formatCountdown(arrivalMs - Date.now())}
      </span>
    </div>
    <button class="hermes-btn danger" style="margin-top:4px" data-snipe-id="${snipeId}">Annuler</button>
  `;
    list.appendChild(card);

    // Bouton annulation
    card.querySelector(`[data-snipe-id]`)?.addEventListener('click', () => {
      hermes.emit('combat:snipe:cancel', { snipeId });
      card.remove();
      if (_snipeCountdowns.has(snipeId)) {
        clearInterval(_snipeCountdowns.get(snipeId).handle);
        _snipeCountdowns.delete(snipeId);
      }
    });

    // Countdown
    const cdEl  = $(`snipe-cd-${snipeId}`);
    const handle = setInterval(() => {
      const left = arrivalMs - Date.now();
      if (cdEl) {
        cdEl.textContent = formatCountdown(left);
        cdEl.className   = `hermes-countdown${left < 60000 ? ' warning' : left < 300000 ? '' : ' safe'}`;
      }
      hermes.emit('combat:snipe:countdown', { snipeId, secondsLeft: Math.max(0, Math.floor(left / 1000)) });
      if (left <= 0) {
        clearInterval(handle);
        _snipeCountdowns.delete(snipeId);
        card.remove();
      }
    }, 500);

    _snipeCountdowns.set(snipeId, { handle, arrivalMs });
  }

  /**
   * Démarre les countdowns pour les attaques entrantes affichées.
   * @param {import('../bridge.js').Attack[]} attacks
   */
  function startAttackCountdowns(attacks) {
    for (const atk of attacks) {
      const el = $q(`[data-attack-countdown="${atk.id}"]`);
      if (!el) continue;
      const handle = setInterval(() => {
        const left = Math.max(0, atk.arrivalTime * 1000 - Date.now());
        if (el) {
          el.textContent = formatCountdown(left);
          el.className   = `hermes-countdown${left < 5 * 60 * 1000 ? ' warning' : ' safe'}`;
        }
        if (left <= 0) clearInterval(handle);
      }, 500);
    }
  }

  /**
   * Rend le contenu de l'onglet Advisor.
   */
  function renderAdvisor() {
    const panel = $('hermes-tab-advisor');
    if (!panel) return;

    let cities = [];
    try { cities = bridge.getCities(); } catch { /* no-op */ }

    // Récupérer les recs via l'event (l'advisor peut ne pas être importé directement)
    // On utilise un cache local mis à jour par les events
    const worldSummary = _cachedWorldSummary || 'Monde non détecté';

    const cityBlocks = cities.map((city) => {
      const score  = _cachedScores.get(String(city.id)) ?? 0;
      const recs   = _cachedRecs.get(String(city.id)) ?? [];
      const spec   = _cachedSpecs.get(String(city.id)) ?? '—';
      const scoreColor = score > 70 ? 'red' : score > 40 ? 'orange' : 'green';

      const recItems = recs.map((rec) => `
      <div class="hermes-rec priority-${rec.priority}" data-rec-id="${rec.id}">
        <div class="hermes-rec-header">
          <span class="hermes-rec-message">${escHtml(rec.message)}</span>
          <button class="hermes-rec-dismiss" data-dismiss="${rec.id}">×</button>
        </div>
        ${rec.actions?.length ? `
          <div class="hermes-btn-group">
            ${rec.actions.map((a) => `
              <button class="hermes-btn secondary" data-action-event="${a.event}" data-action-data='${JSON.stringify(a.data ?? {})}'>
                ${escHtml(a.label)}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `).join('') || `<div class="hermes-text-muted" style="padding:6px 0">Aucune recommandation</div>`;

      return `
      <div class="hermes-card">
        <div class="hermes-village-header">
          <div>
            <div class="hermes-section-title" style="margin-bottom:2px">${escHtml(city.name)}</div>
            <div class="hermes-text-muted">Spé: ${escHtml(spec)}</div>
          </div>
          <span class="hermes-badge ${scoreColor}">Menace: ${Math.round(score)}</span>
        </div>
        <div class="hermes-progress" style="margin:6px 0">
          <div class="hermes-progress-bar ${scoreColor}" style="width:${Math.round(score)}%"></div>
        </div>
        ${recItems}
      </div>
    `;
    }).join('') || `<div class="hermes-empty">Aucune ville détectée</div>`;

    panel.innerHTML = `
    <div class="hermes-card" style="margin-bottom:12px">
      <div class="hermes-text-muted">${escHtml(worldSummary)}</div>
    </div>
    ${cityBlocks}
  `;

    // Listeners dismiss recs
    for (const btn of $qa('[data-dismiss]', panel)) {
      btn.addEventListener('click', (e) => {
        const recId = btn.dataset.dismiss;
        hermes.emit('advisor:dismiss', { recId });
        btn.closest('.hermes-rec')?.remove();
      });
    }

    // Listeners boutons d'action des recs
    for (const btn of $qa('[data-action-event]', panel)) {
      btn.addEventListener('click', () => {
        try {
          const eventName = btn.dataset.actionEvent;
          const data      = JSON.parse(btn.dataset.actionData || '{}');
          hermes.emit(eventName, data);
          dashboard.showNotification('Action envoyée', 'info');
        } catch { /* no-op */ }
      });
    }
  }

  /**
   * Rend le contenu de l'onglet Logs.
   */
  function renderLogs() {
    const panel = $('hermes-tab-logs');
    if (!panel) return;

    const levels   = ['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
    const filterBtns = levels.map((l) => `
    <button class="hermes-filter-btn ${l} ${_logFilter === l ? 'active' : ''}" data-level="${l}">${l}</button>
  `).join('');

    const filtered = _logFilter === 'ALL'
      ? _logBuffer
      : _logBuffer.filter((e) => e.level === _logFilter);

    const logRows = filtered.map((entry) => {
      const ts  = new Date(entry.timestamp).toTimeString().slice(0, 8);
      return `
      <div class="hermes-log-entry">
        <span class="hermes-log-time">${ts}</span>
        <span class="hermes-log-level ${entry.level}">${entry.level}</span>
        <span class="hermes-log-msg">${escHtml(entry.message)}</span>
      </div>
    `;
    }).reverse().join('') || `<div class="hermes-empty">Aucun log</div>`;

    panel.innerHTML = `
    <div class="hermes-logs-toolbar">
      <div class="hermes-logs-filter">${filterBtns}</div>
      <button class="hermes-btn secondary" style="margin-left:auto" id="hermes-logs-clear">Effacer</button>
    </div>
    <div class="hermes-logs-container">${logRows}</div>
  `;

    // Listeners filtres
    for (const btn of $qa('.hermes-filter-btn', panel)) {
      btn.addEventListener('click', () => {
        _logFilter = btn.dataset.level;
        renderLogs();
      });
    }

    $('hermes-logs-clear')?.addEventListener('click', () => {
      _logBuffer.length = 0;
      hermes.log.getAll?.()?.forEach?.(() => {});
      renderLogs();
    });
  }

  // ─── Cache réactif ────────────────────────────────────────────────────────────

  /**
   * Cache des données utilisées par les renderers, mis à jour par les events.
   * Permet de ne pas re-fetch le bridge à chaque render.
   */
  const _cachedScores = new Map();
  const _cachedRecs   = new Map();
  const _cachedSpecs  = new Map();
  let   _cachedWorldSummary = '';

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Échappe le HTML pour éviter les injections.
   * @param {*} str
   * @returns {string}
   */
  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/'/g, '&quot;');
  }

  /**
   * Met à jour le badge de statut global dans le header.
   */
  function updateStatusBadge() {
    const badge = $('hermes-status-badge');
    if (!badge) return;
    const config = storage.getConfig();
    if (!hermes.isRunning) {
      badge.className    = 'hermes-status-badge status-stopped';
      badge.textContent  = 'ARRÊTÉ';
    } else if (!config.enabled) {
      badge.className    = 'hermes-status-badge status-paused';
      badge.textContent  = 'EN PAUSE';
    } else {
      badge.className    = 'hermes-status-badge status-active';
      badge.textContent  = 'ACTIF';
    }
  }

  /**
   * Affiche ou met à jour le badge de notification sur un tab.
   * @param {'combat'|'advisor'|'logs'} tabId
   * @param {'red'|'warn'} [type='red']
   */
  function setBadge(tabId, type = 'red') {
    const badge = $q(`[data-badge="${tabId}"]`);
    if (!badge) return;
    badge.className = `hermes-tab-badge visible${type === 'warn' ? ' warn' : ''}`;
  }

  /**
   * Efface le badge de notification d'un tab.
   * @param {string} tabId
   */
  function clearBadge(tabId) {
    const badge = $q(`[data-badge="${tabId}"]`);
    if (badge) badge.className = 'hermes-tab-badge';
  }

  // ─── Drag ─────────────────────────────────────────────────────────────────────

  /**
   * Configure le drag du panneau via mousedown/mousemove/mouseup.
   * Persiste la position dans storage.
   */
  function setupDrag() {
    const header = $q('.hermes-header', _panelEl);
    if (!header) return;

    let isDragging = false;
    let startX, startY, origLeft, origTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return; // Ne pas drag en cliquant sur un bouton
      isDragging = true;
      startX     = e.clientX;
      startY     = e.clientY;
      const rect = _panelEl.getBoundingClientRect();
      origLeft   = rect.left;
      origTop    = rect.top;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx  = e.clientX - startX;
      const dy  = e.clientY - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - _panelEl.offsetWidth,  origLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - _panelEl.offsetHeight, origTop  + dy));
      _panelEl.style.left   = `${newLeft}px`;
      _panelEl.style.top    = `${newTop}px`;
      _panelEl.style.right  = 'auto';
      _panelEl.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      document.body.style.userSelect = '';
      // Persister la position
      try {
        const rect = _panelEl.getBoundingClientRect();
        storage.updateState({ panelPosition: { left: rect.left, top: rect.top } });
      } catch { /* no-op */ }
    });
  }

  /**
   * Restaure la position persistée du panneau.
   */
  function restorePosition() {
    try {
      const state = storage.getState();
      const pos   = state.panelPosition;
      if (pos && typeof pos.left === 'number') {
        _panelEl.style.left   = `${pos.left}px`;
        _panelEl.style.top    = `${pos.top}px`;
        _panelEl.style.right  = 'auto';
      }
    } catch { /* no-op */ }
  }

  // ─── Event listeners UI ───────────────────────────────────────────────────────

  /**
   * Configure les listeners des contrôles principaux du panneau.
   */
  function setupEventListeners() {
    // Bouton minimize
    $('hermes-minimize-btn')?.addEventListener('click', () => {
      _isMinimized = !_isMinimized;
      _panelEl.classList.toggle('hermes-minimized', _isMinimized);
      $('hermes-minimize-btn').textContent = _isMinimized ? '+' : '−';
    });

    // Bouton fermer (stopper Hermes)
    $('hermes-close-btn')?.addEventListener('click', () => {
      hermes.emit('hermes:stopRequested', {});
      hermes.stop().catch(() => {});
      dashboard.destroy();
    });

    // Tabs
    for (const btn of $qa('.hermes-tab', _panelEl)) {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        dashboard.switchTab(tabId);
      });
    }
  }

  // ─── Souscriptions aux events Hermes ─────────────────────────────────────────

  /**
   * Souscrit aux events Hermes pour mettre à jour le dashboard de manière réactive.
   */
  function subscribeToEvents() {
    // Logs
    _subs.push(hermes.on('hermes:log', (entry) => {
      _logBuffer.push(entry);
      if (_logBuffer.length > LOG_BUFFER_MAX) _logBuffer.shift();
      if (_activeTab === 'logs') renderLogs();
      if (entry.level === 'WARN' || entry.level === 'ERROR') setBadge('logs', 'warn');
    }));

    // Farm updates
    _subs.push(hermes.on('farm:action', ({ cityId, villageId }) => {
      if (_activeTab === 'farm') renderFarm();
    }));

    // Build updates
    _subs.push(hermes.on('build:queued', ({ cityId }) => {
      if (_activeTab === 'build') renderBuild();
    }));

    // Situation updates
    _subs.push(hermes.on('situation:updated', ({ cityId, threatScore }) => {
      _cachedScores.set(String(cityId), threatScore);
      if (_activeTab === 'overview') {
        const badge = $q(`[data-threat-badge="${cityId}"]`);
        if (badge) {
          const color = threatScore > 70 ? 'red' : threatScore > 40 ? 'orange' : 'green';
          badge.className   = `hermes-badge ${color}`;
          badge.textContent = Math.round(threatScore);
        }
      }
      if (_activeTab === 'advisor') renderAdvisor();
    }));

    // Alert situation → badge rouge sur la ville dans overview
    _subs.push(hermes.on('situation:alert', ({ cityId }) => {
      const badge = $q(`[data-threat-badge="${cityId}"]`);
      if (badge) { badge.className = 'hermes-badge red'; }
      if (_activeTab !== 'combat') setBadge('combat');
    }));

    // Recommandations advisor
    _subs.push(hermes.on('advisor:recommendation', ({ cityId, type, message, priority, actions }) => {
      const existing = _cachedRecs.get(String(cityId)) ?? [];
      existing.unshift({ id: `rec_live_${Date.now()}`, type, message, priority, actions: actions ?? [] });
      _cachedRecs.set(String(cityId), existing.slice(0, 10));
      setBadge('advisor', 'warn');
      if (_activeTab === 'advisor') renderAdvisor();
    }));

    // World profile
    _subs.push(hermes.on('world:profile', ({ profile, worldKey }) => {
      const speed  = Math.round(profile?.speed ?? 1);
      const system = profile?.system === 'revolt' ? 'Révolte' : 'Conquête';
      _cachedWorldSummary = `Monde Speed ${speed}, ${system}, WW: ${profile?.ww ? 'Oui' : 'Non'}, Morale: ${profile?.morale ? 'Oui' : 'Non'}`;
      if (_activeTab === 'advisor') renderAdvisor();
    }));

    // Combat alerts
    _subs.push(hermes.on('combat:alert', ({ attack }) => {
      setBadge('combat');
      if (_activeTab === 'combat') renderCombat();
      dashboard.showNotification(`Attaque entrante ! Ville ${attack?.toCityId ?? '?'}`, 'error');
    }));

    // Snipe countdowns (reçus d'autres sources que la UI)
    _subs.push(hermes.on('combat:snipe:countdown', ({ snipeId, secondsLeft }) => {
      const rec = _snipeCountdowns.get(snipeId);
      if (rec) {
        const el = $(`snipe-cd-${snipeId}`);
        if (el) {
          el.textContent = formatCountdown(secondsLeft * 1000);
          el.className   = `hermes-countdown${secondsLeft < 60 ? ' warning' : secondsLeft < 300 ? '' : ' safe'}`;
        }
      }
    }));

    // Hermes ready
    _subs.push(hermes.on('hermes:ready', () => {
      updateStatusBadge();
      renderActiveTab();
    }));

    // Villes trouvées via XHR → refresh immédiat
    _subs.push(hermes.on('hermes:cities:ready', ({ count }) => {
      console.log(`[HERMES] ${count} ville(s) capturée(s) via AJAX — refresh dashboard`);
      renderActiveTab();
    }));

    // Hermes stopped
    _subs.push(hermes.on('hermes:stopped', () => {
      updateStatusBadge();
    }));
  }

  // ─── Render dispatch ──────────────────────────────────────────────────────────

  /**
   * Rend le contenu du tab actif.
   */
  function renderActiveTab() {
    switch (_activeTab) {
      case 'overview': renderOverview(); break;
      case 'farm':     renderFarm();     break;
      case 'build':    renderBuild();    break;
      case 'combat':   renderCombat();   break;
      case 'advisor':  renderAdvisor();  break;
      case 'logs':     renderLogs();     break;
    }
  }

  // ─── Interface publique ───────────────────────────────────────────────────────

  /**
   * Dashboard Hermes — panneau de contrôle flottant.
   */
  const dashboard = {

    /**
     * Initialise le dashboard : injecte le HTML et les styles, configure les listeners.
     */
    init() {
      // Ne pas injecter deux fois
      if (document.getElementById(PANEL_ID)) {
        hermes.log.warn('Dashboard: déjà injecté — init() ignoré');
        return;
      }

      console.log(
        '%c[HERMES] ⚡ Démarrage dashboard…',
        'color:#4ade80;font-weight:bold;font-size:14px;background:#1a1a2e;padding:4px 8px;border-radius:4px'
      );

      injectStyles();

      // Injecter le HTML du panneau
      const wrapper     = document.createElement('div');
      wrapper.innerHTML = buildHTML().trim();
      _panelEl          = wrapper.firstElementChild;

      if (!_panelEl) {
        console.error('[HERMES] buildHTML() a retourné un élément null — abandon');
        return;
      }

      // Appliquer les styles inline critiques pour survivre aux CSS de Grepolis.
      // position:fixed peut être cassé si Grepolis applique transform sur body —
      // on injecte dans <html> pour éviter ce problème.
      _panelEl.style.cssText = [
        'position:fixed !important',
        'top:60px !important',
        'right:16px !important',
        'z-index:2147483647 !important',
        'width:380px !important',
        'display:block !important',
        'visibility:visible !important',
        'opacity:1 !important',
        'pointer-events:auto !important',
      ].join(';');

      // Injection dans <html> (pas dans <body>) pour éviter que transform/filter
      // de Grepolis ne brise position:fixed.
      (document.documentElement || document.body).appendChild(_panelEl);

      console.log('[HERMES] Panel injecté dans le DOM :', _panelEl);

      restorePosition();
      setupDrag();
      setupEventListeners();
      subscribeToEvents();

      // Raccourci Ctrl+Shift+H pour afficher/masquer le panel
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'H') {
          e.preventDefault();
          const p = document.getElementById(PANEL_ID);
          if (p) {
            p.style.display = p.style.display === 'none' ? 'block' : 'none';
            console.log('[HERMES] Panel togglé — Ctrl+Shift+H');
          }
        }
      });

      // Initialiser les logs depuis le buffer existant
      try {
        const existingLogs = hermes.log.getAll?.() ?? [];
        for (const entry of existingLogs) {
          _logBuffer.push(entry);
        }
        while (_logBuffer.length > LOG_BUFFER_MAX) _logBuffer.shift();
      } catch { /* no-op */ }

      // Render initial
      renderActiveTab();
      updateStatusBadge();

      hermes.log.info('Dashboard: injecté');
      console.log('%c[HERMES] ✅ Panel prêt — Ctrl+Shift+H pour masquer/afficher', 'color:#4ade80;font-weight:bold');

      // Notification système Tampermonkey — visible SANS F12 (confirme que le script tourne).
      if (typeof GM_notification === 'function') {
        GM_notification({
          title:   '⚡ Hermes opérationnel',
          text:    'Le panneau Hermes est actif en haut à droite de l\'écran.',
          timeout: 5000,
        });
      }

      // Watchdog : Grepolis peut remplacer le DOM après chargement.
      // On vérifie toutes les 2 secondes et on réinjecte si le panel a disparu.
      const _watchdogId = setInterval(() => {
        if (!document.getElementById(PANEL_ID) && _panelEl) {
          try {
            hermes.log.warn('Dashboard: panel disparu, réinjection…');
            (document.documentElement || document.body).appendChild(_panelEl);
            injectStyles();
          } catch { /* no-op */ }
        }
      }, 2000);

      // Nettoyer le watchdog au destroy
      _subs.push(() => clearInterval(_watchdogId));

      // Auto-refresh : poll toutes les 5s jusqu'à trouver des villes (max 3 min).
      // Corrige le problème de timing : Grepolis charge ses données après le boot Hermes.
      let _cityPollAttempts = 0;
      const _cityPollId = setInterval(() => {
        _cityPollAttempts++;
        let found = 0;
        try { found = bridge.getCities().length; } catch { /* no-op */ }
        if (found > 0) {
          clearInterval(_cityPollId);
          console.log(`[HERMES] ${found} ville(s) détectée(s) après ${_cityPollAttempts * 5}s`);
          renderActiveTab();
        } else if (_cityPollAttempts >= 36) {
          clearInterval(_cityPollId);
          console.warn('[HERMES] Timeout détection villes — bridge.probe() pour diagnostiquer');
        }
      }, 5_000);
      _subs.push(() => clearInterval(_cityPollId));
    },

    /**
     * Retire le panneau du DOM et nettoie les resources.
     */
    destroy() {
      for (const unsub of _subs) unsub();
      _subs.length = 0;

      // Nettoyer les countdowns snipe
      for (const [, rec] of _snipeCountdowns) {
        clearInterval(rec.handle);
      }
      _snipeCountdowns.clear();

      if (_panelEl) {
        _panelEl.remove();
        _panelEl = null;
      }

      if (_notifTimeout) {
        clearTimeout(_notifTimeout);
        _notifTimeout = null;
      }

      removeStyles();
      hermes.log.info('Dashboard: détruit');
    },

    /** Affiche le panneau. */
    show() {
      if (_panelEl) _panelEl.classList.remove('hermes-hidden');
    },

    /** Cache le panneau. */
    hide() {
      if (_panelEl) _panelEl.classList.add('hermes-hidden');
    },

    /** Bascule la visibilité du panneau. */
    toggle() {
      if (_panelEl) _panelEl.classList.toggle('hermes-hidden');
    },

    /**
     * Retourne le tab actuellement actif.
     * @returns {string}
     */
    getActiveTab() {
      return _activeTab;
    },

    /**
     * Bascule vers un tab spécifique.
     * @param {string} tabId - Un des TABS.id
     */
    switchTab(tabId) {
      if (!TABS.find((t) => t.id === tabId)) return;

      // Mise à jour CSS des tabs
      for (const btn of $qa('.hermes-tab', _panelEl)) {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      }
      for (const panel of $qa('.hermes-tab-panel', _panelEl)) {
        panel.classList.toggle('active', panel.id === `hermes-tab-${tabId}`);
      }

      _activeTab = tabId;
      clearBadge(tabId);
      renderActiveTab();
    },

    /**
     * Affiche une notification temporaire (popup en bas à droite).
     * @param {string} message
     * @param {'info'|'warn'|'error'} [type='info']
     */
    showNotification(message, type = 'info') {
      // Retirer la précédente si elle existe encore
      document.querySelectorAll('.hermes-notification').forEach((el) => el.remove());

      const notif         = document.createElement('div');
      notif.className     = `hermes-notification ${type}`;
      notif.textContent   = message;
      document.body.appendChild(notif);

      if (_notifTimeout) clearTimeout(_notifTimeout);
      _notifTimeout = setTimeout(() => {
        notif.style.transition = 'opacity 0.3s';
        notif.style.opacity    = '0';
        setTimeout(() => notif.remove(), 300);
      }, NOTIF_DURATION);
    },
  };

  // ─── Auto-registration ────────────────────────────────────────────────────────

  hermes.register('dashboard', {
    init() {
      // Injection immédiate puis réinjection après 3s (Grepolis peut remplacer le DOM).
      dashboard.init();
      setTimeout(() => {
        if (!document.getElementById(PANEL_ID)) {
          hermes.log.warn('Dashboard: réinjection différée (DOM remplacé par Grepolis)');
          dashboard.init();
        }
      }, 3000);
    },
    destroy() { dashboard.destroy(); },
  });

  /**
   * hermes.main.js — Point d'entrée du userscript Hermes
   *
   * Ce fichier est l'entry point de Rollup. Il :
   * 1. Importe les modules core (déclenchent leur auto-registration)
   * 2. Enregistre explicitement storage/bridge/human (ordre de boot contrôlé)
   * 3. Importe les modules métier dans l'ordre de dépendance
   * 4. Lance la séquence de démarrage
   *
   * Ordre de boot garanti :
   *   storage → bridge → human → world → farm → build → market → combat
   *              → situation → advisor → dashboard
   *
   * Les modules métier s'auto-enregistrent via hermes.register() à leur import.
   * Le bridge doit être initialisé AVANT les modules métier.
   * Storage doit être prêt AVANT bridge (il lit la config).
   * Human doit être prêt AVANT les modules d'automatisation.
   * WorldAnalyzer doit être prêt AVANT situation et advisor (ils en dépendent).
   */


  // Confirmation immédiate que le script est chargé par Tampermonkey.
  console.log(
    '%c[HERMES] ⚡ Script chargé — ' + window.location.href,
    'color:#4ade80;font-weight:bold;font-size:12px;background:#1a1a2e;padding:3px 6px;border-radius:3px'
  );

  // ─── Modules core : registration explicite (ordre de boot contrôlé) ───────────

  hermes.register('storage', {
    init() {
      hermes.log.info('Storage: initialisé');
      storage.resetState();
      hermes.storage = storage;
    },
    destroy() {
      hermes.log.debug('Storage: destruction');
    },
  });

  hermes.register('bridge', {
    init() {
      hermes.log.info('Bridge: initialisé');
      bridge.init();
      hermes.bridge = bridge;
    },
    onGameLoaded() {
      hermes.log.info('Bridge: jeu chargé, hooks Backbone actifs');
    },
    destroy() {
      hermes.log.debug('Bridge: destruction');
    },
  });

  hermes.register('human', {
    init() {
      hermes.log.info('HumanEngine: initialisé');
      hermes.human = human;
      const diag = human.diagnostics();
      hermes.log.debug('HumanEngine diagnostics:', diag);
    },
    destroy() {
      human.cancelAll?.();
      hermes.log.debug('HumanEngine: destruction');
    },
  });

  // ─── Event handlers globaux ────────────────────────────────────────────────────

  hermes.on('hermes:ready', ({ version }) => {
    hermes.log.info(`✅ Hermes v${version} opérationnel — ${Object.keys(hermes._modules ?? {}).length} modules actifs`);
    // Exposer sur window pour debugging en console navigateur.
    if (typeof window !== 'undefined') {
      window.Hermes = hermes;
      console.info(
        '%c[Hermes] ⚡ Opérationnel — window.Hermes disponible pour debug',
        'color: #4ade80; font-weight: bold; font-size: 14px; background: #1a1a2e; padding: 4px 8px; border-radius: 4px;'
      );
    }
  });

  hermes.on('hermes:stopped', () => {
    hermes.log.info('Hermes arrêté proprement');
    if (typeof window !== 'undefined') delete window.Hermes;
  });

  hermes.on('game:loaded', () => {
    hermes.log.info('Jeu Grepolis chargé et prêt');
  });

  // Notification Tampermonkey sur attaque entrante (si activé en config).
  hermes.on('attack:incoming', (attack) => {
    const config = storage.getConfig();
    if (!config.combatConfig?.alertIncoming) return;
    if (typeof GM_notification === 'function') {
      const minutesLeft = Math.round((attack.arrivalTime * 1000 - Date.now()) / 60_000);
      GM_notification({
        title:   '⚔️ Hermes — Attaque entrante !',
        text:    `Ville ${attack.toCityId} — arrivée dans ${minutesLeft} min`,
        timeout: 10_000,
      });
    }
  });

  // Notification sur recommendation urgente de l'advisor.
  hermes.on('advisor:recommendation', (rec) => {
    if (rec.priority !== 'urgent') return;
    if (typeof GM_notification === 'function') {
      GM_notification({
        title:   '🛡️ Hermes — Recommandation urgente',
        text:    rec.message.slice(0, 100),
        timeout: 15_000,
      });
    }
  });

  // ─── Démarrage ────────────────────────────────────────────────────────────────

  hermes.start().catch((err) => {
    console.error('[Hermes] ❌ Erreur fatale au démarrage:', err);
  });

})();
