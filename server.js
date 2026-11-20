const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ESPN_LPF = 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1';
const ESPN_COPA = 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.copa';
const ESPN_WEB_LPF = 'https://site.web.api.espn.com/apis/v2/sports/soccer/arg.1';

let cacheData = null;
let cacheTime = 0;
let inflightRequest = null;

let fixtureCacheData = null;
let fixtureCacheTime = 0;
let inflightFixtureRequest = null;

function normalizeStr(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function getArgentinaNowParts(nowMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [year, month, day] = fmt.format(new Date(nowMs)).split('-').map(Number);
  return { year, month, day };
}

function mapPosition(posAbbr, posName) {
  const abbr = (posAbbr || '').toUpperCase();
  const name = (posName || '').toLowerCase();
  if (abbr === 'G' || abbr === 'GK' || abbr === 'ARQ' || name.includes('arquero') || name.includes('goalkeeper') || name.includes('portero')) {
    return { group: 'ARQ', posLabel: 'Arquero' };
  }
  if (abbr === 'D' || abbr === 'DF' || abbr === 'DEF' || name.includes('defensor') || name.includes('defender') || name.includes('lateral')) {
    return { group: 'DEF', posLabel: 'Defensor' };
  }
  if (abbr === 'F' || abbr === 'FW' || abbr === 'A' || abbr === 'DEL' || name.includes('delantero') || name.includes('atacante') || name.includes('forward')) {
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

function extractScoreNumber(scoreField) {
  if (scoreField === null || scoreField === undefined) return NaN;
  if (typeof scoreField === 'number') return scoreField;
  if (typeof scoreField === 'string') return parseInt(scoreField, 10);
  if (typeof scoreField === 'object') {
    if (scoreField.value !== undefined) return Number(scoreField.value);
    if (scoreField.displayValue !== undefined) return parseInt(scoreField.displayValue, 10);
  }
  return NaN;
}

async function fetchOfficialVelezJerseys() {
  const jerseyByLastName = {};
  try {
    const { data: html } = await axios.get('https://velez.com.ar/futbol/plantel', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 5000
    });
    const regex = /(?:#|N°|num[^>]*>|number[^>]*>|dorsal[^>]*>)\s*(\d{1,2})\s*<[\s\S]{1,350}?([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+)+)/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const num = parseInt(match[1], 10);
      const fullName = normalizeStr(match[2]);
      const parts = fullName.split(' ');
      const lastName = parts[parts.length - 1];
      if (num > 0 && lastName.length > 2) {
        jerseyByLastName[lastName] = num;
        jerseyByLastName[fullName] = num;
      }
    }
  } catch (err) {
    console.warn('No se pudo leer velez.com.ar/futbol/plantel:', err.message);
  }
  return jerseyByLastName;
}

function getTeamLogo(teamObj) {
  if (!teamObj) return '';
  if (teamObj.logo) return teamObj.logo;
  if (teamObj.logos && teamObj.logos.length > 0) return teamObj.logos[0].href;
  if (teamObj.id) return `https://a.espncdn.com/i/teamlogos/soccer/500/${teamObj.id}.png`;
  return '';
}

function formatPastMatch(ev, targetTeamId) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const teamObj = competitors.find(c => String(c.id) === String(targetTeamId) || String(c.team?.id) === String(targetTeamId));
  const oppObj = competitors.find(c => String(c.id) !== String(targetTeamId) && String(c.team?.id) !== String(targetTeamId));
  if (!teamObj || !oppObj) return null;

  const isHome = teamObj.homeAway === 'home';
  const tGoals = extractScoreNumber(teamObj.score);
  const oGoals = extractScoreNumber(oppObj.score);

  const safeT = isNaN(tGoals) ? 0 : tGoals;
  const safeO = isNaN(oGoals) ? 0 : oGoals;

  let outcome = 'E';
  if (safeT > safeO) outcome = 'G';
  else if (safeT < safeO) outcome = 'P';

  const d = new Date(ev.date);
  return {
    id: String(ev.id),
    fecha: ev.seasonType?.abbreviation || 'LPF',
    comp: ev.league?.shortName || 'Liga Profesional',
    date: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
    rival: oppObj.team?.shortDisplayName || oppObj.team?.displayName || 'Rival',
    rivalLogo: getTeamLogo(oppObj.team),
    cond: isHome ? 'L' : 'V',
    velezGoals: safeT,
    rivalGoals: safeO,
    teamGoals: safeT,
    oppGoals: safeO,
    rawRivalGoalsValid: !isNaN(oGoals),
    score: `${safeT} - ${safeO}`,
    outcome
  };
}

function parseStandingsEntries(entries, velezId) {
  const rows = (entries || []).map(entry => {
    const team = entry.team || {};
    const stats = entry.stats || [];
    const findExactStat = (statName) => {
      const s = stats.find(st => st.name === statName || st.type === statName || st.abbreviation === statName);
      return s && s.value !== undefined ? Number(s.value) : 0;
    };

    const pj = findExactStat('gamesPlayed');
    const pts = findExactStat('points');

    const noteDesc = entry.note?.description || '';
    const noteLower = noteDesc.toLowerCase();
    let cupType = null;
    if (noteLower.includes('libertadores')) {
      cupType = 'LIBERTADORES';
    } else if (noteLower.includes('sudamericana')) {
      cupType = 'SUDAMERICANA';
    }

    return {
      id: String(team.id || ''),
      name: team.shortDisplayName || team.displayName || team.name,
      logo: getTeamLogo(team),
      isVelez: String(team.id) === String(velezId),
      pj,
      pg: findExactStat('wins'),
      pe: findExactStat('ties'),
      pp: findExactStat('losses'),
      gf: findExactStat('pointsFor'),
      gc: findExactStat('pointsAgainst'),
      dg: findExactStat('pointDifferential'),
      pts,
      cupType,
      cupNote: noteDesc,
      cupColor: entry.note?.color || null
    };
  });

  rows.sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
  return rows;
}

async function buildGroupStandingsDynamically(allTeams, curYear, velezId, seasonKeyword = '') {
  const kwNorm = normalizeStr(seasonKeyword);
  const validTeamIds = allTeams.map(t => String(t.team?.id || '')).filter(Boolean);
  const validSet = new Set(validTeamIds);
  const rowById = new Map();
  const matchupsByTeam = new Map();

  allTeams.forEach(tObj => {
    const teamId = String(tObj.team?.id || '');
    if (!teamId) return;
    rowById.set(teamId, {
      id: teamId,
      name: tObj.team?.shortDisplayName || tObj.team?.displayName || tObj.team?.name || 'Equipo',
      logo: getTeamLogo(tObj.team),
      isVelez: teamId === String(velezId),
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
    matchupsByTeam.set(teamId, new Map());
  });

  await Promise.allSettled(
    allTeams.map(async (tObj) => {
      const teamId = String(tObj.team?.id || '');
      if (!teamId) return;
      try {
        const schedRes = await axios.get(`${ESPN_LPF}/teams/${teamId}/schedule?region=ar&lang=es`, { timeout: 7000 });
        const events = schedRes.data?.events || [];
        const seenEventIds = new Set();

        events.forEach(ev => {
          if (!ev?.id || seenEventIds.has(String(ev.id))) return;
          seenEventIds.add(String(ev.id));

          const comp = ev.competitions?.[0];
          if (!comp) return;
          const isCompleted = comp.status?.type?.completed === true || comp.status?.type?.state === 'post';
          if (!isCompleted) return;

          const evYear = getArgentinaNowParts(new Date(ev.date).getTime()).year;
          if (evYear !== curYear) return;

          const roundText = normalizeStr(
            `${ev.season?.name || ''} ${ev.seasonType?.name || ''} ${ev.seasonType?.abbreviation || ''} ${comp.status?.type?.shortDetail || ''} ${comp.notes?.[0]?.headline || ''}`
          );

          if (
            roundText.includes('octavos') ||
            roundText.includes('cuartos') ||
            roundText.includes('semi') ||
            roundText.includes('final') ||
            roundText.includes('playoff') ||
            roundText.includes('desempate')
          ) {
            return;
          }

          if (kwNorm.includes('clausura') && roundText.includes('apertura')) return;
          if (kwNorm.includes('apertura') && roundText.includes('clausura')) return;

          const competitors = comp.competitors || [];
          const me = competitors.find(c => String(c.id) === teamId || String(c.team?.id) === teamId);
          const opp = competitors.find(c => String(c.id) !== teamId && String(c.team?.id) !== teamId);
          if (!me || !opp) return;

          const oppId = String(opp.id || opp.team?.id || '');
          if (!validSet.has(oppId)) return;

          const myGoals = extractScoreNumber(me.score);
          const oppGoals = extractScoreNumber(opp.score);
          if (isNaN(myGoals) || isNaN(oppGoals)) return;

          const mMap = matchupsByTeam.get(teamId);
          if (mMap) mMap.set(oppId, (mMap.get(oppId) || 0) + 1);

          const row = rowById.get(teamId);
          if (!row) return;

          row.pj += 1;
          row.gf += myGoals;
          row.gc += oppGoals;
          row.dg = row.gf - row.gc;

          if (myGoals > oppGoals) {
            row.pg += 1;
            row.pts += 3;
          } else if (myGoals < oppGoals) {
            row.pp += 1;
          } else {
            row.pe += 1;
            row.pts += 1;
          }
        });
      } catch (err) {
        console.warn(`Error leyendo schedule de ${teamId}:`, err.message);
      }
    })
  );

  // Particionar dinámicamente los 30 equipos en 2 grupos de 15 minimizando cruces interzonales (Kernighan-Lin)
  const half = Math.floor(validTeamIds.length / 2);
  let setA = new Set(validTeamIds.slice(0, half));
  let setB = new Set(validTeamIds.slice(half));

  const getWeight = (u, v) => {
    const w1 = matchupsByTeam.get(u)?.get(v) || 0;
    const w2 = matchupsByTeam.get(v)?.get(u) || 0;
    return w1 + w2;
  };

  let improved = true;
  let guard = 0;
  while (improved && guard < 50) {
    improved = false;
    guard++;
    const arrA = Array.from(setA);
    const arrB = Array.from(setB);

    let bestGain = 0;
    let bestU = null;
    let bestV = null;

    for (const u of arrA) {
      let intU = 0;
      let extU = 0;
      for (const x of arrA) if (x !== u) intU += getWeight(u, x);
      for (const y of arrB) extU += getWeight(u, y);
      const dU = extU - intU;

      for (const v of arrB) {
        let intV = 0;
        let extV = 0;
        for (const y of arrB) if (y !== v) intV += getWeight(v, y);
        for (const x of arrA) extV += getWeight(v, x);
        const dV = extV - intV;

        const gain = dU + dV - 2 * getWeight(u, v);
        if (gain > bestGain) {
          bestGain = gain;
          bestU = u;
          bestV = v;
        }
      }
    }

    if (bestGain > 0 && bestU && bestV) {
      setA.delete(bestU);
      setB.add(bestU);
      setB.delete(bestV);
      setA.add(bestV);
      improved = true;
    }
  }

  // Asegurar que Grupo A sea el grupo donde está Vélez
  if (setB.has(String(velezId)) && !setA.has(String(velezId))) {
    const tmp = setA;
    setA = setB;
    setB = tmp;
  }

  const grupoA = Array.from(setA).map(id => rowById.get(id)).filter(Boolean).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
  const grupoB = Array.from(setB).map(id => rowById.get(id)).filter(Boolean).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);

  return { grupoA, grupoB };
}

async function buildAnnualStandingsFromTeamSchedules(allTeams, curYear, velezId) {
  const results = await Promise.allSettled(
    allTeams.map(async (tObj) => {
      const teamId = String(tObj.team?.id || '');
      const teamName = tObj.team?.shortDisplayName || tObj.team?.displayName || tObj.team?.name || 'Equipo';
      const teamLogo = getTeamLogo(tObj.team);

      const row = {
        id: teamId,
        name: teamName,
        logo: teamLogo,
        isVelez: teamId === String(velezId),
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
      };

      if (!teamId) return row;

      try {
        const schedRes = await axios.get(`${ESPN_LPF}/teams/${teamId}/schedule?region=ar&lang=es`, { timeout: 7000 });
        const events = schedRes.data?.events || [];
        const seenEventIds = new Set();

        events.forEach(ev => {
          if (!ev?.id || seenEventIds.has(String(ev.id))) return;
          seenEventIds.add(String(ev.id));

          const comp = ev.competitions?.[0];
          if (!comp) return;
          const isCompleted = comp.status?.type?.completed === true || comp.status?.type?.state === 'post';
          if (!isCompleted) return;

          const evYear = getArgentinaNowParts(new Date(ev.date).getTime()).year;
          if (evYear !== curYear) return;

          const roundText = normalizeStr(
            `${ev.seasonType?.name || ''} ${ev.seasonType?.abbreviation || ''} ${comp.status?.type?.shortDetail || ''}`
          );
          if (
            roundText.includes('octavos') ||
            roundText.includes('cuartos') ||
            roundText.includes('semi') ||
            roundText.includes('final') ||
            roundText.includes('playoff') ||
            roundText.includes('desempate')
          ) {
            return;
          }

          const competitors = comp.competitors || [];
          const me = competitors.find(c => String(c.id) === teamId || String(c.team?.id) === teamId);
          const opp = competitors.find(c => String(c.id) !== teamId && String(c.team?.id) !== teamId);
          if (!me || !opp) return;

          const myGoals = extractScoreNumber(me.score);
          const oppGoals = extractScoreNumber(opp.score);
          if (isNaN(myGoals) || isNaN(oppGoals)) return;

          row.pj += 1;
          row.gf += myGoals;
          row.gc += oppGoals;
          row.dg = row.gf - row.gc;

          if (myGoals > oppGoals) {
            row.pg += 1;
            row.pts += 3;
          } else if (myGoals < oppGoals) {
            row.pp += 1;
          } else {
            row.pe += 1;
            row.pts += 1;
          }

          const noteText = me.note?.description || comp.notes?.[0]?.headline || '';
          const noteLower = noteText.toLowerCase();
          if (!row.cupType && noteLower.includes('libertadores')) {
            row.cupType = 'LIBERTADORES';
            row.cupNote = noteText;
          } else if (!row.cupType && noteLower.includes('sudamericana')) {
            row.cupType = 'SUDAMERICANA';
            row.cupNote = noteText;
          }
        });
      } catch (err) {
        console.warn(`Error leyendo schedule anual de ${teamName}:`, err.message);
      }

      return row;
    })
  );

  const table = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  table.sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
  return table;
}

async function computeVelezPayload(now) {
  const { year: curYear, month: curMonth, day: curDay } = getArgentinaNowParts(now);

  const teamsRes = await axios.get(`${ESPN_LPF}/teams?region=ar&lang=es`);
  const allTeams = teamsRes.data?.sports?.[0]?.leagues?.[0]?.teams || [];
  const velezEntry = allTeams.find(t => {
    const name = (t.team?.displayName || t.team?.name || '').toLowerCase();
    return name.includes('vélez') || name.includes('velez');
  });

  if (!velezEntry) {
    throw new Error('No se encontró a Vélez en ESPN arg.1');
  }
  const velezId = String(velezEntry.team.id);
  const velezLogoUrl = getTeamLogo(velezEntry.team);

  const [
    schedPastRes,
    schedFutureLpfRes,
    schedFutureCopaRes,
    teamInfoRes,
    rosterRes,
    standingsRes,
    officialJerseys
  ] = await Promise.allSettled([
    axios.get(`${ESPN_LPF}/teams/${velezId}/schedule?region=ar&lang=es`),
    axios.get(`${ESPN_LPF}/teams/${velezId}/schedule?fixture=true&region=ar&lang=es`),
    axios.get(`${ESPN_COPA}/teams/${velezId}/schedule?region=ar&lang=es`),
    axios.get(`${ESPN_LPF}/teams/${velezId}?enable=roster&region=ar&lang=es`),
    axios.get(`${ESPN_LPF}/teams/${velezId}/roster?region=ar&lang=es`),
    axios.get(`${ESPN_WEB_LPF}/standings?region=ar&lang=es`),
    fetchOfficialVelezJerseys()
  ]);

  const velezWebJerseys = officialJerseys.status === 'fulfilled' ? officialJerseys.value : {};

  let standingsClausura = [];
  let standingsGrupoA = [];
  let standingsGrupoB = [];
  let grupoAName = 'Grupo A';
  let grupoBName = 'Grupo B';
  let standingsAnual = [];
  let activeTournamentName = 'Torneo Clausura';

  if (standingsRes.status === 'fulfilled' && standingsRes.value.data) {
    const data = standingsRes.value.data;
    const children = data.children || [];
    const rawTourneyName = children[0]?.name || data.name || '';
    if (rawTourneyName) {
      activeTournamentName = rawTourneyName;
    }

    if (children[0]?.standings?.entries) {
      standingsGrupoA = parseStandingsEntries(children[0].standings.entries, velezId);
      if (children[0].name) grupoAName = children[0].name;
    }
    if (children[1]?.standings?.entries) {
      standingsGrupoB = parseStandingsEntries(children[1].standings.entries, velezId);
      if (children[1].name) grupoBName = children[1].name;
    }

    const velezZoneChild = children.find(ch =>
      (ch.standings?.entries || []).some(e => String(e.team?.id) === velezId)
    );

    if (velezZoneChild?.standings?.entries) {
      standingsClausura = parseStandingsEntries(velezZoneChild.standings.entries, velezId);
    } else if (standingsGrupoA.length > 0) {
      standingsClausura = standingsGrupoA;
    } else if (data.standings?.entries) {
      standingsClausura = parseStandingsEntries(data.standings.entries, velezId);
      standingsGrupoA = standingsClausura;
    }
  }

  const tourneyNorm = normalizeStr(activeTournamentName);
  const seasonKw = tourneyNorm.includes('apertura') ? 'apertura' : (tourneyNorm.includes('clausura') ? 'clausura' : '');

  const [standingsAnualComputed, groupStandingsFallback] = await Promise.allSettled([
    buildAnnualStandingsFromTeamSchedules(allTeams, curYear, velezId),
    (standingsGrupoA.length === 0 || standingsGrupoB.length === 0)
      ? buildGroupStandingsDynamically(allTeams, curYear, velezId, seasonKw)
      : Promise.resolve(null)
  ]);

  if (groupStandingsFallback.status === 'fulfilled' && groupStandingsFallback.value) {
    if (standingsGrupoA.length === 0 && groupStandingsFallback.value.grupoA?.length > 0) {
      standingsGrupoA = groupStandingsFallback.value.grupoA;
    }
    if (standingsGrupoB.length === 0 && groupStandingsFallback.value.grupoB?.length > 0) {
      standingsGrupoB = groupStandingsFallback.value.grupoB;
    }
    if (standingsClausura.length === 0) {
      const inA = standingsGrupoA.find(t => t.isVelez);
      const inB = standingsGrupoB.find(t => t.isVelez);
      standingsClausura = inA ? standingsGrupoA : (inB ? standingsGrupoB : standingsGrupoA);
    }
  }

  standingsAnual = standingsAnualComputed.status === 'fulfilled' ? standingsAnualComputed.value : [];

  const goalkeeperIdsSet = new Set();
  const playerNameToIdMap = new Map();
  if (rosterRes.status === 'fulfilled' && rosterRes.value.data?.athletes) {
    rosterRes.value.data.athletes.forEach(item => {
      const list = Array.isArray(item.items) ? item.items : [item];
      list.forEach(p => {
        const pos = mapPosition(p.position?.abbreviation, p.position?.displayName || p.position?.name);
        if (pos.group === 'ARQ' && p.id) goalkeeperIdsSet.add(String(p.id));
        if (p.id) {
          const nFull = normalizeStr(p.displayName || p.fullName);
          const nShort = normalizeStr(p.shortName || p.lastName);
          if (nFull) playerNameToIdMap.set(nFull, String(p.id));
          if (nShort && !playerNameToIdMap.has(nShort)) playerNameToIdMap.set(nShort, String(p.id));
        }
      });
    });
  }

  const eventMap = new Map();
  const collectEvents = (evArray, isLpfOnly = false) => {
    (evArray || []).forEach(ev => {
      if (ev && ev.id && ev.competitions?.[0]) {
        const existing = eventMap.get(String(ev.id));
        ev._isLpfTournament = Boolean(existing?._isLpfTournament || isLpfOnly);
        eventMap.set(String(ev.id), ev);
      }
    });
  };

  if (schedPastRes.status === 'fulfilled') collectEvents(schedPastRes.value.data?.events, true);
  if (schedFutureLpfRes.status === 'fulfilled') collectEvents(schedFutureLpfRes.value.data?.events, true);
  if (schedFutureCopaRes.status === 'fulfilled') collectEvents(schedFutureCopaRes.value.data?.events, false);
  if (teamInfoRes.status === 'fulfilled') collectEvents(teamInfoRes.value.data?.team?.nextEvent, false);

  const allEvents = Array.from(eventMap.values());
  const finished = [];
  const upcoming = [];
  let liveEvent = null;

  allEvents.forEach(ev => {
    const comp = ev.competitions?.[0];
    const state = comp?.status?.type?.state;
    const completed = comp?.status?.type?.completed === true;
    const evTime = new Date(ev.date).getTime();

    if (state === 'in') {
      liveEvent = ev;
    } else if (state === 'pre' || (!completed && evTime > now - 2 * 3600 * 1000)) {
      upcoming.push(ev);
    } else if (state === 'post' || completed) {
      finished.push(ev);
    }
  });

  finished.sort((a, b) => new Date(b.date) - new Date(a.date));
  upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));

  const isDec31 = curMonth === 12 && curDay === 31;
  const isPreSeasonWindow = (curMonth === 1 && curDay <= 25) || isDec31;

  const lpfFinishedAll = finished.filter(ev => ev._isLpfTournament === true);
  const lpfUpcomingAll = upcoming.filter(ev => ev._isLpfTournament === true);
  const lastLpfMatch = lpfFinishedAll[0] || null;
  const daysSinceLastLpf = lastLpfMatch
    ? (now - new Date(lastLpfMatch.date).getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;

  const isMidYearTransitionAfter7Days =
    curMonth >= 5 &&
    curMonth <= 8 &&
    lpfUpcomingAll.length === 0 &&
    daysSinceLastLpf > 7;

  const velezTableRow = standingsClausura.find(t => t.isVelez);
  let exactTournamentMatchesCount = velezTableRow && velezTableRow.pj > 0 ? velezTableRow.pj : 16;

  const resetRows = (arr) => arr.map(t => ({
    ...t, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, dg: 0, pts: 0
  }));

  if (isDec31) {
    activeTournamentName = `Torneo Apertura ${curYear + 1}`;
    exactTournamentMatchesCount = 0;
    standingsClausura = resetRows(standingsClausura);
    standingsGrupoA = resetRows(standingsGrupoA);
    standingsGrupoB = resetRows(standingsGrupoB);
    standingsAnual = standingsAnual.map(t => ({
      ...t, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, dg: 0, pts: 0, cupType: null, cupNote: ''
    }));
  } else if (isPreSeasonWindow && (!velezTableRow || velezTableRow.pj === 0)) {
    activeTournamentName = `Torneo Apertura ${curYear}`;
    exactTournamentMatchesCount = 0;
  } else if (isMidYearTransitionAfter7Days) {
    activeTournamentName = `Torneo Clausura ${curYear}`;
    exactTournamentMatchesCount = 0;
    standingsClausura = resetRows(standingsClausura);
    standingsGrupoA = resetRows(standingsGrupoA);
    standingsGrupoB = resetRows(standingsGrupoB);
  } else if (velezTableRow && velezTableRow.pj === 0) {
    exactTournamentMatchesCount = 0;
  }

  const lastMatches = finished.slice(0, 5).map(ev => formatPastMatch(ev, velezId)).filter(Boolean);
  const velezLast2 = lastMatches.slice(0, 2);

  const cleanSheetsByGkId = new Map();
  const playedMatchesByPlayerId = new Map();
  const velezGoalsByPlayerId = new Map();
  const velezYellowsByPlayerId = new Map();
  const velezRedsByPlayerId = new Map();
  const summaryCacheByEventId = new Map();

  const currentTournamentEvents = exactTournamentMatchesCount > 0
    ? lpfFinishedAll.slice(0, exactTournamentMatchesCount)
    : [];

  if (currentTournamentEvents.length > 0) {
    const summaries = await Promise.allSettled(
      currentTournamentEvents.map(ev => axios.get(`${ESPN_LPF}/summary?event=${ev.id}&region=ar&lang=es`))
    );

    summaries.forEach((resItem, idx) => {
      if (resItem.status !== 'fulfilled') return;
      const ev = currentTournamentEvents[idx];
      const sumData = resItem.value.data || {};
      summaryCacheByEventId.set(String(ev.id), sumData);

      const parsedMatch = formatPastMatch(ev, velezId);
      if (!parsedMatch) return;

      const rosters = sumData.rosters || [];
      const velezRoster = rosters.find(r => String(r.team?.id) === velezId);

      if (velezRoster && Array.isArray(velezRoster.roster)) {
        velezRoster.roster.forEach(item => {
          const athId = String(item.athlete?.id || '');
          if (!athId) return;
          const participated = item.starter === true || item.subbedIn === true;
          if (participated) {
            playedMatchesByPlayerId.set(athId, (playedMatchesByPlayerId.get(athId) || 0) + 1);
          }
        });

        const gksInMatch = velezRoster.roster.filter(item => {
          const athId = String(item.athlete?.id || '');
          const pos = mapPosition(item.position?.abbreviation, item.position?.displayName || item.position?.name);
          const isGkRole = goalkeeperIdsSet.has(athId) || pos.group === 'ARQ';
          const participated = item.starter === true || item.subbedIn === true;
          return isGkRole && participated;
        });

        const effectiveGks = gksInMatch.length > 0
          ? gksInMatch
          : velezRoster.roster.filter(item => {
              const athId = String(item.athlete?.id || '');
              const pos = mapPosition(item.position?.abbreviation, item.position?.displayName || item.position?.name);
              return goalkeeperIdsSet.has(athId) || pos.group === 'ARQ';
            }).slice(0, 1);

        effectiveGks.forEach(gk => {
          const gkId = String(gk.athlete?.id || '');
          if (!gkId) return;
          if (!playedMatchesByPlayerId.has(gkId)) {
            playedMatchesByPlayerId.set(gkId, 1);
          }
          if (parsedMatch.rawRivalGoalsValid && parsedMatch.rivalGoals === 0) {
            cleanSheetsByGkId.set(gkId, (cleanSheetsByGkId.get(gkId) || 0) + 1);
          }
        });
      }

      const matchEvents =
        sumData.keyEvents ||
        sumData.header?.competitions?.[0]?.details ||
        ev.competitions?.[0]?.details ||
        [];

      matchEvents.forEach(ke => {
        const eventTeamId = String(ke.team?.id || '');
        if (eventTeamId && eventTeamId !== velezId) return;

        const typeText = (ke.type?.text || ke.text || '').toLowerCase();
        const participant = ke.participants?.[0]?.athlete || ke.athletesInvolved?.[0] || {};
        let athId = String(participant.id || '');

        if (!athId) {
          const pNameNorm = normalizeStr(participant.displayName || participant.shortName || '');
          if (pNameNorm && playerNameToIdMap.has(pNameNorm)) {
            athId = playerNameToIdMap.get(pNameNorm);
          }
        }
        if (!athId) return;

        const isGoal =
          ke.scoringPlay === true ||
          typeText.includes('goal') ||
          typeText.includes('gol') ||
          typeText.includes('penalty - scored') ||
          typeText.includes('penal convertido');

        const isOwnGoal = ke.ownGoal === true || typeText.includes('own goal') || typeText.includes('en contra');
        const isYellow = typeText.includes('yellow card') || typeText.includes('tarjeta amarilla') || typeText.includes('amarilla');
        const isRed = typeText.includes('red card') || typeText.includes('tarjeta roja') || typeText.includes('expuls');

        if (isGoal && !isOwnGoal) {
          velezGoalsByPlayerId.set(athId, (velezGoalsByPlayerId.get(athId) || 0) + 1);
        } else if (isYellow) {
          velezYellowsByPlayerId.set(athId, (velezYellowsByPlayerId.get(athId) || 0) + 1);
        } else if (isRed) {
          velezRedsByPlayerId.set(athId, (velezRedsByPlayerId.get(athId) || 0) + 1);
        }
      });
    });
  }

  const upcomingMatches = upcoming.slice(0, 4).map(ev => {
    const comp = ev.competitions[0];
    const competitors = comp.competitors || [];
    const velez = competitors.find(c => String(c.id) === velezId || String(c.team?.id) === velezId);
    const rival = competitors.find(c => String(c.id) !== velezId && String(c.team?.id) !== velezId);
    const isHome = velez?.homeAway === 'home';
    const d = new Date(ev.date);

    return {
      fecha: ev.seasonType?.abbreviation || 'PRÓXIMO',
      comp: ev.league?.shortName || 'Liga Profesional',
      isoDate: d.toISOString(),
      timestamp: d.getTime(),
      date: d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
      timeART: d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }) + ' ART',
      rival: rival?.team?.shortDisplayName || rival?.team?.displayName || 'Rival',
      rivalLogo: getTeamLogo(rival?.team),
      cond: isHome ? 'L' : 'V',
      stadium: comp.venue?.fullName || (isHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar')
    };
  });

  let currentMatch = null;
  let rivalLastMatches = [];
  let rivalLast2 = [];

  const lastFinishedEv = finished[0] || null;
  const hoursSinceLastMatch = lastFinishedEv
    ? (now - new Date(lastFinishedEv.date).getTime()) / (1000 * 60 * 60)
    : Infinity;
  const isWithin24HoursPostMatch = Boolean(lastFinishedEv && hoursSinceLastMatch >= 0 && hoursSinceLastMatch <= 26);

  const targetEv = liveEvent || (isWithin24HoursPostMatch ? lastFinishedEv : upcoming[0]);

  if (targetEv) {
    const comp = targetEv.competitions[0];
    const homeC = comp.competitors.find(c => c.homeAway === 'home');
    const awayC = comp.competitors.find(c => c.homeAway === 'away');
    const homeTeamId = String(homeC?.team?.id || homeC?.id || '');
    const awayTeamId = String(awayC?.team?.id || awayC?.id || '');
    const rivalC = [homeC, awayC].find(c => String(c?.id) !== velezId && String(c?.team?.id) !== velezId);
    const rivalId = String(rivalC?.team?.id || rivalC?.id || '');

    if (rivalId) {
      try {
        const rivalSched = await axios.get(`${ESPN_LPF}/teams/${rivalId}/schedule?region=ar&lang=es`);
        const rFinished = (rivalSched.data?.events || []).filter(
          e => e.competitions?.[0]?.status?.type?.state === 'post' || e.competitions?.[0]?.status?.type?.completed
        );
        rFinished.sort((a, b) => new Date(b.date) - new Date(a.date));
        rivalLastMatches = rFinished.slice(0, 5).map(e => formatPastMatch(e, rivalId)).filter(Boolean);
        rivalLast2 = rivalLastMatches.slice(0, 2);
      } catch (err) {
        rivalLastMatches = [];
      }
    }

    const scorers = { home: [], away: [] };
    const liveCards = {
      home: { yellow: [], red: [] },
      away: { yellow: [], red: [] }
    };
    let livePossession = null;
    let rawDetails = comp.details || [];

    if ((liveEvent || isWithin24HoursPostMatch)) {
      try {
        const isCopa = (targetEv.league?.slug || '').includes('copa');
        const baseApi = isCopa ? ESPN_COPA : ESPN_LPF;
        const summaryEv = (!liveEvent && summaryCacheByEventId.has(String(targetEv.id)))
          ? { data: summaryCacheByEventId.get(String(targetEv.id)) }
          : await axios.get(`${baseApi}/summary?event=${targetEv.id}&region=ar&lang=es`);
        const summaryDetails = summaryEv.data?.keyEvents || summaryEv.data?.header?.competitions?.[0]?.details || [];
        if (summaryDetails.length > 0) rawDetails = summaryDetails;

        if (liveEvent) {
          const boxTeams = summaryEv.data?.boxscore?.teams || [];
          const getPoss = (boxObj) => {
            const st = (boxObj?.statistics || []).find(s =>
              ['possessionPct', 'possession', 'Posesión', 'Possession'].includes(s.name) ||
              ['possessionPct', 'possession', 'Posesión', 'Possession'].includes(s.label)
            );
            if (!st || st.displayValue === undefined) return null;
            const parsedNum = parseFloat(String(st.displayValue).replace('%', ''));
            return isNaN(parsedNum) ? null : Math.round(parsedNum);
          };

          const homeBox = boxTeams.find(b => String(b.team?.id) === homeTeamId);
          const awayBox = boxTeams.find(b => String(b.team?.id) === awayTeamId);
          const hPoss = getPoss(homeBox);
          const aPoss = getPoss(awayBox);

          if (hPoss !== null || aPoss !== null) {
            const safeH = hPoss !== null ? hPoss : (100 - aPoss);
            const safeA = aPoss !== null ? aPoss : (100 - safeH);
            livePossession = { home: safeH, away: safeA };
          }
        }
      } catch (e) {
        // Mantener rawDetails y livePossession en null si falla el summary
      }
    }

    rawDetails.forEach(d => {
      const typeText = (d.type?.text || d.text || '').toLowerCase();
      const clock = d.clock?.displayValue || '';
      const participant = d.participants?.[0]?.athlete || d.AthletesInvolved?.[0] || {};
      const playerName = participant.shortName || participant.displayName || d.shortText?.split(' ')[0] || '';
      const evTeamId = String(d.team?.id || '');
      const side = evTeamId === homeTeamId ? 'home' : (evTeamId === awayTeamId ? 'away' : null);

      const isGoal =
        d.scoringPlay === true ||
        typeText.includes('goal') ||
        typeText.includes('gol') ||
        typeText.includes('penalty - scored') ||
        typeText.includes('penal convertido');

      const isYellow =
        typeText.includes('yellow card') ||
        typeText.includes('tarjeta amarilla') ||
        typeText.includes('amarilla');

      const isRed =
        typeText.includes('red card') ||
        typeText.includes('tarjeta roja') ||
        typeText.includes('expuls');

      if (isGoal) {
        const safePlayer = playerName || 'Gol';
        const isOwnGoal = d.ownGoal === true || typeText.includes('own goal') || typeText.includes('en contra');
        const isPenalty = d.penaltyKick === true || typeText.includes('penal') || typeText.includes('penalty');

        let suffix = '';
        if (isOwnGoal) suffix = ' (EC)';
        else if (isPenalty) suffix = ' (P)';

        const label = `${safePlayer} ${clock}${suffix}`.trim();
        if (side === 'home') scorers.home.push(label);
        else if (side === 'away') scorers.away.push(label);
      } else if (isYellow && side) {
        const label = `${playerName || 'Jugador'} ${clock}`.trim();
        liveCards[side].yellow.push(label);
      } else if (isRed && side) {
        const label = `${playerName || 'Jugador'} ${clock}`.trim();
        liveCards[side].red.push(label);
      }
    });

    const isoDateStrict = new Date(targetEv.date).toISOString();
    const timestampMs = new Date(targetEv.date).getTime();

    let matchMode = 'NEXT';
    if (liveEvent) matchMode = 'LIVE';
    else if (isWithin24HoursPostMatch) matchMode = 'FINISHED_24H';

    currentMatch = {
      type: matchMode,
      timestamp: timestampMs,
      isoDate: isoDateStrict,
      velezForm: velezLast2,
      rivalForm: rivalLast2,
      velezLastMatches: velezLast2,
      rivalLastMatches: rivalLast2,
      match: {
        teams: {
          home: {
            id: Number(homeTeamId || 0),
            name: homeC?.team?.shortDisplayName || homeC?.team?.displayName || 'Local',
            logo: getTeamLogo(homeC?.team)
          },
          away: {
            id: Number(awayTeamId || 0),
            name: awayC?.team?.shortDisplayName || awayC?.team?.displayName || 'Visitante',
            logo: getTeamLogo(awayC?.team)
          }
        },
        goals: {
          home: extractScoreNumber(homeC?.score) || 0,
          away: extractScoreNumber(awayC?.score) || 0
        },
        scorers,
        cards: liveCards,
        possession: livePossession,
        fixture: {
          date: isoDateStrict,
          timestamp: Math.floor(timestampMs / 1000),
          timestampMs,
          venue: { name: comp.venue?.fullName || 'Estadio José Amalfitani' },
          status: {
            short: matchMode === 'LIVE' ? 'LIVE' : (matchMode === 'FINISHED_24H' ? 'FT' : 'NS'),
            long: comp.status?.type?.detail || 'Programado',
            elapsed: comp.status?.displayClock || comp.status?.type?.shortDetail || ''
          }
        },
        league: {
          name: targetEv.league?.name || 'Liga Profesional de Fútbol',
          round: comp.status?.type?.shortDetail || 'Torneo Local'
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
          home: {
            id: Number(velezId),
            name: 'Vélez Sarsfield',
            logo: velezLogoUrl
          },
          away: {
            id: 0,
            name: 'A confirmar',
            logo: ''
          }
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
          name: activeTournamentName,
          round: 'Calendario por definir'
        }
      }
    };
  }

  const recentLineups = [];
  let lastMatchStats = null;
  const jerseyFromMatchMap = new Map();

  const lastFiveEvents = finished.slice(0, 5);
  if (lastFiveEvents.length > 0) {
    const fiveSummaries = await Promise.allSettled(
      lastFiveEvents.map(ev => {
        const evIdStr = String(ev.id);
        if (summaryCacheByEventId.has(evIdStr)) {
          return Promise.resolve({ data: summaryCacheByEventId.get(evIdStr) });
        }
        const isCopa = (ev.league?.slug || '').includes('copa');
        const baseApi = isCopa ? ESPN_COPA : ESPN_LPF;
        return axios.get(`${baseApi}/summary?event=${ev.id}&region=ar&lang=es`);
      })
    );

    fiveSummaries.forEach((resItem, idx) => {
      if (resItem.status !== 'fulfilled') return;
      const ev = lastFiveEvents[idx];
      const sumData = resItem.value.data || {};
      const parsed = formatPastMatch(ev, velezId);

      const rosters = sumData.rosters || [];
      const velezRoster = rosters.find(r => String(r.team?.id) === velezId);
      const oppRoster = rosters.find(r => String(r.team?.id) !== velezId);
      const rivalShortName = parsed?.rival || oppRoster?.team?.shortDisplayName || oppRoster?.team?.displayName || 'Rival';
      const matchDateShort = parsed?.date || new Date(ev.date).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
      const scoreLabel = parsed ? `${parsed.velezGoals}-${parsed.rivalGoals}` : '';

      if (velezRoster && Array.isArray(velezRoster.roster)) {
        velezRoster.roster.forEach(item => {
          const pId = String(item.athlete?.id || '');
          const jNum = parseInt(item.jersey, 10);
          if (pId && !isNaN(jNum) && !jerseyFromMatchMap.has(pId)) {
            jerseyFromMatchMap.set(pId, jNum);
          }
        });

        const startersRaw = velezRoster.roster.filter(item => item.starter === true);
        if (startersRaw.length >= 11) {
          recentLineups.push({
            eventId: String(ev.id),
            formation: velezRoster.formation || '4-2-3-1',
            rival: rivalShortName,
            date: matchDateShort,
            score: scoreLabel,
            cond: parsed?.cond || 'L',
            comp: parsed?.comp || 'Liga Profesional',
            starters: startersRaw.slice(0, 11).map(item => {
              const posInfo = mapPosition(item.position?.abbreviation, item.position?.displayName || item.position?.name);
              return {
                id: Number(item.athlete?.id || 0),
                name: item.athlete?.displayName || item.athlete?.shortName || 'Jugador',
                shortName: item.athlete?.shortName || item.athlete?.lastName || item.athlete?.displayName,
                number: parseInt(item.jersey, 10) || '-',
                position: item.position?.abbreviation || posInfo.group,
                posLabel: posInfo.posLabel,
                group: posInfo.group,
                formationPlace: Number(item.formationPlace || 0),
                photo: item.athlete?.headshot?.href || ''
              };
            })
          });
        }
      }

      if (idx === 0) {
        const boxTeams = sumData.boxscore?.teams || [];
        const velezBox = boxTeams.find(b => String(b.team?.id) === velezId);
        const oppBox = boxTeams.find(b => String(b.team?.id) !== velezId);

        if (velezBox && Array.isArray(velezBox.statistics)) {
          const getBoxStat = (boxObj, statNames) => {
            const st = (boxObj?.statistics || []).find(s => statNames.includes(s.name) || statNames.includes(s.label));
            return st && st.displayValue !== undefined ? parseFloat(String(st.displayValue).replace('%', '')) : null;
          };

          const possession = getBoxStat(velezBox, ['possessionPct', 'possession', 'Posesión']);
          const totalShots = getBoxStat(velezBox, ['totalShots', 'shots', 'Tiros totales']);
          const shotsOnTarget = getBoxStat(velezBox, ['shotsOnTarget', 'shotsOnGoal', 'Tiros al arco']);
          const shotsOffTarget = (totalShots !== null && shotsOnTarget !== null)
            ? Math.max(0, totalShots - shotsOnTarget)
            : null;

          lastMatchStats = {
            rival: rivalShortName,
            date: matchDateShort,
            possession,
            oppPossession: oppBox ? getBoxStat(oppBox, ['possessionPct', 'possession', 'Posesión']) : null,
            totalShots,
            shotsOnTarget,
            shotsOffTarget
          };
        }
      }
    });
  }

  const lastLineup = recentLineups[0] || { formation: '4-2-3-1', rival: '', date: '', starters: [] };

  const jerseyMap = new Map();
  if (teamInfoRes.status === 'fulfilled' && teamInfoRes.value.data?.team?.athletes) {
    teamInfoRes.value.data.team.athletes.forEach(a => {
      if (a.id && a.jersey) jerseyMap.set(String(a.id), parseInt(a.jersey, 10));
    });
  }

  let squad = [];
  if (rosterRes.status === 'fulfilled' && rosterRes.value.data?.athletes) {
    const rawAthletes = rosterRes.value.data.athletes;
    let playerList = [];
    rawAthletes.forEach(item => {
      if (item.items && Array.isArray(item.items)) playerList = playerList.concat(item.items);
      else playerList.push(item);
    });

    squad = playerList.map(p => {
      const pIdStr = String(p.id);
      const posInfo = mapPosition(p.position?.abbreviation, p.position?.displayName || p.position?.name);

      const pj = playedMatchesByPlayerId.get(pIdStr) || 0;
      const goalsInTournament = velezGoalsByPlayerId.get(pIdStr) || 0;
      const yellowsInTournament = velezYellowsByPlayerId.get(pIdStr) || 0;
      const redsInTournament = velezRedsByPlayerId.get(pIdStr) || 0;
      const cleanSheets = posInfo.group === 'ARQ' ? (cleanSheetsByGkId.get(pIdStr) || 0) : null;

      const fullNameNorm = normalizeStr(p.displayName || p.fullName);
      const lastNameNorm = normalizeStr(p.lastName || fullNameNorm.split(' ').pop());

      const rawJersey =
        p.jersey ||
        jerseyFromMatchMap.get(pIdStr) ||
        velezWebJerseys[fullNameNorm] ||
        velezWebJerseys[lastNameNorm] ||
        jerseyMap.get(pIdStr);

      const jerseyNumber = rawJersey && !isNaN(parseInt(rawJersey, 10)) ? parseInt(rawJersey, 10) : null;

      const rawCountry = p.citizenship || p.birthPlace?.country || p.flag?.alt || 'Argentina';
      const countryInfo = mapCountryToIso(rawCountry);

      return {
        id: Number(p.id),
        name: p.displayName || p.fullName,
        age: p.age || 0,
        number: jerseyNumber,
        dorsal: jerseyNumber,
        jersey: jerseyNumber,
        position: p.position?.displayName || posInfo.posLabel,
        posLabel: posInfo.posLabel,
        group: posInfo.group,
        countryCode: countryInfo.code,
        countryName: countryInfo.label,
        flagUrl: `https://flagcdn.com/w80/${countryInfo.code}.png`,
        photo: p.headshot?.href || velezLogoUrl,
        pj,
        goals: goalsInTournament,
        cleanSheets,
        yellowCards: yellowsInTournament,
        redCards: redsInTournament
      };
    });
  }

  return {
    velezEspnIdDetectado: velezId,
    activeTournamentName,
    grupoAName,
    grupoBName,
    currentMatch,
    lastMatches,
    velezLast2,
    rivalLastMatches,
    rivalLast2,
    upcomingMatches,
    squad,
    lastLineup,
    recentLineups,
    lastMatchStats,
    standingsClausura,
    standingsGrupoA,
    standingsGrupoB,
    standingsAnual
  };
}

