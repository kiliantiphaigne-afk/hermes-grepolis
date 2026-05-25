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

import { storage } from '../storage.js';

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

  const config = storage.getConfig();
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

export const human = {

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

export default human;
