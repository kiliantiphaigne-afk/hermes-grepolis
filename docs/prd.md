# Hermes — Product Requirements Document

**Scope** : standalone (userscript Tampermonkey)
**Mode** : compact

---

## 1. Goals & Background

### Contexte

Hermes est un userscript Tampermonkey pour Grepolis (jeu de stratégie navigateur, InnoGames). Il automatise les tâches répétitives — farming, bâtiments, commerce, combat — en s'intégrant directement dans les objets JavaScript internes du jeu (Backbone.js, appels AJAX natifs). L'outil se distingue des bots existants (GrepoSuite, ModernBot, GrepoBot) par son moteur anti-détection intelligent : délais gaussiens, simulation de comportement humain, plafond d'efficacité configurable. Le joueur laisse sa page ouverte ; Hermes joue de façon autonome mais crédible.

### Objectifs

- Automatiser 100% des actions farming (demand/loot/commerce) sans intervention manuelle
- Maintenir une queue de construction active sur toutes les villes en permanence
- Ne jamais déclencher les systèmes anti-bot de Grepolis sur 30 jours d'utilisation continue
- Gérer de 1 à 50 villes avec les mêmes paramètres ou des templates par ville
- Installation en moins de 2 minutes (Tampermonkey + .user.js)

### Entités métier identifiées

