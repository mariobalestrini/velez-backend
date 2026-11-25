const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';
const TENTATIVE_MATCHES_URL =
  process.env.TENTATIVE_MATCHES_URL || 'https://www.lavazulada.com/api/partidos-tentativos';

const VELEZ_ID = 438;
const LIGA_ARG_ID = 128;
const COPA_ARG_ID = 130;
const SUDAMERICANA_ID = 11;
const COMP_IDS = [LIGA_ARG_ID, COPA_ARG_ID, SUDAMERICANA_ID];

let cacheData = null;
let cacheTime = 0;
let inflightRequest = null;

let fixtureCacheData = null;
let fixtureCacheTime = 0;
let inflightFixtureRequest = null;

let tentativeIdsCache = new Set();
let tentativeIdsCacheTime = 0;

const statsCacheByFixture = new Map();
const eventsCacheByFixture = new Map();
const lineupsCacheByFixture = new Map();

function getCurrentSeasonYear(nowMs = Date.now()) {
  if (process.env.SEASON) {
    const envSeason = Number(process.env.SEASON);
    if (!Number.isNaN(envSeason) && envSeason >= 2020) return envSeason;
  }
  const yearStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric'
  }).format(new Date(nowMs));
  return Number(yearStr) || new Date(nowMs).getFullYear();
}

function normalizeStr(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function formatVelezName(nameStr = '') {
  return String(nameStr || '')
    .replace(/\bVelez\b/g, 'Vélez')
    .replace(/\bvelez\b/g, 'vélez')
    .trim();
}

function translateSpanishLabels(str = '') {
  return formatVelezName(String(str || ''))
    .replace(/\bRound of 64\b/gi, '32avos de Final')
    .replace(/\bRound of 32\b/gi, 'Dieciseisavos de Final')
    .replace(/\bRound of 16\b/gi, 'Octavos de Final')
    .replace(/\bQuarter-?finals?\b/gi, 'Cuartos de Final')
    .replace(/\bSemi-?finals?\b/gi, 'Semifinales')
    .replace(/\bFinal\b/gi, 'Final')
    .replace(/\bGroup\s+A\b/gi, 'Grupo A')
    .replace(/\bGroup\s+B\b/gi, 'Grupo B')
    .replace(/\bGroup\s+C\b/gi, 'Grupo C')
    .replace(/\bGroup\s+D\b/gi, 'Grupo D')
    .replace(/\bGroup\s+E\b/gi, 'Grupo E')
    .replace(/\bGroup\s+F\b/gi, 'Grupo F')
    .replace(/\bGroup\s+G\b/gi, 'Grupo G')
    .replace(/\bGroup\s+H\b/gi, 'Grupo H')
    .replace(/\b2nd Phase\b/gi, 'Torneo Clausura')
    .replace(/\b1st Phase\b/gi, 'Torneo Apertura')
    .trim();
}

function getCompetitionDisplayName(leagueObj = {}) {
  const lid = Number(leagueObj?.id || 0);
  if (lid === COPA_ARG_ID) return 'Copa Argentina';
  if (lid === SUDAMERICANA_ID) return 'Copa Sudamericana';
  const rawName = String(leagueObj?.name || 'Liga Profesional Argentina');
  if (/copa argentina/i.test(rawName)) return 'Copa Argentina';
  if (/sudamericana/i.test(rawName)) return 'Copa Sudamericana';
  return translateSpanishLabels(rawName || 'Liga Profesional Argentina');
}

function cleanRoundLabel(roundStr = '') {
  const cleaned = String(roundStr || '')
    .replace(/\s*[•|-]?\s*(?:MF|FT)\s*-\s*Pens\b/gi, '')
    .replace(/\s*-\s*Pens\b/gi, '')
    .trim();
  return translateSpanishLabels(cleaned);
}

function cleanGroupLabel(groupStr = '') {
  const raw = cleanRoundLabel(groupStr);
  if (/\bGrupo\s*A\b/i.test(raw)) return 'Grupo A';
  if (/\bGrupo\s*B\b/i.test(raw)) return 'Grupo B';
  return raw || 'Grupo A';
}

function isPlayoffRound(roundStr = '') {
  return /64|32avos|round of 32|dieciseisavos|round of 16|octavos|quarter|cuartos|semi|final|play-?off|eliminaci[oó]n|knockout/i.test(String(roundStr));
}

function isAperturaLabel(str = '') {
  return /\b1st phase\b|\bapertura\b/i.test(String(str));
}

function isClausuraLabel(str = '') {
  return /\b2nd phase\b|\bclausura\b/i.test(String(str));
}

function isLeagueMatch(ev = {}) {
  const lid = Number(ev.league?.id || 0);
  if (lid === LIGA_ARG_ID) return true;
  if (lid === COPA_ARG_ID || lid === SUDAMERICANA_ID) return false;
  const cname = String(ev.league?.name || '');
  return !/copa argentina|sudamericana|libertadores/i.test(cname);
}

function calculatePlayerAge(player = {}) {
  if (player.birth && player.birth.date) {
    const birthDate = new Date(player.birth.date);
    if (!Number.isNaN(birthDate.getTime())) {
      const today = new Date();
      let age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
      }
      return age > 0 ? age : 0;
    }
  }
  const rawAge = Number(player.age || 0);
  return rawAge > 0 ? rawAge + 1 : 0;
}

function mapPosition(posName, posAbbr) {
  const name = String(posName || '').toLowerCase();
  const abbr = String(posAbbr || '').toUpperCase();

  if (name.includes('goalkeeper') || name.includes('arquero') || name.includes('portero') || abbr === 'G' || abbr === 'GK' || abbr === 'ARQ') {
    return { group: 'ARQ', posLabel: 'Arquero' };
  }
  if (name.includes('defender') || name.includes('defensor') || name.includes('lateral') || abbr === 'D' || abbr === 'DF' || abbr === 'DEF') {
    return { group: 'DEF', posLabel: 'Defensor' };
  }
  if (name.includes('attacker') || name.includes('forward') || name.includes('delantero') || name.includes('atacante') || abbr === 'F' || abbr === 'FW' || abbr === 'A' || abbr === 'DEL') {
    return { group: 'DEL', posLabel: 'Delantero' };
  }
  return { group: 'MED', posLabel: 'Mediocampista' };
}

function mapCountryToIso(countryRaw) {
  const c = normalizeStr(countryRaw);
  if (!c) return { code: 'ar', label: 'Argentina' };
  if (c.includes('argentin')) return { code: 'ar', label: 'Argentina' };
  if (c.includes('uruguay')) return { code: 'uy', label: 'Uruguay' };
  if (c.includes('chile')) return { code: 'cl', label: 'Chile' };
  if (c.includes('paraguay')) return { code: 'py', label: 'Paraguay' };
  if (c.includes('colombia')) return { code: 'co', label: 'Colombia' };
  if (c.includes('brasil') || c.includes('brazil')) return { code: 'br', label: 'Brasil' };
  if (c.includes('peru')) return { code: 'pe', label: 'Perú' };
  if (c.includes('ecuador')) return { code: 'ec', label: 'Ecuador' };
  if (c.includes('venezuela')) return { code: 've', label: 'Venezuela' };
  if (c.includes('bolivia')) return { code: 'bo', label: 'Bolivia' };
  if (c.includes('mexic')) return { code: 'mx', label: 'México' };
  if (c.includes('estados unidos') || c.includes('united states') || c === 'usa') return { code: 'us', label: 'Estados Unidos' };
  if (c.includes('espana') || c.includes('spain')) return { code: 'es', label: 'España' };
  if (c.includes('italia') || c.includes('italy')) return { code: 'it', label: 'Italia' };
  if (c.includes('francia') || c.includes('france')) return { code: 'fr', label: 'Francia' };
  return { code: 'ar', label: countryRaw || 'Argentina' };
}

