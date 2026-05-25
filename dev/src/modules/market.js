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

import { hermes  } from '../core.js';
import { bridge  } from '../bridge.js';
import { human   } from '../engine/human.js';
import { storage } from '../storage.js';

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
let _running = false;

/** Statistiques. */
let _stats = {
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
      _stats.tradesExecuted++;
      _stats.lastTradeTs = Date.now();
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
      _stats.errors++;
    }
  } catch (err) {
    hermes.log.error('MarketManager: erreur trade fermier', err);
    _stats.errors++;
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
    if (!_running) break;

    const tx = transfers[i];

    if (!human.canAct('trade', tx.fromId)) {
      hermes.log.debug(`MarketManager: human.canAct false pour ville ${tx.fromId} — transfert ignoré`);
      continue;
    }

    // Délai entre trades.
    if (i > 0) {
      const { promise } = human.schedule(() => {}, INTER_TRADE_DELAY_MS, 0.20);
      await promise;
      if (!_running) break;
    }

    try {
      const success = await bridge.sendTrade(tx.fromId, tx.toId, tx.resources);
      if (success) {
        _stats.tradesExecuted++;
        _stats.lastTradeTs = Date.now();
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
        _stats.errors++;
        hermes.log.warn(`MarketManager: bridge.sendTrade a retourné false pour ${tx.fromId} → ${tx.toId}`);
      }
    } catch (err) {
      hermes.log.error('MarketManager: erreur sendTrade', err);
      _stats.errors++;
    }
  }

  _stats.balanceCyclesRun++;
  hermes.log.debug('MarketManager: cycle équilibrage terminé');
}

/**
 * Planifie le prochain cycle d'équilibrage (self-rescheduling).
 */
function scheduleNextBalance() {
  if (!_running) return;

  _balanceLoopHandle = human.schedule(async () => {
    if (!_running) return;
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
      _stats.goldOpportunities++;

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

const _unsubs = [];

function attachListeners() {
  // Démarrer la loop d'équilibrage quand Hermes est prêt.
  _unsubs.push(hermes.on('hermes:ready', () => {
    hermes.log.info('MarketManager: hermes:ready — démarrage loop équilibrage');
    scheduleNextBalance();
    attachGoldOfferHook();
  }));

  _unsubs.push(hermes.on('hermes:stopped', () => {
    if (_balanceLoopHandle) _balanceLoopHandle.cancel();
    _running = false;
    detachGoldOfferHook();
  }));

  // Réagir aux actions de farming pour les trades fermiers.
  _unsubs.push(hermes.on('farm:action', handleFarmAction));
}

function detachListeners() {
  for (const unsub of _unsubs) unsub();
  _unsubs.length = 0;
  detachGoldOfferHook();
}

// ─── Interface publique ───────────────────────────────────────────────────────

export const marketManager = {

  /**
   * Initialise le MarketManager.
   */
  init() {
    hermes.log.info('MarketManager: init');
    _running = true;
    attachListeners();

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
    _running = false;
    if (_balanceLoopHandle) {
      _balanceLoopHandle.cancel();
      _balanceLoopHandle = null;
    }
    detachListeners();
  },

  /**
   * Retourne le statut courant du module.
   * @returns {{ lastTradeTs: number|null, tradesExecuted: number, goldOpportunities: number }}
   */
  getStatus() {
    return {
      running:           _running,
      lastTradeTs:       _stats.lastTradeTs,
      tradesExecuted:    _stats.tradesExecuted,
      goldOpportunities: _stats.goldOpportunities,
      balanceCyclesRun:  _stats.balanceCyclesRun,
      goldRatioThreshold: _goldRatioThreshold,
      errors:            _stats.errors,
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

export default marketManager;