- **City** : ville du joueur, avec ressources, bâtiments, queue de construction, unités
- **FarmingVillage** : village fermier de l'île, avec mood, ressources disponibles, cooldown
- **BuildTemplate** : ordre de construction prédéfini applicable à une ou plusieurs villes
- **AttackTimer** : minuteur de précision pour CS sniping avec calcul de temps de trajet
- **HumanProfile** : configuration du comportement humain simulé (efficacité, pauses, délais)
- **GameSession** : état courant de la session (villes connues, timestamps d'actions, logs)

---

## 2. Functional Requirements

### Module 1 — Farm Manager

**FR1** — Farming automatique avec gestion dynamique de la mood

Le Farm Manager surveille en continu l'état de chaque village fermier pour chaque ville du joueur. Il calcule la mood courante de façon dynamique (sans interroger le serveur inutilement) à partir du timestamp de la dernière action et du taux de récupération linéaire connu (1 point toutes les 24,5 minutes).

Algorithme de décision par village :

1. Calculer `moodCourante = moodAprèsDernièreAction + (minutesEcoulées / 24.5)`
2. **SI** `moodCourante ≥ 85%` ET cooldown farming écoulé :
   a. Exécuter LOOT (double ressources)
   b. Mettre à jour `moodEstimée -= montantLooté * facteurMood`
   c. Enregistrer timestamp
3. **SI** `80% ≤ moodCourante < 85%` ET cooldown écoulé :
   a. Exécuter DEMAND (ressources standard, mood préservée)
   b. Enregistrer timestamp
4. **SI** `moodCourante < 80%` :
   a. **SI** commerce disponible (mood > 80% pour le trade) :
      - Exécuter TRADE (ratio 1:1.25, profitable)
   b. **SINON** : passer au village suivant, planifier re-check dans `tempsRecupération`
5. Attendre délai gaussien (μ = cooldown du village, σ = 15% du cooldown) avant action suivante
→ Résultat : ressources maximisées, mood jamais sous 75%, aucun pattern fixe détectable

- Priorité : Must-have

**FR2** — Rotation multi-îles et multi-villes

1. Pour chaque ville du joueur, indexer tous les villages fermiers de son île
2. Construire une file de priorité globale triée par `(cooldownRestant + estimationRessources)`
3. Traiter les villages dans l'ordre de priorité, pas ville par ville (évite les patterns prévisibles)
4. **SI** une ville n'est pas visible à l'écran : naviguer vers elle via l'API interne du jeu
5. Espacer les actions inter-villes d'un délai gaussien supplémentaire (μ=8s, σ=3s)
→ Résultat : toutes les villes farmées sans pattern géographique régulier

- Priorité : Must-have

---

### Module 2 — Build Queue Manager

**FR3** — Templates de construction et application multi-villes

1. L'utilisateur crée un `BuildTemplate` : liste ordonnée de bâtiments avec niveau cible (ex : "Commerce" = Sénat→5, Stockage→10, Marché→10, Ferme→8, Port→5, Caserne→5, Marché→20)
2. **SI** la queue de construction d'une ville est vide :
   a. Charger le template assigné à cette ville (ou le template par défaut)
   b. Identifier le prochain bâtiment dans l'ordre du template non encore atteint
   c. **SI** ressources suffisantes : lancer la construction via l'API interne
   d. **SINON** : calculer le temps d'attente estimé selon production + farming, planifier retry
3. **SI** plusieurs villes ont la queue vide simultanément :
   a. Traiter une ville à la fois avec délai gaussien entre chaque (μ=12s, σ=4s)
   b. Ne jamais lancer 2 constructions dans la même seconde
→ Résultat : jamais de slot de construction vide, ordre optimal respecté

- Priorité : Must-have

**FR4** — Templates prédéfinis pour les stratégies courantes

Hermes embarque 3 templates de base, éditables par l'utilisateur :

| Template | Objectif | Priorités clés |
|----------|----------|----------------|
| `commerce` | Maximiser ressources et gold | Sénat → Stockage → Marché(10) → Ferme → Marché(20+) |
| `militaire` | Maxer production de troupes | Sénat → Caserne → Écurie → Port → Mur |
| `mixte` | Équilibre croissance + défense | Sénat → Stockage → Ferme → Caserne → Marché |

- Priorité : Must-have

---

### Module 3 — Market Manager

**FR5** — Commerce automatique avec les villages fermiers

1. Après chaque action farming sur un village avec `mood > 80%` :
   a. Vérifier si un trade profitable est disponible (ratio 1:1.25)
   b. **SI** oui et ressources du joueur pas encore au cap : exécuter le trade
   c. **SI** non ou stockage plein : skip
2. Délai gaussien entre le farming et le trade sur le même village (μ=6s, σ=2s)
→ Résultat : aucun trade profitable manqué

- Priorité : Must-have

**FR6** — Équilibrage de ressources entre villes

1. Toutes les 30 minutes (± délai gaussien σ=5min) :
   a. Scanner toutes les villes : ressources actuelles vs capacité stockage
   b. Identifier les villes en surplus (>85% de capacité sur une ressource)
   c. Identifier les villes en déficit (besoin pour la prochaine construction du template)
   d. **SI** surplus ET déficit identifiés ET marché disponible dans les deux villes :
      - Calculer la quantité optimale à transférer
      - Lancer le transfert via l'API commerce
2. Priorité : toujours servir les villes en attente de construction en premier
→ Résultat : aucune ressource gaspillée par débordement de stockage

- Priorité : Should-have

**FR7** — Alerte et capture des offres or (gold exchange)

1. Monitorer les offres or disponibles sur le marché en temps réel (hook sur les événements Backbone)
2. **SI** une offre or apparaît à un ratio favorable (configurable, défaut : ratio ≤ 1:2) :
   a. Afficher une alerte dans le panneau Hermes
   b. **SI** option "auto-accept" activée : accepter automatiquement l'offre
3. Logger toutes les offres vues avec timestamp et ratio
→ Résultat : aucune opportunité or manquée

- Priorité : Should-have

---

### Module 4 — Combat Assistant

**FR8** — CS Sniping avec précision milliseconde

Le CS Sniping consiste à envoyer du renfort dans une ville alliée attaquée par un Colony Ship ennemi, avec un timing précis pour arriver entre les vagues d'attaque et le CS.

1. L'utilisateur entre :
   - Coordonnées de la ville cible
   - Timestamp d'arrivée du CS ennemi (copié depuis le rapport d'attaque)
   - Ville source du renfort