function extractPlayerTechStats(playerEntry = {}) {
  const statsArr = Array.isArray(playerEntry.statistics) ? playerEntry.statistics : [];
  const mainStat = statsArr.find(s => Number(s.league?.id) === LIGA_ARG_ID) || statsArr[0] || {};
  const games = mainStat.games || {};
  const goals = mainStat.goals || {};
  const shots = mainStat.shots || {};
  const passes = mainStat.passes || {};
  const tackles = mainStat.tackles || {};
  const dribbles = mainStat.dribbles || {};
  const fouls = mainStat.fouls || {};
  const penalty = mainStat.penalty || {};
  const subs = mainStat.substitutes || {};

  const accRaw = passes.accuracy;
  const accuracyNum = typeof accRaw === 'string'
    ? Number(accRaw.replace('%', '').trim())
    : Number(accRaw || 0);

  return {
    foot: playerEntry.player?.foot || '',
    minutes: Number(games.minutes || 0),
    lineups: Number(games.lineups || 0),
    subIn: Number(subs.in || 0),
    assists: Number(goals.assists || 0),
    conceded: Number(goals.conceded || 0),
    penScored: Number(penalty.scored || 0),
    penMissed: Number(penalty.missed || 0),
    foulsCommitted: Number(fouls.committed || 0),
    foulsDrawn: Number(fouls.drawn || 0),
    shotsTotal: Number(shots.total || 0),
    shotsOn: Number(shots.on || 0),
    dribblesAttempts: Number(dribbles.attempts || 0),
    dribblesSuccess: Number(dribbles.success || 0),
    passAccuracy: Number.isNaN(accuracyNum) ? 0 : Math.round(accuracyNum),
    tacklesTotal: Number(tackles.total || 0)
  };
}

async function fetchTentativeFixtureIds() {
  const now = Date.now();
  const ttl = 60 * 1000;
  if (now - tentativeIdsCacheTime < ttl && tentativeIdsCache instanceof Set) {
    return tentativeIdsCache;
  }

  if (!TENTATIVE_MATCHES_URL) {
    return tentativeIdsCache;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(TENTATIVE_MATCHES_URL, { signal: controller.signal });
    if (!res.ok) {
      return tentativeIdsCache;
    }
    const rows = await res.json();
    const nextSet = new Set();
    if (Array.isArray(rows)) {
      rows.forEach((item) => {
        const rawId = item?.fixture_id ?? item?.fixtureId ?? item;
        if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
          nextSet.add(String(rawId).trim());
        }
      });
    }
    tentativeIdsCache = nextSet;
    tentativeIdsCacheTime = now;
    return nextSet;
  } catch (err) {
    return tentativeIdsCache;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiFootballGet(path, params = {}) {
  if (!API_KEY) {
    throw new Error('Falta configurar API_FOOTBALL_KEY en Render');
  }

  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9000);

  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-apisports-key': API_KEY },
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`API-Football HTTP ${res.status} en ${path}`);
    }

    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length > 0) {
      throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
    }

    return data.response || [];
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchVelezAllCompetitionsFixtures(season) {
  const results = await Promise.allSettled(
    COMP_IDS.map(leagueId => apiFootballGet('/fixtures', { team: VELEZ_ID, league: leagueId, season }))
  );

  const byId = new Map();
  results.forEach((r, idx) => {
    const fallbackLeagueId = COMP_IDS[idx];
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      r.value.forEach(ev => {
        const homeObj = ev.teams?.home || {};
        const awayObj = ev.teams?.away || {};
        const enriched = {
          ...ev,
          teams: {
            home: { ...homeObj, name: formatVelezName(homeObj.name || 'Local') },
            away: { ...awayObj, name: formatVelezName(awayObj.name || 'Visitante') }
          },
          league: {
            ...(ev.league || {}),
            id: Number(ev.league?.id || fallbackLeagueId),
            name: getCompetitionDisplayName({
              id: ev.league?.id || fallbackLeagueId,
              name: ev.league?.name
            })
          }
        };
        const key = String(ev.fixture?.id || `${fallbackLeagueId}-${ev.fixture?.date}`);
        byId.set(key, enriched);
      });
    }
  });

  return Array.from(byId.values());
}

function getStatValue(statsList = [], typeName) {
  const found = (statsList || []).find(s => s.type === typeName);
  if (!found || found.value === null || found.value === undefined) return null;
  if (typeof found.value === 'string' && found.value.includes('%')) {
    const num = parseFloat(found.value.replace('%', '').trim());
    return Number.isNaN(num) ? null : num;
  }
  const num = Number(found.value);
  return Number.isNaN(num) ? null : num;
}

function getRawStatDisplay(statsList = [], typeName) {
  const found = (statsList || []).find(s => s.type === typeName);
  if (!found || found.value === null || found.value === undefined) return '0';
  return String(found.value);
}

function buildMatchStatisticsComparison(statsList = [], homeId, awayId) {
  const homeBlock = (statsList || []).find(b => Number(b.team?.id) === Number(homeId));
  const awayBlock = (statsList || []).find(b => Number(b.team?.id) === Number(awayId));
  if (!homeBlock && !awayBlock) return [];

  const hStats = homeBlock?.statistics || [];
  const aStats = awayBlock?.statistics || [];

  const definitions = [
    { type: 'Shots on Goal', label: 'Tiros al arco' },
    { type: 'Shots off Goal', label: 'Tiros desviados' },
    { type: 'Total Shots', label: 'Remates totales' },
    { type: 'Blocked Shots', label: 'Tiros bloqueados' },
    { type: 'Shots insidebox', label: 'Remates dentro del área' },
    { type: 'Shots outsidebox', label: 'Remates fuera del área' },
    { type: 'Fouls', label: 'Faltas' },
    { type: 'Corner Kicks', label: 'Tiros de esquina' },
    { type: 'Offsides', label: 'Fueras de juego' },
    { type: 'Ball Possession', label: 'Posesión' },
    { type: 'Yellow Cards', label: 'Tarjetas amarillas' },
    { type: 'Red Cards', label: 'Tarjetas rojas' },
    { type: 'Goalkeeper Saves', label: 'Atajadas del arquero' }
  ];

  return definitions
    .map(def => {
      const hRaw = getRawStatDisplay(hStats, def.type);
      const aRaw = getRawStatDisplay(aStats, def.type);
      const hNum = getStatValue(hStats, def.type);
      const aNum = getStatValue(aStats, def.type);
      if (hNum === null && aNum === null) return null;

      return {
        type: def.type,
        label: def.label,
        home: hRaw,
        away: aRaw,
        homeNum: hNum ?? 0,
        awayNum: aNum ?? 0
      };
    })
    .filter(Boolean);
}

