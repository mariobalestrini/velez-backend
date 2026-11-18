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

function normalizeStr(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
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
      const s = stats.find(st => st.name === statName || st.type === statName);
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

app.get('/', (req, res) => {
  res.json({ status: 'OK', mensaje: 'Backend Vélez ESPN v13 activo (estadísticas 100% exclusivas del torneo actual). Usá /api/velez-data' });
});

app.get('/api/velez-data', async (req, res) => {
  const now = Date.now();
  const ttl = cacheData?.currentMatch?.type === 'LIVE' ? 15 * 1000 : 60 * 1000;
  if (cacheData && (now - cacheTime < ttl)) {
    return res.json(cacheData);
  }

  try {
    const teamsRes = await axios.get(`${ESPN_LPF}/teams?region=ar&lang=es`);
    const allTeams = teamsRes.data?.sports?.[0]?.leagues?.[0]?.teams || [];
    const velezEntry = allTeams.find(t => {
      const name = (t.team?.displayName || t.team?.name || '').toLowerCase();
      return name.includes('vélez') || name.includes('velez');
    });

    if (!velezEntry) {
      return res.status(404).json({ error: 'No se encontró a Vélez en ESPN arg.1' });
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

    // --- TABLAS (Las procesamos primero para saber exactamente cuántos PJ lleva Vélez en el torneo actual) ---
    let standingsClausura = [];
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
        standingsClausura = parseStandingsEntries(children[0].standings.entries, velezId);
      } else if (data.standings?.entries) {
        standingsClausura = parseStandingsEntries(data.standings.entries, velezId);
      }

      const anualChild = children.find(c => {
        const n = (c.name || c.abbreviation || '').toLowerCase();
        return n.includes('anual') || n.includes('general') || n.includes('acumulad') || n.includes('overall') || (c.standings?.entries?.length >= 26);
      });

      if (anualChild?.standings?.entries) {
        standingsAnual = parseStandingsEntries(anualChild.standings.entries, velezId);
      } else if (children.length >= 2) {
        const combinedMap = new Map();
        children.forEach(ch => {
          const parsed = parseStandingsEntries(ch.standings?.entries || [], velezId);
          parsed.forEach(row => {
            if (!combinedMap.has(row.name)) {
              combinedMap.set(row.name, { ...row });
            } else {
              const ex = combinedMap.get(row.name);
              ex.pj += row.pj;
              ex.pg += row.pg;
              ex.pe += row.pe;
              ex.pp += row.pp;
              ex.gf += row.gf;
              ex.gc += row.gc;
              ex.dg += row.dg;
              ex.pts += row.pts;
              if (!ex.cupType && row.cupType) {
                ex.cupType = row.cupType;
                ex.cupNote = row.cupNote;
                ex.cupColor = row.cupColor;
              }
            }
          });
        });
        standingsAnual = Array.from(combinedMap.values()).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
      } else {
        standingsAnual = [...standingsClausura];
      }
    }

    const velezClausuraRow = standingsClausura.find(t => t.isVelez);
    const exactClausuraMatchesCount = velezClausuraRow && velezClausuraRow.pj > 0 ? velezClausuraRow.pj : 16;

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

    const lastMatches = finished.slice(0, 5).map(ev => formatPastMatch(ev, velezId)).filter(Boolean);
    const velezLast2 = lastMatches.slice(0, 2);

    // --- CONTEO PARTIDO POR PARTIDO EXCLUSIVO DEL TORNEO ACTUAL (SIN APERTURA NI COPA ARGENTINA) ---
    const cleanSheetsByGkId = new Map();
    const playedMatchesByPlayerId = new Map();
    const velezGoalsByPlayerId = new Map();
    const velezYellowsByPlayerId = new Map();
    const velezRedsByPlayerId = new Map();

    // Tomamos ÚNICAMENTE los últimos `exactClausuraMatchesCount` partidos finalizados de Primera División (arg.1)
    const currentTournamentEvents = finished
      .filter(ev => ev._isLpfTournament === true)
      .slice(0, exactClausuraMatchesCount);

    if (currentTournamentEvents.length > 0) {
      const summaries = await Promise.allSettled(
        currentTournamentEvents.map(ev => axios.get(`${ESPN_LPF}/summary?event=${ev.id}&region=ar&lang=es`))
      );

      summaries.forEach((resItem, idx) => {
        if (resItem.status !== 'fulfilled') return;
        const ev = currentTournamentEvents[idx];
        const parsedMatch = formatPastMatch(ev, velezId);
        if (!parsedMatch) return;

        const sumData = resItem.value.data || {};
        const rosters = sumData.rosters || [];
        const velezRoster = rosters.find(r => String(r.team?.id) === velezId);

        // 1. Sumar PJ de cada jugador que participó en este partido del torneo actual
        if (velezRoster && Array.isArray(velezRoster.roster)) {
          velezRoster.roster.forEach(item => {
            const athId = String(item.athlete?.id || '');
            if (!athId) return;
            const participated = item.starter === true || item.subbedIn === true;
            if (participated) {
              playedMatchesByPlayerId.set(athId, (playedMatchesByPlayerId.get(athId) || 0) + 1);
            }
          });

          // Vallas invictas de arqueros
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

        // 2. Sumar Goles, Amarillas y Rojas desde keyEvents / details oficiales del partido
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
        date: d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
        timeART: d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }) + ' ART',
        rival: rival?.team?.shortDisplayName || rival?.team?.displayName || 'Rival',
        rivalLogo: getTeamLogo(rival?.team),
        cond: isHome ? 'L' : 'V',
        stadium: comp.venue?.fullName || (isHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar')
      };
    });

    // --- PARTIDO PRINCIPAL ---
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
      let rawDetails = comp.details || [];

      if ((liveEvent || isWithin24HoursPostMatch) && rawDetails.length === 0) {
        try {
          const isCopa = (targetEv.league?.slug || '').includes('copa');
          const baseApi = isCopa ? ESPN_COPA : ESPN_LPF;
          const summaryEv = await axios.get(`${baseApi}/summary?event=${targetEv.id}&region=ar&lang=es`);
          rawDetails = summaryEv.data?.keyEvents || summaryEv.data?.header?.competitions?.[0]?.details || [];
        } catch (e) {
          rawDetails = [];
        }
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

        if (scoringTeamId === homeTeamId) {
          scorers.home.push(label);
        } else if (scoringTeamId === awayTeamId) {
          scorers.away.push(label);
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

    // --- ÚLTIMO 11 TITULAR Y ESTADÍSTICAS DEL ÚLTIMO PARTIDO ---
    let lastLineup = { formation: '4-2-3-1', rival: '', date: '', starters: [] };
    let lastMatchStats = null;
    const jerseyFromMatchMap = new Map();

    if (finished.length > 0) {
      const lastGame = finished[0];
      try {
        const isCopa = (lastGame.league?.slug || '').includes('copa');
        const baseApi = isCopa ? ESPN_COPA : ESPN_LPF;
        const summaryRes = await axios.get(`${baseApi}/summary?event=${lastGame.id}&region=ar&lang=es`);
        const rosters = summaryRes.data?.rosters || [];
        const velezRoster = rosters.find(r => String(r.team?.id) === velezId);
        const oppRoster = rosters.find(r => String(r.team?.id) !== velezId);
        const rivalShortName = oppRoster?.team?.shortDisplayName || oppRoster?.team?.displayName || 'Rival';
        const matchDateShort = new Date(lastGame.date).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });

        if (velezRoster && Array.isArray(velezRoster.roster)) {
          velezRoster.roster.forEach(item => {
            const pId = String(item.athlete?.id || '');
            const jNum = parseInt(item.jersey, 10);
            if (pId && !isNaN(jNum)) jerseyFromMatchMap.set(pId, jNum);
          });

          const startersRaw = velezRoster.roster.filter(item => item.starter === true);
          lastLineup = {
            formation: velezRoster.formation || '4-2-3-1',
            rival: rivalShortName,
            date: matchDateShort,
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
          };
        }

        const boxTeams = summaryRes.data?.boxscore?.teams || [];
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
      } catch (err) {
        console.warn('No se pudo obtener la formación/estadísticas del último partido:', err.message);
      }
    }

    // --- PLANTEL CON ESTADÍSTICAS 100 % EXCLUSIVAS DEL TORNEO ACTUAL ---
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

        // Usamos exclusivamente el conteo extraído de los partidos jugados del torneo actual
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

    const payload = {
      velezEspnIdDetectado: velezId,
      activeTournamentName,
      currentMatch,
      lastMatches,
      velezLast2,
      rivalLastMatches,
      rivalLast2,
      upcomingMatches,
      squad,
      lastLineup,
      lastMatchStats,
      standingsClausura,
      standingsAnual
    };

    cacheData = payload;
    cacheTime = now;
    res.json(payload);

  } catch (error) {
    res.status(500).json({
      error: 'Fallo al procesar datos de ESPN',
      mensaje: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
