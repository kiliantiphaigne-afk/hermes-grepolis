# Hermes — Post-MVP (For Later)

Features validées mais hors MVP. À prioriser selon les retours d'utilisation.

---

## Distribution & Communauté

- **Greasy Fork** : publication sur greasyfork.org avec versioning automatique
- **Page de présentation** : landing page simple avec instructions d'installation + changelog
- **Discord communautaire** : serveur pour les utilisateurs, remontée de bugs, partage de templates
- **Système de mise à jour** : notification in-game quand une nouvelle version est disponible

---

## Coordination Alliance

- **Partage de templates** : exporter/importer des BuildTemplates entre joueurs
- **Coordination défense** : alerter les membres de l'alliance via Discord webhook quand une attaque est détectée
- **Timer partagé** : timer de snipe collaboratif pour les opérations d'alliance

---

## Analytics & Optimisation

- **Statistiques de session** : ressources farmées, constructions lancées, trades effectués par jour
- **Graphes de progression** : courbe de croissance des villes dans le temps
- **Comparaison templates** : A/B testing entre deux templates sur des villes similaires
- **Export CSV** : historique d'actions pour analyse externe

---

## Modules Avancés

- **Auto-recherche** : automatiser la file de recherches militaires/civiles dans le temple
- **Festivals culturels** : lancer automatiquement les festivals pour débloquer les slots de population
- **WW (World Wonders)** : envoi automatique de ressources vers les Merveilles du Monde de l'alliance
- **Recrutement automatique** : maintenir un niveau minimal de troupes dans chaque ville
- **Sorts automatiques** : utiliser les sorts de favoris divins au bon moment

---

## Anti-Détection Avancé

- **Empreinte souris simulée** : pour les rares interactions qui le nécessitent, simuler des trajectoires de souris naturelles (courbes de Bézier)
- **Fingerprint browser** : rotation légère des headers pour éviter la corrélation de sessions
- **Captcha handling** : détection et alerte si un captcha apparaît (pause automatique du bot)

---

## Fonctionnalités Combat

- **Calculateur d'attaques** : outil de planification d'attaques groupées avec timing
- **Spy tracker** : suivi des rapports d'espionnage pour estimer les défenses ennemies
- **Dodge intelligent** : analyse des rapports d'attaques historiques pour prédire si une attaque est un clear ou un CS

---

## Technique

- **Multi-compte** : support de plusieurs comptes dans des onglets différents avec coordination
- **Configuration cloud** : sync des settings entre machines via un backend léger (optionnel)
- **API Hermes** : permettre à d'autres scripts de se plugger sur les événements Hermes