function parseMatchLineupsForView(lineupsResp = [], homeId, awayId) {
  const mapSide = (block) => {
    if (!block) return null;
    return {
      teamId: Number(block.team?.id || 0),
      teamName: formatVelezName(block.team?.name || ''),
      teamLogo: block.team?.logo || '',
      coach: block.coach?.name || '',
      formation: block.formation || '4-2-3-1',
      startXI: (block.startXI || []).map(entry => {
        const pl = entry.player || {};
        return {
          id: Number(pl.id || 0),
          name: pl.name || 'Jugador',
          number: Number(pl.number || 0) || '-',
          pos: pl.pos || ''
        };
      }),
      substitutes: (block.substitutes || []).map(entry => {
        const pl = entry.player || {};
        return {
          id: Number(pl.id || 0),
          name: pl.name || 'Jugador',
          number: Number(pl.number || 0) || '-',
          pos: pl.pos || ''
        };
      })
    };
  };

  const homeBlock = (lineupsResp || []).find(item => Number(item.team?.id) === Number(homeId)) || (lineupsResp || [])[0] || null;
  const awayBlock = (lineupsResp || []).find(item => Number(item.team?.id) === Number(awayId)) || (lineupsResp || [])[1] || null;

  return {
    home: mapSide(homeBlock),
    away: mapSide(awayBlock)
  };
}

async function getFixtureStatisticsCached(fixtureId, isLive = false) {
  const key = String(fixtureId);
  const cached = statsCacheByFixture.get(key);
  const maxAge = isLive ? 20 * 1000 : 24 * 60 * 60 * 1000;
  if (cached && (Date.now() - cached.ts < maxAge)) {
    return cached.data;
  }
  const data = await apiFootballGet('/fixtures/statistics', { fixture: fixtureId });
  statsCacheByFixture.set(key, { data, ts: Date.now() });
  return data;
}

async function getFixtureEventsCached(fixtureId, isLive = false) {
  const key = String(fixtureId);
  const cached = eventsCacheByFixture.get(key);
  const maxAge = isLive ? 20 * 1000 : 24 * 60 * 60 * 1000;
  if (cached && (Date.now() - cached.ts < maxAge)) {
    return cached.data;
  }
  const data = await apiFootballGet('/fixtures/events', { fixture: fixtureId });
  eventsCacheByFixture.set(key, { data, ts: Date.now() });
  return data;
}

async function getFixtureLineupsCached(fixtureId) {
  const key = String(fixtureId);
  const cached = lineupsCacheByFixture.get(key);
  if (cached && (Date.now() - cached.ts < 24 * 60 * 60 * 1000)) {
    return cached.data;
  }
  const data = await apiFootballGet('/fixtures/lineups', { fixture: fixtureId });
  lineupsCacheByFixture.set(key, { data, ts: Date.now() });
  return data;
}

function parseEventsIntoScorersAndCards(eventsList = [], homeTeamId, awayTeamId, homeTeamName = 'Local', awayTeamName = 'Visitante') {
  const scorers = { home: [], away: [] };
  const cards = {
    home: { yellow: [], red: [] },
    away: { yellow: [], red: [] }
  };
  const substitutions = { home: [], away: [] };
  const penaltyShootout = { home: [], away: [] };
  const timeline = [];

  (eventsList || []).forEach((ev, idx) => {
    const evTeamId = Number(ev.team?.id || 0);
    const side = evTeamId === Number(homeTeamId) ? 'home' : (evTeamId === Number(awayTeamId) ? 'away' : null);
    if (!side) return;

    const teamName = formatVelezName(side === 'home' ? (ev.team?.name || homeTeamName) : (ev.team?.name || awayTeamName));
    const minuteElapsed = Number(ev.time?.elapsed ?? 0);
    const minuteExtraNum = Number(ev.time?.extra ?? 0);
    const minuteExtra = ev.time?.extra ? `+${ev.time.extra}` : '';
    const clock = ev.time?.elapsed !== undefined && ev.time?.elapsed !== null ? `${minuteElapsed}${minuteExtra}'` : '';
    const sortKey = minuteElapsed * 100 + minuteExtraNum + idx * 0.001;
    const playerName = ev.player?.name || 'Jugador';
    const assistName = ev.assist?.name || '';
    const typeLower = String(ev.type || '').toLowerCase();
    const detailLower = String(ev.detail || '').toLowerCase();
    const commentsLower = String(ev.comments || '').toLowerCase();

    const isShootoutEvent =
      commentsLower.includes('shootout') ||
      commentsLower.includes('penalty shootout') ||
      detailLower.includes('shootout') ||
      (minuteElapsed >= 118 && (detailLower.includes('penalty') || detailLower.includes('missed') || detailLower.includes('saved')));

    if (isShootoutEvent) {
      const missedOrSaved =
        detailLower.includes('missed') ||
        detailLower.includes('saved') ||
        detailLower.includes('no goal') ||
        detailLower.includes('errado') ||
        detailLower.includes('atajado') ||
        commentsLower.includes('missed') ||
        commentsLower.includes('saved');

      const scored = !missedOrSaved && (typeLower === 'goal' || detailLower === 'penalty' || detailLower.includes('scored'));

      penaltyShootout[side].push({
        player: playerName,
        scored: Boolean(scored),
        minute: clock
      });

      timeline.push({
        sortKey,
        minute: clock || 'PEN',
        side,
        team: teamName,
        kind: scored ? 'PEN_GOAL' : 'PEN_MISS',
        icon: scored ? '⚽' : '❌',
        title: scored ? `Penal convertido: ${playerName}` : `Penal errado: ${playerName}`,
        subtitle: 'Tanda de penales'
      });
      return;
    }

    if (typeLower === 'goal') {
      if (detailLower.includes('own goal')) {
        scorers[side].push(`${playerName} ${clock} (EC)`.trim());
        timeline.push({
          sortKey,
          minute: clock,
          side,
          team: teamName,
          kind: 'GOAL',
          icon: '⚽',
          title: `Gol en contra: ${playerName}`,
          subtitle: teamName
        });
      } else if (detailLower.includes('penalty')) {
        scorers[side].push(`${playerName} ${clock} (P)`.trim());
        timeline.push({
          sortKey,
          minute: clock,
          side,
          team: teamName,
          kind: 'GOAL',
          icon: '⚽',
          title: `Gol de penal: ${playerName}`,
          subtitle: teamName
        });
      } else if (detailLower.includes('missed penalty')) {
        timeline.push({
          sortKey,
          minute: clock,
          side,
          team: teamName,
          kind: 'PEN_MISS',
          icon: '❌',
          title: `Penal errado: ${playerName}`,
          subtitle: teamName
        });
      } else {
        scorers[side].push(`${playerName} ${clock}`.trim());
        timeline.push({
          sortKey,
          minute: clock,
          side,
          team: teamName,
          kind: 'GOAL',
          icon: '⚽',
          title: `Gol de ${playerName}`,
          subtitle: assistName ? `${teamName} • Asist. ${assistName}` : teamName
        });
      }
    } else if (typeLower === 'card') {
      if (detailLower.includes('red') || detailLower.includes('second yellow')) {
        cards[side].red.push(`${playerName} ${clock}`.trim());
        timeline.push({
          sortKey,
          minute: clock,
          side,
          team: teamName,
          kind: 'RED_CARD',
          icon: '🟥',
          title: detailLower.includes('second yellow') ? `Doble amarilla y roja: ${playerName}` : `Tarjeta roja: ${playerName}`,
          subtitle: teamName
        });
      } else if (detailLower.includes('yellow')) {
        cards[side].yellow.push(`${playerName} ${clock}`.trim());
        timeline.push({
          sortKey,
          minute: clock,
          side,
          team: teamName,
          kind: 'YELLOW_CARD',
          icon: '🟨',
          title: `Tarjeta amarilla: ${playerName}`,
          subtitle: teamName
        });
      }
    } else if (typeLower === 'subst') {
      const playerIn = ev.assist?.name || playerName;
      const playerOut = ev.assist?.name ? playerName : '';
      substitutions[side].push({
        minute: clock,
        playerIn,
        playerOut
      });
      timeline.push({
        sortKey,
        minute: clock,
        side,
        team: teamName,
        kind: 'SUBST',
        icon: '🔄',
        title: playerOut ? `Cambio: entra ${playerIn} por ${playerOut}` : `Cambio: ${playerIn}`,
        subtitle: teamName
      });
    } else if (typeLower === 'var') {
      timeline.push({
        sortKey,
        minute: clock,
        side,
        team: teamName,
        kind: 'VAR',
        icon: '🖥️',
        title: `VAR: ${translateSpanishLabels(ev.detail || 'Revisión')}`,
        subtitle: `${teamName} • ${playerName}`
      });
    }
  });

  timeline.sort((a, b) => b.sortKey - a.sortKey);

  return { scorers, cards, substitutions, penaltyShootout, timeline };
}

