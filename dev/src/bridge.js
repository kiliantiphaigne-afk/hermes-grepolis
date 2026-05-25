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

import { hermes } from './core.js';

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
 * Appelle une méthode sur un objet de manière sécurisée.
 * @param {object} obj
 * @param {string} method
 * @param {...*} args
 * @returns {*} Résultat ou undefined si l'appel échoue
 */
function safeCall(obj, method, ...args) {
  try {
    if (obj && typeof obj[method] === 'function') {
      return obj[method](...args);
    }
  } catch (err) {
    hermes.log.warn(`safeCall failed: ${method}`, err);
  }
  return undefined;
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

export { bridge };
export default bridge;
