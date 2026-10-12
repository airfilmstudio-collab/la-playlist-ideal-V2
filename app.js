/* =============================================================================
   LA PLAYLIST IDÉALE — Universal DJ Normandie
   -----------------------------------------------------------------------------
   Application de vote musical en soirée.
   - Invités : se connectent avec le code de la soirée, choisissent une catégorie
     et votent (30 crédits, 2 votes max par titre).
   - DJ : pilote le minuteur, l'écran géant, la publication des résultats,
     l'export M3U8 pour Rekordbox et la gestion des titres.
   - Écran géant : fenêtre dédiée (?public=qrcode ou ?public=monitor).

   Synchronisation : un seul document Firestore, lu et écrit via l'API REST
   (le SDK Firebase se bloquait quand l'authentification anonyme échouait).

   Organisation du fichier :
     1. Configuration
     2. Utilitaires
     3. Accès Firestore (REST)
     4. Stockage local
     5. État de l'application
     6. Catalogue & classement
     7. Minuteur & phases
     8. Synchronisation (lecture périodique)
     9. Notifications invités (son, vibration, écran allumé)
    10. Actions (invités, DJ, fenêtres)
    11. Rendu (vues HTML)
    12. Événements & démarrage
   ============================================================================= */

import { SONGS } from './songs.js?v=3.3.0';
import * as rekordbox from './rekordbox.js?v=3.1.0';

// =============================================================================
// 1. CONFIGURATION
// =============================================================================

const FIREBASE = {
    projectId: 'laplaylistideale',
    // Identifiant historique utilisé dans le chemin du document : NE PAS MODIFIER,
    // sinon l'application lirait un autre document (votes et codes perdus).
    appId: '1:288987066836:web:12b48f1ae0adbfef8f6641',
};

const PUBLIC_URL = 'https://airfilmstudio-collab.github.io/la-playlist-ideal-V2/';
const LOGO_URL = 'lOGO-style-App-UniversalDj-512p.png';
const GOODBYE_URL = 'https://www.universal-dj.com/bar-a-vinyles-normandie/';

const MAX_TOTAL_VOTES = 30;
const MAX_VOTES_PER_SONG = 2;
const TOP_SIZE = 40;

const DEFAULTS = Object.freeze({
    guestCode: 'FIESTA',
    adminCode: 'DJ',
    phase1Duration: 2 * 60 * 60 * 1000,
    phase2Duration: 1 * 60 * 60 * 1000,
});

/** Formules de minuteur proposées au DJ (durées en minutes). */
const TIMER_PRESETS = {
    '3H':  { label: '3H',      p1: 120, p2: 60 },
    '1H':  { label: '1H',      p1: 40,  p2: 20 },
    '30M': { label: '30 Min',  p1: 20,  p2: 10 },
    '2M':  { label: 'Test 2M', p1: 1,   p2: 1, isTest: true },
};

const DOUBLE_TAP_GUARD_MS = 700;      // délai minimal entre deux votes sur le même titre
const POLL_INTERVAL_NORMAL = 3000;
const POLL_INTERVAL_FAST = 1500;   // pendant le Top 40 et après la clôture
const OFFLINE_AFTER_MS = 10000;    // au-delà, le DJ voit « Hors connexion »

/** Visuel des catégories (emoji + dégradé). Les catégories inconnues reçoivent un visuel par défaut. */
const THEME_VISUALS = {
    'Disco Funk':          { emoji: '🪩', from: '#FF007A', to: '#7000FF' },
    'Urbain Français':     { emoji: '🎤', from: '#7000FF', to: '#00A3FF' },
    'Pop Rock':            { emoji: '🎸', from: '#FF4D00', to: '#FF007A' },
    'Hits Français':       { emoji: '🥖', from: '#0055FF', to: '#FF2D55' },
    "Rock n' Roll & Soul": { emoji: '🕺', from: '#B8860B', to: '#FF4D00' },
    'Hits 2010s':          { emoji: '📱', from: '#00C6FF', to: '#7000FF' },
    'Hits 90s':            { emoji: '📼', from: '#00D084', to: '#0077FF' },
    'Hits Soleil':         { emoji: '☀️', from: '#FFB800', to: '#FF4D00' },
    'Hits 2000s':          { emoji: '💿', from: '#9D00FF', to: '#FF00C8' },
    'Classic 80s':         { emoji: '🕹️', from: '#FF00C8', to: '#00F0FF' },
    'Hits 2020s':          { emoji: '🔥', from: '#FF2D55', to: '#FF9500' },
    'Oriental':            { emoji: '🌙', from: '#C48A00', to: '#7A1FA2' },
    'Reggaeton & Latin':   { emoji: '💃', from: '#FF3B30', to: '#FFCC00' },
    'Électro / Club':      { emoji: '🎧', from: '#00F0FF', to: '#0047FF' },
    'Danses de soirée':    { emoji: '🎩', from: '#B8860B', to: '#7000FF' },
};
const FALLBACK_VISUALS = [
    { emoji: '🎵', from: '#FF007A', to: '#00F0FF' },
    { emoji: '🎶', from: '#7000FF', to: '#FF007A' },
    { emoji: '🎼', from: '#00F0FF', to: '#7000FF' },
];
const ALL_THEMES = 'Tous';

// =============================================================================
// 2. UTILITAIRES
// =============================================================================

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Échappe un texte avant insertion dans le HTML (protège contre l'injection de code). */
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const pad = n => String(n).padStart(2, '0');
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function normalizeCode(value) {
    return String(value ?? '').toUpperCase().trim();
}

function sameSong(a, b) {
    return a.title.toLowerCase() === b.title.toLowerCase() && a.artist.toLowerCase() === b.artist.toLowerCase();
}

function downloadFile(filename, content, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = Object.assign(document.createElement('a'), { href: url, download: filename, hidden: true });
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 100);
}

function todayStamp() {
    return new Date().toISOString().slice(0, 10);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Effet visuel éphémère (flash, toast...) supprimé automatiquement. */
function showEffect(className, durationMs, text = '') {
    const el = document.createElement('div');
    el.className = className;
    if (text) el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
    return el;
}

function flashScreen() {
    showEffect('fx-flash', 600);
}

function showToast(text, { isError = false, durationMs = 4000 } = {}) {
    const toast = showEffect(`fx-toast${isError ? ' is-error' : ''}`, durationMs + 600, text);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('is-visible')));
    setTimeout(() => toast.classList.remove('is-visible'), durationMs);
}

// =============================================================================
// 3. ACCÈS FIRESTORE (API REST)
// =============================================================================

const firestore = (() => {
    const DOC_PATH = `artifacts/${FIREBASE.appId}/public/data/playlist/main`;
    const ROOT = `projects/${FIREBASE.projectId}/databases/(default)/documents`;
    const API = 'https://firestore.googleapis.com/v1';
    const DOC_URL = `${API}/${ROOT}/${DOC_PATH}`;

    function toValue(v) {
        if (v === null || v === undefined) return { nullValue: null };
        if (typeof v === 'boolean') return { booleanValue: v };
        if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
        if (typeof v === 'object') {
            return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
        }
        return { stringValue: String(v) };
    }

    function fromValue(v) {
        if (!v) return undefined;
        if ('integerValue' in v) return parseInt(v.integerValue, 10);
        if ('doubleValue' in v) return Number(v.doubleValue);
        if ('stringValue' in v) return v.stringValue;
        if ('booleanValue' in v) return v.booleanValue;
        if ('nullValue' in v) return null;
        if ('mapValue' in v) {
            const fields = v.mapValue.fields || {};
            return Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, fromValue(x)]));
        }
        return undefined;
    }

    async function ensureOk(resp) {
        if (resp.ok) return resp;
        let detail = '';
        try { detail = (await resp.json())?.error?.message || ''; } catch { /* corps illisible */ }
        throw new Error(`Firestore ${resp.status}${detail ? ' : ' + detail : ''}`);
    }

    return {
        /** Lit le document. Renvoie null s'il n'existe pas encore. */
        async read() {
            const resp = await fetch(DOC_URL, { cache: 'no-store' });
            if (resp.status === 404) return null;
            await ensureOk(resp);
            const doc = await resp.json();
            return Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, fromValue(v)]));
        },

        /** Met à jour uniquement les champs fournis (les autres sont conservés). */
        async update(fields) {
            const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
            const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) };
            await ensureOk(await fetch(`${DOC_URL}?${mask}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }));
        },

        /** Ajoute 1 vote à un titre de façon atomique (aucun vote perdu, même simultané). */
        async incrementVote(songId) {
            await ensureOk(await fetch(`${API}/${ROOT}:commit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    writes: [{
                        transform: {
                            document: `${ROOT}/${DOC_PATH}`,
                            fieldTransforms: [{ fieldPath: `songVotes.\`${songId}\``, increment: { integerValue: '1' } }],
                        },
                    }],
                }),
            }));
        },
    };
})();

// =============================================================================
// 4. STOCKAGE LOCAL (navigateur)
// =============================================================================

const storage = {
    KEYS: {
        clientSession: 'dj_client_session',   // session de vote de ce téléphone
        userVotes: 'dj_userVotes',            // votes de ce téléphone
        customSongs: 'dj_customSongs',        // titres ajoutés par le DJ (import M3U8 / ajout manuel)
        endHandledFor: 'dj_endHandledFor',    // fin de soirée déjà traitée (export auto) pour ce minuteur
        endPublishedFor: 'dj_endPublishedFor', // publication automatique déjà faite pour ce minuteur
        legacySongs: 'dj_songs',              // ancien format (v2), migré automatiquement
    },
    get(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible (navigation privée) */ }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch { /* idem */ }
    },
};

// =============================================================================
// 5. ÉTAT DE L'APPLICATION
// =============================================================================

const urlParams = new URLSearchParams(window.location.search);
const DISPLAY_VIEWS = ['qrcode', 'monitor'];
/** Fenêtre « écran géant » : seules ces deux vues sont autorisées via l'URL. */
const displayMode = DISPLAY_VIEWS.includes(urlParams.get('public')) ? urlParams.get('public') : null;

const state = {
    /** Données partagées (copie locale du document Firestore). */
    remote: {
        sessionId: null,
        guestCode: DEFAULTS.guestCode,
        adminCode: DEFAULTS.adminCode,
        eventStartTime: null,
        phase1Duration: DEFAULTS.phase1Duration,
        phase2Duration: DEFAULTS.phase2Duration,
        resultsPublished: false,
        songVotes: {},
    },
    /** Interface. */
    view: displayMode || 'login',          // login | adminLogin | user | admin | qrcode | monitor
    guestScreen: 'categories',             // categories | songs
    selectedTheme: ALL_THEMES,
    searchQuery: '',
    loginError: '',
    modal: null,                           // { type, title, html, confirmLabel, onConfirm }
    phase: 0,                              // 0 = arrêté, 1 = QR code, 2 = Top 40, 3 = clôturé
    /** Votes de ce téléphone pour la session en cours. */
    userVotes: {},
    /** Synchronisation. */
    sync: { ready: false, lastOkAt: 0, pendingWrites: 0, lastWriteDoneAt: 0, online: false },
    resultsNotified: false,
};

// =============================================================================
// 6. CATALOGUE & CLASSEMENT
// =============================================================================

const BASE_SONGS = SONGS.map(([id, title, artist, theme, filepath]) => ({ id, title, artist, theme, filepath: filepath || '' }));
const BASE_IDS = new Set(BASE_SONGS.map(s => s.id));

/** Ancien format v2 : la liste complète était stockée dans « dj_songs ». On n'en garde que les titres ajoutés. */
function migrateLegacySongs() {
    const legacy = storage.get(storage.KEYS.legacySongs);
    if (!Array.isArray(legacy)) return;
    if (storage.get(storage.KEYS.customSongs) === null) {
        const added = legacy
            .filter(s => s && Number.isFinite(s.id) && !BASE_IDS.has(s.id))
            .map(({ id, title, artist, theme, filepath }) => ({ id, title, artist, theme, filepath: filepath || '' }));
        storage.set(storage.KEYS.customSongs, added);
    }
    storage.remove(storage.KEYS.legacySongs);
}

let customSongs = [];
const lastVoteAt = new Map();
let allSongs = BASE_SONGS;

function loadCustomSongs() {
    const saved = storage.get(storage.KEYS.customSongs, []);
    customSongs = Array.isArray(saved) ? saved.filter(s => s && !BASE_IDS.has(s.id)) : [];
    allSongs = BASE_SONGS.concat(customSongs);
}

function addCustomSongs(songs) {
    let nextId = Math.max(0, ...allSongs.map(s => s.id)) + 1;
    const added = songs.map(s => ({ ...s, id: nextId++ }));
    customSongs = customSongs.concat(added);
    allSongs = BASE_SONGS.concat(customSongs);
    storage.set(storage.KEYS.customSongs, customSongs);
    return added;
}

function votesOf(song) {
    return Number(state.remote.songVotes[song.id]) || 0;
}