function formatPastMatchApiFootball(ev, targetTeamId = VELEZ_ID) {
  const isHome = Number(ev.teams?.home?.id) === Number(targetTeamId);
  const oppTeam = isHome ? ev.teams?.away : ev.teams?.home;
  const tGoals = Number(isHome ? (ev.goals?.home ?? 0) : (ev.goals?.away ?? 0));
  const oGoals = Number(isHome ? (ev.goals?.away ?? 0) : (ev.goals?.home ?? 0));

  let outcome = 'E';
  if (tGoals > oGoals) outcome = 'G';
  else if (tGoals < oGoals) outcome = 'P';

  const d = new Date(ev.fixture?.date);
  return {
    id: String(ev.fixture?.id || ''),
    leagueId: Number(ev.league?.id || LIGA_ARG_ID),
    fecha: cleanRoundLabel(ev.league?.round || 'LPF'),
    comp: getCompetitionDisplayName(ev.league),
    date: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
    rival: formatVelezName(oppTeam?.name || 'Rival'),
    rivalLogo: oppTeam?.logo || '',
    cond: isHome ? 'L' : 'V',
    velezGoals: tGoals,
    rivalGoals: oGoals,
    teamGoals: tGoals,
    oppGoals: oGoals,
    rawRivalGoalsValid: true,
    score: `${tGoals} - ${oGoals}`,
    outcome
  };
}

async function fetchRivalLast2Matches(rivalId, season, allLeagueFixtures = []) {
  const rId = Number(rivalId || 0);
  if (!rId || rId === VELEZ_ID) return [];

  const finishedCodes = ['FT', 'AET', 'PEN'];
  const byId = new Map();

  const addMatches = (list = [], fallbackLeagueId = LIGA_ARG_ID) => {
    (list || []).forEach(ev => {
      const hId = Number(ev.teams?.home?.id || 0);
      const aId = Number(ev.teams?.away?.id || 0);
      if (hId !== rId && aId !== rId) return;
      if (!finishedCodes.includes(ev.fixture?.status?.short)) return;

      const enriched = {
        ...ev,
        teams: {
          home: { ...(ev.teams?.home || {}), name: formatVelezName(ev.teams?.home?.name || 'Local') },
          away: { ...(ev.teams?.away || {}), name: formatVelezName(ev.teams?.away?.name || 'Visitante') }
        },
        league: {
          ...(ev.league || {}),
          id: Number(ev.league?.id || fallbackLeagueId),
          name: getCompetitionDisplayName({
            id: ev.league?.id || fallbackLeagueId,
            name: ev.league?.name
          })
        }
      };

      const key = String(ev.fixture?.id || `${fallbackLeagueId}-${ev.fixture?.date}`);
      byId.set(key, enriched);
    });
  };

  addMatches(allLeagueFixtures, LIGA_ARG_ID);

  try {
    const compResults = await Promise.allSettled(
      COMP_IDS.map(leagueId => apiFootballGet('/fixtures', { team: rId, league: leagueId, season }))
    );
    compResults.forEach((res, idx) => {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        addMatches(res.value, COMP_IDS[idx]);
      }
    });
  } catch (err) {
    // Continuar con los partidos ya cargados en allLeagueFixtures
  }

  const sortedDesc = Array.from(byId.values()).sort(
    (a, b) => new Date(b.fixture?.date || 0).getTime() - new Date(a.fixture?.date || 0).getTime()
  );

  return sortedDesc.slice(0, 2).map(ev => formatPastMatchApiFootball(ev, rId));
}

function buildAnnualStandingsFromLeagueFixtures(allLeagueFixtures = [], targetTeamId = VELEZ_ID) {
  const finishedStatuses = ['FT', 'AET', 'PEN'];
  const regularYearMatches = (allLeagueFixtures || []).filter(f =>
    finishedStatuses.includes(f.fixture?.status?.short) &&
    !isPlayoffRound(f.league?.round)
  );

  const map = new Map();
  const ensureTeam = (teamObj) => {
    if (!teamObj?.id) return null;
    const id = String(teamObj.id);
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: formatVelezName(teamObj.name || 'Equipo'),
        logo: teamObj.logo || '',
        isVelez: Number(teamObj.id) === Number(targetTeamId),
        pj: 0,
        pg: 0,
        pe: 0,
        pp: 0,
        gf: 0,
        gc: 0,
        dg: 0,
        pts: 0,
        cupType: null,
        cupNote: '',
        cupColor: null
      });
    }
    return map.get(id);
  };

  regularYearMatches.forEach(f => {
    const homeRow = ensureTeam(f.teams?.home);
    const awayRow = ensureTeam(f.teams?.away);
    if (!homeRow || !awayRow) return;

    const gh = Number(f.goals?.home ?? 0);
    const ga = Number(f.goals?.away ?? 0);

    homeRow.pj += 1;
    awayRow.pj += 1;
    homeRow.gf += gh;
    homeRow.gc += ga;
    awayRow.gf += ga;
    awayRow.gc += gh;

    if (gh > ga) {
      homeRow.pg += 1;
      homeRow.pts += 3;
      awayRow.pp += 1;
    } else if (ga > gh) {
      awayRow.pg += 1;
      awayRow.pts += 3;
      homeRow.pp += 1;
    } else {
      homeRow.pe += 1;
      awayRow.pe += 1;
      homeRow.pts += 1;
      awayRow.pts += 1;
    }

    homeRow.dg = homeRow.gf - homeRow.gc;
    awayRow.dg = awayRow.gf - awayRow.gc;
  });

  return Array.from(map.values()).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
}

