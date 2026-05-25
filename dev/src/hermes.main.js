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

import { hermes }  from './core.js';
import { bridge }  from './bridge.js';
import { storage } from './storage.js';
import { human }   from './engine/human.js';

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

// ─── Modules intelligence (avant les modules automation qui en dépendent) ─────

// WorldAnalyzer : détecte le profil du monde, émet 'world:profile'.
// Doit être chargé avant SituationAnalyzer et StrategicAdvisor.
import './modules/world.js';

// ─── Modules automation ────────────────────────────────────────────────────────

// Chacun s'auto-enregistre via hermes.register() à son import.
import './modules/farm.js';
import './modules/build.js';
import './modules/market.js';
import './modules/combat.js';

// ─── Modules intelligence (suite — dépendent de world) ────────────────────────

// SituationAnalyzer : analyse géopolitique, score de menace par ville.
import './modules/situation.js';

// StrategicAdvisor : recommandations contextuelles (dépend de world + situation).
import './modules/advisor.js';

// ─── UI ────────────────────────────────────────────────────────────────────────

// Dashboard : panneau flottant, injecté dans le DOM du jeu.
// Doit être le dernier module chargé (dépend de tous les events).
import './ui/dashboard.js';

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
