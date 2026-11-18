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
const CACHE_TTL = 60 * 1000;

function mapPosition(posAbbr, posName) {
  const abbr = (posAbbr || '').toUpperCase();
  const name = (posName || '').toLowerCase();
  if (abbr === 'G' || abbr === 'GK' || name.includes('arquero') || name.includes('goalkeeper')) {
    return { group: 'ARQ', posLabel: 'Arquero' };
  }
  if (abbr === 'D' || abbr === 'DF' || name.includes('defensor') || name.includes('defender')) {
    return { group: 'DEF', posLabel: 'Defensor' };
  }
  if (abbr === 'F' || abbr === 'FW' || abbr === 'A' || name.includes('delantero') || name.includes('atacante') || name.includes('forward')) {
    return { group: 'DEL', posLabel: 'Delantero' };
  }
  return { group: 'MED', posLabel: 'Mediocampista' };
}

function formatPastMatch(ev, targetTeamId) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const teamObj = competitors.find(c => String(c.id) === String(targetTeamId) || String(c.team?.id) === String(targetTeamId));
  const oppObj = competitors.find(c => String(c.id) !== String(targetTeamId) && String(c.team?.id) !== String(targetTeamId));
  if (!teamObj || !oppObj) return null;

  const isHome = teamObj.homeAway === 'home';
  const tGoals = parseInt(teamObj.score?.value ?? teamObj.score?.displayValue ?? 0);
  const oGoals = parseInt(oppObj.score?.value ?? oppObj.score?.displayValue ?? 0);

  let outcome = 'E';
  if (tGoals > oGoals) outcome = 'G';
  else if (tGoals < oGoals) outcome = 'P';

  const d = new Date(ev.date);
  return {
    fecha: ev.seasonType?.abbreviation || 'LPF',
    comp: ev.league?.shortName || 'Liga Profesional',
    date: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
    rival: oppObj.team?.shortDisplayName || oppObj.team?.displayName || 'Rival',
    cond: isHome ? 'L' : 'V',
    velezGoals: isNaN(tGoals) ? 0 : tGoals,
    rivalGoals: isNaN(oGoals) ? 0 : oGoals,
    outcome
  };
}

// Mapeo EXACTO de tabla que funcionaba bien (sin mezclar abreviaturas ambiguas)
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

    return {
      name: team.shortDisplayName || team.displayName || team.name,
      isVelez: String(team.id) === String(velezId),
      pj,
      pg: findExactStat('wins'),
      pe: findExactStat('ties'),
      pp: findExactStat('losses'),
      gf: findExactStat('pointsFor'),
      gc: findExactStat('pointsAgainst'),
      dg: findExactStat('pointDifferential'),
      pts,
      promedio: pj > 0 ? (pts / pj).toFixed(3) : '0.000'
    };
  });

  rows.sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
  return rows;
}

app.get('/', (req, res) => {
  res.json({ status: 'OK', mensaje: 'Backend Vélez ESPN v3 activo. Usá /api/velez-data' });
});