function totalVotes() {
    return Object.values(state.remote.songVotes).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function rankedSongs(limit = Infinity) {
    return allSongs
        .map(song => ({ ...song, votes: votesOf(song) }))
        .filter(song => song.votes > 0)
        .sort((a, b) => b.votes - a.votes)
        .slice(0, limit);
}

function topSongs() {
    return rankedSongs(TOP_SIZE);
}

/** Catégories affichées en dernier sur l'écran d'accueil invité (dans cet ordre). */
const THEMES_LAST = ['Urbain Français'];

function themesWithCounts() {
    const counts = new Map();
    for (const song of allSongs) counts.set(song.theme, (counts.get(song.theme) || 0) + 1);
    const rank = name => THEMES_LAST.indexOf(name); // -1 = ordre normal
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => (rank(a.name) >= 0) - (rank(b.name) >= 0) || rank(a.name) - rank(b.name));
}

function themeVisual(name, index = 0) {
    return THEME_VISUALS[name] || FALLBACK_VISUALS[index % FALLBACK_VISUALS.length];
}

function userVoteTotal() {
    return Object.values(state.userVotes).reduce((sum, v) => sum + v, 0);
}

// =============================================================================
// 7. MINUTEUR & PHASES
// =============================================================================

/** Calcule la phase et les temps restants à partir de l'heure de départ partagée. */
function computeTimer(now = Date.now()) {
    const { eventStartTime, phase1Duration: p1, phase2Duration: p2 } = state.remote;
    if (!eventStartTime) return { phase: 0, phaseLeft: 0, totalLeft: 0 };
    const elapsed = now - eventStartTime;
    const totalLeft = Math.max(0, p1 + p2 - elapsed);
    if (elapsed < p1) return { phase: 1, phaseLeft: p1 - elapsed, totalLeft };
    if (elapsed < p1 + p2) return { phase: 2, phaseLeft: p1 + p2 - elapsed, totalLeft };
    return { phase: 3, phaseLeft: 0, totalLeft: 0 };
}

/** Appelé chaque seconde et après chaque synchronisation. */
function tick() {
    const timer = computeTimer();

    updateTextAll('.dynamic-timer-display', formatDuration(timer.phaseLeft));
    updateTextAll('.global-timer-display', formatDuration(timer.totalLeft));

    const online = Date.now() - state.sync.lastOkAt < OFFLINE_AFTER_MS;
    if (online !== state.sync.online) {
        state.sync.online = online;
        if (state.view === 'admin') render();
    }

    if (timer.phase !== state.phase) {
        state.phase = timer.phase;
        if (timer.phase === 3 && state.view === 'user') window.scrollTo({ top: 0, behavior: 'smooth' });
        // Fin du compte à rebours : chaque téléphone affiche les résultats, bipe et vibre de lui-même,
        // sans attendre le tableau de bord DJ.
        checkResultsNotification();
        render();
    }

    // Écran géant : passe automatiquement du QR code au classement dès la phase 2.
    if (displayMode && state.view === 'qrcode' && timer.phase >= 2) {
        state.view = 'monitor';
        render();
    }

    handleEndOfEvent(timer.phase);
}

function updateTextAll(selector, text) {
    document.querySelectorAll(selector).forEach(el => { if (el.textContent !== text) el.textContent = text; });
}

/**
 * Fin de soirée (côté DJ uniquement) : export M3U8 + publication automatique des résultats.
 * Mémorisé par minuteur pour ne pas se répéter à chaque rechargement de la page.
 */
function handleEndOfEvent(phase) {
    if (phase !== 3 || !state.remote.eventStartTime) return;
    const eventKey = String(state.remote.eventStartTime);

    // Publication automatique : faite par le tableau de bord DJ OU par la fenêtre écran géant,
    // pour ne pas dépendre d'un seul ordinateur. (Les téléphones bipent de toute façon d'eux-mêmes.)
    if ((state.view === 'admin' || displayMode) && storage.get(storage.KEYS.endPublishedFor) !== eventKey) {
        storage.set(storage.KEYS.endPublishedFor, eventKey);
        if (!state.remote.resultsPublished) setTimeout(() => publishResults({ auto: true }), 1000);
    }

    // Export M3U8 automatique : uniquement sur le tableau de bord DJ.
    if (state.view === 'admin' && !displayMode && storage.get(storage.KEYS.endHandledFor) !== eventKey) {
        storage.set(storage.KEYS.endHandledFor, eventKey);
        setTimeout(() => actions.downloadM3U(), 500);
    }
}

// =============================================================================
// 8. SYNCHRONISATION
// =============================================================================

/** Lit le document partagé et met à jour l'affichage si quelque chose a changé. */
async function syncFromServer() {
    const startedAt = Date.now();
    let data;
    try {
        data = await firestore.read();
    } catch (err) {
        console.warn('Lecture Firestore impossible :', err.message);
        return false;
    }

    state.sync.lastOkAt = Date.now();
    state.sync.ready = true;

    if (data === null) {
        // Première utilisation : création du document avec les valeurs par défaut.
        await writeRemote({ ...DEFAULTS, sessionId: String(Date.now()), eventStartTime: null, resultsPublished: false, songVotes: {} }, { silent: true });
        return true;
    }

    // Une écriture locale est en cours ou s'est terminée pendant la lecture : la lecture est périmée.
    if (state.sync.pendingWrites > 0 || startedAt < state.sync.lastWriteDoneAt) return true;

    applyRemote(data);
    return true;
}

function applyRemote(data) {
    const previous = state.remote;
    const next = {
        sessionId: data.sessionId || previous.sessionId || 'init',
        guestCode: data.guestCode || DEFAULTS.guestCode,
        adminCode: data.adminCode || DEFAULTS.adminCode,
        eventStartTime: Number.isFinite(data.eventStartTime) ? data.eventStartTime : null,
        phase1Duration: data.phase1Duration || DEFAULTS.phase1Duration,
        phase2Duration: data.phase2Duration || DEFAULTS.phase2Duration,
        resultsPublished: data.resultsPublished === true,
        songVotes: data.songVotes || {},
    };

    // Les compteurs de votes ne sont pas affichés chez l'invité pendant le vote : inutile de tout redessiner.
    const withoutVotes = r => JSON.stringify({ ...r, songVotes: null });
    const votesOnly = withoutVotes(next) === withoutVotes(previous);
    const guestScreen = ['user', 'login', 'adminLogin'].includes(state.view) && !next.resultsPublished && state.phase !== 3;
    const changed = JSON.stringify(next) !== JSON.stringify(previous) && !(votesOnly && guestScreen);
    const votesIncreased = sumValues(next.songVotes) > sumValues(previous.songVotes);
    state.remote = next;

    if (next.sessionId !== previous.sessionId) {
        loadUserVotesForSession();
        // Nouveau tour / nouvelle soirée : l'invité repart de l'accueil des catégories.
        if (previous.sessionId && state.view === 'user') state.guestScreen = 'categories';
    }
    if (votesIncreased && (state.view === 'qrcode' || state.view === 'monitor')) flashScreen();

    if (changed) render();
    tick();
    checkResultsNotification();
}

function sumValues(obj) {
    return Object.values(obj || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * Écrit des champs dans le document partagé.
 * En cas d'échec, le DJ est prévenu (sauf mode silencieux) au lieu d'un échec invisible.
 */
async function writeRemote(fields, { silent = false } = {}) {
    state.sync.pendingWrites++;
    try {
        await firestore.update(fields);
        return true;
    } catch (err) {
        console.error('Écriture Firestore impossible :', err);
        if (!silent) {
            showModal('alert', '⚠️ Synchronisation impossible',
                `Le changement n'a pas pu être envoyé au serveur, les invités ne le verront pas.<br><br>
                 <span class="text-sm text-magical-pink">${esc(err.message)}</span><br><br>
                 Vérifie la connexion internet et recommence.`);
        }
        return false;
    } finally {
        state.sync.pendingWrites--;
        state.sync.lastWriteDoneAt = Date.now();
    }
}

/** Applique localement puis envoie au serveur. */
async function updateShared(fields, options) {
    for (const [key, value] of Object.entries(fields)) {
        if (key in state.remote) state.remote[key] = value;
    }
    render();
    tick();
    return writeRemote(fields, options);
}

/** Attend la première lecture du serveur (utile si l'invité tape son code très vite). */
async function ensureSynced(timeoutMs = 6000) {
    if (state.sync.ready) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await syncFromServer()) return true;
        await wait(700);
    }
    return state.sync.ready;
}

/** Boucle de lecture : plus rapide pendant le Top 40 et après la clôture. */
async function pollLoop() {
    await syncFromServer();
    const delay = state.phase >= 2 ? POLL_INTERVAL_FAST : POLL_INTERVAL_NORMAL;
    setTimeout(pollLoop, delay);
}

// ---- Votes de ce téléphone ----

function loadUserVotesForSession() {
    const sessionId = state.remote.sessionId;
    if (!sessionId) return;
    if (storage.get(storage.KEYS.clientSession) !== sessionId) {
        // Nouvelle soirée ou nouveau tour : les crédits sont remis à zéro.
        state.userVotes = {};
        storage.set(storage.KEYS.clientSession, sessionId);
        storage.set(storage.KEYS.userVotes, {});
    } else {
        const saved = storage.get(storage.KEYS.userVotes, {});
        state.userVotes = saved && typeof saved === 'object' ? saved : {};
    }
}

function saveUserVotes() {
    storage.set(storage.KEYS.userVotes, state.userVotes);
}

// =============================================================================
// 9. NOTIFICATIONS INVITÉS (son, vibration, écran allumé)
// =============================================================================

const notifier = (() => {
    let audioCtx = null;
    let wakeLock = null;
    let keepAliveTimer = null;

    function playSilentTone(gainValue, durationS) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = gainValue;
        osc.frequency.value = 1;
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + durationS);
    }

    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator && !wakeLock) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => { wakeLock = null; });
            }
        } catch { /* non supporté ou refusé */ }
    }

    return {
        get isUnlocked() { return audioCtx !== null; },

        /** Doit être appelé lors d'un geste de l'utilisateur (exigence iOS). */
        unlock() {
            if (audioCtx) return;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                audioCtx = new Ctx();
                playSilentTone(0.0001, 0.001);
                // Son inaudible toutes les 25 s : empêche iOS de suspendre l'audio.
                keepAliveTimer = setInterval(() => {
                    try {
                        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
                        playSilentTone(0.00001, 0.01);
                    } catch { /* ignoré */ }
                }, 25000);
                requestWakeLock();
            } catch { /* navigateur ancien */ }
        },

        /** Retour au premier plan : réactive l'audio et l'écran allumé. */
        resume() {
            if (!audioCtx) return;
            requestWakeLock();
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        },

        /** Trois notes ascendantes (Do-Mi-Sol), jouées deux fois. */
        async beep() {
            if (!audioCtx) return;
            try {
                if (audioCtx.state === 'suspended') await audioCtx.resume();
                const now = audioCtx.currentTime;
                [0, 0.9].forEach(offset => {
                    [523.25, 659.25, 783.99].forEach((freq, i) => {
                        const osc = audioCtx.createOscillator();
                        const gain = audioCtx.createGain();
                        const t0 = now + offset + i * 0.18;
                        osc.type = 'sine';
                        osc.frequency.value = freq;
                        gain.gain.setValueAtTime(0, t0);
                        gain.gain.linearRampToValueAtTime(0.4, t0 + 0.02);
                        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
                        osc.connect(gain).connect(audioCtx.destination);
                        osc.start(t0);
                        osc.stop(t0 + 0.4);
                    });
                });
            } catch { /* ignoré */ }
        },

        vibrate() {
            try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch { /* ignoré */ }
        },

        stopKeepAlive() { clearInterval(keepAliveTimer); },
    };
})();

/** Prévient l'invité (une seule fois) quand le DJ publie les résultats. */
/** Résultats visibles chez l'invité : publiés par le DJ, ou fin du compte à rebours atteinte. */
function resultsAvailable() {
    return state.remote.resultsPublished || (!!state.remote.eventStartTime && state.phase === 3);
}

function checkResultsNotification() {
    if (!resultsAvailable()) {
        state.resultsNotified = false;
        return;
    }
    if (state.view !== 'user' || state.resultsNotified) return;
    state.resultsNotified = true;

    // Plusieurs tentatives : sur iOS, la reprise de l'audio peut prendre 1 à 2 secondes.
    notifier.beep();
    setTimeout(() => notifier.beep(), 1000);
    setTimeout(() => notifier.beep(), 3000);
    notifier.vibrate();
    showEffect('fx-results-flash', 1900);
    showToast('🎉 RÉSULTATS FINAUX DISPONIBLES');
    setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 200);
    render();
}

/** Au retour de veille (iOS notamment), on rattrape immédiatement le retard. */
function handleAppResume() {
    if (!notifier.isUnlocked) return;
    notifier.resume();
    syncFromServer();
    setTimeout(syncFromServer, 1000);
    setTimeout(syncFromServer, 3000);
}

// =============================================================================
// 10. ACTIONS
// =============================================================================

function showModal(type, title, html, { onConfirm = null, confirmLabel = 'Confirmer' } = {}) {
    state.modal = { type, title, html, onConfirm, confirmLabel };
    render();
}

function closeModal() {
    state.modal = null;
    render();
}

