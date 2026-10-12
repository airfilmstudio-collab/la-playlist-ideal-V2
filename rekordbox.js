/* =============================================================================
   Rekordbox — choix de la version la plus jouée
   -----------------------------------------------------------------------------
   Lit l'export XML de la collection Rekordbox (Fichier > Exporter la collection
   au format xml) et, pour chaque titre voté, retrouve toutes les versions du même
   morceau par le même interprète (radio edit, extended, remix, copies sur un
   autre disque…) pour garder celle qui a le plus grand nombre de lectures.

   Module sans dépendance au navigateur : testable seul.
   ============================================================================= */

/**
 * Copie indépendante d'un texte. Sans cela, chaque petit texte extrait garderait en mémoire
 * tout le gros bloc du XML dont il provient (plusieurs centaines de Mo au total).
 */
function own(text) {
    return text ? JSON.parse(JSON.stringify(text)) : '';
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value) {
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, code) => {
        if (code[0] === '#') {
            const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : match;
        }
        return XML_ENTITIES[code.toLowerCase()] ?? match;
    });
}

/** « file://localhost/U:/Musique/a%20b.mp3 » → « U:\Musique\a b.mp3 » (Windows) ou « /Volumes/… » (Mac). */
export function locationToPath(location) {
    let path = location.replace(/^file:\/\/localhost/i, '').replace(/^file:\/\//i, '');
    try { path = decodeURIComponent(path); } catch { /* chemin mal encodé : on le garde tel quel */ }
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replace(/\//g, '\\');
    return path;
}

/** Clé de comparaison de deux chemins (insensible à la casse et au type de barre). */
export function pathKey(path) {
    return String(path || '').replace(/\\/g, '/').toLowerCase().trim();
}

/** Extrait les morceaux de la collection (les listes de lecture du XML sont ignorées). */
export function parseCollection(xmlText) {
    const start = xmlText.indexOf('<COLLECTION');
    const end = xmlText.indexOf('</COLLECTION>');
    const body = start >= 0 ? xmlText.slice(start, end > start ? end : undefined) : xmlText;

    const tracks = [];
    const trackRe = /<TRACK\s([^>]*?)\/?>/g;
    const attrRe = /([A-Za-z_]+)="([^"]*)"/g;
    let m;
    while ((m = trackRe.exec(body)) !== null) {
        const attrs = {};
        let a;
        attrRe.lastIndex = 0;
        while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
        if (!attrs.Location || attrs.Name === undefined) continue;
        tracks.push({
            title: own(decodeXml(attrs.Name)),
            artist: own(decodeXml(attrs.Artist || '')),
            genre: own(decodeXml(attrs.Genre || '')),
            year: parseInt(attrs.Year, 10) || 0,
            duration: parseInt(attrs.TotalTime, 10) || 0,
            playCount: parseInt(attrs.PlayCount, 10) || 0,
            rating: parseInt(attrs.Rating, 10) || 0,
            path: own(locationToPath(decodeXml(attrs.Location))),
        });
    }
    return tracks;
}

// ---- Normalisation des titres et artistes ----

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[’'`´]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const VERSION_WORDS = /\b(mix|edit|remix|rmx|version|remaster(ed)?|extended|radio|club|dub|instrumental|intro|outro|clean|dirty|original|live|acapella|bootleg|rework|vip|re ?edit|12|7)\b/;

/** Titre de base : sans parenthèses/crochets, sans « feat. », sans suffixe « - Extended Mix ». */
function baseTitleRaw(title) {
    return String(title || '').replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
}

export function baseTitle(title) {
    let t = String(title || '')
        .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
        .replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, ' ');
    const dash = t.lastIndexOf(' - ');
    if (dash > 0 && VERSION_WORDS.test(normalize(t.slice(dash + 3)))) t = t.slice(0, dash);
    return normalize(t).replace(/\s(ext|extended|edit|remix|rmx|intro|clean|dirty)$/, '');
}

/** Interprète principal : « Aya Nakamura feat. Damso » → « aya nakamura ». */
export function mainArtist(artist) {
    const first = String(artist || '').split(/\s+(?:feat\.?|ft\.?|featuring|vs\.?|x|&|and|et|with)\s+|[,;/]|\s+&\s+/i)[0];
    return normalize(first);
}

function indexKey(title, artist) {
    const id = cleanIdentity(title, artist);
    const t = baseTitle(id.title);
    const a = mainArtist(id.artist);
    return t && a ? `${t}|${a}` : null;
}

