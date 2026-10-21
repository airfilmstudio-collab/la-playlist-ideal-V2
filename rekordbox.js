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
        .replace(/(\w)[«»](\w)/g, '$1$2')          // apostrophe mal encodée (« New Year«s Day »)
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
    // Numéros de piste en tête (« 01 - Positive Force », « 040 - Coldplay - … »).
    let t = String(title || '').trim().replace(/^\d{1,3}\s*[-._]\s+/, '');
    let a = String(artist || '').trim().replace(/^\d{1,3}\s*[-._]\s+/, '');
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

// ---- Recherche souple (fiches mal remplies : « Various Artists », « 03-Soprano - En feu »,
//      artiste vide et « 042 - Coldplay - Viva La Vida », « Party Rock Anthem Featuring. L »…) ----

/** Mots ignorés quand on vérifie qu'une fiche parle bien du même morceau. */
const STOP_WORDS = new Set(('feat ft featuring various artists artist va mp3 wav flac m4a aiff www com fr net org pl '
    + 'mix edit remix rmx version remaster remastered extended radio club dub instrumental intro outro clean dirty '
    + 'original live acapella bootleg rework vip reedit re anniversary single album cut long short '
    + 'and the le la les l de du des d a et x vs y el los las '
    + 'bpm hd hq 720p 1080p 4k official officiel video clip audio lyrics paroles recut').split(' '));

function stripNoise(text) {
    return String(text || '')
        .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')                    // adresses de sites
        .replace(/-\+[^+]*\+-/g, ' ')                                    // « -+www.site.pl+- »
        .replace(/\.(mp3|wav|flac|m4a|aiff?)\b/gi, ' ');
}

function words(text) {
    return normalize(text).split(' ').filter(Boolean);
}

/** Texte complet d'une fiche (artiste + titre + nom du fichier) pour la recherche par mots. */
function trackBlob(track) {
    return ` ${normalize(stripNoise(`${track.artist} ${track.title} ${fileName(track.path)}`))} `;
}

/** Mots de version (« remix », « edit », « extended »…) qui annoncent une mention de remixeur. */
const VERSION_TOKEN = /^(mix|edit|remix|rmx|version|remaster|remastered|extended|radio|club|dub|instrumental|intro|outro|clean|dirty|original|live|acapella|bootleg|rework|vip|reedit|maxi|longue|long|cut)$/;

/**
 * Le titre d'une fiche désigne-t-il bien le morceau voté ?
 * On garde le texte hors parenthèses (sans numéro de piste ni « feat. … ») et on exige :
 *  - le titre voté en entier ;
 *  - avant lui, seulement l'interprète, des numéros ou des mots neutres ;
 *  - après lui, seulement des mots neutres, ou une mention de version (« Uni edit », « Garraud Club Mix »,
 *    « Version 2021 Dj Oliv ») : « Bella Ciao » n'est donc pas « Bella », ni « Comme les rois mages » « Les rois mages ».
 */