function cleanUrl() {
    try {
        const url = new URL(window.location.href);
        if (url.protocol === 'blob:') return;
        url.searchParams.delete('code');
        url.searchParams.delete('s');
        window.history.replaceState({}, document.title, url.pathname + url.search);
    } catch { /* environnement restreint */ }
}

function openDisplayWindow(type) {
    const url = `${window.location.href.split(/[?#]/)[0]}?public=${type}`;
    window.open(url, 'UniversalDJ_Display', 'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no');
    showModal('alert', 'Fenêtre externe ouverte',
        'Une nouvelle fenêtre vient de s\'ouvrir.<br><br>Faites-la glisser sur votre 2ème écran (TV ou vidéoprojecteur) puis appuyez sur <strong>F11</strong> pour la mettre en plein écran.');
}

function qrCodeUrl() {
    // Le code de la soirée est inclus : le téléphone l'affiche pré-rempli en arrivant.
    const target = `${PUBLIC_URL}?code=${encodeURIComponent(state.remote.guestCode || '')}&s=${encodeURIComponent(state.remote.sessionId || '')}`;
    return `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(target)}&color=050212&bgcolor=FFFFFF`;
}

async function publishResults({ auto = false } = {}) {
    const ok = await updateShared({ resultsPublished: true, resultsPublishedAt: Date.now() });
    if (ok && !auto) {
        showModal('alert', '📣 Résultats publiés !',
            'Les téléphones des invités vont biper et basculer automatiquement vers le classement final.');
    }
}

// ---- Formulaires de la fenêtre modale (ajout / import de titres) ----

function themeSelectHtml(id) {
    return `
        <select id="${id}" class="w-full bg-black/60 border border-white/20 rounded-xl py-3 px-4 text-white focus:outline-none focus:border-magical-cyan transition-all">
            ${themesWithCounts().map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}
        </select>`;
}

const INPUT_CLASS = 'w-full bg-black/60 border border-white/20 rounded-xl py-3 px-4 text-white focus:outline-none focus:border-magical-cyan focus:ring-2 focus:ring-magical-cyan/40 transition-all';
const LABEL_CLASS = 'block text-sm text-white/60 mb-1 uppercase tracking-widest font-bold';

function inputValue(id) {
    return document.getElementById(id)?.value?.trim() || '';
}

function parseM3U(text) {
    const songs = [];
    let extinf = null;
    const splitArtistTitle = label => {
        const parts = label.split(' - ');
        return parts.length >= 2
            ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
            : { artist: 'Inconnu', title: label.trim() };
    };

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/^\uFEFF/, '').trim();
        if (!line) continue;
        if (line.startsWith('#EXTINF:')) {
            const match = line.match(/^#EXTINF:[^,]*,(.*)$/);
            extinf = match ? match[1].trim() : null;
        } else if (!line.startsWith('#')) {
            let label = extinf;
            if (!label) {
                // Pas d'information : on déduit « Artiste - Titre » du nom du fichier.
                label = (line.split(/[/\\]/).pop() || '')
                    .replace(/\.[^.]+$/, '')
                    .replace(/^\d+[\s._-]+/, '');
            }
            const { artist, title } = splitArtistTitle(label);
            if (title) songs.push({ title, artist, filepath: line });
            extinf = null;
        }
    }
    return songs;
}

/** Toutes les actions déclenchées depuis l'interface (attribut data-action). */
const actions = {
    // ---- Navigation ----
    goTo(view) {
        if (!['login', 'adminLogin'].includes(view)) return; // les autres vues exigent une connexion
        state.view = view;
        state.loginError = '';
        render();
    },
    logout() {
        state.view = 'login';
        state.loginError = '';
        state.guestScreen = 'categories';
        render();
    },
    closeModal,
    confirmModal() {
        const { onConfirm } = state.modal || {};
        state.modal = null;
        // La fenêtre se ferme AVANT l'action : une nouvelle fenêtre ouverte par l'action reste visible.
        if (onConfirm) onConfirm();
        render();
    },
    closeDisplay() {
        window.close();
    },

    // ---- Connexion ----
    async guestLogin(_arg, form) {
        notifier.unlock(); // geste utilisateur : débloque le son sur iOS
        const input = normalizeCode(form.querySelector('input')?.value);
        if (!input) return;
        if (!(await ensureSynced())) {
            state.loginError = 'Connexion impossible. Vérifie ta connexion internet et réessaie.';
            return render();
        }
        if (input !== normalizeCode(state.remote.guestCode)) {
            prefillCode = ''; // ancien QR code : on laisse l'invité taper le code affiché
            state.loginError = 'Code incorrect. Regarde le code affiché sur l\'écran de la soirée.';
            return render();
        }
        state.view = 'user';
        state.guestScreen = 'categories';
        state.loginError = '';
        state.resultsNotified = resultsAvailable(); // pas de bip pour des résultats déjà affichés avant la connexion
        loadUserVotesForSession();
        cleanUrl();
        render();
    },
    async adminLogin(_arg, form) {
        const input = normalizeCode(form.querySelector('input')?.value);
        if (!input) return;
        if (!(await ensureSynced())) {
            state.loginError = 'Connexion au serveur impossible. Réessaie dans un instant.';
            return render();
        }
        if (input !== normalizeCode(state.remote.adminCode || DEFAULTS.adminCode)) {
            state.loginError = 'Code DJ incorrect !';
            return render();
        }
        state.view = 'admin';
        state.loginError = '';
        render();
        tick();
    },

    // ---- Invités : navigation dans les catégories ----
    showCategories() {
        state.guestScreen = 'categories';
        state.searchQuery = '';
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    openTheme(theme) {
        state.selectedTheme = theme;
        state.guestScreen = 'songs';
        state.searchQuery = '';
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    search(_arg, input) {
        state.searchQuery = input.value.toLowerCase();
        if (state.guestScreen === 'categories') {
            // Recherche lancée depuis l'accueil : on bascule sur tous les titres (le champ garde le focus).
            state.guestScreen = 'songs';
            state.selectedTheme = ALL_THEMES;
            return render();
        }
        filterSongCards();
    },

    // ---- Invités : vote ----
    async vote(songIdArg) {
        const songId = Number(songIdArg);
        if (state.phase === 3 || state.remote.resultsPublished) {
            return showModal('alert', 'Votes clôturés', 'Les votes sont terminés pour cette session ! Regardez l\'écran géant.');
        }
        const already = state.userVotes[songId] || 0;
        if (userVoteTotal() >= MAX_TOTAL_VOTES || already >= MAX_VOTES_PER_SONG) return;

        // Anti double-appui : un 2e vote sur le même titre exige un vrai second geste.
        const now = Date.now();
        if (now - (lastVoteAt.get(songId) || 0) < DOUBLE_TAP_GUARD_MS) return;
        lastVoteAt.set(songId, now);

        // 1. Mise à jour immédiate à l'écran (uniquement le bouton touché et les crédits).
        state.userVotes[songId] = already + 1;
        state.remote.songVotes[songId] = (Number(state.remote.songVotes[songId]) || 0) + 1;
        patchVoteUI(songId);
        saveUserVotes();

        // 2. Envoi au serveur ; en cas d'échec, le crédit est rendu à l'invité.
        state.sync.pendingWrites++;
        try {
            await firestore.incrementVote(songId);
            flashScreen();
        } catch (err) {
            console.warn('Vote non enregistré :', err.message);
            state.userVotes[songId] = already;
            if (!already) delete state.userVotes[songId];
            state.remote.songVotes[songId] = Math.max(0, (Number(state.remote.songVotes[songId]) || 1) - 1);
            saveUserVotes();
            patchVoteUI(songId);
            showToast('Vote non enregistré (connexion). Réessaie !', { isError: true });
            return;
        } finally {
            state.sync.pendingWrites--;
            state.sync.lastWriteDoneAt = Date.now();
        }

        // 3. Tous les crédits utilisés : remerciement puis redirection.
        if (userVoteTotal() >= MAX_TOTAL_VOTES) {
            showModal('goodbye', 'Merci pour votre participation !',
                `Vos ${MAX_TOTAL_VOTES} votes ont été enregistrés avec succès.<br><br>L'application va se fermer pour laisser place à la musique !`);
            setTimeout(() => { window.location.href = GOODBYE_URL; }, 3000);
        }
    },
    async replayNotification() {
        notifier.unlock();
        await wait(100);
        await notifier.beep();
        notifier.vibrate();
    },

    // ---- DJ : minuteur ----
    startTimer(presetKey) {
        const preset = TIMER_PRESETS[presetKey];
        if (!preset) return;
        const fmt = min => (min >= 60 ? `${min / 60} Heure${min >= 120 ? 's' : ''}` : `${min} Minute${min > 1 ? 's' : ''}`);
        showModal('confirm', `Démarrer le minuteur (${preset.label}) ?`,
            `- ${fmt(preset.p1)} : QR Code géant.<br>- ${fmt(preset.p2)} : Top 40.${preset.isTest ? ' (TEST)' : ''}<br>- Ensuite : clôture des votes.`,
            {
                onConfirm: () => {
                    storage.remove(storage.KEYS.endHandledFor);
                    storage.remove(storage.KEYS.endPublishedFor);
                    updateShared({
                        phase1Duration: preset.p1 * 60000,
                        phase2Duration: preset.p2 * 60000,
                        eventStartTime: Date.now(),
                        resultsPublished: false,
                    });
                    openDisplayWindow('qrcode');
                },
            });
    },
    stopTimer() {
        showModal('confirm', 'Arrêter le minuteur',
            '⚠️ Voulez-vous vraiment arrêter le minuteur et stopper l\'affichage public ?',
            { onConfirm: () => updateShared({ eventStartTime: null }) });
    },
    forceEnd() {
        showModal('confirm', 'Clôturer et résultats',
            '⚠️ Voulez-vous clôturer définitivement les votes, afficher le classement final sur l\'écran géant, générer le fichier M3U8 et notifier les téléphones invités ?',
            {
                onConfirm: () => {
                    const { phase1Duration, phase2Duration } = state.remote;
                    const eventStartTime = Date.now() - (phase1Duration + phase2Duration + 5000);
                    storage.set(storage.KEYS.endHandledFor, String(eventStartTime)); // évite un double export
                    updateShared({ eventStartTime, resultsPublished: true, resultsPublishedAt: Date.now() });
                    actions.downloadM3U();
                    openDisplayWindow('monitor');
                },
            });
    },

    // ---- DJ : résultats ----
    publishResults() {
        showModal('confirm', 'Publier les résultats ?',
            'Les téléphones des invités recevront une notification (bip + vibration) et basculeront automatiquement vers le Top 40 final.<br><br>À utiliser seulement quand les votes sont clos.',
            { onConfirm: () => publishResults() });
    },
    unpublishResults() {
        showModal('confirm', 'Retirer les résultats ?',
            'Les téléphones des invités reviendront à l\'écran de vote.',
            { onConfirm: () => updateShared({ resultsPublished: false }) });
    },

    // ---- DJ : tours de vote ----
    newRound() {
        showModal('confirm', 'Nouveau tour de votes',
            `Cela va générer un nouveau QR Code. En le scannant, les invités recevront ${MAX_TOTAL_VOTES} nouveaux crédits !<br><br><strong class="text-magical-cyan">Les scores actuels des chansons seront CONSERVÉS.</strong>`,
            {
                onConfirm: async () => {
                    if (await updateShared({ sessionId: String(Date.now()) })) {
                        showModal('alert', 'Succès', '✅ C\'est prêt ! Affichez le QR Code sur l\'écran géant, les invités n\'ont plus qu\'à le scanner pour revoter.');
                    }
                },
            });
    },
    resetAll() {
        showModal('confirm', 'Remise à zéro totale',
            '⚠️ Attention, cela va effacer tous les votes, arrêter le minuteur et réinitialiser les crédits de tout le monde.<br><br><span class="text-sm text-white/60">Les codes d\'accès et les titres ajoutés sont conservés.</span>',
            {
                onConfirm: async () => {
                    storage.remove(storage.KEYS.endHandledFor);
                    const ok = await updateShared({
                        sessionId: String(Date.now()),
                        eventStartTime: null,
                        resultsPublished: false,
                        songVotes: {},
                    });
                    if (ok) showModal('alert', 'Succès', '✅ L\'application a été entièrement remise à zéro pour une nouvelle soirée.');
                },
            });
    },

    // ---- DJ : codes d'accès ----
    async updateGuestCode() {
        const code = normalizeCode(inputValue('newGuestCode'));
        if (!code) return;
        if (await updateShared({ guestCode: code })) {
            showModal('alert', '✅ Mot de passe modifié',
                `Le mot de passe de la soirée est désormais :<br><br><strong class="text-4xl text-magical-cyan tracking-widest">${esc(code)}</strong><br><br><span class="text-sm text-white/60">Les invités peuvent maintenant se connecter avec ce code.</span>`);
        }
    },
    async updateAdminCode() {
        const code = normalizeCode(inputValue('newAdminCode'));
        if (!code) return;
        if (await updateShared({ adminCode: code })) {
            showModal('alert', '✅ Code DJ modifié',
                `Le code administrateur est désormais :<br><br><strong class="text-4xl text-magical-purple tracking-widest">${esc(code)}</strong><br><br><span class="text-sm text-white/60">Garde-le en lieu sûr !</span>`);
        }
    },

    // ---- DJ : écran géant ----
    openDisplay(type) {
        if (DISPLAY_VIEWS.includes(type)) openDisplayWindow(type);
    },

    // ---- DJ : fichiers ----
    downloadM3U() {
        const top = topSongs();
        if (top.length === 0) {
            return showModal('alert', 'Aucun vote', 'Il n\'y a pas encore de votes pour générer la playlist.');
        }
        downloadM3UFile(`Universal_DJ_Top40_${todayStamp()}.m3u8`, top.map(song => ({ ...song, path: song.filepath })));
    },
    exportBestVersions() {
        if (topSongs().length === 0) {
            return showModal('alert', 'Aucun vote', 'Il n\'y a pas encore de votes pour générer la playlist.');
        }
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.xml', hidden: true });
        document.body.appendChild(input);
        input.addEventListener('change', () => {
            const file = input.files[0];
            input.remove();
            if (file) exportBestVersionsFrom(file);
        });
        input.click();
    },
    importM3U() {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.m3u8,.m3u', multiple: true, hidden: true });
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const files = [...input.files];
            input.remove();
            if (!files.length) return;
            const texts = await Promise.all(files.map(f => f.text().catch(() => '')));
            showImportModal(texts.flatMap(parseM3U), files.map(f => f.name).join(', '));
        });
        input.click();
    },
    addSong() {
        showModal('custom', '🎵 Ajouter un titre', `
            <div class="flex flex-col gap-4 text-left">
                <div><label class="${LABEL_CLASS}" for="add-artist">Artiste *</label>
                    <input id="add-artist" type="text" placeholder="Ex : Daft Punk" class="${INPUT_CLASS}"></div>
                <div><label class="${LABEL_CLASS}" for="add-title">Titre *</label>
                    <input id="add-title" type="text" placeholder="Ex : Get Lucky" class="${INPUT_CLASS}"></div>
                <div><label class="${LABEL_CLASS}" for="add-theme">Catégorie</label>
                    ${themeSelectHtml('add-theme')}
                    <input id="add-theme-new" type="text" placeholder="…ou nouvelle catégorie (facultatif)" class="${INPUT_CLASS} mt-2 text-magical-cyan"></div>
                <div><label class="${LABEL_CLASS}" for="add-filepath">Chemin fichier <span class="text-white/30">(optionnel, pour l'export M3U8)</span></label>
                    <input id="add-filepath" type="text" placeholder="Ex : I:\\Musique\\Daft Punk - Get Lucky.mp3" class="${INPUT_CLASS} text-sm font-mono"></div>
            </div>`,
        {
            confirmLabel: 'Ajouter',
            onConfirm: () => {
                const song = {
                    artist: inputValue('add-artist'),
                    title: inputValue('add-title'),
                    theme: inputValue('add-theme-new') || inputValue('add-theme'),
                    filepath: inputValue('add-filepath'),
                };
                if (!song.artist || !song.title) {
                    return showModal('alert', 'Champs requis', 'L\'artiste et le titre sont obligatoires.');
                }
                if (allSongs.some(s => sameSong(s, song))) {
                    return showModal('alert', 'Doublon', `<strong>${esc(song.artist)} - ${esc(song.title)}</strong> existe déjà dans la playlist.`);
                }
                addCustomSongs([song]);
                showModal('alert', 'Titre ajouté !',
                    `<strong>${esc(song.artist)} - ${esc(song.title)}</strong><br>ajouté à la catégorie « <strong>${esc(song.theme)}</strong> ».<br><br>
                     <span class="text-sm text-white/60">Pour que les invités le voient, exporte la liste (bouton &lt;/&gt;) et remplace <strong>songs.js</strong> sur GitHub.</span>`);
            },
        });
    },
    exportSongList() {
        const header = [
            '// Catalogue des titres proposés au vote.',
            '// Format de chaque ligne : [id, "Titre", "Artiste", "Catégorie", "Chemin du fichier (Rekordbox)"]',
            '// Ce fichier peut être régénéré depuis le tableau de bord DJ (bouton « Exporter la liste »).',
            'export const SONGS = [',
        ];
        const rows = allSongs.map(s => '  ' + JSON.stringify([s.id, s.title, s.artist, s.theme, s.filepath || '']) + ',');
        downloadFile('songs.js', [...header, ...rows, '];', ''].join('\n'), 'text/javascript;charset=utf-8');
        showModal('alert', 'Liste exportée !',
            `<strong>${allSongs.length}</strong> titres dans le fichier <strong>songs.js</strong>` +
            (customSongs.length ? `, dont <strong>${customSongs.length}</strong> ajoutés par toi.` : '.') +
            '<br><br>Remplace le fichier <strong>songs.js</strong> sur GitHub par celui-ci pour que les invités voient les nouveaux titres.');
    },
};