/**
 * Corrige les fiches mal remplies avant comparaison :
 *  - artiste vide et « Artiste - Titre » dans le titre ;
 *  - « ARTISTE / TITRE » répété dans les deux champs ;
 *  - artiste qui contient aussi le titre (« LOUISE ATTAQUE J'T'EMMENE AU VENT »).
 */
export function cleanIdentity(title, artist) {
    let t = String(title || '').trim();
    let a = String(artist || '').trim();
    if (!a && t.includes(' - ')) {
        const i = t.indexOf(' - ');
        a = t.slice(0, i); t = t.slice(i + 3);
    }
    if (t && t === a && t.includes(' / ')) {
        const i = t.indexOf(' / ');
        a = t.slice(0, i); t = t.slice(i + 3);
    }
    const nt = normalize(baseTitleRaw(t));
    const na = normalize(a);
    if (nt && na.length > nt.length && na.endsWith(' ' + nt)) a = a.slice(0, a.length - (baseTitleRaw(t).trim().length)).trim();
    return { title: t, artist: a };
}

/** Index de la collection : clé « titre|interprète » → versions, et chemin → morceau. */
export function buildIndex(tracks) {
    const byKey = new Map();
    const byPath = new Map();
    for (const track of tracks) {
        byPath.set(pathKey(track.path), track);
        const key = indexKey(track.title, track.artist);
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(track);
    }
    return { byKey, byPath, size: tracks.length };
}

/**
 * Trouve la version la plus jouée d'un titre voté.
 * Sources de correspondance : titre/artiste du catalogue, version inversée (fiches où titre et
 * artiste sont échangés), et métadonnées Rekordbox du fichier déjà référencé dans le catalogue.
 * @returns {{ best: object|null, versions: object[], current: object|null }}
 */
export function findBestVersion(song, index) {
    const current = song.filepath ? index.byPath.get(pathKey(song.filepath)) || null : null;
    const keys = new Set([
        indexKey(song.title, song.artist),
        indexKey(song.artist, song.title),
        current && indexKey(current.title, current.artist),
    ].filter(Boolean));

    const versions = [];
    const seen = new Set();
    for (const key of keys) {
        for (const track of index.byKey.get(key) || []) {
            const id = pathKey(track.path);
            if (!seen.has(id)) { seen.add(id); versions.push(track); }
        }
    }
    if (current && !seen.has(pathKey(current.path))) versions.push(current);

    // Plus de lectures d'abord ; à égalité, la version déjà au catalogue, puis la mieux notée.
    const currentKey = current ? pathKey(current.path) : null;
    versions.sort((a, b) =>
        (b.playCount - a.playCount)
        || ((pathKey(b.path) === currentKey) - (pathKey(a.path) === currentKey))
        || (b.rating - a.rating));

    return { best: versions[0] || null, versions, current };
}

/** Nom de fichier lisible depuis un chemin complet. */
export function fileName(path) {
    return String(path || '').split(/[\\/]/).pop();
}

/**
 * Lit un fichier XML Rekordbox (même très gros : plusieurs centaines de Mo) morceau par morceau,
 * sans jamais le charger entièrement en mémoire. Le fichier reste sur l'ordinateur.
 * @param {File} file
 * @param {(ratio: number) => void} [onProgress] avancement de 0 à 1
 */
export async function parseCollectionFile(file, onProgress = () => {}) {
    const tracks = [];
    const reader = file.stream().pipeThrough(new TextDecoderStream('utf-8')).getReader();
    let buffer = '';
    let read = 0;
    let started = false;
    let finished = false;

    const consume = text => {
        for (const track of parseCollection(`<COLLECTION>${text}</COLLECTION>`)) tracks.push(track);
    };

    while (!finished) {
        const { value, done } = await reader.read();
        if (value) { buffer += value; read += value.length; }

        if (!started) {
            const i = buffer.indexOf('<COLLECTION');
            if (i >= 0) { buffer = buffer.slice(i); started = true; }
            else if (!done) { buffer = buffer.slice(-20); continue; }
        }

        const end = buffer.indexOf('</COLLECTION>');
        if (end >= 0) {
            consume(buffer.slice(0, end));
            finished = true;
        } else if (done) {
            consume(buffer);
            finished = true;
        } else {
            // On garde le dernier <TRACK (peut-être incomplet) pour le prochain morceau.
            const cut = buffer.lastIndexOf('<TRACK');
            if (cut > 0) { consume(buffer.slice(0, cut)); buffer = buffer.slice(cut); }
        }
        onProgress(Math.min(1, read / Math.max(1, file.size)));
        if (done) break;
    }
    reader.cancel().catch(() => {});
    return tracks;
}
