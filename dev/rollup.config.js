// rollup.config.js — Configuration de build Hermes
// Format IIFE (Immediately Invoked Function Expression) pour Tampermonkey.
// Pas de minification en dev pour faciliter le debugging dans la console du navigateur.

const tampermonkeyHeader = `// ==UserScript==
// @name         Hermes — Grepolis Assistant
// @namespace    https://github.com/hermes-grepolis
// @version      1.0.0
// @description  Intelligent automation for Grepolis — farming, building, combat, strategy advisor
// @author       Hermes
// @match        *://*.grepolis.com/game/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/kiliantiphaigne-afk/hermes-grepolis/main/dist/hermes.user.js
// @downloadURL  https://raw.githubusercontent.com/kiliantiphaigne-afk/hermes-grepolis/main/dist/hermes.user.js
// ==/UserScript==`;

export default {
  input: 'src/hermes.main.js',

  output: {
    file: '../dist/hermes.user.js',
    // IIFE = function auto-exécutée, idéale pour les userscripts :
    // évite toute pollution du namespace global sauf ce qu'on expose explicitement.
    format: 'iife',
    name: 'Hermes',
    // Le banner Tampermonkey doit être le premier contenu du fichier —
    // Tampermonkey lit les metadata dans les premiers Ko du fichier.
    banner: tampermonkeyHeader,
    // Exposer 'window.Hermes' pour le debugging en console (pratique en dev).
    // En prod on pourrait retirer ça, mais c'est utile pour inspecter l'état.
    extend: true,
    // Pas de sourcemap dans le dist final — le fichier est déjà lisible (no minification).
    sourcemap: false,
  },

  // Pas de plugins en dev pour garder le build simple et rapide.
  // Pour une version prod minifiée, décommenter :
  // plugins: [terser()],
  plugins: [],

  // Rollup doit ignorer les "unresolved imports" qui correspondent à des APIs
  // du navigateur ou de Tampermonkey — ce ne sont pas des modules npm.
  onwarn(warning, warn) {
    // Ignorer les avertissements de circular dependency entre modules internes :
    // ils sont intentionnels (core ↔ modules via EventBus).
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    warn(warning);
  },
};