2. Hermes calcule :
   - Temps de trajet exact (distance × vitesse des unités)
   - Timestamp d'envoi optimal = `arrivéeCS - tempsTrajet - délaiCible` (configurable, défaut : -2s)
3. Afficher un compte à rebours en temps réel dans le panneau
4. **SI** `tempsRestant ≤ 500ms` :
   a. Déclencher l'envoi via l'API interne (bypass anti-timer car même ville possible)
   b. Confirmer dans les logs avec timestamp réel d'envoi
5. **SI** l'envoi est depuis la même ville attaquée : activer le mode "anchor snipe" (contourne l'anti-timer du jeu)
→ Résultat : snipe exécuté à ±50ms de la cible

- Priorité : Must-have

**FR9** — Détection et alerte d'attaques entrantes

1. Hooker sur les événements d'attaques entrantes dans l'objet Game de Grepolis
2. **SI** une attaque entrante est détectée :
   a. Afficher une notification visuelle dans le panneau (badge rouge + sound optionnel)
   b. Afficher : origine, heure d'arrivée, type d'unités si visible
3. **SI** option "auto-dodge" activée et attaque semble être un clear :
   a. Calculer si l'envoi de troupes en attaque sur un village fermier les met hors de danger
   b. **SI** oui : proposer l'action (ou l'exécuter automatiquement selon config)
→ Résultat : zéro attaque manquée pendant que le bot tourne

- Priorité : Must-have

---

### Module 5 — City Dashboard

**FR10** — Panneau de contrôle flottant in-game

Un panneau UI discret s'injecte dans le DOM de Grepolis. Il est repositionnable et minimisable.

Contenu du panneau :

```
┌─ HERMES ─────────────────── [−] [×] ┐
│ 🟢 Actif  |  Efficacité: 68%        │
│ Prochaine action: Farm dans 2:34     │
│                                       │
│ [VILLES]  [FARM]  [BUILD]  [COMBAT]  │
│                                       │
│ ▸ Athènes    🌾 ✓  🏗️ Marché 12     │
│ ▸ Sparte     🌾 ✓  🏗️ Caserne 7     │
│ ▸ Corinthe   🌾 ⚠️  🏗️ En attente   │
│                                       │
│ [▶ Démarrer]  [⚙ Config]  [📋 Logs] │
└───────────────────────────────────────┘
```

- Icônes d'état : ✓ OK, ⚠️ Attention (mood basse / ressources), ❌ Erreur, ⏳ En attente
- Clic sur une ville : affiche le détail (mood villages, queue bâtiments, ressources)
- Panneau logs : 50 dernières actions avec timestamp

- Priorité : Must-have

**FR11** — Vue détaillée par ville

1. Clic sur une ville dans le panneau → affiche :
   - Ressources actuelles vs capacité
   - Queue de construction (bâtiment en cours + suivants du template)
   - Tableau des villages fermiers : mood, prochaine action, cooldown restant
   - Attaques entrantes/sortantes
2. Depuis la vue détaillée : possibilité de forcer une action manuellement (override)
→ Résultat : visibilité complète sans quitter la vue courante

- Priorité : Should-have

---

### Module 6 — Human Engine (Anti-Détection)

**FR12** — Délais gaussiens sur toutes les actions

Aucune action ne part avec un intervalle fixe. Chaque timing utilise une distribution gaussienne :

| Action | μ (moyenne) | σ (écart-type) | Min garanti |
|--------|-------------|-----------------|-------------|
| Farming demand/loot | Cooldown du village | 15% du cooldown | Cooldown - 30s |
| Entre deux villages | 8s | 3s | 3s |
| Entre deux villes | 12s | 4s | 5s |
| Construction bâtiment | 6s après queue vide | 3s | 2s |
| Commerce | 6s après farming | 2s | 3s |
| Transfert inter-villes | 15s | 5s | 8s |

- Priorité : Must-have