async function computeVelezTournamentFixture(now) {
  const { year: curYear } = getArgentinaNowParts(now);

  const teamsRes = await axios.get(`${ESPN_LPF}/teams?region=ar&lang=es`);
  const allTeams = teamsRes.data?.sports?.[0]?.leagues?.[0]?.teams || [];
  const velezEntry = allTeams.find(t => {
    const name = (t.team?.displayName || t.team?.name || '').toLowerCase();
    return name.includes('vélez') || name.includes('velez');
  });

  if (!velezEntry) {
    throw new Error('No se encontró a Vélez en ESPN arg.1');
  }
  const velezId = String(velezEntry.team.id);

  const [schedPastRes, schedFutureLpfRes, standingsRes] = await Promise.allSettled([
    axios.get(`${ESPN_LPF}/teams/${velezId}/schedule?region=ar&lang=es`),
    axios.get(`${ESPN_LPF}/teams/${velezId}/schedule?fixture=true&region=ar&lang=es`),
    axios.get(`${ESPN_WEB_LPF}/standings?region=ar&lang=es`)
  ]);

  let tournamentName = 'Torneo Clausura';
  let velezPlayedInTournament = 0;

  if (standingsRes.status === 'fulfilled' && standingsRes.value.data) {
    const data = standingsRes.value.data;
    const children = data.children || [];
    const rawTourney = children[0]?.name || data.name || '';
    if (rawTourney) tournamentName = rawTourney;

    const allEntries = children.flatMap(ch => ch.standings?.entries || []);
    const velezRow = allEntries.find(e => String(e.team?.id) === velezId);
    if (velezRow) {
      const pjStat = (velezRow.stats || []).find(s => s.name === 'gamesPlayed' || s.type === 'gamesPlayed');
      if (pjStat && pjStat.value !== undefined) {
        velezPlayedInTournament = Number(pjStat.value) || 0;
      }
    }
  }

  const tourneyNorm = normalizeStr(tournamentName);
  const seasonKeyword = tourneyNorm.includes('apertura')
    ? 'apertura'
    : (tourneyNorm.includes('clausura') ? 'clausura' : '');

  const eventMap = new Map();
  const addEvs = (arr) => {
    (arr || []).forEach(ev => {
      if (ev && ev.id && ev.competitions?.[0]) {
        eventMap.set(String(ev.id), ev);
      }
    });
  };

  if (schedPastRes.status === 'fulfilled') addEvs(schedPastRes.value.data?.events);
  if (schedFutureLpfRes.status === 'fulfilled') addEvs(schedFutureLpfRes.value.data?.events);

  const tournamentEvents = Array.from(eventMap.values()).filter(ev => {
    const comp = ev.competitions?.[0];
    if (!comp) return false;

    const evYear = getArgentinaNowParts(new Date(ev.date).getTime()).year;
    if (evYear !== curYear) return false;

    const leagueSlug = normalizeStr(ev.league?.slug || comp.league?.slug || '');
    if (leagueSlug && leagueSlug !== 'arg1' && leagueSlug !== 'arg 1') {
      return false;
    }

    const metaText = normalizeStr(
      `${ev.season?.name || ''} ${ev.seasonType?.name || ''} ${ev.seasonType?.abbreviation || ''} ${comp.type?.text || ''} ${comp.notes?.[0]?.headline || ''}`
    );

    if (metaText.includes('amistoso') || metaText.includes('friendly')) {
      return false;
    }

    if (seasonKeyword && metaText.includes(seasonKeyword)) {
      return true;
    }

    return !metaText.includes('apertura') && !metaText.includes('clausura');
  });

  tournamentEvents.sort((a, b) => new Date(b.date) - new Date(a.date));

  const matches = await Promise.all(
    tournamentEvents.map(async (ev) => {
      const comp = ev.competitions[0];
      const state = comp.status?.type?.state || 'pre';
      const completed = comp.status?.type?.completed === true || state === 'post';
      const isLive = state === 'in';
      const status = completed ? 'FINISHED' : (isLive ? 'LIVE' : 'UPCOMING');

      const competitors = comp.competitors || [];
      const homeC = competitors.find(c => c.homeAway === 'home');
      const awayC = competitors.find(c => c.homeAway === 'away');
      const homeTeamId = String(homeC?.team?.id || homeC?.id || '');
      const awayTeamId = String(awayC?.team?.id || awayC?.id || '');
      const isVelezHome = homeTeamId === velezId || String(homeC?.id) === velezId;

      const homeGoals = status === 'UPCOMING' ? null : (extractScoreNumber(homeC?.score) || 0);
      const awayGoals = status === 'UPCOMING' ? null : (extractScoreNumber(awayC?.score) || 0);

      const scorers = { home: [], away: [] };
      let possession = null;

      if (status === 'FINISHED' || status === 'LIVE') {
        let rawDetails = comp.details || [];
        try {
          const sumRes = await axios.get(`${ESPN_LPF}/summary?event=${ev.id}&region=ar&lang=es`, { timeout: 6500 });
          const sumData = sumRes.data || {};
          const sumDetails = sumData.keyEvents || sumData.header?.competitions?.[0]?.details || [];
          if (sumDetails.length > 0) rawDetails = sumDetails;

          const boxTeams = sumData.boxscore?.teams || [];
          const getPoss = (boxObj) => {
            const st = (boxObj?.statistics || []).find(s =>
              ['possessionPct', 'possession', 'Posesión', 'Possession'].includes(s.name) ||
              ['possessionPct', 'possession', 'Posesión', 'Possession'].includes(s.label)
            );
            if (!st || st.displayValue === undefined) return null;
            const n = parseFloat(String(st.displayValue).replace('%', ''));
            return isNaN(n) ? null : Math.round(n);
          };

          const hPoss = getPoss(boxTeams.find(b => String(b.team?.id) === homeTeamId));
          const aPoss = getPoss(boxTeams.find(b => String(b.team?.id) === awayTeamId));
          if (hPoss !== null || aPoss !== null) {
            const safeH = hPoss !== null ? hPoss : (100 - aPoss);
            const safeA = aPoss !== null ? aPoss : (100 - safeH);
            possession = { home: safeH, away: safeA };
          }
        } catch (e) {
          // Si falla el summary individual, conserva lo disponible en details
        }

        rawDetails.forEach(d => {
          const typeText = (d.type?.text || d.text || '').toLowerCase();
          const isGoal =
            d.scoringPlay === true ||
            typeText.includes('goal') ||
            typeText.includes('gol') ||
            typeText.includes('penalty - scored') ||
            typeText.includes('penal convertido');
          if (!isGoal) return;

          const clock = d.clock?.displayValue || '';
          const participant = d.participants?.[0]?.athlete || d.AthletesInvolved?.[0] || {};
          const playerName = participant.shortName || participant.displayName || d.shortText?.split(' ')[0] || 'Gol';
          const isOwnGoal = d.ownGoal === true || typeText.includes('own goal') || typeText.includes('en contra');
          const isPenalty = d.penaltyKick === true || typeText.includes('penal') || typeText.includes('penalty');

          let suffix = '';
          if (isOwnGoal) suffix = ' (EC)';
          else if (isPenalty) suffix = ' (P)';

          const label = `${playerName} ${clock}${suffix}`.trim();
          const scoringTeamId = String(d.team?.id || '');
          if (scoringTeamId === homeTeamId) scorers.home.push(label);
          else if (scoringTeamId === awayTeamId) scorers.away.push(label);
        });
      }

      const d = new Date(ev.date);
      return {
        id: String(ev.id),
        status,
        isoDate: d.toISOString(),
        timestamp: d.getTime(),
        round: ev.seasonType?.abbreviation || comp.status?.type?.shortDetail || 'Fecha',
        comp: tournamentName,
        stadium: comp.venue?.fullName || (isVelezHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar'),
        cond: isVelezHome ? 'L' : 'V',
        home: {
          name: homeC?.team?.shortDisplayName || homeC?.team?.displayName || 'Local',
          logo: getTeamLogo(homeC?.team),
          goals: homeGoals
        },
        away: {
          name: awayC?.team?.shortDisplayName || awayC?.team?.displayName || 'Visitante',
          logo: getTeamLogo(awayC?.team),
          goals: awayGoals
        },
        scorers,
        possession
      };
    })
  );

  return {
    tournamentName,
    playedCount: velezPlayedInTournament,
    matches
  };
}

app.get('/', (req, res) => {
  res.json({ status: 'OK', mensaje: 'Backend Vélez ESPN v28 activo. Endpoints: /api/velez-data y /api/velez-fixture' });
});

app.get('/api/velez-data', async (req, res) => {
  const now = Date.now();
  const isLiveCached = cacheData?.currentMatch?.type === 'LIVE';
  const ttl = isLiveCached ? 10 * 1000 : 60 * 1000;

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
      error: 'Fallo al procesar datos de ESPN',
      mensaje: error.message
    });
  } finally {
    inflightRequest = null;
  }
});

app.get('/api/velez-fixture', async (req, res) => {
  const now = Date.now();
  const ttl = 45 * 1000;

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
    const payload = await computeVelezTournamentFixture(Date.now());
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