/** Écrit un fichier M3U8 (UTF-8) lisible par Rekordbox. */
function downloadM3UFile(filename, entries) {
    const lines = ['#EXTM3U'];
    for (const entry of entries) {
        lines.push(`#EXTINF:-1,${entry.artist} - ${entry.title}`);
        lines.push(entry.path || `${entry.artist} - ${entry.title}.mp3`);
    }
    downloadFile(filename, lines.join('\n') + '\n', 'audio/x-mpegurl;charset=utf-8');
}

/**
 * Top 40 avec, pour chaque titre voté, la version de l'interprète la plus jouée dans Rekordbox.
 * Le XML est lu sur place par le navigateur : il n'est envoyé nulle part.
 */
async function exportBestVersionsFrom(file) {
    showModal('progress', '🎧 Lecture de ta bibliothèque Rekordbox',
        `<p>${esc(file.name)}</p><p class="mt-4 text-4xl font-black text-magical-cyan" id="rb-progress">0 %</p>
         <p class="mt-2 text-sm text-white/50">Le fichier reste sur cet ordinateur.</p>`);
    await wait(50);

    let tracks;
    try {
        tracks = await rekordbox.parseCollectionFile(file, ratio => {
            const el = document.getElementById('rb-progress');
            if (el) el.textContent = `${Math.round(ratio * 100)} %`;
        });
    } catch (err) {
        return showModal('alert', 'Lecture impossible', `Le fichier n'a pas pu être lu :<br><span class="text-sm text-magical-pink">${esc(err.message)}</span>`);
    }
    if (tracks.length === 0) {
        return showModal('alert', 'Fichier non reconnu',
            'Aucun morceau trouvé. Exporte la collection depuis Rekordbox : <strong>Fichier → Exporter la collection au format xml</strong>.');
    }

    const index = rekordbox.buildIndex(tracks);
    const report = topSongs().map((song, i) => {
        const { best, versions } = rekordbox.findBestVersion(song, index);
        const chosen = best || { path: song.filepath, playCount: null };
        return {
            rank: i + 1, song, chosen, versions: versions.length,
            changed: !!best && rekordbox.pathKey(best.path) !== rekordbox.pathKey(song.filepath),
            found: !!best,
        };
    });

    downloadM3UFile(`Universal_DJ_Top40_Versions_Preferees_${todayStamp()}.m3u8`,
        report.map(r => ({ artist: r.song.artist, title: r.song.title, path: r.chosen.path })));

    const changedCount = report.filter(r => r.changed).length;
    const missing = report.filter(r => !r.found).length;
    const rows = report.map(r => `
        <tr class="border-t border-white/10 ${r.changed ? 'text-white' : 'text-white/60'}">
            <td class="py-2 pr-2 font-black text-magical-cyan">${r.rank}</td>
            <td class="py-2 pr-2"><div class="font-bold truncate max-w-[14rem]">${esc(r.song.title)}</div><div class="text-xs text-white/50 truncate max-w-[14rem]">${esc(r.song.artist)}</div></td>
            <td class="py-2 pr-2 text-xs break-all">${r.found ? esc(rekordbox.fileName(r.chosen.path)) : '<span class="text-magical-pink">non trouvé (version du catalogue)</span>'}</td>
            <td class="py-2 text-right font-black whitespace-nowrap">${r.chosen.playCount ?? '–'}${r.changed ? ' <span class="text-magical-gold">★</span>' : ''}</td>
        </tr>`).join('');

    showModal('alert', '✅ Top 40 « versions préférées » téléchargé',
        `<p class="text-base"><strong>${tracks.length.toLocaleString('fr-FR')}</strong> morceaux lus dans Rekordbox.
         <strong class="text-magical-gold">${changedCount}</strong> titres remplacés par ta version la plus jouée (★)${missing ? `, <strong class="text-magical-pink">${missing}</strong> non trouvés` : ''}.</p>
         <div class="mt-4 max-h-[45vh] overflow-y-auto text-left text-sm">
            <table class="w-full"><thead><tr class="text-xs uppercase tracking-widest text-white/40"><th class="text-left">#</th><th class="text-left">Titre</th><th class="text-left">Fichier choisi</th><th class="text-right">Lectures</th></tr></thead>
            <tbody>${rows}</tbody></table>
         </div>`);
}

function showImportModal(parsed, fileNames) {
    // Doublons exclus : déjà présents dans la playlist ou répétés dans le fichier importé.
    const fresh = [];
    for (const song of parsed) {
        if (!allSongs.some(s => sameSong(s, song)) && !fresh.some(s => sameSong(s, song))) fresh.push(song);
    }

    const preview = fresh.slice(0, 50).map(s => `<div>${esc(s.artist)} — ${esc(s.title)}</div>`).join('');
    const body = `
        <div class="flex flex-col gap-4 text-left">
            <div class="bg-black/40 rounded-xl p-4 border border-white/10">
                <p class="text-white/60 text-sm mb-1">Fichier(s) : <strong class="text-white">${esc(fileNames)}</strong></p>
                <p class="text-white/60 text-sm">Titres trouvés : <strong class="text-magical-cyan text-lg">${parsed.length}</strong></p>
                <p class="text-white/60 text-sm">Nouveaux (hors doublons) : <strong class="text-magical-pink text-lg">${fresh.length}</strong></p>
            </div>
            ${fresh.length === 0 ? '<p class="text-magical-pink font-bold text-center">Aucun nouveau titre à importer (tous déjà présents).</p>' : `
            <div><label class="${LABEL_CLASS}" for="import-theme">Ajouter à la catégorie :</label>${themeSelectHtml('import-theme')}</div>
            <div><label class="${LABEL_CLASS}" for="import-theme-new">Ou créer une nouvelle catégorie :</label>
                <input id="import-theme-new" type="text" placeholder="Laisser vide pour utiliser la catégorie ci-dessus…" class="${INPUT_CLASS} text-magical-cyan"></div>
            <details class="bg-black/30 rounded-xl border border-white/10">
                <summary class="p-3 cursor-pointer text-sm text-white/50 hover:text-white/80 transition-colors">Aperçu des titres (${fresh.length})</summary>
                <div class="max-h-40 overflow-y-auto p-3 pt-0 text-xs text-white/60 space-y-1">
                    ${preview}
                    ${fresh.length > 50 ? `<div class="text-magical-pink font-bold mt-2">… et ${fresh.length - 50} autres</div>` : ''}
                </div>
            </details>`}
        </div>`;

    if (fresh.length === 0) return showModal('alert', '📂 Import M3U8', body);

    showModal('custom', '📂 Import M3U8', body, {
        confirmLabel: 'Importer',
        onConfirm: () => {
            const theme = inputValue('import-theme-new') || inputValue('import-theme');
            if (!theme) return;
            const added = addCustomSongs(fresh.map(s => ({ ...s, theme })));
            const inTheme = allSongs.filter(s => s.theme === theme).length;
            showModal('alert', 'Import réussi !',
                `<strong>${added.length}</strong> titres ajoutés à la catégorie « <strong>${esc(theme)}</strong> ».<br><br>Total : <strong>${inTheme}</strong> titres dans cette catégorie.<br><br>
                 <span class="text-sm text-white/60">Pour que les invités les voient, exporte la liste (bouton &lt;/&gt;) et remplace <strong>songs.js</strong> sur GitHub.</span>`);
        },
    });
}

/** Filtre les cartes déjà affichées sans redessiner l'écran (le clavier mobile reste ouvert). */
function filterSongCards() {
    let visible = 0;
    document.querySelectorAll('.song-item-card').forEach(card => {
        const match = card.dataset.search.includes(state.searchQuery);
        card.style.display = match ? 'flex' : 'none';
        if (match) visible++;
    });
    const empty = document.getElementById('empty-search-msg');
    if (empty) empty.style.display = visible === 0 ? 'block' : 'none';
}

// =============================================================================
// 11. RENDU (vues HTML)
// =============================================================================