function parseStandingsResponse(standingsResp = [], allLeagueFixtures = [], targetTeamId = VELEZ_ID) {
  const leagueStandings = standingsResp[0]?.league?.standings || [];
  const candidateGroups = [];

  if (Array.isArray(leagueStandings) && leagueStandings.length > 0) {
    if (Array.isArray(leagueStandings[0])) {
      leagueStandings.forEach((groupRows, idx) => {
        const rawGroup = String(groupRows[0]?.group || `Grupo ${idx === 0 ? 'A' : 'B'}`);
        const cleanGroup = cleanGroupLabel(rawGroup);
        if (!isPlayoffRound(rawGroup) && !isAperturaLabel(rawGroup)) {
          candidateGroups.push({ name: cleanGroup, rows: groupRows });
        }
      });
    } else {
      const rawGroup = String(leagueStandings[0]?.group || 'Grupo A');
      const cleanGroup = cleanGroupLabel(rawGroup);
      if (!isPlayoffRound(rawGroup) && !isAperturaLabel(rawGroup)) {
        candidateGroups.push({ name: cleanGroup, rows: leagueStandings });
      }
    }
  }

  const mapRow = (r) => {
    const pj = Number(r.all?.played ?? 0);
    const pg = Number(r.all?.win ?? 0);
    const pe = Number(r.all?.draw ?? 0);
    const pp = Number(r.all?.lose ?? 0);
    const gf = Number(r.all?.goals?.for ?? 0);
    const gc = Number(r.all?.goals?.against ?? 0);
    const dg = r.goalsDiff !== undefined && r.goalsDiff !== null ? Number(r.goalsDiff) : (gf - gc);
    const pts = Number(r.points ?? 0);

    const descLower = String(r.description || '').toLowerCase();
    let cupType = null;
    if (descLower.includes('libertadores')) cupType = 'LIBERTADORES';
    else if (descLower.includes('sudamericana')) cupType = 'SUDAMERICANA';

    return {
      id: String(r.team?.id || ''),
      name: formatVelezName(r.team?.name || 'Equipo'),
      logo: r.team?.logo || '',
      isVelez: Number(r.team?.id) === Number(targetTeamId),
      pj,
      pg,
      pe,
      pp,
      gf,
      gc,
      dg,
      pts,
      cupType,
      cupNote: translateSpanishLabels(r.description || ''),
      cupColor: null
    };
  };

  let standingsGrupoA = [];
  let standingsGrupoB = [];
  let grupoAName = 'Grupo A';
  let grupoBName = 'Grupo B';

  if (candidateGroups.length >= 2) {
    grupoAName = cleanGroupLabel(candidateGroups[0].name || 'Grupo A');
    grupoBName = cleanGroupLabel(candidateGroups[1].name || 'Grupo B');
    standingsGrupoA = candidateGroups[0].rows.map(mapRow).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
    standingsGrupoB = candidateGroups[1].rows.map(mapRow).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
  } else if (candidateGroups.length === 1) {
    grupoAName = cleanGroupLabel(candidateGroups[0].name || 'Grupo A');
    standingsGrupoA = candidateGroups[0].rows.map(mapRow).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
  }

  const velezInB = standingsGrupoB.some(t => t.isVelez);
  const standingsClausura = velezInB ? standingsGrupoB : standingsGrupoA;
  const standingsAnual = buildAnnualStandingsFromLeagueFixtures(allLeagueFixtures, targetTeamId);

  return {
    standingsClausura,
    standingsGrupoA,
    standingsGrupoB,
    grupoAName,
    grupoBName,
    standingsAnual
  };
}

function detectActiveTournamentName(fixtures = [], standingsResp = []) {
  const leagueFixtures = (fixtures || []).filter(isLeagueMatch);
  const rounds = leagueFixtures.map(f => String(f.league?.round || ''));
  const groups = (standingsResp[0]?.league?.standings || []).flat().map(r => String(r?.group || ''));
  const allLabels = [...rounds, ...groups].join(' ');
  if (/clausura|2nd phase/i.test(allLabels)) return 'Torneo Clausura';
  if (/apertura|1st phase/i.test(allLabels)) return 'Torneo Apertura';
  return translateSpanishLabels(standingsResp[0]?.league?.name || 'Liga Profesional');
}

async function fetchCurrentSquad(season) {
  const metaById = new Map();

  try {
    const playersResp = await apiFootballGet('/players', {
      team: VELEZ_ID,
      league: LIGA_ARG_ID,
      season
    });
    (playersResp || []).forEach(entry => {
      const player = entry.player || {};
      const id = Number(player.id || 0);
      if (!id) return;
      const countryInfo = mapCountryToIso(player.nationality);
      const rawHeight = player.height ? String(player.height).trim() : '';
      metaById.set(id, {
        age: calculatePlayerAge(player),
        height: rawHeight || null,
        countryCode: countryInfo.code,
        countryName: countryInfo.label,
        flagUrl: `https://flagcdn.com/w80/${countryInfo.code}.png`,
        photo: player.photo || '',
        techStats: extractPlayerTechStats(entry)
      });
    });
  } catch (err) {
    // Continuar con /players/squads
  }

  const squadsResp = await apiFootballGet('/players/squads', { team: VELEZ_ID });
  const currentList = squadsResp[0]?.players || [];

  return currentList.map(p => {
    const id = Number(p.id || 0);
    const posInfo = mapPosition(p.position, '');
    const meta = metaById.get(id) || {
      age: calculatePlayerAge(p),
      height: null,
      countryCode: 'ar',
      countryName: 'Argentina',
      flagUrl: 'https://flagcdn.com/w80/ar.png',
      photo: p.photo || '',
      techStats: null
    };
    const num = Number(p.number || 0) || null;

    return {
      id,
      name: p.name || 'Jugador',
      shortName: p.name || 'Jugador',
      age: meta.age,
      height: meta.height || null,
      foot: meta.techStats?.foot || '',
      techStats: meta.techStats || null,
      number: num,
      dorsal: num,
      jersey: num,
      position: posInfo.posLabel,
      posLabel: posInfo.posLabel,
      group: posInfo.group,
      countryCode: meta.countryCode,
      countryName: meta.countryName,
      flagUrl: meta.flagUrl,
      photo: p.photo || meta.photo || '',
      pj: 0,
      goals: 0,
      cleanSheets: posInfo.group === 'ARQ' ? 0 : null,
      yellowCards: 0,
      redCards: 0
    };
  });
}

async function computeClausuraSquadStats(baseSquad, finishedMatches, activeTournamentName = 'Torneo Clausura') {
  const isClausuraActive = isClausuraLabel(activeTournamentName);
  const isAperturaActive = isAperturaLabel(activeTournamentName);

  const regularLeagueMatches = (finishedMatches || []).filter(f => {
    if (!isLeagueMatch(f) || isPlayoffRound(f.league?.round)) return false;
    const r = String(f.league?.round || '');
    if (isClausuraActive) {
      if (isAperturaLabel(r)) return false;
      return isClausuraLabel(r) || !/\b1st phase\b|\bapertura\b/i.test(r);
    }
    if (isAperturaActive) {
      if (isClausuraLabel(r)) return false;
      return isAperturaLabel(r) || !/\b2nd phase\b|\bclausura\b/i.test(r);
    }
    return true;
  });

  const pjCount = new Map();
  const goalsCount = new Map();
  const yellowCount = new Map();
  const redCount = new Map();
  const cleanSheetsCount = new Map();

  for (const ev of regularLeagueMatches) {
    const fId = ev.fixture?.id;
    if (!fId) continue;

    const isVelezHome = Number(ev.teams?.home?.id) === VELEZ_ID;
    const rivalGoals = Number(isVelezHome ? (ev.goals?.away ?? 0) : (ev.goals?.home ?? 0));

    let lineupsResp = [];
    let eventsResp = [];

    try {
      lineupsResp = await getFixtureLineupsCached(fId);
    } catch (e) {
      lineupsResp = [];
    }

    try {
      eventsResp = await getFixtureEventsCached(fId, false);
    } catch (e) {
      eventsResp = [];
    }

    const velezLineup = (lineupsResp || []).find(item => Number(item.team?.id) === VELEZ_ID);
    const matchPlayersSet = new Set();
    const startersList = velezLineup?.startXI || [];

    const subbedInIds = new Set();
    (eventsResp || []).forEach(evItem => {
      if (Number(evItem.team?.id) !== VELEZ_ID) return;
      if (String(evItem.type || '').toLowerCase() === 'subst') {
        const enteredId = Number(evItem.assist?.id || 0);
        if (enteredId) subbedInIds.add(enteredId);
      }
    });

    if (startersList.length > 0) {
      startersList.forEach(x => {
        const pid = Number(x.player?.id || 0);
        if (pid) matchPlayersSet.add(pid);
        if (String(x.player?.pos || '').toUpperCase() === 'G' && pid && rivalGoals === 0) {
          cleanSheetsCount.set(pid, (cleanSheetsCount.get(pid) || 0) + 1);
        }
      });
    }

    subbedInIds.forEach(pid => {
      if (pid) matchPlayersSet.add(pid);
    });

    (eventsResp || []).forEach(evItem => {
      if (Number(evItem.team?.id) !== VELEZ_ID) return;
      const pid = Number(evItem.player?.id || 0);
      const typeLower = String(evItem.type || '').toLowerCase();
      const detailLower = String(evItem.detail || '').toLowerCase();
      const commentsLower = String(evItem.comments || '').toLowerCase();
      const minElapsed = Number(evItem.time?.elapsed ?? 0);
      const isShootout =
        commentsLower.includes('shootout') ||
        detailLower.includes('shootout') ||
        (minElapsed >= 118 && (detailLower.includes('penalty') || detailLower.includes('missed') || detailLower.includes('saved')));

      if (typeLower === 'goal' && !isShootout && !detailLower.includes('own goal') && !detailLower.includes('missed penalty') && pid) {
        goalsCount.set(pid, (goalsCount.get(pid) || 0) + 1);
      } else if (typeLower === 'card' && pid) {
        if (detailLower.includes('red') || detailLower.includes('second yellow')) {
          redCount.set(pid, (redCount.get(pid) || 0) + 1);
        } else if (detailLower.includes('yellow')) {
          yellowCount.set(pid, (yellowCount.get(pid) || 0) + 1);
        }
      }
    });

    matchPlayersSet.forEach(pid => {
      pjCount.set(pid, (pjCount.get(pid) || 0) + 1);
    });
  }

  return (baseSquad || []).map(p => ({
    ...p,
    pj: pjCount.get(p.id) || 0,
    goals: goalsCount.get(p.id) || 0,
    yellowCards: yellowCount.get(p.id) || 0,
    redCards: redCount.get(p.id) || 0,
    cleanSheets: p.group === 'ARQ' ? (cleanSheetsCount.get(p.id) || 0) : null
  }));
}

