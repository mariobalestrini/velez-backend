const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';

const VELEZ_ID = 438;
const LIGA_ARG_ID = 128;
const SEASON = 2026;

let cacheData = null;
let cacheTime = 0;
let inflightRequest = null;

let fixtureCacheData = null;
let fixtureCacheTime = 0;
let inflightFixtureRequest = null;

const statsCacheByFixture = new Map();
const eventsCacheByFixture = new Map();
const lineupsCacheByFixture = new Map();

function normalizeStr(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function cleanRoundLabel(roundStr = '') {
  return String(roundStr || '')
    .replace(/\s*[•|-]?\s*(?:MF|FT)\s*-\s*Pens\b/gi, '')
    .replace(/\s*-\s*Pens\b/gi, '')
    .trim();
}

function isPlayoffRound(roundStr = '') {
  return /round of 16|octavos|quarter|cuartos|semi|final|play-?off|eliminaci[oó]n|knockout/i.test(String(roundStr));
}

function isAperturaLabel(str = '') {
  return /\b1st phase\b|\bapertura\b/i.test(String(str));
}

function isClausuraRegularRound(roundStr = '') {
  const r = String(roundStr || '');
  if (!r) return false;
  if (isPlayoffRound(r) || isAperturaLabel(r)) return false;
  return /2nd phase|clausura|regular|fecha\s*\d+|group\s*[ab]/i.test(r);
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

function parseEventsIntoScorersAndCards(eventsList = [], homeTeamId, awayTeamId) {
  const scorers = { home: [], away: [] };
  const cards = {
    home: { yellow: [], red: [] },
    away: { yellow: [], red: [] }
  };

  (eventsList || []).forEach(ev => {
    const evTeamId = Number(ev.team?.id || 0);
    const side = evTeamId === Number(homeTeamId) ? 'home' : (evTeamId === Number(awayTeamId) ? 'away' : null);
    if (!side) return;

    const minuteElapsed = Number(ev.time?.elapsed ?? 0);
    const minuteExtra = ev.time?.extra ? `+${ev.time.extra}` : '';
    const clock = ev.time?.elapsed !== undefined && ev.time?.elapsed !== null ? `${minuteElapsed}${minuteExtra}'` : '';
    const playerName = ev.player?.name || 'Jugador';
    const typeLower = String(ev.type || '').toLowerCase();
    const detailLower = String(ev.detail || '').toLowerCase();
    const commentsLower = String(ev.comments || '').toLowerCase();

    const isShootoutPenalty =
      commentsLower.includes('shootout') ||
      commentsLower.includes('penalty shootout') ||
      (detailLower === 'penalty' && minuteElapsed >= 120);

    if (typeLower === 'goal' && !isShootoutPenalty) {
      if (detailLower.includes('own goal')) {
        scorers[side].push(`${playerName} ${clock} (EC)`.trim());
      } else if (detailLower.includes('penalty')) {
        scorers[side].push(`${playerName} ${clock} (P)`.trim());
      } else if (!detailLower.includes('missed penalty')) {
        scorers[side].push(`${playerName} ${clock}`.trim());
      }
    } else if (typeLower === 'card') {
      if (detailLower.includes('red') || detailLower.includes('second yellow')) {
        cards[side].red.push(`${playerName} ${clock}`.trim());
      } else if (detailLower.includes('yellow')) {
        cards[side].yellow.push(`${playerName} ${clock}`.trim());
      }
    }
  });

  return { scorers, cards };
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
    fecha: cleanRoundLabel(ev.league?.round || 'LPF'),
    comp: ev.league?.name || 'Liga Profesional Argentina',
    date: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
    rival: oppTeam?.name || 'Rival',
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

function parseStandingsResponse(standingsResp = [], targetTeamId = VELEZ_ID) {
  const leagueStandings = standingsResp[0]?.league?.standings || [];
  const candidateGroups = [];

  if (Array.isArray(leagueStandings) && leagueStandings.length > 0) {
    if (Array.isArray(leagueStandings[0])) {
      leagueStandings.forEach((groupRows, idx) => {
        const rawGroup = String(groupRows[0]?.group || `Grupo ${idx === 0 ? 'A' : 'B'}`);
        const cleanGroup = cleanRoundLabel(rawGroup);
        if (!isPlayoffRound(rawGroup) && !isAperturaLabel(rawGroup)) {
          candidateGroups.push({ name: cleanGroup, rows: groupRows });
        }
      });
    } else {
      const rawGroup = String(leagueStandings[0]?.group || 'Torneo Clausura');
      const cleanGroup = cleanRoundLabel(rawGroup);
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
      name: r.team?.name || 'Equipo',
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
      cupNote: r.description || '',
      cupColor: null
    };
  };

  let standingsGrupoA = [];
  let standingsGrupoB = [];
  let grupoAName = 'Grupo A';
  let grupoBName = 'Grupo B';

  if (candidateGroups.length >= 2) {
    grupoAName = candidateGroups[0].name || 'Grupo A';
    grupoBName = candidateGroups[1].name || 'Grupo B';
    standingsGrupoA = candidateGroups[0].rows.map(mapRow).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
    standingsGrupoB = candidateGroups[1].rows.map(mapRow).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
  } else if (candidateGroups.length === 1) {
    grupoAName = candidateGroups[0].name || 'Grupo A';
    standingsGrupoA = candidateGroups[0].rows.map(mapRow).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
  }

  const velezInA = standingsGrupoA.some(t => t.isVelez);
  const velezInB = standingsGrupoB.some(t => t.isVelez);
  const standingsClausura = velezInB ? standingsGrupoB : (velezInA ? standingsGrupoA : standingsGrupoA);

  return {
    standingsClausura,
    standingsGrupoA,
    standingsGrupoB,
    grupoAName,
    grupoBName,
    standingsAnual: []
  };
}

async function fetchBaseSquad() {
  const mapById = new Map();

  try {
    const playersResp = await apiFootballGet('/players', {
      team: VELEZ_ID,
      league: LIGA_ARG_ID,
      season: SEASON
    });

    (playersResp || []).forEach(entry => {
      const player = entry.player || {};
      const statBlock = (entry.statistics || []).find(s => Number(s.league?.id) === LIGA_ARG_ID) || entry.statistics?.[0] || {};
      const id = Number(player.id || 0);
      if (!id) return;
      const posInfo = mapPosition(statBlock.games?.position || player.position, '');
      const countryInfo = mapCountryToIso(player.nationality);
      mapById.set(id, {
        id,
        name: player.name || 'Jugador',
        shortName: player.lastname || player.name || 'Jugador',
        age: Number(player.age || 0),
        number: Number(statBlock.games?.number ?? player.number ?? 0) || null,
        dorsal: Number(statBlock.games?.number ?? player.number ?? 0) || null,
        jersey: Number(statBlock.games?.number ?? player.number ?? 0) || null,
        position: posInfo.posLabel,
        posLabel: posInfo.posLabel,
        group: posInfo.group,
        countryCode: countryInfo.code,
        countryName: countryInfo.label,
        flagUrl: `https://flagcdn.com/w80/${countryInfo.code}.png`,
        photo: player.photo || '',
        pj: 0,
        goals: 0,
        cleanSheets: posInfo.group === 'ARQ' ? 0 : null,
        yellowCards: 0,
        redCards: 0
      });
    });
  } catch (err) {
    console.warn('Error leyendo /players:', err.message);
  }

  try {
    const squadsResp = await apiFootballGet('/players/squads', { team: VELEZ_ID });
    const list = squadsResp[0]?.players || [];
    list.forEach(p => {
      const id = Number(p.id || 0);
      if (!id) return;
      const posInfo = mapPosition(p.position, '');
      const existing = mapById.get(id);
      if (existing) {
        existing.number = existing.number || Number(p.number || 0) || null;
        existing.dorsal = existing.number;
        existing.jersey = existing.number;
        existing.group = posInfo.group || existing.group;
        existing.posLabel = posInfo.posLabel || existing.posLabel;
        existing.position = existing.posLabel;
        existing.cleanSheets = existing.group === 'ARQ' ? 0 : null;
      } else {
        mapById.set(id, {
          id,
          name: p.name || 'Jugador',
          shortName: p.name || 'Jugador',
          age: Number(p.age || 0),
          number: Number(p.number || 0) || null,
          dorsal: Number(p.number || 0) || null,
          jersey: Number(p.number || 0) || null,
          position: posInfo.posLabel,
          posLabel: posInfo.posLabel,
          group: posInfo.group,
          countryCode: 'ar',
          countryName: 'Argentina',
          flagUrl: 'https://flagcdn.com/w80/ar.png',
          photo: p.photo || '',
          pj: 0,
          goals: 0,
          cleanSheets: posInfo.group === 'ARQ' ? 0 : null,
          yellowCards: 0,
          redCards: 0
        });
      }
    });
  } catch (err) {
    console.warn('Error leyendo /players/squads:', err.message);
  }

  return Array.from(mapById.values());
}

async function computeClausuraSquadStats(baseSquad, finishedMatches) {
  const clausuraMatches = (finishedMatches || []).filter(f => !isPlayoffRound(f.league?.round) && !isAperturaLabel(f.league?.round));
  const pjCount = new Map();
  const goalsCount = new Map();
  const yellowCount = new Map();
  const redCount = new Map();
  const cleanSheetsCount = new Map();

  for (const ev of clausuraMatches) {
    const fId = ev.fixture?.id;
    if (!fId) continue;

    const isVelezHome = Number(ev.teams?.home?.id) === VELEZ_ID;
    const rivalGoals = Number(isVelezHome ? (ev.goals?.away ?? 0) : (ev.goals?.home ?? 0));

    try {
      const [lineupsResp, eventsResp] = await Promise.all([
        getFixtureLineupsCached(fId),
        getFixtureEventsCached(fId, false)
      ]);

      const velezLineup = (lineupsResp || []).find(item => Number(item.team?.id) === VELEZ_ID);
      const matchPlayersSet = new Set();

      if (velezLineup) {
        (velezLineup.startXI || []).forEach(x => {
          const pid = Number(x.player?.id || 0);
          if (pid) matchPlayersSet.add(pid);
          if (String(x.player?.pos || '').toUpperCase() === 'G' && pid) {
            if (rivalGoals === 0) cleanSheetsCount.set(pid, (cleanSheetsCount.get(pid) || 0) + 1);
          }
        });
        (velezLineup.substitutes || []).forEach(x => {
          const pid = Number(x.player?.id || 0);
          if (pid) matchPlayersSet.add(pid);
        });
      }

      (eventsResp || []).forEach(evItem => {
        const pid = Number(evItem.player?.id || 0);
        const assistId = Number(evItem.assist?.id || 0);
        if (Number(evItem.team?.id) === VELEZ_ID) {
          if (pid && String(evItem.type || '').toLowerCase() === 'subst') {
            matchPlayersSet.add(pid);
          }
          if (assistId && String(evItem.type || '').toLowerCase() === 'subst') {
            matchPlayersSet.add(assistId);
          }

          const minElapsed = Number(evItem.time?.elapsed ?? 0);
          const typeLower = String(evItem.type || '').toLowerCase();
          const detailLower = String(evItem.detail || '').toLowerCase();
          const commentsLower = String(evItem.comments || '').toLowerCase();
          const isShootout = commentsLower.includes('shootout') || (detailLower === 'penalty' && minElapsed >= 120);

          if (typeLower === 'goal' && !isShootout && !detailLower.includes('own goal') && !detailLower.includes('missed penalty') && pid) {
            goalsCount.set(pid, (goalsCount.get(pid) || 0) + 1);
          } else if (typeLower === 'card' && pid) {
            if (detailLower.includes('red') || detailLower.includes('second yellow')) {
              redCount.set(pid, (redCount.get(pid) || 0) + 1);
            } else if (detailLower.includes('yellow')) {
              yellowCount.set(pid, (yellowCount.get(pid) || 0) + 1);
            }
          }
        }
      });

      matchPlayersSet.forEach(pid => {
        pjCount.set(pid, (pjCount.get(pid) || 0) + 1);
      });
    } catch (err) {
      // Continuar si un partido no tiene eventos o alineación
    }
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
  const [fixtures, standingsResp, baseSquad] = await Promise.all([
    apiFootballGet('/fixtures', { team: VELEZ_ID, league: LIGA_ARG_ID, season: SEASON }),
    apiFootballGet('/standings', { league: LIGA_ARG_ID, season: SEASON }),
    fetchBaseSquad()
  ]);

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

  const squad = await computeClausuraSquadStats(baseSquad, finishedMatches);

  const lastMatches = [...finishedMatches].reverse().slice(0, 5).map(ev => formatPastMatchApiFootball(ev, VELEZ_ID));
  const velezLast2 = lastMatches.slice(0, 2);

  const upcomingMatches = upcomingRaw.slice(0, 4).map(ev => {
    const isHome = Number(ev.teams?.home?.id) === VELEZ_ID;
    const rivalTeam = isHome ? ev.teams?.away : ev.teams?.home;
    const d = new Date(ev.fixture?.date);
    return {
      fecha: cleanRoundLabel(ev.league?.round || 'PRÓXIMO'),
      comp: ev.league?.name || 'Liga Profesional Argentina',
      isoDate: d.toISOString(),
      timestamp: d.getTime(),
      date: d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
      timeART: d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }) + ' ART',
      rival: rivalTeam?.name || 'Rival',
      rivalLogo: rivalTeam?.logo || '',
      cond: isHome ? 'L' : 'V',
      stadium: ev.fixture?.venue?.name || (isHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar')
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

  if (targetEv) {
    const isLive = Boolean(liveMatchRaw && Number(targetEv.fixture?.id) === Number(liveMatchRaw.fixture?.id));
    const isFinishedTarget = finishedCodes.includes(targetEv.fixture?.status?.short);
    const homeTeam = targetEv.teams?.home || {};
    const awayTeam = targetEv.teams?.away || {};
    const homeId = Number(homeTeam.id || 0);
    const awayId = Number(awayTeam.id || 0);
    const rivalTeam = homeId === VELEZ_ID ? awayTeam : homeTeam;
    const matchDateObj = new Date(targetEv.fixture?.date);
    const timestampMs = matchDateObj.getTime();
    const isoDateStrict = matchDateObj.toISOString();

    let scorers = { home: [], away: [] };
    let cards = { home: { yellow: [], red: [] }, away: { yellow: [], red: [] } };
    let possessionObj = null;

    if (isLive || isFinishedTarget) {
      try {
        const [evList, statsList] = await Promise.all([
          getFixtureEventsCached(targetEv.fixture.id, isLive),
          getFixtureStatisticsCached(targetEv.fixture.id, isLive)
        ]);

        const parsedEv = parseEventsIntoScorersAndCards(evList, homeId, awayId);
        scorers = parsedEv.scorers;
        cards = parsedEv.cards;

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
            rival: rivalTeam.name || 'Rival',
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
      ? (targetEv.fixture?.status?.elapsed ? `${targetEv.fixture.status.elapsed}'` : 'EN JUEGO')
      : '';

    currentMatch = {
      type: matchMode,
      timestamp: timestampMs,
      isoDate: isoDateStrict,
      penalties: targetEv.score?.penalty || null,
      velezForm: velezLast2,
      rivalForm: [],
      velezLastMatches: velezLast2,
      rivalLastMatches: [],
      match: {
        teams: {
          home: { id: homeId, name: homeTeam.name || 'Local', logo: homeTeam.logo || '' },
          away: { id: awayId, name: awayTeam.name || 'Visitante', logo: awayTeam.logo || '' }
        },
        goals: {
          home: targetEv.goals?.home ?? 0,
          away: targetEv.goals?.away ?? 0
        },
        score: targetEv.score || {},
        scorers,
        cards,
        possession: possessionObj,
        fixture: {
          date: isoDateStrict,
          timestamp: Math.floor(timestampMs / 1000),
          timestampMs,
          venue: { name: targetEv.fixture?.venue?.name || 'Estadio José Amalfitani' },
          status: {
            short: isLive ? 'LIVE' : (isFinishedTarget ? 'FT' : 'NS'),
            long: targetEv.fixture?.status?.long || 'Programado',
            elapsed: elapsedLabel
          }
        },
        league: {
          name: targetEv.league?.name || 'Liga Profesional Argentina',
          round: cleanRoundLabel(targetEv.league?.round || '')
        }
      }
    };
  } else {
    currentMatch = {
      type: 'TBD',
      timestamp: null,
      isoDate: null,
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
        possession: null,
        fixture: {
          date: null,
          venue: { name: 'A confirmar' },
          status: { short: 'TBD', long: 'Próximo encuentro a confirmar' }
        },
        league: {
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
  const standingsParsed = parseStandingsResponse(standingsResp, VELEZ_ID);

  return {
    velezApiFootballId: VELEZ_ID,
    activeTournamentName: 'Torneo Clausura',
    grupoAName: standingsParsed.grupoAName,
    grupoBName: standingsParsed.grupoBName,
    currentMatch,
    lastMatches,
    velezLast2,
    rivalLastMatches: [],
    rivalLast2: [],
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
  const fixtures = await apiFootballGet('/fixtures', { team: VELEZ_ID, league: LIGA_ARG_ID, season: SEASON });
  const sortedDesc = [...fixtures].sort(
    (a, b) => new Date(b.fixture?.date || 0).getTime() - new Date(a.fixture?.date || 0).getTime()
  );

  const finishedCodes = ['FT', 'AET', 'PEN'];
  const liveCodes = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE'];

  const matches = sortedDesc.map(ev => {
    const code = ev.fixture?.status?.short || 'NS';
    const status = finishedCodes.includes(code) ? 'FINISHED' : (liveCodes.includes(code) ? 'LIVE' : 'UPCOMING');
    const homeTeam = ev.teams?.home || {};
    const awayTeam = ev.teams?.away || {};
    const isVelezHome = Number(homeTeam.id) === VELEZ_ID;
    const d = new Date(ev.fixture?.date);

    return {
      id: String(ev.fixture?.id || ''),
      status,
      isoDate: d.toISOString(),
      timestamp: d.getTime(),
      round: cleanRoundLabel(ev.league?.round || 'Fecha'),
      comp: ev.league?.name || 'Liga Profesional Argentina',
      stadium: ev.fixture?.venue?.name || (isVelezHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar'),
      cond: isVelezHome ? 'L' : 'V',
      home: {
        name: homeTeam.name || 'Local',
        logo: homeTeam.logo || '',
        goals: status === 'UPCOMING' ? null : (ev.goals?.home ?? 0)
      },
      away: {
        name: awayTeam.name || 'Visitante',
        logo: awayTeam.logo || '',
        goals: status === 'UPCOMING' ? null : (ev.goals?.away ?? 0)
      },
      penalties: ev.score?.penalty || null,
      scorers: { home: [], away: [] },
      possession: null
    };
  });

  return {
    tournamentName: 'Torneo Clausura',
    matches
  };
}

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    mensaje: 'Backend Vélez API-Football activo. Endpoints: /api/velez-data y /api/velez-fixture'
  });
});

app.get('/api/velez-data', async (req, res) => {
  const now = Date.now();
  const isLiveCached = cacheData?.currentMatch?.type === 'LIVE';
  const ttl = isLiveCached ? 20 * 1000 : 15 * 60 * 1000;

  if (cacheData && (now - cacheTime < ttl)) {
    return res.json(cacheData);
  }

  if (inflightRequest) {
    try {
      const sharedData = await inflightRequest;
      return res.json(sharedData);
    } catch (err) {
      if (cacheData) return res.json(cacheData);
    }
  }

  inflightRequest = (async () => {
    const payload = await computeVelezPayload(Date.now());
    cacheData = payload;
    cacheTime = Date.now();
    return payload;
  })();

  try {
    const data = await inflightRequest;
    res.json(data);
  } catch (error) {
    if (cacheData) {
      return res.json(cacheData);
    }
    res.status(500).json({
      error: 'Fallo al procesar datos de API-Football',
      mensaje: error.message
    });
  } finally {
    inflightRequest = null;
  }
});

app.get('/api/velez-fixture', async (req, res) => {
  const now = Date.now();
  const ttl = 15 * 60 * 1000;

  if (fixtureCacheData && (now - fixtureCacheTime < ttl)) {
    return res.json(fixtureCacheData);
  }

  if (inflightFixtureRequest) {
    try {
      const shared = await inflightFixtureRequest;
      return res.json(shared);
    } catch (err) {
      if (fixtureCacheData) return res.json(fixtureCacheData);
    }
  }

  inflightFixtureRequest = (async () => {
    const payload = await computeVelezTournamentFixture();
    fixtureCacheData = payload;
    fixtureCacheTime = Date.now();
    return payload;
  })();

  try {
    const data = await inflightFixtureRequest;
    res.json(data);
  } catch (error) {
    if (fixtureCacheData) return res.json(fixtureCacheData);
    res.status(500).json({ error: 'Error obteniendo fixture', mensaje: error.message });
  } finally {
    inflightFixtureRequest = null;
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