function titleMatches(track, title, allowed) {
    const raw = stripNoise(String(track.title || '').trim() || fileName(track.path).replace(/\.[a-z0-9]+$/i, ''));
    // 1er essai : texte hors parenthèses. 2e essai (titre lui-même entre parenthèses :
    // « Wake Me Up (Before You Go Go) ») : parenthèses gardées.
    const outside = raw.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/[([{].*$/, ' ');
    return matchTokens(outside, title, allowed, 2) ?? matchTokens(raw.replace(/[()[\]{}]/g, ' '), title, allowed, 3) ?? false;
}

/** null = titre voté absent du texte ; sinon true / false. */
function matchTokens(text, title, allowed, maxCredit) {
    // « feat. Untel » retiré jusqu'au séparateur suivant (« Alliance Ethnik feat Vinia Mojica - Respect »).
    const tokens = normalize(text.replace(/^\s*\d{1,3}\s*[-._)]?\s*/, ' ').replace(/(^|\s)(feat\.?|ft\.?|featuring)\s[^-–()[\]{}]*/gi, ' '))
        .split(' ').filter(Boolean);
    const target = title.split(' ');
    let at = -1;
    for (let i = 0; i + target.length <= tokens.length && at < 0; i++) {
        if (target.every((w, j) => tokens[i + j] === w)) at = i;
    }
    if (at < 0) return null;
    const neutral = w => STOP_WORDS.has(w) || /^\d+(st|nd|rd|th|e|eme)?$/.test(w) || allowed.has(w);
    if (!tokens.slice(0, at).every(neutral)) return false;
    let pending = 0;
    for (const w of tokens.slice(at + target.length)) {
        if (VERSION_TOKEN.test(w)) return pending <= maxCredit;   // la suite est le nom du remixeur
        if (!neutral(w)) pending++;
    }
    return pending === 0;
}

/** Index de la collection : clé « titre|interprète » → versions, chemin → morceau, mot → morceaux. */
export function buildIndex(tracks) {
    const byKey = new Map();
    const byPath = new Map();
    const byWord = new Map();
    for (const track of tracks) {
        byPath.set(pathKey(track.path), track);
        const key = indexKey(track.title, track.artist);
        if (key) {
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(track);
        }
        for (const w of new Set(trackBlob(track).split(' '))) {
            if (w.length < 3 || STOP_WORDS.has(w) || /^\d+$/.test(w)) continue;
            if (!byWord.has(w)) byWord.set(w, []);
            byWord.get(w).push(track);
        }
    }
    return { byKey, byPath, byWord, size: tracks.length };
}

/** Autres fiches du même morceau, retrouvées par les mots (titre + interprète principal). */
function fuzzyVersions(song, index) {
    if (!index.byWord) return [];
    const id = cleanIdentity(song.title, song.artist);
    const artist = mainArtist(id.artist);
    // Titre de base, et titre avec ses parenthèses « de sens » (« Chacun fait (c'qui lui plaît) »).
    const full = normalize(String(id.title).replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (m, x, y) => (VERSION_WORDS.test(normalize(x ?? y)) ? ' ' : ` ${x ?? y} `))
        .replace(/(^|\s)(feat\.?|ft\.?|featuring)\s.*$/i, ' '));
    const titles = [...new Set([baseTitle(id.title), full].filter(Boolean))];
    if (!titles.length || !artist) return [];
    const allowed = new Set([...titles.flatMap(words), ...words(id.artist), ...words(artist)]);
    // On part du mot le plus rare (artiste ou titre) pour ne parcourir que quelques fiches.
    const candidates = [...new Set([...words(artist), ...words(titles[0])])]
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && index.byWord.has(w))
        .sort((a, b) => index.byWord.get(a).length - index.byWord.get(b).length);
    if (!candidates.length) return [];
    const pool = index.byWord.get(candidates[0]);
    return pool.filter(track => {
        const blob = trackBlob(track);
        if (!blob.includes(` ${artist} `)) return false;
        if (/ (cover|karaoke|tribute|reprise) /.test(blob) && !titles.some(t => / (cover|karaoke|tribute|reprise) /.test(` ${t} `))) return false;
        return titles.some(title => blob.includes(` ${title} `) && titleMatches(track, title, allowed));
    });
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
    for (const track of fuzzyVersions(song, index)) {
        const id = pathKey(track.path);
        if (!seen.has(id)) { seen.add(id); versions.push(track); }
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

/**
 * Contrôle indépendant (plus large) : la fiche la plus jouée qui contient le titre ET l'interprète principal,
 * sans les garde-fous. Sert à repérer d'éventuels oublis ; souvent un autre morceau (medley, reprise…).
 */
export function widestCandidate(song, index) {
    if (!index.byWord) return null;
    const id = cleanIdentity(song.title, song.artist);
    const title = baseTitle(id.title);
    const artist = mainArtist(id.artist);
    if (!title || !artist) return null;
    const keys = [...new Set([...words(artist), ...words(title)])]
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && index.byWord.has(w))
        .sort((a, b) => index.byWord.get(a).length - index.byWord.get(b).length);
    if (!keys.length) return null;
    let best = null;
    for (const track of index.byWord.get(keys[0])) {
        const blob = trackBlob(track);
        if (blob.includes(` ${title} `) && blob.includes(` ${artist} `) && (!best || track.playCount > best.playCount)) best = track;
    }
    return best;
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