async function computeVelezPayload(nowMs = Date.now()) {
  const season = getCurrentSeasonYear(nowMs);

  const [fixtures, allLeagueFixtures, standingsResp, baseSquad, tentativeIds] = await Promise.all([
    fetchVelezAllCompetitionsFixtures(season),
    apiFootballGet('/fixtures', { league: LIGA_ARG_ID, season }),
    apiFootballGet('/standings', { league: LIGA_ARG_ID, season }),
    fetchCurrentSquad(season),
    fetchTentativeFixtureIds()
  ]);

  const activeTournamentName = detectActiveTournamentName(fixtures, standingsResp);

  const sortedAsc = [...fixtures].sort(
    (a, b) => new Date(a.fixture?.date || 0).getTime() - new Date(b.fixture?.date || 0).getTime()
  );

  const finishedCodes = ['FT', 'AET', 'PEN'];
  const liveCodes = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE'];

  const finishedMatches = sortedAsc.filter(f => finishedCodes.includes(f.fixture?.status?.short));
  const liveMatchRaw = sortedAsc.find(f => liveCodes.includes(f.fixture?.status?.short)) || null;
  const upcomingRaw = sortedAsc.filter(
    f => !finishedCodes.includes(f.fixture?.status?.short) && !liveCodes.includes(f.fixture?.status?.short)
  );
  const nextMatchRaw = upcomingRaw[0] || null;
  const lastFinishedRaw = finishedMatches[finishedMatches.length - 1] || null;

  const squad = await computeClausuraSquadStats(baseSquad, finishedMatches, activeTournamentName);

  const lastMatches = [...finishedMatches].reverse().slice(0, 5).map(ev => formatPastMatchApiFootball(ev, VELEZ_ID));
  const velezLast2 = lastMatches.slice(0, 2);

  const upcomingMatches = upcomingRaw.slice(0, 4).map(ev => {
    const isHome = Number(ev.teams?.home?.id) === VELEZ_ID;
    const rivalTeam = isHome ? ev.teams?.away : ev.teams?.home;
    const d = new Date(ev.fixture?.date);
    const rawCode = String(ev.fixture?.status?.short || 'NS');
    const isTbd = rawCode === 'TBD' || tentativeIds.has(String(ev.fixture?.id || '').trim());
    return {
      id: String(ev.fixture?.id || ''),
      leagueId: Number(ev.league?.id || LIGA_ARG_ID),
      fecha: cleanRoundLabel(ev.league?.round || 'PRÓXIMO'),
      comp: getCompetitionDisplayName(ev.league),
      isoDate: d.toISOString(),
      timestamp: d.getTime(),
      date: isTbd ? 'A confirmar' : d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
      timeART: isTbd ? 'A confirmar' : d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }) + ' ART',
      rival: formatVelezName(rivalTeam?.name || 'Rival'),
      rivalLogo: rivalTeam?.logo || '',
      cond: isHome ? 'L' : 'V',
      stadium: ev.fixture?.venue?.name || (isHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar'),
      apiStatusShort: rawCode,
      tentativeDate: isTbd
    };
  });

  const hoursSinceLastMatch = lastFinishedRaw
    ? (nowMs - new Date(lastFinishedRaw.fixture?.date || 0).getTime()) / (1000 * 60 * 60)
    : Infinity;
  const isWithin24HoursPostMatch = Boolean(lastFinishedRaw && hoursSinceLastMatch >= 0 && hoursSinceLastMatch <= 26);
  const useLastAsReference = !liveMatchRaw && !nextMatchRaw && Boolean(lastFinishedRaw);
  const targetEv = liveMatchRaw || (isWithin24HoursPostMatch || useLastAsReference ? lastFinishedRaw : nextMatchRaw);

  let currentMatch = null;
  let lastMatchStats = null;
  let rivalLast2 = [];

  if (targetEv) {
    const isLive = Boolean(liveMatchRaw && Number(targetEv.fixture?.id) === Number(liveMatchRaw.fixture?.id));
    const isFinishedTarget = finishedCodes.includes(targetEv.fixture?.status?.short);
    const statusShortRaw = String(targetEv.fixture?.status?.short || '');
    const isTargetTbd = !isLive && !isFinishedTarget && (statusShortRaw === 'TBD' || tentativeIds.has(String(targetEv.fixture?.id || '').trim()));
    const homeTeam = targetEv.teams?.home || {};
    const awayTeam = targetEv.teams?.away || {};
    const homeId = Number(homeTeam.id || 0);
    const awayId = Number(awayTeam.id || 0);
    const homeNameStr = formatVelezName(homeTeam.name || 'Local');
    const awayNameStr = formatVelezName(awayTeam.name || 'Visitante');
    const rivalTeam = homeId === VELEZ_ID ? awayTeam : homeTeam;
    const rivalId = Number(rivalTeam?.id || 0);
    const matchDateObj = new Date(targetEv.fixture?.date);
    const timestampMs = matchDateObj.getTime();
    const isoDateStrict = matchDateObj.toISOString();

    if (rivalId && rivalId !== VELEZ_ID) {
      rivalLast2 = await fetchRivalLast2Matches(rivalId, season, allLeagueFixtures);
    }

    let scorers = { home: [], away: [] };
    let cards = { home: { yellow: [], red: [] }, away: { yellow: [], red: [] } };
    let substitutions = { home: [], away: [] };
    let penaltyShootout = { home: [], away: [] };
    let timeline = [];
    let matchStatistics = [];
    let matchLineups = { home: null, away: null };
    let possessionObj = null;

    if (isLive || isFinishedTarget) {
      try {
        const [evList, statsList, lineupsResp] = await Promise.all([
          getFixtureEventsCached(targetEv.fixture.id, isLive),
          getFixtureStatisticsCached(targetEv.fixture.id, isLive),
          getFixtureLineupsCached(targetEv.fixture.id).catch(() => [])
        ]);

        const parsedEv = parseEventsIntoScorersAndCards(evList, homeId, awayId, homeNameStr, awayNameStr);
        scorers = parsedEv.scorers;
        cards = parsedEv.cards;
        substitutions = parsedEv.substitutions;
        penaltyShootout = parsedEv.penaltyShootout;
        timeline = parsedEv.timeline;

        matchStatistics = buildMatchStatisticsComparison(statsList, homeId, awayId);
        matchLineups = parseMatchLineupsForView(lineupsResp, homeId, awayId);

        const velezBlock = (statsList || []).find(b => Number(b.team?.id) === VELEZ_ID);
        const rivalBlock = (statsList || []).find(b => Number(b.team?.id) !== VELEZ_ID);
        const homeBlock = (statsList || []).find(b => Number(b.team?.id) === homeId);
        const awayBlock = (statsList || []).find(b => Number(b.team?.id) === awayId);

        const hPoss = getStatValue(homeBlock?.statistics || [], 'Ball Possession');
        const aPoss = getStatValue(awayBlock?.statistics || [], 'Ball Possession');
        if (hPoss !== null && aPoss !== null) {
          possessionObj = { home: Math.round(hPoss), away: Math.round(aPoss) };
        }

        if (velezBlock) {
          const vStats = velezBlock.statistics || [];
          const rStats = rivalBlock?.statistics || [];
          const shotsOnTarget = getStatValue(vStats, 'Shots on Goal') ?? 0;
          const shotsOffTarget = getStatValue(vStats, 'Shots off Goal') ?? 0;
          const totalShots = getStatValue(vStats, 'Total Shots') ?? (shotsOnTarget + shotsOffTarget);

          lastMatchStats = {
            rival: formatVelezName(rivalTeam.name || 'Rival'),
            date: matchDateObj.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
            possession: getStatValue(vStats, 'Ball Possession'),
            oppPossession: getStatValue(rStats, 'Ball Possession'),
            totalShots,
            shotsOnTarget,
            shotsOffTarget
          };
        }
      } catch (e) {
        console.warn('Error obteniendo eventos/estadísticas del partido:', e.message);
      }
    }

    let matchMode = 'NEXT';
    if (isLive) matchMode = 'LIVE';
    else if (isWithin24HoursPostMatch) matchMode = 'FINISHED_24H';
    else if (useLastAsReference) matchMode = 'LAST_REFERENCE';

    const elapsedLabel = isLive
      ? (statusShortRaw === 'HT'
          ? 'ENTRETIEMPO'
          : (targetEv.fixture?.status?.elapsed ? `${targetEv.fixture.status.elapsed}'` : 'EN JUEGO'))
      : '';

    currentMatch = {
      type: matchMode,
      timestamp: timestampMs,
      isoDate: isoDateStrict,
      apiStatusShort: statusShortRaw || 'NS',
      tentativeDate: isTargetTbd,
      penalties: targetEv.score?.penalty || null,
      velezForm: velezLast2,
      rivalForm: rivalLast2,
      velezLastMatches: velezLast2,
      rivalLastMatches: rivalLast2,
      match: {
        teams: {
          home: { id: homeId, name: homeNameStr, logo: homeTeam.logo || '' },
          away: { id: awayId, name: awayNameStr, logo: awayTeam.logo || '' }
        },
        goals: {
          home: targetEv.goals?.home ?? 0,
          away: targetEv.goals?.away ?? 0
        },
        score: targetEv.score || {},
        scorers,
        cards,
        substitutions,
        penaltyShootout,
        timeline,
        statistics: matchStatistics,
        lineups: matchLineups,
        possession: possessionObj,
        fixture: {
          date: isoDateStrict,
          timestamp: Math.floor(timestampMs / 1000),
          timestampMs,
          venue: { name: targetEv.fixture?.venue?.name || 'Estadio José Amalfitani' },
          status: {
            short: isLive ? 'LIVE' : (isFinishedTarget ? 'FT' : (isTargetTbd ? 'TBD' : 'NS')),
            long: isTargetTbd ? 'Fecha a confirmar' : (targetEv.fixture?.status?.long || 'Programado'),
            elapsed: elapsedLabel
          }
        },
        league: {
          id: Number(targetEv.league?.id || LIGA_ARG_ID),
          name: getCompetitionDisplayName(targetEv.league),
          round: cleanRoundLabel(targetEv.league?.round || '')
        }
      }
    };
  } else {
    currentMatch = {
      type: 'TBD',
      timestamp: null,
      isoDate: null,
      apiStatusShort: 'TBD',
      tentativeDate: true,
      velezForm: velezLast2,
      rivalForm: [],
      velezLastMatches: velezLast2,
      rivalLastMatches: [],
      match: {
        teams: {
          home: { id: VELEZ_ID, name: 'Vélez Sarsfield', logo: '' },
          away: { id: 0, name: 'A confirmar', logo: '' }
        },
        goals: { home: null, away: null },
        scorers: { home: [], away: [] },
        cards: { home: { yellow: [], red: [] }, away: { yellow: [], red: [] } },
        substitutions: { home: [], away: [] },
        penaltyShootout: { home: [], away: [] },
        timeline: [],
        statistics: [],
        lineups: { home: null, away: null },
        possession: null,
        fixture: {
          date: null,
          venue: { name: 'A confirmar' },
          status: { short: 'TBD', long: 'Próximo encuentro a confirmar' }
        },
        league: {
          id: LIGA_ARG_ID,
          name: 'Liga Profesional Argentina',
          round: 'Calendario por definir'
        }
      }
    };
  }

  const recentLineups = [];
  const lineupsTargetEvents = [...finishedMatches].reverse().slice(0, 3);
  for (const ev of lineupsTargetEvents) {
    try {
      const lResp = await getFixtureLineupsCached(ev.fixture.id);
      const velezLineup = (lResp || []).find(item => Number(item.team?.id) === VELEZ_ID);
      if (velezLineup && Array.isArray(velezLineup.startXI) && velezLineup.startXI.length >= 11) {
        const parsed = formatPastMatchApiFootball(ev, VELEZ_ID);
        recentLineups.push({
          eventId: String(ev.fixture.id),
          formation: velezLineup.formation || '4-2-3-1',
          rival: parsed.rival,
          date: parsed.date,
          score: parsed.score,
          cond: parsed.cond,
          comp: parsed.comp,
          starters: velezLineup.startXI.slice(0, 11).map(entry => {
            const pl = entry.player || {};
            const posInfo = mapPosition('', pl.pos);
            return {
              id: Number(pl.id || 0),
              name: pl.name || 'Jugador',
              shortName: pl.name || 'Jugador',
              number: Number(pl.number || 0) || '-',
              position: pl.pos || posInfo.group,
              posLabel: posInfo.posLabel,
              group: posInfo.group
            };
          })
        });
      }
    } catch (e) {
      // Continuar si un partido no tiene formación cargada
    }
  }

  const lastLineup = recentLineups[0] || { formation: '4-2-3-1', rival: '', date: '', starters: [] };
  const standingsParsed = parseStandingsResponse(standingsResp, allLeagueFixtures, VELEZ_ID);

  return {
    season,
    velezApiFootballId: VELEZ_ID,
    competitions: {
      liga: LIGA_ARG_ID,
      copaArgentina: COPA_ARG_ID,
      sudamericana: SUDAMERICANA_ID
    },
    activeTournamentName,
    grupoAName: standingsParsed.grupoAName,
    grupoBName: standingsParsed.grupoBName,
    currentMatch,
    lastMatches,
    velezLast2,
    rivalLastMatches: rivalLast2,
    rivalLast2,
    upcomingMatches,
    squad,
    clausuraSquad: squad,
    lastLineup,
    recentLineups,
    lastMatchStats,
    standingsClausura: standingsParsed.standingsClausura,
    standingsGrupoA: standingsParsed.standingsGrupoA,
    standingsGrupoB: standingsParsed.standingsGrupoB,
    standingsAnual: standingsParsed.standingsAnual
  };
}

