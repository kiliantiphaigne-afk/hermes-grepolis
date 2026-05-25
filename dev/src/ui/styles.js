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
export function injectStyles() {
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
export function removeStyles() {
  const existing = document.getElementById(STYLE_ID);
  if (existing) existing.remove();
}

export default { injectStyles, removeStyles };
