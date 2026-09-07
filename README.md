# LocaDrive OS

Console SaaS de gestion pour une agence de location de véhicules — projet réalisé dans le cadre d'un stage.

## Aperçu

Application web (PWA) tout-en-un pour gérer une agence de location : clients, flotte de véhicules, réservations, contrats — avec génération de PDF, signatures manuscrites et lecture automatique de la CNI par OCR.

## Fonctionnalités

- **Tableau de bord** — activité récente, statistiques, alertes
- **Gestion des clients** — CRUD complet, tags VIP/signalé, liste noire, notes
- **Gestion de la flotte** — véhicules, statut (disponible/loué/maintenance), tarif journalier, kilométrage
- **Réservations** — planning type Gantt, détection automatique des retards (overdue)
- **Contrats** — cycle de vie complet (brouillon → envoyé → signé), signatures manuscrites du client et du gestionnaire, historique d'événements, génération de PDF téléchargeable
- **OCR de CNI** — scan d'une photo de carte d'identité marocaine → extraction automatique (nom, prénom, numéro, date d'expiration du permis) pour préremplir la fiche client
- **PWA installable** — manifest + service worker, shell réouvrable hors-ligne

## Stack technique

| Couche | Techno |
|---|---|
| Frontend | HTML + JavaScript vanilla (aucun framework, aucun build), Tailwind CSS via CDN avec tokens personnalisés (style Material Design 3) |
| Backend | [Supabase](https://supabase.com) — Postgres, Auth, Row Level Security, fonctions RPC |
| PDF | [jsPDF](https://github.com/parallax/jsPDF) — génération côté client |
| OCR | [OCR-rex](https://github.com/nahlibee/OCR-rex) — service local basé sur PaddleOCR |
| PWA | `manifest.webmanifest` + `sw.js` |

## Structure du projet

- `index.html` — markup de la page et références aux librairies externes
- `src/styles/main.css` — styles de l'application et règles de responsive
- `src/js/tailwind-config.js` — configuration Tailwind
- `src/js/navigation.js` — comportement de navigation entre pages
- `src/js/contract-interactions.js` — interactions de la page contrat (dont les signatures)
- `src/js/app.js` — authentification, chargement des données, comportement de l'application
- `public/` — assets PWA statiques (manifest et icône)
- `sw.js` — service worker à la racine, pour qu'il contrôle toute l'application
- `ocr-rex-service/` — service OCR local (voir section dédiée plus bas)

## Architecture

- **SPA faite main**, sans librairie de routing — chaque page est un `<div>` basculé en `display:none/block` via `showPage()` (`src/js/navigation.js`).
- **État applicatif** centralisé dans un objet `DB` en mémoire, chargé depuis Supabase à la connexion puis reconstruit à chaque mutation via `renderAll()` (`src/js/app.js`).
- **Auth gate** : aucune donnée n'est accessible tant qu'une session Supabase n'existe pas ; chaque appel `sb.from(...)` s'exécute donc toujours avec un JWT authentifié, ce qui permet à la policy RLS `staff_full_access` de s'appliquer côté base de données.
- **Adaptateurs `mapXRow()`** : convertissent chaque ligne Postgres (snake_case) vers le format attendu par l'interface (camelCase), pour découpler l'UI du schéma de la base.

## Installation / Lancement

1. Cloner le repo.
2. Servir ce dossier avec un serveur web local, puis ouvrir `index.html`. L'adresse Live Server existante (`http://127.0.0.1:5500/index.html`) supporte l'installation en PWA. Ouvrir le fichier directement en `file://` ne supporte pas les service workers.
3. Se connecter avec un compte staff existant sur le projet Supabase.

Une connexion internet est nécessaire (Tailwind, Supabase et jsPDF sont chargés depuis des CDN).

### Installer en PWA

1. Ouvrir l'application dans Chrome ou Edge via le serveur local.
2. Utiliser le bouton **Installer l'application** dans la sidebar, quand il apparaît.
3. Le shell de l'application peut se rouvrir hors-ligne. Les changements de données Supabase et l'OCR nécessitent toujours que leurs services respectifs soient joignables.

## Signatures de contrat

Démarrer une réservation confirmée nécessite désormais des signatures manuscrites du client et de l'agence. Les signatures fonctionnent à la souris, au stylet ou au tactile.

- Les horodatages et le statut du contrat sont enregistrés dans Supabase.
- Les dessins de signature, eux, sont conservés dans le stockage local du navigateur **sur l'appareil qui a signé**, et inclus dans les PDF téléchargés depuis cet appareil.

> ⚠️ À garder en tête : si le PDF est régénéré plus tard depuis un autre appareil, le tracé de la signature ne sera pas disponible (seuls le statut et l'horodatage le sont, via Supabase).

## OCR — lecture de CNI

Le module OCR s'appuie sur [OCR-rex](https://github.com/nahlibee/OCR-rex), un service local basé sur PaddleOCR.

Pour l'installation et le démarrage d'OCR-rex, voir [`ocr-rex-service/README.md`](./ocr-rex-service/README.md).

Résumé rapide :
1. Lancer le service local (`ocr-rex-service/start.bat`) et laisser la fenêtre ouverte.
2. Le service doit être accessible sur `http://127.0.0.1:5000`.
3. Uploader une photo de CNI (JPG/PNG/WEBP) depuis la fiche client — les champs détectés sont préremplis automatiquement (à vérifier avant sauvegarde).

> ⚠️ Le service OCR tourne en local sur la machine qui l'exécute — cette fonctionnalité ne marchera pas si l'app est testée à distance sans lancer le service correspondant.

## Statut

Projet terminé (stage) — backend réel (Supabase + Auth + RLS), génération de contrats en PDF avec signatures manuscrites, et OCR de CNI fonctionnels.