async function computeVelezTournamentFixture() {
  const season = getCurrentSeasonYear(Date.now());
  const [fixtures, tentativeIds] = await Promise.all([
    fetchVelezAllCompetitionsFixtures(season),
    fetchTentativeFixtureIds()
  ]);

  const sortedDesc = [...fixtures].sort(
    (a, b) => new Date(b.fixture?.date || 0).getTime() - new Date(a.fixture?.date || 0).getTime()
  );

  const finishedCodes = ['FT', 'AET', 'PEN'];
  const liveCodes = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE'];

  const matches = await Promise.all(
    sortedDesc.map(async (ev) => {
      const code = String(ev.fixture?.status?.short || 'NS');
      const status = finishedCodes.includes(code) ? 'FINISHED' : (liveCodes.includes(code) ? 'LIVE' : 'UPCOMING');
      const fixtureIdStr = String(ev.fixture?.id || '').trim();
      const tentativeDate = status === 'UPCOMING' && (code === 'TBD' || tentativeIds.has(fixtureIdStr));
      const homeTeam = ev.teams?.home || {};
      const awayTeam = ev.teams?.away || {};
      const homeId = Number(homeTeam.id || 0);
      const awayId = Number(awayTeam.id || 0);
      const homeName = formatVelezName(homeTeam.name || 'Local');
      const awayName = formatVelezName(awayTeam.name || 'Visitante');
      const isVelezHome = homeId === VELEZ_ID;
      const d = new Date(ev.fixture?.date);

      let scorers = { home: [], away: [] };
      let cards = { home: { yellow: [], red: [] }, away: { yellow: [], red: [] } };
      let substitutions = { home: [], away: [] };
      let penaltyShootout = { home: [], away: [] };
      let statistics = [];
      let lineups = { home: null, away: null };
      let possession = null;

      if ((status === 'FINISHED' || status === 'LIVE') && ev.fixture?.id) {
        try {
          const [evList, statsList, lineupsResp] = await Promise.all([
            getFixtureEventsCached(ev.fixture.id, status === 'LIVE'),
            getFixtureStatisticsCached(ev.fixture.id, status === 'LIVE'),
            getFixtureLineupsCached(ev.fixture.id).catch(() => [])
          ]);

          const parsedEv = parseEventsIntoScorersAndCards(evList, homeId, awayId, homeName, awayName);
          scorers = parsedEv.scorers;
          cards = parsedEv.cards;
          substitutions = parsedEv.substitutions;
          penaltyShootout = parsedEv.penaltyShootout;

          statistics = buildMatchStatisticsComparison(statsList, homeId, awayId);
          lineups = parseMatchLineupsForView(lineupsResp, homeId, awayId);

          const homeBlock = (statsList || []).find(b => Number(b.team?.id) === homeId);
          const awayBlock = (statsList || []).find(b => Number(b.team?.id) === awayId);
          const hPoss = getStatValue(homeBlock?.statistics || [], 'Ball Possession');
          const aPoss = getStatValue(awayBlock?.statistics || [], 'Ball Possession');
          if (hPoss !== null && aPoss !== null) {
            possession = { home: Math.round(hPoss), away: Math.round(aPoss) };
          }
        } catch (err) {
          // Si un partido no tiene eventos/estadísticas disponibles, queda en vacío
        }
      }

      return {
        id: fixtureIdStr,
        leagueId: Number(ev.league?.id || LIGA_ARG_ID),
        status,
        apiStatusShort: code,
        tentativeDate,
        isoDate: d.toISOString(),
        timestamp: d.getTime(),
        round: cleanRoundLabel(ev.league?.round || 'Fecha'),
        comp: getCompetitionDisplayName(ev.league),
        stadium: ev.fixture?.venue?.name || (isVelezHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar'),
        cond: isVelezHome ? 'L' : 'V',
        home: {
          name: homeName,
          logo: homeTeam.logo || '',
          goals: status === 'UPCOMING' ? null : (ev.goals?.home ?? 0)
        },
        away: {
          name: awayName,
          logo: awayTeam.logo || '',
          goals: status === 'UPCOMING' ? null : (ev.goals?.away ?? 0)
        },
        penalties: ev.score?.penalty || null,
        scorers,
        cards,
        substitutions,
        penaltyShootout,
        statistics,
        lineups,
        possession
      };
    })
  );

  return {
    season,
    tournamentName: detectActiveTournamentName(fixtures, []),
    matches
  };
}

function refreshVelezDataInBackground() {
  if (inflightRequest) return inflightRequest;
  inflightRequest = (async () => {
    try {
      const payload = await computeVelezPayload(Date.now());
      cacheData = payload;
      cacheTime = Date.now();
      return payload;
    } finally {
      inflightRequest = null;
    }
  })();
  return inflightRequest;
}

function refreshFixtureInBackground() {
  if (inflightFixtureRequest) return inflightFixtureRequest;
  inflightFixtureRequest = (async () => {
    try {
      const payload = await computeVelezTournamentFixture();
      fixtureCacheData = payload;
      fixtureCacheTime = Date.now();
      return payload;
    } finally {
      inflightFixtureRequest = null;
    }
  })();
  return inflightFixtureRequest;
}

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    season: getCurrentSeasonYear(Date.now()),
    mensaje: 'Backend Vélez API-Football activo. Endpoints: /api/velez-data y /api/velez-fixture'
  });
});

