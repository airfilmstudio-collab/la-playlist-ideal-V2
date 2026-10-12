# La Playlist Idéale — Universal DJ Normandie

Application de vote musical en soirée : les invités scannent le QR code, choisissent une catégorie et votent ; le DJ pilote le minuteur, l'écran géant et récupère le Top 40 en M3U8 pour Rekordbox.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page d'accueil (structure minimale) |
| `tailwind.css` | Styles Tailwind précompilés (généré, ne pas modifier à la main) |
| `tailwind.config.js` | Configuration pour régénérer `tailwind.css` |
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

## Version 3.2 (12 octobre 2026)

- Vérification de l'historique : aucun titre supprimé par la refonte (les 981 titres d'origine sont tous présents). 36 titres avaient disparu en mars-avril 2026, avant la refonte (catégorie « Hits du Moment » notamment).
- Hits 90s : de 60 à 160 titres. Grands tubes des années 90 retrouvés dans la bibliothèque Rekordbox (version la plus jouée), +13 titres reclassés dans leur vraie époque. Catalogue : 1 226 titres.
- Accueil invité : la catégorie « Urbain Français » est affichée en dernier (`THEMES_LAST` dans `app.js`).

## Version 3.3 (12 octobre 2026)

- Toutes les catégories complétées depuis la bibliothèque Rekordbox, avec la version la plus jouée de chaque titre :
  - +220 titres joués 10 à 19 fois qui manquaient (tri manuel : jingles, intros et morceaux d'ambiance exclus) ;
  - +343 grands classiques de soirée par catégorie (environ 1 000 vérifiés), présents sur les disques mais absents du catalogue.
- Catalogue : 1 789 titres. Aucun doublon ajouté ; les doublons de même chanson ou les reprises ont été écartés.
- À noter : le catalogue d'origine contient 60 doublons (plusieurs versions d'un même titre), laissés en l'état.

## Version 3.4 (12 octobre 2026) — réactivité sur téléphone

Mesuré sur téléphone moyen simulé (processeur ralenti ×6) :

| | Avant | Après |
|---|---|---|
| Appui sur « Voter » → retour visuel (« Tous les titres ») | 1,6 à 2,2 s | 0,05 à 0,1 s |
| Appui sur « Voter » → retour visuel (une catégorie) | ~0,5 s | ~0,02 s |
| Ouverture d'une catégorie | 1,5 à 2,7 s | 0,8 à 1 s |

- Un vote ne redessine plus tout l'écran : seuls le bouton touché et le compteur de crédits changent.
- Réaction visuelle dès que le doigt touche le bouton ; « Voté (1/2) » s'affiche en rose plein.
- Anti double-appui : un 2e vote sur le même titre moins de 0,7 s après le 1er est ignoré.
- Tailwind précompilé (`tailwind.css`) au lieu du calcul des styles sur le téléphone.
- Plus de flou d'arrière-plan sur les cartes, halos du fond immobiles sur téléphone, cartes hors écran non dessinées.
- Les longues listes s'affichent par étapes (60 premiers titres tout de suite).
- La lecture régulière du serveur ne redessine plus l'écran invité quand seuls les compteurs de votes changent.
- Filet de sécurité : l'écran se dessine aussi dans une fenêtre en arrière-plan.

## Version 3.5 (12 octobre 2026) — résultats automatiques en fin de compte à rebours

- Quand le compte à rebours atteint zéro, chaque téléphone invité bascule de lui-même sur le classement final, avec bip, vibration et bannière « Résultats finaux disponibles » (une seule fois), même si le tableau de bord DJ est fermé ou l'ordinateur en veille.
- Un téléphone en veille à ce moment-là est prévenu dès qu'il est rallumé.
- La publication sur le serveur est faite automatiquement par le tableau de bord DJ ou par la fenêtre écran géant ; l'export M3U8 automatique reste sur le tableau de bord DJ.

## Version 3.6 (12 octobre 2026) — code de la soirée bien visible

- Grand écran (QR code) : « CODE À TAPER » en très gros, encadré, juste au-dessus du QR code, avec les étapes « 1. Flashez le QR code / 2. Tapez le code ».
- Grand écran (Top 40) : QR code agrandi (environ 2,5×) et code de la soirée en gros à côté.
- Téléphone : le QR code contient le code de la soirée, qui arrive déjà rempli et affiché (« Code de la soirée : FIESTA — touchez simplement Rejoindre »). Si le QR scanné est ancien (code changé entre-temps), le champ se vide et l'invité tape le code affiché.

## Version 3.7 (12 octobre 2026) — Chromecast

- Tableau de bord DJ → « Écrans publics » : boutons « Chromecast QR Code » et « Chromecast classement ». Chrome affiche la liste des Chromecast du Wi-Fi ; l'écran géant s'affiche sur la TV, sans fenêtre à déplacer ni F11.
- Fonctionne avec Google Chrome sur l'ordinateur du DJ, sur le même Wi-Fi que le Chromecast (API « Presentation » de Chrome, gratuite, sans inscription).
- Pendant la diffusion, le lancement du minuteur et « Clôturer & Résultats » n'ouvrent plus de fenêtre : la TV passe seule du QR code au Top 40 puis au classement final.
- Bouton « Arrêter » ; une coupure côté TV est détectée.

## Version 3.8 (12 octobre 2026) — Fire TV Amazon

- Tableau de bord DJ → « Écrans publics » → bouton « Fire TV Amazon » : mode d'emploi en 2 méthodes.
  - Méthode 1 (autonome) : sur le Fire TV, navigateur Silk → adresse courte `…/la-playlist-ideal-V2/tv` (dossier `tv/`, redirige vers l'écran géant) → favori → « Plein écran ». L'écran géant fonctionne seul, même PC éteint.
  - Méthode 2 (PC Windows) : mise en miroir du Fire TV + Windows + K, puis Windows + P → Étendre.
- Écran géant : bouton « Plein écran » (utilisable à la télécommande), demande à l'appareil de garder l'écran allumé.