app.get('/api/velez-data', async (req, res) => {
  const now = Date.now();
  if (cacheData && (now - cacheTime < CACHE_TTL)) {
    return res.json(cacheData);
  }

  try {
    // 1. Obtener el ID de Vélez en ESPN
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

    // 2. Consultas paralelas incluyendo fixture=true (próximos partidos) y enable=roster (dorsales completos)
    const [
      schedPastRes,
      schedFutureLpfRes,
      schedFutureCopaRes,
      teamInfoRes,
      rosterRes,
      standingsRes
    ] = await Promise.allSettled([
      axios.get(`${ESPN_LPF}/teams/${velezId}/schedule?region=ar&lang=es`),
      axios.get(`${ESPN_LPF}/teams/${velezId}/schedule?fixture=true&region=ar&lang=es`),
      axios.get(`${ESPN_COPA}/teams/${velezId}/schedule?region=ar&lang=es`),
      axios.get(`${ESPN_LPF}/teams/${velezId}?enable=roster&region=ar&lang=es`),
      axios.get(`${ESPN_LPF}/teams/${velezId}/roster?region=ar&lang=es`),
      axios.get(`${ESPN_WEB_LPF}/standings?region=ar&lang=es`)
    ]);

    // Unificar todos los eventos pasados y futuros de Vélez
    const eventMap = new Map();
    const collectEvents = (evArray) => {
      (evArray || []).forEach(ev => {
        if (ev && ev.id && ev.competitions?.[0]) {
          eventMap.set(String(ev.id), ev);
        }
      });
    };

    if (schedPastRes.status === 'fulfilled') collectEvents(schedPastRes.value.data?.events);
    if (schedFutureLpfRes.status === 'fulfilled') collectEvents(schedFutureLpfRes.value.data?.events);
    if (schedFutureCopaRes.status === 'fulfilled') collectEvents(schedFutureCopaRes.value.data?.events);
    if (teamInfoRes.status === 'fulfilled') collectEvents(teamInfoRes.value.data?.team?.nextEvent);

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
      } else if (state === 'pre' || (!completed && evTime > now - 3 * 3600 * 1000)) {
        upcoming.push(ev);
      } else if (state === 'post' || completed) {
        finished.push(ev);
      }
    });

    finished.sort((a, b) => new Date(b.date) - new Date(a.date));
    upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));

    const lastMatches = finished.slice(0, 5).map(ev => formatPastMatch(ev, velezId)).filter(Boolean);

    // Calcular vallas invictas reales de los partidos jugados por Vélez
    const totalCleanSheetsSeason = finished.filter(ev => {
      const m = formatPastMatch(ev, velezId);
      return m && m.rivalGoals === 0;
    }).length;

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
        cond: isHome ? 'L' : 'V',
        stadium: comp.venue?.fullName || (isHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar')
      };
    });

    // --- PRÓXIMO PARTIDO Y RACHAS ("CÓMO LLEGA VÉLEZ Y RIVAL") ---
    let currentMatch = null;
    let rivalLastMatches = [];
    const targetEv = liveEvent || upcoming[0] || finished[0];

    if (targetEv) {
      const comp = targetEv.competitions[0];
      const homeC = comp.competitors.find(c => c.homeAway === 'home');
      const awayC = comp.competitors.find(c => c.homeAway === 'away');
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
        } catch (err) {
          rivalLastMatches = [];
        }
      }

      currentMatch = {
        type: liveEvent ? 'LIVE' : 'NEXT',
        velezForm: lastMatches,
        rivalForm: rivalLastMatches,
        rivalLastMatches,
        match: {
          teams: {
            home: {
              id: Number(homeC?.team?.id || homeC?.id || 0),
              name: homeC?.team?.shortDisplayName || homeC?.team?.displayName || 'Local',
              logo: homeC?.team?.logos?.[0]?.href || ''
            },
            away: {
              id: Number(awayC?.team?.id || awayC?.id || 0),
              name: awayC?.team?.shortDisplayName || awayC?.team?.displayName || 'Visitante',
              logo: awayC?.team?.logos?.[0]?.href || ''
            }
          },
          goals: {
            home: parseInt(homeC?.score?.value ?? homeC?.score?.displayValue ?? 0) || 0,
            away: parseInt(awayC?.score?.value ?? awayC?.score?.displayValue ?? 0) || 0
          },
          fixture: {
            date: targetEv.date,
            venue: { name: comp.venue?.fullName || 'Estadio José Amalfitani' },
            status: {
              short: liveEvent ? 'LIVE' : (upcoming.length > 0 ? 'NS' : 'FT'),
              long: comp.status?.type?.detail || 'Programado'
            }
          },
          league: {
            name: targetEv.league?.name || 'Liga Profesional',
            round: comp.status?.type?.shortDetail || 'Torneo Local'
          }
        }
      };
    }

    // --- PLANTEL CON CRUCE DE DORSALES DESDE TEAM_INFO + ROSTER ---
    // Armamos un mapa de dorsales desde /teams/velezId?enable=roster por si /roster omite alguno
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
        const posInfo = mapPosition(p.position?.abbreviation, p.position?.displayName || p.position?.name);
        const splits = p.statistics?.splits?.categories || [];

        const getStat = (names) => {
          for (const cat of splits) {
            for (const st of (cat.stats || [])) {
              if (names.includes(st.name) || names.includes(st.abbreviation)) {
                return Number(st.value) || 0;
              }
            }
          }
          return 0;
        };

        const pj = getStat(['appearances', 'GP', 'subIns']);
        const goalsConceded = getStat(['goalsConceded', 'GA']);
        let cleanSheets = null;

        if (posInfo.group === 'ARQ') {
          const apiCS = getStat(['cleanSheets', 'CS']);
          cleanSheets = apiCS > 0 ? apiCS : (pj > 0 ? Math.min(pj, totalCleanSheetsSeason || Math.max(0, pj - goalsConceded)) : 0);
        }

        // Buscar dorsal en el jugador o en el mapa de respaldo de teamInfo
        const rawJersey = p.jersey || jerseyMap.get(String(p.id));
        const jerseyNumber = rawJersey && !isNaN(parseInt(rawJersey, 10)) ? parseInt(rawJersey, 10) : 0;

        return {
          id: Number(p.id),
          name: p.displayName || p.fullName,
          age: p.age || 0,
          number: jerseyNumber,
          position: p.position?.displayName || posInfo.posLabel,
          posLabel: posInfo.posLabel,
          group: posInfo.group,
          photo: p.headshot?.href || velezEntry.team?.logos?.[0]?.href || '',
          pj,
          goals: getStat(['totalGoals', 'G', 'goals']),
          cleanSheets,
          yellowCards: getStat(['yellowCards', 'YC']),
          redCards: getStat(['redCards', 'RC'])
        };
      });
    }

    // --- TABLAS DE POSICIONES (CON LECTURA EXACTA RESTAURADA) ---
    let standingsClausura = [];
    let standingsAnual = [];
    let standingsPromedios = [];

    if (standingsRes.status === 'fulfilled' && standingsRes.value.data) {
      const data = standingsRes.value.data;
      const children = data.children || [];

      if (children[0]?.standings?.entries) {
        standingsClausura = parseStandingsEntries(children[0].standings.entries, velezId);
      } else if (data.standings?.entries) {
        standingsClausura = parseStandingsEntries(data.standings.entries, velezId);
      }

      if (children[1]?.standings?.entries) {
        standingsAnual = parseStandingsEntries(children[1].standings.entries, velezId);
      } else {
        standingsAnual = [...standingsClausura];
      }

      if (children[2]?.standings?.entries) {
        standingsPromedios = parseStandingsEntries(children[2].standings.entries, velezId);
      } else {
        standingsPromedios = [...standingsAnual].sort((a, b) => parseFloat(b.promedio) - parseFloat(a.promedio));
      }
    }

    const payload = {
      velezEspnIdDetectado: velezId,
      currentMatch,
      lastMatches,
      rivalLastMatches,
      upcomingMatches,
      squad,
      standingsClausura,
      standingsAnual,
      standingsPromedios
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