const SOCIAL_LINKS = [
    { href: 'https://www.universal-dj.com', icon: 'ph-bold ph-globe', title: 'Site web', hover: 'hover:text-white' },
    { href: 'https://www.facebook.com/profile.php?id=100054386763284', icon: 'ph-fill ph-facebook-logo', title: 'Facebook', hover: 'hover:text-[#1877F2]' },
    { href: 'https://www.instagram.com/barvinylesnormandie/', icon: 'ph-fill ph-instagram-logo', title: 'Instagram', hover: 'hover:text-[#E1306C]' },
    { href: 'https://www.linkedin.com/in/universal-dj', icon: 'ph-fill ph-linkedin-logo', title: 'LinkedIn', hover: 'hover:text-[#0A66C2]' },
    { href: 'https://www.google.com/maps/place/Universal-Dj/@49.1957276,0.3553857,17z', icon: 'ph-fill ph-map-pin', title: 'Google Maps', hover: 'hover:text-[#EA4335]' },
];

function logo(classes) {
    // Si l'image manque, elle est simplement masquée (l'ancien service d'image de secours n'existe plus).
    return `<img src="${LOGO_URL}" alt="Universal DJ" class="${classes}" onerror="this.style.display='none'">`;
}

function rankStyles(index) {
    if (index === 0) return { rank: 'text-magical-gold text-2xl sm:text-3xl text-glow-white', box: 'bg-gradient-to-r from-magical-gold/20 to-transparent border-magical-gold/40 shadow-[0_0_20px_rgba(255,215,0,0.3)]' };
    if (index === 1) return { rank: 'text-slate-300 text-xl sm:text-2xl text-glow-white', box: 'bg-gradient-to-r from-white/10 to-transparent border-white/30 shadow-[0_0_20px_rgba(255,255,255,0.1)]' };
    if (index === 2) return { rank: 'text-orange-500 text-xl sm:text-2xl text-glow-white', box: 'bg-gradient-to-r from-orange-500/20 to-transparent border-orange-500/30 shadow-[0_0_20px_rgba(249,115,22,0.2)]' };
    return { rank: 'text-white/40 text-xl font-bold', box: 'bg-white/[0.01]' };
}

// ---------- Écran géant ----------

function displayCloseButton(subtle = false) {
    if (!displayMode) return '';
    const look = subtle
        ? 'text-white/0 hover:text-white/50 p-3 hover:bg-white/10'
        : 'text-white/50 hover:text-white neo-glass p-2 hover:bg-white/10';
    return `<button data-action="closeDisplay" title="Fermer la fenêtre" class="absolute top-3 right-3 md:top-6 md:right-6 z-50 rounded-full transition-all ${look}">
                <i class="ph-bold ph-x text-2xl"></i></button>`;
}

function displayTitle() {
    return `
        <div class="flex items-center gap-4 mb-4 shrink-0">
            ${logo('h-10 md:h-14 object-contain drop-shadow-[0_0_20px_rgba(255,0,122,0.6)]')}
            <h1 class="font-black text-transparent bg-clip-text bg-gradient-to-r from-magical-cyan via-white to-magical-pink uppercase tracking-widest leading-none" style="font-size: clamp(1.5rem, 4vw, 4rem);">
                VOTRE PLAYLIST IDÉALE
            </h1>
        </div>`;
}

/** Encadré « code de la soirée », très lisible de loin (au-dessus du QR code). */
function bigCodeBadge(size = 'xl') {
    const codeSize = size === 'xl' ? 'clamp(2.75rem, 7vw, 6.5rem)' : 'clamp(1.75rem, 3.2vw, 3.25rem)';
    return `
        <div class="flex flex-col items-center">
            <p class="font-black uppercase tracking-[0.25em] text-magical-cyan text-glow-cyan" style="font-size:${size === 'xl' ? 'clamp(1rem,1.8vw,1.6rem)' : 'clamp(0.75rem,1.1vw,1.05rem)'}">Code à taper</p>
            <div class="mt-2 px-6 md:px-10 py-1 md:py-2 rounded-3xl border-2 border-magical-pink bg-black/60 shadow-[0_0_40px_rgba(255,0,122,0.55)]">
                <span class="font-black text-white tracking-[0.15em] text-glow-white leading-none" style="font-size:${codeSize}">${esc(state.remote.guestCode)}</span>
            </div>
        </div>`;
}

function qrScreen(animClass) {
    const qrSize = 'min(46vh, 30vw, 420px)';
    return `
        <div class="h-screen w-screen flex flex-col items-center justify-center p-4 md:p-6 relative ${animClass} overflow-hidden bg-[#050212]">
            ${displayCloseButton()}
            ${displayTitle()}
            <div class="flex items-center justify-center gap-6 lg:gap-12 flex-1 min-h-0 w-full max-w-7xl">
                <div class="flex flex-col items-center justify-center gap-5 flex-1 text-center">
                    <p class="font-black text-white leading-tight" style="font-size:clamp(1.5rem,3vw,3rem)">1. Flashez<br><span class="text-magical-pink text-glow-pink">le QR code</span></p>
                    <p class="font-black text-white leading-tight" style="font-size:clamp(1.5rem,3vw,3rem)">2. Tapez<br><span class="text-magical-cyan text-glow-cyan">le code</span></p>
                    ${state.remote.eventStartTime ? `
                    <div class="flex items-center gap-2 neo-glass px-5 py-2 rounded-full border-magical-pink/40 mt-2">
                        <i class="ph-fill ph-timer text-magical-pink animate-pulse text-xl"></i>
                        <span class="text-xl md:text-3xl font-black tabular-nums tracking-widest text-magical-pink dynamic-timer-display text-glow-pink">--:--:--</span>
                    </div>` : ''}
                </div>
                <div class="shrink-0 flex flex-col items-center gap-4 min-h-0">
                    ${bigCodeBadge('xl')}
                    <div class="neo-glass p-3 md:p-4 rounded-[1.5rem] border-2 border-white/20 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
                        <div class="bg-white p-2 md:p-3 rounded-xl">
                            <img src="${qrCodeUrl()}" alt="QR Code" style="width:${qrSize};height:${qrSize};" class="object-contain rounded-lg">
                        </div>
                    </div>
                </div>
                <div class="flex flex-col items-center justify-center gap-4 flex-1">
                    <p class="text-sm md:text-lg text-white/60 font-bold uppercase tracking-widest">Votes en direct</p>
                    <div class="flex items-center gap-3">
                        <i class="ph-fill ph-heart text-magical-pink text-3xl md:text-5xl animate-pulse"></i>
                        <span class="text-6xl md:text-8xl font-black text-transparent bg-clip-text bg-gradient-to-r from-magical-cyan to-magical-pink tabular-nums">${totalVotes()}</span>
                    </div>
                    <p class="text-base md:text-xl text-white/50 font-bold uppercase tracking-widest">votes</p>
                </div>
            </div>
        </div>`;
}

function rankingScreen() {
    const top = topSongs();
    const closed = state.phase === 3;
    const card = (song, index) => {
        const style = rankStyles(index);
        return `
            <div class="flex items-center neo-card ${style.box} rounded-2xl px-3 sm:px-4 overflow-hidden h-full">
                <div class="w-8 sm:w-10 text-center font-black shrink-0 ${style.rank}">${index + 1}</div>
                <div class="flex-1 min-w-0 px-2 sm:px-4 border-l border-white/10 ml-2 sm:ml-3 py-1">
                    <div class="text-sm sm:text-base md:text-lg font-bold text-white truncate leading-tight">${esc(song.title)}</div>
                    <div class="text-[10px] sm:text-xs font-light text-white/70 truncate leading-tight mt-0.5 tracking-wide">${esc(song.artist)}</div>
                </div>
                <div class="shrink-0 flex items-center justify-center bg-black/50 rounded-xl px-3 sm:px-4 py-1 sm:py-1.5 border border-white/10 shadow-inner">
                    <span class="text-lg sm:text-xl md:text-2xl font-black ${index < 3 ? 'text-white' : 'text-magical-cyan'}">${song.votes}</span>
                </div>
            </div>`;
    };

    return `
        <div class="h-screen w-screen flex flex-col p-4 md:p-6 relative overflow-hidden">
            ${displayCloseButton(true)}
            <div class="relative z-10 flex justify-between items-center gap-4 mb-4 px-2">
                <div class="flex items-center gap-4 min-w-0">
                    ${logo('h-14 md:h-20 object-contain drop-shadow-[0_0_30px_rgba(255,0,122,0.6)] shrink-0')}
                    <h1 class="font-black text-transparent bg-clip-text bg-gradient-to-r from-magical-cyan via-white to-magical-pink uppercase tracking-wider text-glow-white leading-tight" style="font-size:clamp(1.5rem,3.2vw,3rem)">
                        ${closed ? 'LE CLASSEMENT FINAL' : 'VOTRE PLAYLIST IDÉALE'}
                    </h1>
                </div>
                <div class="flex items-center gap-4 shrink-0">
                    ${state.phase === 2 ? `
                        <div class="neo-glass border-magical-cyan/40 px-5 py-2.5 rounded-2xl flex flex-col items-center whitespace-nowrap">
                            <span class="text-magical-cyan font-bold text-sm uppercase tracking-widest">Fin des votes</span>
                            <span class="text-white font-black text-3xl tabular-nums dynamic-timer-display text-glow-cyan">--:--:--</span>
                        </div>
                        <div class="hidden md:flex items-center gap-5 neo-glass p-3 pr-6 rounded-3xl border border-white/20 shrink-0">
                            <div class="bg-white p-2 rounded-2xl shrink-0"><img src="${qrCodeUrl()}" alt="QR Code" class="block rounded-xl object-contain max-w-none" style="width:min(19vh,160px);height:min(19vh,160px)"></div>
                            <div class="flex flex-col items-center justify-center gap-1">
                                <span class="text-base lg:text-lg font-bold text-white tracking-wide leading-tight">Flashez pour voter !</span>
                                ${bigCodeBadge('md')}
                            </div>
                        </div>` : ''}
                    ${closed ? `
                        <div class="btn-liquid px-8 py-3 rounded-2xl pulse-magical">
                            <span class="text-white font-black text-2xl uppercase tracking-widest text-glow-white">Les votes sont clôturés</span>
                        </div>` : ''}
                </div>
            </div>
            <div class="relative z-10 flex-1 w-full neo-glass rounded-[2.5rem] p-4 overflow-y-auto">
                ${top.length > 0 ? `
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 h-full w-full" style="grid-template-rows: repeat(10, minmax(0, 1fr)); grid-auto-flow: column;">
                        ${top.map(card).join('')}
                    </div>` : `
                    <div class="flex flex-col items-center justify-center h-full text-center">
                        <i class="ph-duotone ${closed ? 'ph-check-circle text-magical-cyan' : 'ph-disc text-magical-pink/50 animate-spin'} text-9xl mb-6 inline-block drop-shadow-[0_0_20px_rgba(0,240,255,0.4)]"></i>
                        <h3 class="text-4xl font-bold text-white mb-3 text-glow-white">${closed ? 'Playlist terminée' : 'En attente des votes…'}</h3>
                        <p class="text-2xl text-white/60 font-light">${closed ? 'Le Top 40 est vide car aucun vote n\'a été enregistré.' : 'La playlist idéale se prépare !'}</p>
                    </div>`}
            </div>
        </div>`;
}

function displayView(animClass) {
    const showQr = (state.view === 'qrcode' && state.phase < 2) || state.phase === 1;
    return showQr ? qrScreen(animClass) : rankingScreen();
}

// ---------- Connexion ----------

/** Code de la soirée reçu via le QR code du grand écran (pré-rempli sur le téléphone). */
let prefillCode = normalizeCode(urlParams.get('code'));

function guestLoginHint() {
    if (prefillCode) {
        return `
            <div class="mb-8 mt-2 rounded-2xl border border-magical-cyan/40 bg-magical-cyan/10 px-4 py-3">
                <p class="text-white/80 text-sm font-bold uppercase tracking-widest">Code de la soirée</p>
                <p class="text-magical-cyan text-3xl font-black tracking-[0.2em] text-glow-cyan mt-1">${esc(prefillCode)}</p>
                <p class="text-white/70 text-sm mt-1">Déjà rempli : touchez simplement « Rejoindre » 👇</p>
            </div>`;
    }
    return `<p class="text-white/70 mb-10 font-medium text-lg">Tapez le <strong class="text-magical-cyan">code de la soirée</strong>,<br>affiché en grand sur l'écran.</p>`;
}

