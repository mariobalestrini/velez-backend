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

// Formatea un evento de ESPN al formato de partido para cualquier equipo (Vélez o Rival)
function formatMatchForTeam(ev, targetTeamId) {
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
    id: ev.id,
    rawDate: d,
    fecha: ev.seasonType?.abbreviation || 'LPF',
    comp: ev.league?.shortName || 'Liga Profesional',
    date: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
    rival: oppObj.team?.shortDisplayName || oppObj.team?.displayName || 'Rival',
    rivalLogo: oppObj.team?.logos?.[0]?.href || '',
    cond: isHome ? 'L' : 'V',
    velezGoals: isNaN(tGoals) ? 0 : tGoals,
    rivalGoals: isNaN(oGoals) ? 0 : oGoals,
    teamGoals: isNaN(tGoals) ? 0 : tGoals,
    oppGoals: isNaN(oGoals) ? 0 : oGoals,
    outcome,
    result: outcome // Compatibilidad con ambos nombres de propiedad en el frontend
  };
}

// Formatea fecha YYYYMMDD para pedir el scoreboard extendido de ESPN
function getEspnDateRange(daysBack, daysForward) {
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const start = new Date(Date.now() - daysBack * 86400000);
  const end = new Date(Date.now() + daysForward * 86400000);
  return `${fmt(start)}-${fmt(end)}`;
}

app.get('/', (req, res) => {
  res.json({ status: 'OK', mensaje: 'Backend de Vélez conectado a ESPN v2. Usá /api/velez-data' });
});