**FR13** — Simulation d'activité humaine et pauses naturelles

1. Hermes maintient un profil d'activité simulé :
   - Plage active principale : configurable (défaut : 08h-23h)
   - Pauses repas simulées : 2-3 pauses/jour de 20-45 min (horaires légèrement variables)
   - Nuit : activité réduite à 20% ou stoppée (configurable)
2. **SI** l'heure courante est hors plage active : réduire l'activité ou stopper (selon config)
3. Efficacité maximale : plafonnée à 65% de ce que permettrait un timing parfait (configurable 50-80%)
4. Jamais deux actions critiques en même temps (construction + farming + trade sur la même ville simultanément)
5. Variation légère de l'ordre des villes à chaque cycle (pas toujours la même première)
→ Résultat : profil d'activité indistinguable d'un joueur humain assidu

- Priorité : Must-have

**FR14** — Navigation et clics via l'API interne (pas de simulation souris)

Hermes n'utilise PAS de simulation de clics souris (Selenium-style). Il appelle directement les fonctions JavaScript internes de Grepolis (Backbone models, collections, commands) comme le ferait le code natif du jeu. Cela rend les actions indétectables au niveau réseau car elles génèrent exactement les mêmes requêtes AJAX que les actions manuelles du joueur.

1. Hooker sur `window.Game` et les modèles Backbone après le chargement de la page
2. Pour chaque action : appeler la méthode native (`model.trigger()`, `collection.fetch()`, commandes internes)
3. Ne jamais faire de requête directe aux endpoints Grepolis sans passer par la couche JS native
→ Résultat : signature réseau identique à un joueur humain

- Priorité : Must-have

---

### Module 7 — World Analyzer

**FR15** — Détection automatique du profil de monde au démarrage

1. Au chargement de la page, lire `game_data` et les endpoints internes pour extraire :
   - **Vitesse** du monde (speed 1 à 4) — affecte production, entraînement, temps de trajet
   - **Système de conquête** : Revolt (12h de révolte avant prise) vs Conquest (tenir le CS)
   - **World Wonders** : activé ou non
   - **Morale** : activée ou non (pénalise les attaques contre les petits joueurs)
   - **Vitesse des unités** : multiplicateur spécifique
   - **Taille max d'alliance** : détermine le niveau de coordination possible
2. Construire un `WorldProfile` structuré :
   ```json
   { "speed": 3, "system": "revolt", "ww": false, "morale": true, "unitSpeedMultiplier": 1.5 }
   ```
3. Ce profil est injecté dans tous les modules pour adapter leur comportement
4. Afficher le profil détecté dans le Dashboard au démarrage
→ Résultat : Hermes s'adapte automatiquement au monde sans configuration manuelle

- Priorité : Must-have

**FR16** — Adaptation des stratégies selon le profil de monde

La `KnowledgeBase` contient des stratégies indexées par profil. Le World Analyzer sélectionne automatiquement la stratégie appropriée :

| Profil monde | Priorité stratégique |
|---|---|
| Speed 1, Revolt | Défense solide, croissance durable, cave obligatoire |
| Speed 1, Conquest | Trirrèmes en priorité, CS protection |
| Speed 3+, Revolt | Rush colonisation (Harbor 20 en ~72h), expansion agressive |
| Speed 3+, Conquest | Vitesse de déploiement CS, coordination multi-villes |
| WW activé | Villes WW Support dès late game |
| Morale activée | Farming de joueurs de même taille seulement |

- Priorité : Must-have

---

### Module 8 — Situation Analyzer

**FR17** — Analyse géopolitique temps réel autour de chaque ville