function loginView(isAdmin, animClass) {
    return `
        <div class="min-h-screen flex flex-col items-center justify-center p-4 relative ${animClass}">
            <div class="neo-glass w-full max-w-md rounded-[2.5rem] p-8 md:p-10 shadow-[0_30px_60px_rgba(0,0,0,0.8)] relative z-10 text-center border-t-magical-pink/50">
                <div class="mb-8 relative inline-block">
                    ${logo('h-20 md:h-28 object-contain drop-shadow-[0_0_30px_rgba(255,0,122,0.5)] mx-auto')}
                    ${isAdmin ? '<div class="absolute -bottom-2 -right-2 bg-magical-purple rounded-full p-3 shadow-[0_0_20px_rgba(112,0,255,0.8)]"><i class="ph-fill ph-lock-key text-white text-lg"></i></div>' : ''}
                </div>
                <h1 class="text-4xl font-black text-white mb-2 tracking-tight text-glow-white">${isAdmin ? 'Espace DJ' : 'Bienvenue'}</h1>
                ${isAdmin ? '<p class="text-white/70 mb-10 font-medium text-lg">Entrez le code administrateur.</p>' : guestLoginHint()}
                <form data-action="${isAdmin ? 'adminLogin' : 'guestLogin'}" class="space-y-6" autocomplete="off">
                    <input type="text" id="${isAdmin ? 'adminPass' : 'guestPass'}" placeholder="${isAdmin ? 'Code DJ secret' : 'Code de la soirée'}" value="${isAdmin ? '' : esc(prefillCode)}"
                        autocapitalize="characters" autocorrect="off" spellcheck="false" aria-label="${isAdmin ? 'Code DJ' : 'Mot de passe de la soirée'}"
                        class="w-full bg-black/60 border border-white/20 rounded-2xl py-4 px-6 text-center text-2xl text-white uppercase tracking-[0.3em] focus:outline-none focus:border-magical-cyan focus:ring-2 focus:ring-magical-cyan/40 transition-all placeholder:text-white/30 font-black shadow-inner">
                    ${state.loginError ? `<p class="text-magical-pink font-bold animate-fade-in drop-shadow-md" role="alert">${esc(state.loginError)}</p>` : ''}
                    <button type="submit" class="w-full btn-liquid font-black py-4 px-6 rounded-2xl text-lg tracking-widest uppercase">
                        ${isAdmin ? 'Accéder au Dashboard' : 'Rejoindre la soirée&nbsp;!'}
                    </button>
                </form>
                <div class="mt-10 pt-8 border-t border-white/10">
                    <button data-action="goTo" data-arg="${isAdmin ? 'login' : 'adminLogin'}" class="text-sm font-bold text-white/50 hover:text-white transition-colors uppercase tracking-widest">
                        ${isAdmin ? '← Retour à l\'accès invité' : 'Accès DJ (Admin)'}
                    </button>
                </div>
            </div>
        </div>`;
}

// ---------- Barre de navigation (invité et DJ) ----------

function headerNav(isScrolled) {
    const timerActive = state.phase === 1 || state.phase === 2;
    const isAdmin = state.view === 'admin';
    return `
        <div class="fixed top-4 left-0 w-full z-50 px-2 sm:px-4 md:px-8 pointer-events-none">
            <nav id="main-nav" class="max-w-7xl mx-auto neo-glass rounded-full px-2 sm:px-4 py-2 sm:py-3 shadow-[0_10px_30px_rgba(0,0,0,0.5)] flex items-center justify-between pointer-events-auto w-full transition-all duration-300 ${isScrolled ? 'glass-scrolled-nav' : ''}">
                <div class="flex items-center gap-2 sm:gap-6 overflow-hidden">
                    <button data-action="${isAdmin ? 'noop' : 'showCategories'}" class="flex items-center gap-2 hover:opacity-80 transition-opacity focus:outline-none text-left shrink-0" title="${isAdmin ? 'Tableau de bord' : 'Retour aux catégories'}">
                        ${logo('h-6 sm:h-8 md:h-10 object-contain drop-shadow-[0_0_10px_rgba(255,0,122,0.4)]')}
                        ${isAdmin ? '<span class="text-sm md:text-xl font-black text-white hidden lg:block border-l border-white/20 pl-4 ml-1 tracking-widest uppercase text-glow-white">Dashboard</span>' : ''}
                    </button>
                    <div class="flex items-center gap-1.5 sm:gap-3 border-l border-white/10 pl-2 sm:pl-4">
                        ${SOCIAL_LINKS.map(link => `
                            <a href="${link.href}" target="_blank" rel="noopener noreferrer" title="${link.title}" class="text-white/60 ${link.hover} transition-all hover:scale-110">
                                <i class="${link.icon} text-[11px] sm:text-lg md:text-xl"></i>
                            </a>`).join('')}
                    </div>
                    ${timerActive ? `
                    <div class="flex items-center gap-1 sm:gap-2 border-l border-white/10 pl-2 sm:pl-4 ml-1">
                        <i class="ph-fill ph-timer text-magical-pink animate-pulse text-[10px] sm:text-base"></i>
                        <span class="text-[10px] sm:text-sm font-black tabular-nums tracking-widest text-magical-pink global-timer-display text-glow-pink">--:--:--</span>
                    </div>` : ''}
                </div>
                <div class="flex items-center gap-1.5 sm:gap-4 shrink-0">
                    ${state.phase === 3 ? `
                    <div class="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full bg-black/40 border border-magical-pink/40 shadow-inner">
                        <i class="ph-fill ph-check-circle text-magical-pink text-[10px] sm:text-base"></i>
                        <span class="text-[10px] sm:text-sm font-black tracking-widest text-magical-pink text-glow-pink uppercase">Clôturé</span>
                    </div>` : ''}
                    <button data-action="logout" class="flex shrink-0 items-center gap-1.5 sm:gap-2 text-white/80 hover:text-white transition-all bg-white/5 border border-white/10 px-2 sm:px-4 py-1.5 sm:py-2 rounded-full text-[9px] sm:text-sm font-bold hover:bg-white/20 uppercase tracking-wider ml-1 sm:ml-0">
                        <i class="ph-bold ph-sign-out text-xs sm:text-lg"></i> <span class="hidden sm:inline">Quitter</span>
                    </button>
                </div>
            </nav>
        </div>`;
}

// ---------- Invité ----------

// ---------- Bouton de vote (partagé entre le rendu complet et la mise à jour instantanée) ----------

const VOTE_BTN_BASE = 'vote-btn shrink-0 ml-2 sm:ml-4 flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-6 md:px-8 py-2 sm:py-3 md:py-3.5 rounded-xl sm:rounded-2xl text-[10px] sm:text-sm md:text-base font-black uppercase tracking-wide sm:tracking-widest';

function voteButtonState(mine, totalUsed) {
    const maxed = mine >= MAX_VOTES_PER_SONG;
    const disabled = maxed || totalUsed >= MAX_TOTAL_VOTES;
    let look, text, iconClass = '';
    if (maxed) {
        look = 'bg-magical-cyan/20 text-magical-cyan border border-magical-cyan/40 cursor-default shadow-[0_0_15px_rgba(0,240,255,0.3)]';
        text = `Max (${MAX_VOTES_PER_SONG}/${MAX_VOTES_PER_SONG})`;
        iconClass = 'text-magical-cyan';
    } else if (mine === 1) {
        look = disabled ? 'bg-black/60 text-white/30 border border-white/5 cursor-not-allowed' : 'bg-magical-pink text-white border border-magical-pink shadow-[0_0_20px_rgba(255,0,122,0.5)]';
        text = `Voté (1/${MAX_VOTES_PER_SONG})`;
        iconClass = 'text-white';
    } else {
        look = disabled ? 'bg-black/60 text-white/30 border border-white/5 cursor-not-allowed' : 'btn-liquid border-transparent';
        text = 'Voter';
    }
    return {
        disabled,
        className: `${VOTE_BTN_BASE} ${look}`,
        html: `<i class="ph-fill ph-heart ${iconClass} text-[10px] sm:text-xl"></i> ${text}`,
    };
}

/**
 * Met à jour instantanément le bouton voté et les crédits, sans redessiner tout l'écran
 * (la liste peut contenir plus de 1 500 titres : la redessiner prenait plusieurs secondes sur téléphone).
 */
function patchVoteUI(songId) {
    const totalUsed = userVoteTotal();
    if (totalUsed >= MAX_TOTAL_VOTES) return render(); // tous les boutons se désactivent : rendu complet (une seule fois)
    const btn = voteButtonState(state.userVotes[songId] || 0, totalUsed);
    document.querySelectorAll(`button[data-action="vote"][data-arg="${songId}"]`).forEach(el => {
        el.className = btn.className;
        el.innerHTML = btn.html;
        el.disabled = btn.disabled;
    });
    document.querySelectorAll('.credits-badge').forEach(el => { el.outerHTML = creditsBadge(); });
}

function creditsBadge() {
    const left = Math.max(0, MAX_TOTAL_VOTES - userVoteTotal());
    return `
        <div class="credits-badge px-3 sm:px-4 py-1 sm:py-1.5 rounded-full bg-white/10 border border-white/20 flex items-center gap-1.5 sm:gap-2 shadow-inner">
            <i class="ph-fill ph-ticket ${left === 0 ? 'text-magical-pink' : 'text-magical-cyan'} text-xs sm:text-base"></i>
            <span class="text-xs sm:text-sm font-black ${left === 0 ? 'text-magical-pink text-glow-pink' : 'text-white'}">${left} / ${MAX_TOTAL_VOTES} crédits</span>
        </div>`;
}

function guestTimerBadge() {
    if (state.phase !== 1 && state.phase !== 2) return '';
    return `
        <div class="px-3 sm:px-4 py-1 sm:py-1.5 rounded-full bg-magical-pink/10 border border-magical-pink/30 flex items-center gap-1.5 sm:gap-2 shadow-inner animate-pulse">
            <i class="ph-fill ph-timer text-magical-pink text-xs sm:text-base"></i>
            <span class="text-xs sm:text-sm font-black text-magical-pink text-glow-pink global-timer-display tabular-nums">--:--:--</span>
        </div>`;
}

function searchField(placeholder) {
    return `
        <div class="relative w-full group">
            <i class="ph-bold ph-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-magical-cyan group-focus-within:text-magical-pink transition-colors text-base sm:text-lg"></i>
            <input id="searchInput" type="search" placeholder="${esc(placeholder)}" value="${esc(state.searchQuery)}" data-input="search"
                enterkeyhint="search" autocomplete="off"
                class="w-full bg-black/60 border border-white/20 rounded-full py-3 pl-11 pr-4 text-sm sm:text-base text-white focus:outline-none focus:border-magical-pink focus:ring-1 focus:ring-magical-pink/50 transition-all placeholder:text-white/40 shadow-inner">
        </div>`;
}

/** Accueil invité : les catégories en grandes tuiles colorées. */
function guestCategoriesView() {
    const themes = themesWithCounts();
    const tile = (name, count, visual, extraClass = '') => `
        <button data-action="openTheme" data-arg="${esc(name)}" class="category-tile ${extraClass}"
            style="--tile-gradient: linear-gradient(135deg, ${visual.from}, ${visual.to}); --tile-glow: ${visual.from}80;">
            <span class="tile-emoji" aria-hidden="true">${visual.emoji}</span>
            <span class="relative z-10 mt-3">
                <span class="block text-base sm:text-lg font-black text-white leading-tight drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]">${esc(name === ALL_THEMES ? 'Tous les titres' : name)}</span>
                <span class="block text-[11px] sm:text-xs font-bold text-white/85 uppercase tracking-widest mt-1">${count} titres</span>
            </span>
        </button>`;

    return `
        <div class="pb-16 pt-24 sm:pt-28 max-w-5xl mx-auto px-4 w-full">
            <div class="text-center mb-5 sm:mb-8">
                <h2 class="text-2xl sm:text-4xl font-black text-white tracking-tight text-glow-white">Choisis ton style 🎶</h2>
                <p class="text-white/70 text-sm sm:text-lg mt-1 sm:mt-2">Touche une catégorie pour voir les titres et voter</p>
                <div class="flex flex-wrap items-center justify-center gap-2 mt-4">
                    ${creditsBadge()}
                    ${guestTimerBadge()}
                </div>
            </div>
            <div class="mb-5 sm:mb-8 max-w-xl mx-auto">${searchField('Rechercher un titre ou un artiste…')}</div>
            <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-5">
                ${tile(ALL_THEMES, allSongs.length, { emoji: '✨', from: '#FF007A', to: '#00F0FF' }, 'col-span-2 sm:col-span-3 lg:col-span-4 !min-h-[5.5rem] sm:!min-h-[6.5rem] !flex-row !items-center !justify-start gap-4')}
                ${themes.map((t, i) => tile(t.name, t.count, themeVisual(t.name, i))).join('')}
            </div>
        </div>`;
}

/** Longues listes : les premiers titres s'affichent tout de suite, le reste est ajouté juste après. */
const FIRST_BATCH = 60;
const NEXT_BATCH = 200;
let pendingCards = null;
let appendToken = 0;

function appendPendingCards() {
    const job = pendingCards;
    pendingCards = null;
    if (!job || job.songs.length === 0) return;
    const token = ++appendToken;
    let index = 0;
    const step = () => {
        const grid = document.getElementById('songs-grid');
        if (token !== appendToken || !grid) return; // l'écran a changé entre-temps
        const batch = job.songs.slice(index, index + NEXT_BATCH);
        index += batch.length;
        grid.insertAdjacentHTML('beforeend', batch.map(job.make).join(''));
        if (index < job.songs.length) setTimeout(step, 16);
        else if (state.searchQuery) filterSongCards(); // recherche tapée pendant l'ajout
    };
    setTimeout(step, 30);
}

