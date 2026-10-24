# Cahier des charges — Application de planification d'entraînement marathon

## 1. Vision du projet

Application personnelle de planification et de suivi d'entraînement pour la course à pied (marathon), combinant données objectives (Garmin) et données subjectives (humeur, blessures, tensions) pour générer un planning d'entraînement adaptatif, exportable, et suivi dans le temps via des bilans mensuels.

**Utilisateur cible** : usage personnel (le porteur du projet), avec une architecture pensée pour être robuste et évolutive.

**Contraintes de fond** :
- Régularité réaliste : maximum 2-3 sorties par semaine
- Créativité et variabilité dans les séances pour réduire l'ennui et stimuler le cardio global
- UI simple, couleurs basiques, usage fluide

---

## 2. Fonctionnalités — v1

### 2.1 Planification & construction du planning
- Générateur de planning d'entraînement (training days planner / schedule builder)
- Logique d'entraînement **placeholder** en v1 : structure connue et éprouvée (type Pfitzinger ou entraînement polarisé), **isolée dans un module dédié et remplaçable** — en attendant une recherche méthodologique approfondie (voir section 5)
- Tapering automatique simple avant course (réduction de volume sur les 2-3 dernières semaines)
- Chaque séance planifiée porte une **note "pourquoi"** courte expliquant son objectif (ex. "endurance de base, allure facile" / "travail VMA")

### 2.2 Onboarding
- Questionnaire d'onboarding léger, une fois à l'inscription :
  - Import automatique de l'historique Garmin (via `garminconnect`, requête élargie sur l'historique complet) pour pré-remplir kilométrage récent, tendances d'allure et historique VMA
  - Records personnels (PB) actuels — saisie manuelle
  - Historique de blessures — saisie manuelle
  - Date de course objectif — saisie manuelle

> **Piste future (hors v1)** : import également depuis Strava pour couvrir l'historique antérieur non présent sur Garmin. Non retenu en v1 pour rester simple ; ajoutable plus tard comme source d'import optionnelle sans remise en cause de l'architecture.

### 2.3 Saisie de données (INPUT)
- **Données physiques** : récupérées automatiquement depuis Garmin (via `garminconnect`, librairie Python non-officielle) — activités, allure, distance, durée, fréquence cardiaque, VMA estimée
- **Données subjectives** : petits formulaires post-course pour humeur / blessures / tensions
- **Vue de tendance douleur/fatigue** : visualisation simple (ligne temporelle) des données auto-déclarées sur les dernières semaines, pour repérer une tendance à risque tôt

### 2.4 Calendrier
- Synchronisation **deux sens** avec **Google Calendar** (cible technique retenue pour la robustesse de l'API et le support des webhooks)
- Possibilité de continuer à consulter dans Apple Calendar via l'abonnement d'Apple Calendar à un calendrier Google

### 2.5 Export & bilans (OUTPUT)
- Export PDF global en fin de chaque mois, incluant :
  - Kilométrage total (en km)
  - Petits bilans synthétiques par course
  - Score VMA (Garmin)
  - Type de course (aérobie/anaérobie) — **non automatisé en v1**, voir section 5
  - Score d'amélioration globale
  - Score de régularité globale
  - Suggestions générées par Claude

### 2.6 Interface
- PWA (Progressive Web App) : utilisable sur ordinateur et installable sur iPhone
- UI simple, couleurs basiques, priorité à la fluidité d'usage plutôt qu'à la richesse visuelle

---

## 3. Architecture technique retenue

| Composant | Choix | Justification |
|---|---|---|
| Frontend | PWA (ex. React/Next.js) | Usage PC + téléphone sans développement natif iOS/Android séparé |
| Base de données | PostgreSQL hébergé (ex. Supabase) | Synchro native PC/iPhone via API, gère bien les données mixtes (structurées + formulaires flexibles) |
| Hébergement | Ex. Vercel | Accès possible depuis n'importe où (pas seulement le wifi local), sans surcoût significatif par rapport à un usage local uniquement |
| Données Garmin | `garminconnect` (Python, non-officiel) | Le plus rapide à mettre en place pour un projet personnel ; alternative officielle (Garmin Health API) jugée disproportionnée pour cet usage |
| Calendrier | Google Calendar API | Seule option avec un support mature de la synchro deux-sens (webhooks) parmi Google/Apple/Notion Calendar |

**Point de vigilance** : `garminconnect` étant non-officiel, il peut être affecté par des changements côté Garmin (généralement corrigés en quelques jours par la communauté).

---

## 4. Explicitement hors scope v1

- Gamification (streaks, badges) — risque d'encourager à courir malgré une contre-indication (blessure/fatigue)
- Ajustements liés à la météo — complexité additionnelle (API supplémentaire) pour une valeur jugée secondaire à ce stade
- Notifications push / rappels — complexité mobile disproportionnée à ce stade

---

## 5. Chantier séparé : méthodologie d'entraînement

La sélection des données et régimes d'entraînement qui fonderont la logique de conception des séances (classification aérobie/anaérobie, courbe de progression personnalisée) est identifiée comme **le point le plus complexe du projet** — un problème de recherche et de jugement plus qu'un problème technique.

Ce chantier sera traité **séparément**, en s'appuyant notamment sur :
- Études scientifiques sur la méthode norvégienne de course à pied
- Routines et pratiques existantes
- Une courbe de progression personnelle définie par l'utilisateur

Une fois ce travail abouti, il remplacera le module de logique d'entraînement placeholder (section 2.1) sans nécessiter de refonte du reste de l'application, grâce à son isolation architecturale.

---

## 6. Prochaines étapes proposées

1. Setup du projet technique (repo, structure PWA, connexion base de données)
2. Intégration Garmin (`garminconnect`) — récupération et stockage des premières activités
3. Modèle de données utilisateur + questionnaire d'onboarding
4. Générateur de planning avec logique placeholder + note "pourquoi" par séance
5. Intégration Google Calendar (export puis synchro deux-sens)
6. Formulaires de saisie subjective + vue de tendance douleur/fatigue
7. Génération du bilan PDF mensuel
8. Chantier séparé : recherche méthodologique (section 5)