1. Au chargement et toutes les 15 minutes (± délai gaussien σ=2min) :
   a. Lire les données de carte du jeu dans un rayon configurable autour de chaque ville (défaut : 25 cases)
   b. Pour chaque ville/joueur détecté : récupérer alliance, taille de ville, activité récente
   c. Classifier chaque entité : `ALLY | NAP | NEUTRAL | ENEMY | WAR`
   d. Calculer un **score de menace** par ville (0-100) basé sur :
      - Distance (plus proche = plus dangereux) : facteur 40%
      - Relation alliance : `WAR=100, ENEMY=70, NEUTRAL=20, NAP=5, ALLY=0`
      - Taille relative (ennemi beaucoup plus grand = plus dangereux) : facteur 30%
      - Activité récente (attaques connues, rapports) : facteur 30%
2. Mettre à jour le score de menace de chaque ville du joueur dans le `GameSession`
3. **SI** score menace > 70 : déclencher une alerte dans le Dashboard

- Priorité : Must-have

**FR18** — Détection des changements d'alliance et adaptation

1. Hooker sur les événements Backbone liés aux alliances (`alliance:updated`, `player:relation:changed`)
2. **SI** un changement de relation est détecté (ex : allié → ennemi après changement d'alliance du joueur) :
   a. Re-scanner immédiatement la carte pour toutes les villes affectées
   b. Recalculer les scores de menace
   c. **SI** une ville du joueur se retrouve avec des ennemis proches (score > 60) :
      - Créer une recommandation d'urgence dans le Strategic Advisor
      - Notification visible dans le Dashboard : *"Ta ville à [X,Y] a maintenant 3 ennemis dans un rayon de 10 cases. Recommandation : basculer vers template Défense + recruter des archers."*
3. Journaliser l'événement dans les logs avec timestamp

- Priorité : Must-have

**FR19** — Historique des patterns ennemis

1. Logger toutes les attaques entrantes avec : joueur source, timestamp, type d'unités (si visible dans rapport), fréquence
2. Détecter les patterns : *"Ce joueur attaque surtout entre 22h et 2h"*, *"Ce joueur envoie toujours un clear avant son CS"*
3. Intégrer ces patterns dans le score de menace et les recommandations du Strategic Advisor
4. Conserver l'historique en `localStorage` (max 30 jours)

- Priorité : Should-have

---

### Module 9 — Strategic Advisor

**FR20** — Moteur de recommandations contextuelles par ville

Le Strategic Advisor combine le `WorldProfile` + le `SituationScore` + l'état courant de la ville + la `KnowledgeBase` pour générer des recommandations actionnables.

Logique de recommandation par ville :

1. Lire : spécialisation cible de la ville (assignée ou suggérée), progression actuelle des bâtiments, score de menace, ressources, world profile
2. Sélectionner dans la KnowledgeBase le template optimal pour cette combinaison
3. **SI** score de menace > 60 ET spécialisation actuelle = "Commerce" :
   a. Recommander de basculer vers template "Mixte" ou "Défense"
   b. Identifier les bâtiments prioritaires à construire (ex : Mur, Caserne)
   c. Recommander les unités défensives à recruter en urgence
4. **SI** c'est la 1ère ville ET joueur < 500 points :
   a. Activer le plan "Colony Rush" : Harbor 20 en priorité absolue
   b. Recommander : *"Atteins Harbor 20 avant tout. Avec Speed [X], ton premier CS sera prêt dans ~[calculé]"*
5. **SI** c'est la Nième ville (N > 1) :
   a. Analyser les spécialisations des villes existantes
   b. Recommander la spécialisation manquante (ex : si toutes sont offense → suggérer défense)
→ Résultat : chaque ville a un plan clair adapté à son contexte réel

- Priorité : Must-have

**FR21** — Interface de spécialisation des villes

1. Dans la vue détaillée de chaque ville dans le Dashboard : selector de spécialisation
   - Options : `Auto` (Hermes suggère), `Colony Rush`, `Offense`, `Defense`, `Commerce`, `Cave`, `WW Support`
   - Mode `Auto` : Hermes choisit selon worldProfile + situationScore
2. **SI** `Auto` : afficher la spécialisation suggérée avec le raisonnement en tooltip :
   - *"Suggéré: Offense — Ce monde est Speed 3 Revolt, tu as déjà 2 villes Défense. Priorité : expansion offensive."*
3. Le Build Manager utilise le template correspondant à la spécialisation choisie
4. **SI** l'utilisateur override manuellement : respecter le choix et ne plus changer automatiquement (sauf si l'utilisateur repasse en `Auto`)