/** Liste des titres d'une catégorie, avec retour aux catégories bien visible. */
function guestSongsView(isScrolled) {
    const theme = state.selectedTheme;
    const songs = theme === ALL_THEMES ? allSongs : allSongs.filter(s => s.theme === theme);
    const query = state.searchQuery;
    const matches = song => `${song.title} ${song.artist}`.toLowerCase().includes(query);
    const totalUsed = userVoteTotal();
    const visual = theme === ALL_THEMES ? { emoji: '✨' } : themeVisual(theme, themesWithCounts().findIndex(t => t.name === theme));

    const songCard = song => {
        const btn = voteButtonState(state.userVotes[song.id] || 0, totalUsed);
        return `
            <div class="song-item-card neo-card rounded-[1.25rem] sm:rounded-[1.5rem] p-3 sm:p-5 items-center justify-between" style="display:${matches(song) ? 'flex' : 'none'}" data-search="${esc(`${song.title} ${song.artist}`.toLowerCase())}">
                <div class="min-w-0 flex-1 pl-1 sm:pl-2 pr-1">
                    <h3 class="font-bold text-white text-sm sm:text-lg truncate mb-0.5 tracking-wide">${esc(song.title)}</h3>
                    <p class="text-[11px] sm:text-sm font-light text-white/60 truncate tracking-wider">${esc(song.artist)}</p>
                </div>
                <button data-action="vote" data-arg="${song.id}" ${btn.disabled ? 'disabled' : ''} class="${btn.className}">${btn.html}</button>
            </div>`;
    };

    const emptyBlock = (id, hint, visible) => `
        <div ${id ? `id="${id}"` : ''} class="text-center py-20 sm:py-32 neo-glass rounded-[2rem] sm:rounded-[3rem] mt-4" style="display:${visible ? 'block' : 'none'}">
            <i class="ph-duotone ph-music-notes text-6xl sm:text-8xl text-magical-cyan/40 mb-4 sm:mb-6 inline-block"></i>
            <h3 class="text-xl sm:text-3xl font-black text-white mb-2 text-glow-white">Aucun titre trouvé</h3>
            <p class="text-sm sm:text-lg text-white/60 font-light">${hint}</p>
        </div>`;

    pendingCards = { songs: songs.slice(FIRST_BATCH), make: songCard };

    return `
        <div class="pb-16 pt-24 sm:pt-28 max-w-7xl mx-auto px-4 w-full">
            <div id="sticky-control-panel" class="sticky top-16 sm:top-24 z-40 neo-glass bg-black/40 p-3 sm:p-5 rounded-[2rem] mb-6 sm:mb-8 shadow-[0_20px_40px_rgba(0,0,0,0.6)] backdrop-blur-2xl -mx-2 sm:mx-0 transition-all duration-300 ${isScrolled ? 'glass-scrolled-panel' : ''}">
                <div class="flex flex-col gap-3">
                    <div class="flex items-center gap-2 sm:gap-4">
                        <button data-action="showCategories" class="shrink-0 flex items-center gap-2 btn-liquid rounded-full pl-3 pr-4 py-2 sm:py-2.5 text-xs sm:text-sm font-black uppercase tracking-wider">
                            <i class="ph-bold ph-squares-four text-base sm:text-lg"></i> Catégories
                        </button>
                        <div class="min-w-0 flex items-center gap-2">
                            <span class="text-xl sm:text-3xl" aria-hidden="true">${visual.emoji}</span>
                            <h2 class="text-sm sm:text-xl font-black text-white truncate text-glow-white">${esc(theme === ALL_THEMES ? 'Tous les titres' : theme)}</h2>
                        </div>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">${creditsBadge()}${guestTimerBadge()}</div>
                    ${searchField(theme === ALL_THEMES ? 'Rechercher un titre ou un artiste…' : `Rechercher dans ${theme}…`)}
                </div>
            </div>
            ${songs.length > 0 ? `
                <div id="songs-grid" class="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-6 lg:gap-8">${songs.slice(0, FIRST_BATCH).map(songCard).join('')}</div>
                ${emptyBlock('empty-search-msg', 'Essayez une autre recherche.', !songs.some(matches))}
            ` : emptyBlock('', 'Essayez une autre catégorie.', true)}
        </div>`;
}

/** Classement final sur le téléphone de l'invité (après clôture ou publication). */
function guestResultsView() {
    const top = topSongs();
    const myIds = new Set(Object.keys(state.userVotes).filter(k => state.userVotes[k] > 0).map(Number));
    const myInTop = top.filter(s => myIds.has(s.id)).length;

    return `
        <div class="relative z-10 px-3 sm:px-6 pb-10 pt-24 sm:pt-28 max-w-4xl mx-auto w-full">
            <div class="text-center mb-8">
                <div class="inline-block animate-bounce mb-3">
                    <i class="ph-fill ph-trophy text-magical-gold text-7xl drop-shadow-[0_0_30px_rgba(255,215,0,0.8)]"></i>
                </div>
                <h1 class="text-4xl sm:text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-magical-gold via-magical-pink to-magical-cyan mb-2 leading-tight">CLASSEMENT FINAL</h1>
                <p class="text-white/70 text-sm sm:text-base font-light tracking-widest uppercase">Top ${top.length} de la soirée</p>
                ${myInTop > 0 ? `
                <div class="inline-block mt-4 px-5 py-2 rounded-full bg-magical-cyan/20 border border-magical-cyan/40 text-magical-cyan font-bold text-sm tracking-widest">
                    🎯 ${myInTop} de tes votes dans le Top !
                </div>` : ''}
                ${state.remote.resultsPublished ? `
                <div class="mt-4">
                    <button data-action="replayNotification" class="text-xs uppercase tracking-widest text-white/40 hover:text-white/80 transition-colors px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/30">🔔 Rejouer le bip</button>
                </div>` : ''}
            </div>
            ${top.length === 0 ? `
                <div class="neo-glass rounded-3xl p-12 text-center">
                    <i class="ph-duotone ph-music-notes-simple text-magical-pink/50 text-7xl mb-4"></i>
                    <p class="text-white/70 text-lg">Aucun vote enregistré pour cette soirée.</p>
                </div>` : `
                <ol class="space-y-2 sm:space-y-3">
                    ${top.map((s, i) => {
                        const isMine = myIds.has(s.id);
                        const badge = ['🥇', '🥈', '🥉'][i] || `#${i + 1}`;
                        return `
                        <li class="neo-glass rounded-2xl p-3 sm:p-4 flex items-center gap-3 sm:gap-5 ${isMine ? 'ring-2 ring-magical-cyan shadow-[0_0_20px_rgba(0,240,255,0.3)]' : ''}">
                            <div class="flex-shrink-0 w-12 sm:w-16 text-center">
                                <span class="font-black text-2xl sm:text-3xl ${i < 3 ? 'text-magical-gold' : 'text-white/70'}">${badge}</span>
                            </div>
                            <div class="flex-1 min-w-0">
                                <p class="font-bold text-white text-sm sm:text-base truncate">${esc(s.title)}</p>
                                <p class="text-white/60 text-xs sm:text-sm truncate">${esc(s.artist)}</p>
                                <p class="text-magical-pink/70 text-[10px] sm:text-xs uppercase tracking-widest mt-0.5">${esc(s.theme)}</p>
                            </div>
                            <div class="flex-shrink-0 text-right">
                                <p class="font-black text-2xl sm:text-3xl text-magical-cyan">${s.votes}</p>
                                <p class="text-white/50 text-[10px] uppercase tracking-widest">vote${s.votes > 1 ? 's' : ''}</p>
                            </div>
                            ${isMine ? '<i class="ph-fill ph-heart text-magical-pink text-lg sm:text-xl flex-shrink-0"></i>' : ''}
                        </li>`;
                    }).join('')}
                </ol>`}
            <div class="text-center mt-10 text-white/50 text-xs uppercase tracking-widest">
                <p>✨ Merci d'avoir voté !</p>
                <p class="mt-2">Universal-DJ Normandie</p>
            </div>
        </div>`;
}

function guestView(isScrolled) {
    if (state.remote.resultsPublished || state.phase === 3) return guestResultsView();
    return state.guestScreen === 'categories' ? guestCategoriesView() : guestSongsView(isScrolled);
}

// ---------- DJ ----------