app.get('/api/velez-data', async (req, res) => {
  const now = Date.now();
  if (cacheData && (now - cacheTime < CACHE_TTL)) {
    return res.json(cacheData);
  }

  try {
    // 1. Detectar ID de Vélez en ESPN
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
    const dateRange = getEspnDateRange(45, 60); // 45 días atrás y 60 días hacia adelante

    // 2. Consultas en paralelo (Schedule Liga, Scoreboard extendido Liga, Scoreboard Copa Argentina, Plantel y Tablas)
    const [schedLpfRes, sbLpfRes, sbCopaRes, rosterRes, standingsRes] = await Promise.allSettled([
      axios.get(`${ESPN_LPF}/teams/${velezId}/schedule?region=ar&lang=es`),
      axios.get(`${ESPN_LPF}/scoreboard?dates=${dateRange}&limit=300&region=ar&lang=es`),
      axios.get(`${ESPN_COPA}/scoreboard?dates=${dateRange}&limit=100&region=ar&lang=es`),
      axios.get(`${ESPN_LPF}/teams/${velezId}/roster?region=ar&lang=es`),
      axios.get(`${ESPN_WEB_LPF}/standings?region=ar&lang=es`)
    ]);

    // Unificar todos los partidos donde juega Vélez (evitando duplicados por ID de evento)
    const eventsMap = new Map();
    const addEventsIfVelez = (eventsList, defaultLeagueName) => {
      (eventsList || []).forEach(ev => {
        const comp = ev.competitions?.[0];
        if (!comp) return;
        const hasVelez = (comp.competitors || []).some(
          c => String(c.id) === velezId || String(c.team?.id) === velezId
        );
        if (hasVelez) {
          if (!ev.league && defaultLeagueName) ev.league = { shortName: defaultLeagueName, name: defaultLeagueName };
          eventsMap.set(String(ev.id), ev);
        }
      });
    };

    if (schedLpfRes.status === 'fulfilled') addEventsIfVelez(schedLpfRes.value.data?.events, 'Liga Profesional');
    if (sbLpfRes.status === 'fulfilled') addEventsIfVelez(sbLpfRes.value.data?.events, 'Liga Profesional');
    if (sbCopaRes.status === 'fulfilled') addEventsIfVelez(sbCopaRes.value.data?.events, 'Copa Argentina');

    const allVelezEvents = Array.from(eventsMap.values());
    const finished = [];
    const upcoming = [];
    let liveEvent = null;

    allVelezEvents.forEach(ev => {
      const comp = ev.competitions?.[0];
      const state = comp?.status?.type?.state;
      const completed = comp?.status?.type?.completed === true;
      const evTime = new Date(ev.date).getTime();

      if (state === 'in') {
        liveEvent = ev;
      } else if (completed || state === 'post') {
        finished.push(ev);
      } else if (state === 'pre' || evTime > now - 2 * 3600 * 1000) {
        upcoming.push(ev);
      }
    });

    // Ordenar finalizados (más reciente primero) y futuros (más cercano primero)
    finished.sort((a, b) => new Date(b.date) - new Date(a.date));
    upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));

    const lastMatches = finished.slice(0, 5).map(ev => formatMatchForTeam(ev, velezId)).filter(Boolean);

    // Calcular vallas invictas reales de Vélez en la temporada para asignar al arquero titular
    const totalCleanSheetsSeason = finished.filter(ev => {
      const formatted = formatMatchForTeam(ev, velezId);
      return formatted && formatted.rivalGoals === 0;
    }).length;

    const upcomingMatches = upcoming.slice(0, 5).map(ev => {
      const comp = ev.competitions[0];
      const competitors = comp.competitors || [];
      const velez = competitors.find(c => String(c.id) === velezId || String(c.team?.id) === velezId);
      const rival = competitors.find(c => String(c.id) !== velezId && String(c.team?.id) !== velezId);
      const isHome = velez?.homeAway === 'home';
      const d = new Date(ev.date);

      return {
        id: ev.id,
        fecha: ev.seasonType?.abbreviation || 'PRÓXIMO',
        comp: ev.league?.shortName || 'Liga Profesional',
        date: d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
        timeART: d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }) + ' ART',
        rival: rival?.team?.shortDisplayName || rival?.team?.displayName || 'Rival',
        rivalLogo: rival?.team?.logos?.[0]?.href || '',
        cond: isHome ? 'L' : 'V',
        stadium: comp.venue?.fullName || (isHome ? 'Estadio José Amalfitani' : 'Estadio a confirmar')
      };
    });

    // --- PRÓXIMO PARTIDO OFICIAL Y "CÓMO LLEGA EL RIVAL" ---
    let currentMatch = null;
    let rivalLastMatches = [];
    // Prioridad estricta: Partido en vivo -> Próximo partido futuro -> Último jugado (solo si no hay futuros programados)
    const targetEv = liveEvent || upcoming[0] || finished[0];

    if (targetEv) {
      const comp = targetEv.competitions[0];
      const homeC = comp.competitors.find(c => c.homeAway === 'home');
      const awayC = comp.competitors.find(c => c.homeAway === 'away');
      const rivalC = [homeC, awayC].find(c => String(c?.id) !== velezId && String(c?.team?.id) !== velezId);
      const rivalId = String(rivalC?.team?.id || rivalC?.id || '');

      // Obtener últimos 5 partidos del próximo rival para la sección "Cómo llega el rival"
      if (rivalId) {
        try {
          const rivalSched = await axios.get(`${ESPN_LPF}/teams/${rivalId}/schedule?region=ar&lang=es`);
          const rEvents = (rivalSched.data?.events || []).filter(
            e => e.competitions?.[0]?.status?.type?.state === 'post' || e.competitions?.[0]?.status?.type?.completed
          );
          rEvents.sort((a, b) => new Date(b.date) - new Date(a.date));
          rivalLastMatches = rEvents.slice(0, 5).map(e => formatMatchForTeam(e, rivalId)).filter(Boolean);
        } catch (e) {
          rivalLastMatches = [];
        }
      }

      const isTargetUpcoming = !liveEvent && upcoming.length > 0;
      currentMatch = {
        type: liveEvent ? 'LIVE' : 'NEXT',
        velezForm: lastMatches,
        rivalForm: rivalLastMatches,
        match: {
          teams: {
            home: {
              id: homeC?.team?.id,
              name: homeC?.team?.shortDisplayName || homeC?.team?.displayName || 'Local',
              logo: homeC?.team?.logos?.[0]?.href || ''
            },
            away: {
              id: awayC?.team?.id,
              name: awayC?.team?.shortDisplayName || awayC?.team?.displayName || 'Visitante',
              logo: awayC?.team?.logos?.[0]?.href || ''
            }
          },
          goals: {
            home: isTargetUpcoming ? null : (parseInt(homeC?.score?.value ?? homeC?.score?.displayValue ?? 0) || 0),
            away: isTargetUpcoming ? null : (parseInt(awayC?.score?.value ?? awayC?.score?.displayValue ?? 0) || 0)
          },
          fixture: {
            date: targetEv.date,
            venue: { name: comp.venue?.fullName || 'Estadio José Amalfitani' },
            status: {
              short: liveEvent ? 'LIVE' : 'NS',
              long: isTargetUpcoming ? 'Próximo Partido Oficial' : (comp.status?.type?.detail || 'Finalizado')
            }
          },
          league: {
            name: targetEv.league?.name || 'Liga Profesional Argentina',
            round: comp.status?.type?.shortDetail || 'Torneo Local'
          },
          velezLastMatches: lastMatches,
          rivalLastMatches: rivalLastMatches
        }
      };
    }

    // --- PLANTEL CON DORSAL Y VALLAS INVICTAS CORREGIDOS ---
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
              if (names.includes(st.name) || names.includes(st.abbreviation) || names.includes(st.type)) {
                return Number(st.value) || 0;
              }
            }
          }
          return 0;
        };

        const pj = getStat(['appearances', 'GP', 'gamesPlayed']);
        const goalsConceded = getStat(['goalsConceded', 'GA', 'pointsAgainst']);
        let cleanSheets = null;

        if (posInfo.group === 'ARQ') {
          const apiCS = getStat(['cleanSheets', 'CS', 'shutouts']);
          if (apiCS > 0) {
            cleanSheets = apiCS;
          } else if (pj > 0) {
            // Si ESPN no desglosa cleanSheets pero el arquero atajó, asignamos proporcional o el cálculo real de partidos con 0 goles recibidos
            cleanSheets = Math.min(pj, totalCleanSheetsSeason || Math.max(0, pj - goalsConceded));
          } else {
            cleanSheets = 0;
          }
        }

        // Extraer dorsal de cualquiera de las propiedades donde ESPN lo aloja
        const rawJersey = p.jersey ?? p.uniformNumber ?? p.displayJersey;
        const parsedJersey = rawJersey !== undefined && rawJersey !== '' ? Number(rawJersey) : '-';

        return {
          id: Number(p.id),
          name: p.displayName || p.fullName,
          age: p.age || '-',
          number: parsedJersey,
          dorsal: parsedJersey,
          jersey: parsedJersey,
          position: p.position?.displayName || posInfo.posLabel,
          posLabel: posInfo.posLabel,
          group: posInfo.group,
          photo: p.headshot?.href || velezEntry.team?.logos?.[0]?.href || '',
          pj,
          goals: getStat(['totalGoals', 'G', 'goals']),
          cleanSheets,
          vallasInvictas: cleanSheets,
          yellowCards: getStat(['yellowCards', 'YC']),
          redCards: getStat(['redCards', 'RC'])
        };
      });
    }

    // --- TABLAS: CLAUSURA, ANUAL Y PROMEDIOS ---
    let standingsClausura = [];
    let standingsAnual = [];
    let standingsPromedios = [];

    const parseTableEntries = (entries) => {
      const list = (entries || []).map(entry => {
        const team = entry.team || {};
        const stats = entry.stats || [];
        const findStat = (names) => {
          const s = stats.find(st => names.includes(st.name) || names.includes(st.type) || names.includes(st.abbreviation));
          return s ? Number(s.value) : 0;
        };

        const pj = findStat(['gamesPlayed', 'GP', 'PJ']);
        const pts = findStat(['points', 'P', 'PTS']);
        const avg = findStat(['average', 'AVG', 'PROM']) || (pj > 0 ? Number((pts / pj).toFixed(3)) : 0);

        return {
          name: team.shortDisplayName || team.displayName || team.name,
          logo: team.logos?.[0]?.href || '',
          isVelez: String(team.id) === velezId,
          pj,
          pg: findStat(['wins', 'W', 'G']),
          pe: findStat(['ties', 'D', 'T', 'E']),
          pp: findStat(['losses', 'L', 'P']),
          gf: findStat(['pointsFor', 'GF', 'F']),
          gc: findStat(['pointsAgainst', 'GA', 'A', 'GC']),
          dg: findStat(['pointDifferential', 'GD', 'DIFF', 'DG']),
          pts,
          promedio: avg.toFixed(3),
          avg: avg.toFixed(3)
        };
      });
      list.sort((a, b) => b.pts - a.pts || b.dg - a.dg);
      return list;
    };

    if (standingsRes.status === 'fulfilled' && standingsRes.value.data) {
      const data = standingsRes.value.data;
      const children = data.children || [];

      // children[0] = Torneo actual (Liga / Clausura), children[1] = Tabla Anual
      if (children[0]?.standings?.entries) {
        standingsClausura = parseTableEntries(children[0].standings.entries);
      } else if (data.standings?.entries) {
        standingsClausura = parseTableEntries(data.standings.entries);
      }

      if (children[1]?.standings?.entries) {
        standingsAnual = parseTableEntries(children[1].standings.entries);
      } else {
        standingsAnual = [...standingsClausura];
      }

      if (children[2]?.standings?.entries) {
        standingsPromedios = parseTableEntries(children[2].standings.entries);
      } else {
        // Ordenar por coeficiente de promedio (pts / pj) de mayor a menor
        standingsPromedios = [...standingsAnual].sort((a, b) => Number(b.promedio) - Number(a.promedio));
      }
    }

    const payload = {
      velezEspnIdDetectado: velezId,
      currentMatch,
      lastMatches,
      velezLastMatches: lastMatches,
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
