# La Playlist Idéale — Universal DJ Normandie

Application de vote musical en soirée : les invités scannent le QR code, choisissent une catégorie et votent ; le DJ pilote le minuteur, l'écran géant et récupère le Top 40 en M3U8 pour Rekordbox.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page d'accueil (structure minimale) |
| `app.css` | Styles visuels (verre holographique, tuiles de catégories, animations) |
| `app.js` | Toute la logique, organisée en 12 sections commentées |
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
