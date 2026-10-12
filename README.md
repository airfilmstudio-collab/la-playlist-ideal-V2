# La Playlist Idéale — Universal DJ Normandie

Application de vote musical en soirée : les invités scannent le QR code, choisissent une catégorie et votent ; le DJ pilote le minuteur, l'écran géant et récupère le Top 40 en M3U8 pour Rekordbox.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page d'accueil (structure minimale) |
| `app.css` | Styles visuels (verre holographique, tuiles de catégories, animations) |
| `app.js` | Toute la logique, organisée en 12 sections commentées |
| `rekordbox.js` | Lecture du XML Rekordbox et choix de la version la plus jouée |
| `songs.js` | Catalogue des titres (`[id, titre, artiste, catégorie, chemin]`) |
| `firestore.rules` | Règles de sécurité à coller dans la console Firebase |
| `lOGO-style-App-UniversalDj-512p.png` | Logo |

## Ajouter des titres

1. Tableau de bord DJ → bouton **Importer** (M3U8) ou **Ajouter un titre**.
2. Bouton **</>** → télécharge un nouveau `songs.js`.
3. Remplacer `songs.js` sur GitHub. Les invités voient les nouveaux titres dès la mise en ligne.

## Écran géant

- `…/?public=qrcode` : QR code puis classement automatique.
- `…/?public=monitor` : classement.

## Version 3.0 (octobre 2026)

- Accueil invité : catégories en grandes tuiles colorées, bouton « Catégories » toujours visible.
- Sécurité : fin de l'accès DJ via `?public=admin` et via le logo de l'écran géant ; textes échappés (anti-injection).
- Synchronisation : toutes les écritures passent par l'API REST (plus de dépendance au SDK Firebase), avec alerte si une écriture échoue.
- Corrections : classement final figé chez les invités en cas de publication manuelle ; messages de confirmation qui se fermaient tout seuls ; « Remise à zéro » qui effaçait le code DJ et les titres importés ; téléchargement M3U déclenché chez un invité non connecté ; double export au rechargement ; rafraîchissement rapide jamais activé ; recherche qui perdait le clavier sur mobile ; vote perdu sans prévenir en cas de coupure réseau.
- Export Top 40 en vrai `.m3u8` (UTF-8, accents corrects dans Rekordbox).
- Versions des bibliothèques figées (Tailwind 3.4.16, Phosphor 2.1.1).

## Version 3.0.1 (11 octobre 2026) — mise en ligne

- Correctif : la lecture Firestore n'envoie plus le paramètre `_t` (refusé par le vrai serveur avec une erreur 400). La v2 avait le même défaut : sa lecture REST échouait sans le dire.
- `index.html` charge `app.js?v=3.0.1` : les téléphones abandonnent l'ancienne copie en cache.
- Règles Firestore publiées dans la console (avant : `allow read, write: if true` sur toute la base). Vérifié en direct : lecture, écriture des codes et votes OK ; champ inconnu, mauvais type et autres chemins refusés (403).

## Version 3.1 (12 octobre 2026)

- Nouveau bouton DJ « Top 40 avec mes versions les plus jouées » : on choisit l'export XML de Rekordbox (Fichier → Exporter la collection au format xml) ; pour chaque titre voté, l'application prend la version de l'interprète la plus jouée et télécharge le M3U8. Le XML est lu sur place (aucun envoi), même très gros (748 Mo lus en ~3 s). Code dans `rekordbox.js`.
- Catalogue : +132 titres parmi les plus joués dans Rekordbox (20 lectures et plus) qui manquaient, soit 1 113 titres.
- Nouvelle catégorie « 🎩 Danses de soirée » (Madison, valses, Les Sardines, La jument de Michao…).
