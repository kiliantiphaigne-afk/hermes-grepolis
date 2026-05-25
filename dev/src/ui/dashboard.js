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

import { hermes }  from '../core.js';
import { bridge }  from '../bridge.js';
import { storage } from '../storage.js';
import { injectStyles, removeStyles } from './styles.js';

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

/** Map<villageId, { cooldownEnd: number, timerHandle }> — countdowns villages */
const _villageCooldowns = new Map();

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
export const dashboard = {

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

export default dashboard;