- Priorité : Must-have

**FR22** — Recommandations progressives et contextuelles

Le Strategic Advisor propose des recommandations à plusieurs échéances :

| Horizon | Exemple |
|---|---|
| Immédiat (< 1h) | "Lance la caserne maintenant, tu as assez de ressources" |
| Court terme (< 24h) | "Dans 6h, ton Harbor sera au niveau 15. Commence à recruter des slingers pour le CS" |
| Moyen terme (< 7j) | "Pour coloniser rapidement, voici l'ordre optimal des 12 prochains bâtiments" |
| Stratégique | "Tu es en speed 3 avec 4 villes. Pour passer au rang supérieur : focus WW Support dès maintenant" |

- Priorité : Should-have

---

### Knowledge Base — Base de connaissances stratégiques

**FR23** — Base de données de jeu exhaustive (générée par scraper)

La KnowledgeBase est un objet JSON embarqué dans le userscript, généré par le scraper Python (`tools/scraper.py`). Elle contient :

**Données de jeu (depuis Grepolis Wiki) :**
- Stats complètes de toutes les unités : attaque, défense, vitesse, coût, temps d'entraînement × speed
- Coûts et effets de tous les bâtiments par niveau
- Formules du jeu : temps de trajet, récupération de mood, cooldowns farming
- Paramètres par monde : modificateurs de vitesse, système de conquête, WW

**Stratégies communautaires (depuis forums + guides) :**
- Build orders validés par la communauté, indexés par profil monde + spécialisation
- Compositions de troupes optimales par objectif (attaque, défense CS, défense ville)
- Timings colony rush par speed de monde
- Guides de spécialisation par stade de jeu (early/mid/late)

**Templates de construction optimaux :**
```json
{
  "templates": {
    "colony_rush_speed3": {
      "priority": ["senate_5", "storage_10", "harbor_10", "farm_6", "barracks_5", "harbor_20"],
      "target_troops": { "slinger": 600, "bireme": 20 },
      "estimated_cs_ready": "72h",
      "reasoning": "Speed 3 — Harbor 20 is the bottleneck for CS. Everything else secondary."
    }
  }
}
```

**Mise à jour** : le scraper Python est relancé manuellement ou en CI lors d'une nouvelle version du userscript. La KB est versionnée et embarquée à la compilation.

- Priorité : Must-have (version initiale avec données wiki + 5-6 templates clés)

---

## 3. Livrable technique

**Fichier distribué** : `dist/hermes.user.js`
- Userscript Tampermonkey, auto-installable via lien `.user.js`
- Fichier unique bundlé (Rollup), pas de dépendances externes au runtime
- Compatible : Chrome + Tampermonkey, Firefox + Greasemonkey/Violentmonkey
- Fonctionne sur tous les serveurs Grepolis (`*.grepolis.com/game/*`)
- Paramètres persistés en `GM_setValue` / `localStorage` sous la clé `hermes_v1`
- Auto-update via `@updateURL` + `@downloadURL` dans le header Tampermonkey

**Structure du projet :**