function adminView() {
    const ranked = rankedSongs();
    const online = state.sync.online;
    const phaseLabel = [
        '<span class="text-white/60 font-black text-2xl">Non démarré</span>',
        '<span class="text-magical-cyan font-black text-2xl flex items-center gap-3 text-glow-cyan"><i class="ph-bold ph-spinner animate-spin"></i> Phase 1 : QR Code (<span class="dynamic-timer-display tabular-nums">--:--:--</span>)</span>',
        '<span class="text-magical-gold font-black text-2xl flex items-center gap-3"><i class="ph-bold ph-spinner animate-spin"></i> Phase 2 : Top 40 (<span class="dynamic-timer-display tabular-nums">--:--:--</span>)</span>',
        '<span class="text-magical-pink font-black text-2xl flex items-center gap-3 text-glow-pink"><i class="ph-fill ph-check-circle"></i> Clôturé définitivement</span>',
    ][state.phase];

    const presetButton = key => {
        const preset = TIMER_PRESETS[key];
        return preset.isTest
            ? `<button data-action="startTimer" data-arg="${key}" class="w-full sm:w-auto bg-white/10 hover:bg-white/20 border border-white/20 text-white font-bold py-3 px-6 rounded-2xl transition-all flex items-center justify-center gap-2 text-sm md:text-base tracking-widest uppercase"><i class="ph-fill ph-flask text-xl text-magical-cyan"></i> ${preset.label}</button>`
            : `<button data-action="startTimer" data-arg="${key}" class="w-full sm:w-auto btn-liquid text-white font-black py-3 px-6 rounded-2xl flex items-center justify-center gap-2 text-sm md:text-base tracking-widest uppercase shadow-lg"><i class="ph-fill ph-play-circle text-xl"></i> ${preset.label}</button>`;
    };

    const toolButton = (action, icon, title, accent) => `
        <button data-action="${action}" title="${title}" aria-label="${title}" class="bg-white/10 ${accent} border font-bold px-4 py-5 rounded-2xl transition-colors flex items-center justify-center text-white">
            <i class="ph-bold ${icon} text-xl md:text-2xl"></i>
        </button>`;

    const codeField = (id, label, value, action, color, icon = '') => `
        <div class="mb-6 last:mb-0">
            <label for="${id}" class="block text-xs text-${color} mb-2 uppercase tracking-widest font-bold flex items-center gap-2">${icon}${label}</label>
            <div class="flex flex-col sm:flex-row lg:flex-col xl:flex-row gap-3 items-stretch">
                <input id="${id}" type="text" value="${esc(value)}" autocapitalize="characters" autocomplete="off"
                    class="flex-1 min-w-0 bg-black/60 border border-${color}/30 rounded-2xl py-4 px-5 text-white uppercase tracking-[0.2em] font-black text-xl focus:outline-none focus:border-${color} focus:ring-2 focus:ring-${color}/40 transition-all text-center shadow-inner">
                <button data-action="${action}" class="bg-${color}/15 hover:bg-${color}/25 border border-${color}/40 hover:border-${color} text-${color} font-bold px-6 py-4 rounded-2xl transition-colors whitespace-nowrap uppercase tracking-widest text-sm">Mettre à jour</button>
            </div>
        </div>`;

    return `
        <div class="max-w-5xl mx-auto pb-24 pt-28 px-4 w-full">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 gap-4">
                <h2 class="text-4xl font-black text-white tracking-tight text-glow-white">Tableau de bord</h2>
                <div class="neo-glass px-4 py-2 rounded-full flex items-center gap-2 border-white/20">
                    <div class="w-2.5 h-2.5 rounded-full animate-pulse ${online ? 'bg-magical-cyan shadow-[0_0_8px_#00F0FF]' : 'bg-red-500 shadow-[0_0_8px_#EF4444]'}"></div>
                    <span class="text-xs font-bold uppercase tracking-widest ${online ? 'text-magical-cyan' : 'text-red-500'}">${online ? 'Cloud connecté' : 'Hors connexion'}</span>
                </div>
            </div>

            <section class="neo-glass border-t-magical-pink/50 rounded-[2.5rem] p-6 md:p-10 mb-8 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
                <h3 class="text-3xl font-black text-white mb-2 flex items-center gap-4 tracking-tight text-glow-white">
                    <i class="ph-fill ph-timer text-magical-pink text-4xl"></i> Minuteurs automatiques
                </h3>
                <p class="text-white/70 text-lg mb-8 font-light">Automatise l'écran géant : affichage du QR Code, puis du Top 40, puis clôture définitive.</p>
                <div class="flex flex-col md:flex-row gap-6 items-center justify-between bg-black/50 p-6 md:p-8 rounded-[2rem] border border-white/10 shadow-inner">
                    <div class="w-full md:w-auto">
                        <span class="block text-sm text-white/50 font-bold mb-2 uppercase tracking-widest">Statut actuel :</span>
                        ${phaseLabel}
                    </div>
                    <div class="flex flex-col sm:flex-row w-full md:w-auto gap-3 flex-wrap justify-end">
                        ${state.phase === 0
                            ? Object.keys(TIMER_PRESETS).map(presetButton).join('')
                            : `<button data-action="stopTimer" class="w-full md:w-auto bg-white/10 hover:bg-white/20 border border-white/20 text-white font-bold py-4 px-10 rounded-2xl transition-all flex items-center justify-center gap-3 text-xl tracking-widest uppercase"><i class="ph-bold ph-stop"></i> Arrêter / Annuler</button>`}
                    </div>
                </div>
            </section>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                <section class="neo-glass rounded-[2.5rem] p-6 md:p-8">
                    <h3 class="text-2xl font-black text-white mb-2 flex items-center gap-3 tracking-tight text-glow-white">
                        <i class="ph-fill ph-monitor-play text-magical-cyan text-3xl"></i> Écrans publics
                    </h3>
                    <p class="text-white/70 text-base mb-6 font-light">Contrôle l'affichage sur vidéoprojecteur / TV.</p>
                    <div class="flex flex-col gap-4">
                        <button data-action="forceEnd" class="w-full btn-liquid font-black px-4 py-5 rounded-2xl flex items-center justify-center gap-3 text-sm md:text-lg uppercase tracking-widest">
                            <i class="ph-bold ph-monitor text-xl md:text-2xl"></i> Clôturer & Résultats
                        </button>
                        <button data-action="exportBestVersions" class="w-full bg-magical-gold/10 hover:bg-magical-gold/20 border border-magical-gold/40 hover:border-magical-gold text-magical-gold font-black px-4 py-4 rounded-2xl transition-colors flex items-center justify-center gap-3 text-xs md:text-sm uppercase tracking-widest">
                            <i class="ph-bold ph-crown text-xl"></i> Top 40 avec mes versions les plus jouées
                        </button>
                        <div class="grid grid-cols-5 gap-3">
                            ${state.remote.resultsPublished
                                ? toolButton('unpublishResults', 'ph-bell-ringing', 'Retirer la publication des résultats', 'bg-magical-cyan/20 border-magical-cyan/60 hover:bg-magical-cyan/30 animate-pulse')
                                : toolButton('publishResults', 'ph-bell', 'Publier les résultats sur les téléphones invités', 'border-magical-gold/40 hover:bg-magical-gold/30')}
                            ${toolButton('downloadM3U', 'ph-download-simple', 'Exporter le Top 40 en M3U8 (Rekordbox)', 'border-white/20 hover:bg-white/20')}
                            ${toolButton('importM3U', 'ph-upload-simple', 'Importer une playlist M3U8', 'border-magical-purple/30 hover:bg-magical-purple/20')}
                            ${toolButton('exportSongList', 'ph-code', 'Exporter la liste des titres (songs.js) pour GitHub', 'border-magical-gold/30 hover:bg-magical-gold/20')}
                            ${toolButton('addSong', 'ph-music-notes-plus', 'Ajouter un titre manuellement', 'border-magical-cyan/30 hover:bg-magical-cyan/20')}
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <button data-action="openDisplay" data-arg="monitor" class="w-full bg-white/5 hover:bg-white/10 border border-white/20 text-white font-bold px-4 py-4 rounded-2xl transition-colors flex items-center justify-center gap-2 text-xs uppercase tracking-widest"><i class="ph-bold ph-screencast text-lg"></i> Fenêtre classement</button>
                            <button data-action="openDisplay" data-arg="qrcode" class="w-full bg-white/5 hover:bg-white/10 border border-white/20 text-white font-bold px-4 py-4 rounded-2xl transition-colors flex items-center justify-center gap-2 text-xs uppercase tracking-widest"><i class="ph-bold ph-screencast text-lg"></i> Fenêtre QR Code</button>
                        </div>
                    </div>
                </section>

                <section class="neo-glass rounded-[2.5rem] p-6 md:p-8 flex flex-col justify-center">
                    <h3 class="text-2xl font-black text-white mb-6 flex items-center gap-3 text-glow-white">
                        <i class="ph-fill ph-lock-key text-white/50 text-3xl"></i> Mots de passe
                    </h3>
                    ${codeField('newGuestCode', 'Code invité (la soirée)', state.remote.guestCode, 'updateGuestCode', 'magical-cyan')}
                    ${codeField('newAdminCode', 'Code DJ (administrateur)', state.remote.adminCode, 'updateAdminCode', 'magical-purple', '<i class="ph-fill ph-crown text-sm"></i>')}
                    <p class="text-xs text-white/40 mt-2 italic">⚠️ Le code DJ permet d'accéder à ce panneau. Garde-le secret.</p>
                </section>
            </div>

            <section class="neo-glass rounded-[2.5rem] p-6 md:p-8 mb-8">
                <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-6">
                    <div>
                        <h2 class="text-4xl font-black text-white mb-2 tracking-tight text-glow-white">Gestion des votes</h2>
                        <p class="text-white/70 font-medium text-lg">Contrôle absolu sur la soirée.</p>
                    </div>
                    <div class="bg-black/50 rounded-[1.5rem] px-10 py-5 border border-white/10 shadow-inner text-center shrink-0 w-full md:w-auto">
                        <span class="block text-sm text-white/50 uppercase tracking-[0.2em] mb-1 font-bold">Total votes</span>
                        <span class="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-magical-cyan to-magical-pink">${totalVotes()}</span>
                    </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <button data-action="newRound" class="w-full bg-white/5 hover:bg-magical-cyan/20 text-magical-cyan hover:text-white border border-magical-cyan/30 hover:border-magical-cyan font-bold py-5 px-6 rounded-[1.5rem] transition-all flex justify-center items-center gap-3 uppercase tracking-widest"><i class="ph-bold ph-arrows-clockwise text-2xl"></i> Nouveau tour</button>
                    <button data-action="resetAll" class="w-full bg-white/5 hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/60 font-bold py-5 px-6 rounded-[1.5rem] transition-all flex justify-center items-center gap-3 uppercase tracking-widest"><i class="ph-bold ph-trash text-2xl"></i> Remise à zéro</button>
                </div>
                <p class="text-xs text-white/40 text-center mt-4 uppercase tracking-widest">⚠️ Les invités doivent flasher le nouveau QR Code pour récupérer ${MAX_TOTAL_VOTES} crédits.</p>
            </section>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                ${ranked.map((song, index) => `
                    <div class="neo-card rounded-[1.5rem] p-5 flex items-center justify-between">
                        <div class="flex items-center gap-4 min-w-0 pr-4">
                            <div class="w-12 h-12 shrink-0 rounded-xl bg-black/60 flex items-center justify-center font-black text-xl border border-white/10 ${index < 3 ? 'text-magical-gold shadow-[0_0_15px_rgba(255,215,0,0.3)]' : 'text-white/50'}">${index + 1}</div>
                            <div class="min-w-0">
                                <h4 class="font-bold text-white text-lg tracking-wide truncate">${esc(song.title)}</h4>
                                <p class="text-sm font-light text-white/60 truncate">${esc(song.artist)}</p>
                            </div>
                        </div>
                        <div class="bg-black/50 px-5 py-2.5 rounded-xl border border-white/10 shrink-0">
                            <span class="text-2xl font-black text-magical-cyan">${song.votes}</span>
                        </div>
                    </div>`).join('')}
            </div>
        </div>`;
}

// ---------- Fenêtre modale ----------

function modalView() {
    const modal = state.modal;
    if (!modal) return '';
    const secondary = 'flex-1 bg-white/10 hover:bg-white/20 border border-white/20 text-white font-bold py-4 px-6 rounded-2xl transition-all uppercase tracking-widest text-sm';
    const primary = 'flex-1 btn-liquid text-white font-black py-4 px-6 rounded-2xl transition-all uppercase tracking-widest text-sm shadow-lg';
    let buttons;
    if (modal.type === 'goodbye' || modal.type === 'progress') {
        buttons = '<i class="ph-duotone ph-spinner-gap animate-spin text-5xl text-magical-cyan mx-auto mt-2 block"></i>';
    } else if (modal.type === 'confirm' || modal.type === 'custom') {
        buttons = `<button data-action="closeModal" class="${secondary}">Annuler</button>
                   <button data-action="confirmModal" class="${primary}">${esc(modal.confirmLabel)}</button>`;
    } else {
        buttons = `<button data-action="closeModal" class="w-full sm:w-2/3 mx-auto ${primary}">Compris</button>`;
    }
    return `
        <div class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in" role="dialog" aria-modal="true">
            <div class="neo-glass p-8 md:p-10 rounded-[2.5rem] w-full max-w-xl text-center border-t border-t-magical-pink/50 shadow-[0_20px_60px_rgba(0,0,0,0.8)] max-h-[90vh] overflow-y-auto">
                <h3 class="text-3xl font-black text-white mb-6 text-glow-white">${esc(modal.title)}</h3>
                <div class="text-white/80 font-medium mb-8 text-lg leading-relaxed">${modal.html}</div>
                <div class="flex flex-col sm:flex-row gap-4 justify-center">${buttons}</div>
            </div>
        </div>`;
}

// ---------- Assemblage ----------

let renderScheduled = false;
let lastRenderedScreen = null;

/** Demande un rafraîchissement de l'écran (regroupé à la prochaine image). */
function render() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(renderNow);
    // Les navigateurs suspendent requestAnimationFrame dans les fenêtres en arrière-plan
    // (fenêtre DJ derrière l'écran géant, onglet masqué) : filet de sécurité.
    setTimeout(renderNow, 120);
}

function renderNow() {
    if (!renderScheduled) return; // déjà dessiné par l'autre déclencheur
    renderScheduled = false;
    const root = document.getElementById('root');
    if (!root) return;

    const screenKey = `${state.view}:${state.guestScreen}:${state.selectedTheme}`;
    const animClass = screenKey !== lastRenderedScreen ? 'animate-fade-in' : '';
    lastRenderedScreen = screenKey;
    const isScrolled = window.scrollY > 20;

    let html;
    switch (state.view) {
        case 'qrcode':
        case 'monitor':    html = displayView(animClass); break;
        case 'adminLogin': html = loginView(true, animClass); break;
        case 'user':       html = headerNav(isScrolled) + guestView(isScrolled); break;
        case 'admin':      html = headerNav(isScrolled) + adminView(); break;
        default:           html = loginView(false, animClass);
    }

    // Conserve le champ en cours de saisie (focus + curseur) malgré le rafraîchissement.
    const active = document.activeElement;
    const focusId = active && active.id && root.contains(active) ? active.id : null;
    const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const typed = focusId && active.tagName === 'INPUT' ? active.value : null;

    appendToken++; // annule un ajout progressif en cours
    if (state.view !== 'user' || state.guestScreen !== 'songs') pendingCards = null;
    root.innerHTML = html + modalView();
    appendPendingCards();

    if (focusId) {
        const el = document.getElementById(focusId);
        if (el) {
            if (typed !== null && el.tagName === 'INPUT' && el.value !== typed) el.value = typed;
            el.focus({ preventScroll: true });
            if (caret) { try { el.setSelectionRange(caret[0], caret[1]); } catch { /* type sans curseur */ } }
        }
    }
    updateTextAll('.dynamic-timer-display', formatDuration(computeTimer().phaseLeft));
    updateTextAll('.global-timer-display', formatDuration(computeTimer().totalLeft));
}

// =============================================================================
// 12. ÉVÉNEMENTS & DÉMARRAGE
// =============================================================================

actions.noop = () => {};

document.addEventListener('click', event => {
    const el = event.target.closest('[data-action]');
    if (!el || el.tagName === 'FORM' || el.disabled) return;
    const handler = actions[el.dataset.action];
    if (!handler) return;
    event.preventDefault();
    handler(el.dataset.arg, el, event);
});

// Retour visuel immédiat au toucher (avant même le traitement du vote).
document.addEventListener('pointerdown', event => {
    const btn = event.target.closest('.vote-btn');
    if (btn && !btn.disabled) btn.classList.add('is-pressed');
}, { passive: true });
['pointerup', 'pointercancel', 'pointerleave'].forEach(type => document.addEventListener(type, () => {
    document.querySelectorAll('.vote-btn.is-pressed').forEach(el => el.classList.remove('is-pressed'));
}, { passive: true }));

document.addEventListener('submit', event => {
    const form = event.target.closest('form[data-action]');
    if (!form) return;
    event.preventDefault();
    actions[form.dataset.action]?.(form.dataset.arg, form, event);
});

document.addEventListener('input', event => {
    const el = event.target.closest('[data-input]');
    if (el) actions[el.dataset.input]?.(el.dataset.arg, el, event);
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.modal && !['goodbye', 'progress'].includes(state.modal.type)) closeModal();
});

// Opacifie la barre et le panneau quand on fait défiler la page.
window.addEventListener('scroll', () => {
    const scrolled = window.scrollY > 20;
    document.getElementById('sticky-control-panel')?.classList.toggle('glass-scrolled-panel', scrolled);
    document.getElementById('main-nav')?.classList.toggle('glass-scrolled-nav', scrolled);
}, { passive: true });

// Retour de veille : plusieurs signaux, car aucun n'est fiable seul sur iOS.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') handleAppResume(); });
window.addEventListener('pageshow', handleAppResume);
window.addEventListener('focus', handleAppResume);

// Titres ajoutés depuis un autre onglet (ex. : fenêtre écran géant ouverte par le DJ).
window.addEventListener('storage', event => {
    if (event.key === storage.KEYS.customSongs) { loadCustomSongs(); render(); }
});

function start() {
    migrateLegacySongs();
    loadCustomSongs();
    render();
    pollLoop();
    setInterval(tick, 1000);
}

start();