app.get('/api/velez-data', async (req, res) => {
  const now = Date.now();
  const isLiveCached = cacheData?.currentMatch?.type === 'LIVE';
  const ttl = isLiveCached ? 20 * 1000 : 15 * 60 * 1000;

  if (cacheData) {
    if (now - cacheTime >= ttl) {
      refreshVelezDataInBackground().catch(err =>
        console.warn('Error refrescando velez-data en background:', err.message)
      );
    }
    return res.json(cacheData);
  }

  try {
    const data = await refreshVelezDataInBackground();
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: 'Fallo al procesar datos de API-Football',
      mensaje: error.message
    });
  }
});

app.get('/api/velez-fixture', async (req, res) => {
  const now = Date.now();
  const ttl = 15 * 60 * 1000;

  if (fixtureCacheData) {
    if (now - fixtureCacheTime >= ttl) {
      refreshFixtureInBackground().catch(err =>
        console.warn('Error refrescando velez-fixture en background:', err.message)
      );
    }
    return res.json(fixtureCacheData);
  }

  try {
    const data = await refreshFixtureInBackground();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo fixture', mensaje: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT} (temporada ${getCurrentSeasonYear(Date.now())})`);
  refreshVelezDataInBackground().catch(err => console.warn('Warmup velez-data:', err.message));
  refreshFixtureInBackground().catch(err => console.warn('Warmup velez-fixture:', err.message));
});