```
hermes/
├── docs/                    — PRD, for-later
├── dev/
│   ├── src/
│   │   ├── core.js          — Bootstrap, EventBus, init séquencée
│   │   ├── bridge.js        — GameBridge : hooks Backbone, API interne Grepolis
│   │   ├── storage.js       — Persistance GM_setValue + localStorage
│   │   ├── modules/
│   │   │   ├── farm.js      — FarmManager (FR1-FR2)
│   │   │   ├── build.js     — BuildManager (FR3-FR4)
│   │   │   ├── market.js    — MarketManager (FR5-FR7)
│   │   │   ├── combat.js    — CombatManager (FR8-FR9)
│   │   │   ├── world.js     — WorldAnalyzer (FR15-FR16)
│   │   │   ├── situation.js — SituationAnalyzer (FR17-FR19)
│   │   │   └── advisor.js   — StrategicAdvisor (FR20-FR22)
│   │   ├── ui/
│   │   │   ├── dashboard.js — Dashboard flottant (FR10-FR11)
│   │   │   └── styles.js    — CSS injecté dynamiquement
│   │   ├── engine/
│   │   │   └── human.js     — HumanEngine anti-détection (FR12-FR14)
│   │   └── data/
│   │       └── knowledge.js — KnowledgeBase embarquée (FR23)
│   ├── tools/
│   │   └── scraper.py       — Scraper Python : Grepolis wiki + forums → knowledge.json
│   ├── package.json
│   └── rollup.config.js
└── dist/
    └── hermes.user.js       — Fichier final bundlé, prêt à installer
```

**Interfaces contractuelles entre modules :**

```javascript
// EventBus (core.js) — tous les modules communiquent via events
hermes.on('farm:complete', ({ cityId, villageId, amount }) => {})
hermes.on('attack:incoming', ({ cityId, arrival, source }) => {})
hermes.on('alliance:changed', ({ playerId, oldRelation, newRelation }) => {})
hermes.on('situation:updated', ({ cityId, threatScore }) => {})
hermes.emit(eventName, data)

// GameBridge (bridge.js) — seule interface autorisée pour toucher au jeu
bridge.getCities()                              // → City[]
bridge.getFarmingVillages(cityId)               // → FarmVillage[]
bridge.executeAction(cityId, action, params)    // → Promise<result>
bridge.getWorldSettings()                       // → WorldProfile
bridge.getMapData(x, y, radius)                // → MapCell[]
bridge.getPlayerRelations()                     // → Relation[]
bridge.onGameEvent(type, handler)               // → unsubscribeFn

// HumanEngine (human.js) — seule façon de scheduler une action
human.schedule(fn, targetMs, variancePct)       // délai gaussien
human.scheduleSequence(actions, baseInterval)   // séquence espacée
human.isActiveHour()                            // → Boolean
human.canAct(actionType)                        // → Boolean (rate limits)
```

---

## 4. Non-Functional Requirements

**NFR1** — Imperceptibilité

- Aucune requête réseau supplémentaire vs un joueur manuel
- Tous les appels passent par l'API JS interne de Grepolis
- Délais toujours gaussiens, jamais uniformes
- Jamais d'action en dehors des plages humaines sans configuration explicite
- Efficacité plafonnée : impossible d'agir plus vite qu'un humain très attentif

**NFR2** — Performance

- Empreinte mémoire < 5 Mo
- Pas de polling agressif : utiliser les événements Backbone plutôt que des `setInterval` courts
- Le panneau UI ne doit pas dégrader les performances du jeu (< 1% CPU en idle)

**NFR3** — Résilience

- **SI** le jeu recharge une page ou change de vue : Hermes se réinitialise automatiquement sans perdre l'état
- **SI** une action échoue (timeout, erreur réseau) : retry avec délai exponentiel + log de l'erreur
- **SI** le jeu est mis à jour et casse un hook : le module concerné se désactive proprement sans crasher les autres

**NFR4** — Facilité d'installation et de configuration

- Installation : 2 étapes (Tampermonkey + clic sur le lien .user.js)
- Configuration : tout via le panneau in-game, aucun fichier à éditer
- Mise à jour : automatique via le mécanisme standard Tampermonkey (`@updateURL`)

**NFR5** — Discrétion visuelle

- Le panneau est minimaliste et ne ressemble pas à un outil de triche
- Il peut être minimisé en une icône discrète
- Aucune mention du mot "bot" dans l'interface
