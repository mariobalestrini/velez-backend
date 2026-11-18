const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1';
const ESPN_WEB_API = 'https://site.web.api.espn.com/apis/v2/sports/soccer/arg.1';

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

// Ruta principal para tu web
app.get('/api/velez-data', async (req, res) => {
  const now = Date.now();
  if (cacheData && (now - cacheTime < CACHE_TTL)) {
    return res.json(cacheData);
  }

  try {
    // 1. Obtener la lista oficial de equipos de Argentina en ESPN y encontrar el ID real de Vélez
    const teamsRes = await axios.get(`${ESPN_BASE}/teams?region=ar&lang=es`);
    const allTeams = teamsRes.data?.sports?.[0]?.leagues?.[0]?.teams || [];
    
    const velezEntry = allTeams.find(t => {
      const name = (t.team?.displayName || t.team?.name || '').toLowerCase();
      return name.includes('vélez') || name.includes('velez');
    });

    if (!velezEntry) {
      return res.status(404).json({ error: 'No se encontró a Vélez en la lista de equipos de ESPN arg.1' });
    }

    const velezId = String(velezEntry.team.id);

    // 2. Con el ID real verificado, pedimos Fixture, Plantel y Tabla de Posiciones en paralelo
    const [scheduleRes, rosterRes, standingsRes] = await Promise.allSettled([
      axios.get(`${ESPN_BASE}/teams/${velezId}/schedule?region=ar&lang=es`),
      axios.get(`${ESPN_BASE}/teams/${velezId}/roster?region=ar&lang=es`),
      axios.get(`${ESPN_WEB_API}/standings?region=ar&lang=es`)
    ]);

    // --- A. PROCESAR PARTIDOS ---
    let lastMatches = [];
    let upcomingMatches = [];
    let currentMatch = null;

    if (scheduleRes.status === 'fulfilled' && scheduleRes.value.data?.events) {
      const events = scheduleRes.value.data.events;
      const finished = [];
      const upcoming = [];
      let liveEvent = null;

      events.forEach(ev => {
        const comp = ev.competitions?.[0];
        if (!comp) return;
        const state = comp.status?.type?.state;
        if (state === 'post') finished.push(ev);
        else if (state === 'pre') upcoming.push(ev);
        else if (state === 'in') liveEvent = ev;
      });

      finished.sort((a, b) => new Date(b.date) - new Date(a.date));
      lastMatches = finished.slice(0, 5).map(ev => {
        const comp = ev.competitions[0];
        const competitors = comp.competitors || [];
        const velez = competitors.find(c => String(c.id) === velezId || String(c.team?.id) === velezId);
        const rival = competitors.find(c => String(c.id) !== velezId && String(c.team?.id) !== velezId);

        const isHome = velez?.homeAway === 'home';
        const vGoals = parseInt(velez?.score?.value ?? velez?.score?.displayValue ?? 0);
        const rGoals = parseInt(rival?.score?.value ?? rival?.score?.displayValue ?? 0);

        let outcome = 'E';
        if (vGoals > rGoals) outcome = 'G';
        else if (vGoals < rGoals) outcome = 'P';

        const d = new Date(ev.date);
        return {
          fecha: ev.seasonType?.abbreviation || 'LPF',
          comp: ev.league?.shortName || 'Liga Profesional',
          date: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
          rival: rival?.team?.shortDisplayName || rival?.team?.displayName || 'Rival',
          cond: isHome ? 'L' : 'V',
          velezGoals: isNaN(vGoals) ? 0 : vGoals,
          rivalGoals: isNaN(rGoals) ? 0 : rGoals,
          outcome
        };
      });

      upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
      upcomingMatches = upcoming.slice(0, 4).map(ev => {
        const comp = ev.competitions[0];
        const competitors = comp.competitors || [];
        const velez = competitors.find(c => String(c.id) === velezId || String(c.team?.id) === velezId);
        const rival = competitors.find(c => String(c.id) !== velezId && String(c.team?.id) !== velezId);

        const isHome = velez?.homeAway === 'home';
        const d = new Date(ev.date);

        return {
          fecha: 'PRÓXIMO',
          comp: ev.league?.shortName || 'Liga Profesional',
          date: d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
          timeART: d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }) + ' ART',
          rival: rival?.team?.shortDisplayName || rival?.team?.displayName || 'Rival',
          cond: isHome ? 'L' : 'V',
          stadium: comp.venue?.fullName || 'Estadio José Amalfitani'
        };
      });

      const targetEv = liveEvent || upcoming[0] || finished[0];
      if (targetEv) {
        const comp = targetEv.competitions[0];
        const homeC = comp.competitors.find(c => c.homeAway === 'home');
        const awayC = comp.competitors.find(c => c.homeAway === 'away');

        currentMatch = {
          type: liveEvent ? 'LIVE' : 'NEXT',
          match: {
            teams: {
              home: { name: homeC?.team?.shortDisplayName || homeC?.team?.displayName || 'Local', logo: homeC?.team?.logos?.[0]?.href },
              away: { name: awayC?.team?.shortDisplayName || awayC?.team?.displayName || 'Visitante', logo: awayC?.team?.logos?.[0]?.href }
            },
            goals: {
              home: parseInt(homeC?.score?.value ?? homeC?.score?.displayValue ?? 0) || 0,
              away: parseInt(awayC?.score?.value ?? awayC?.score?.displayValue ?? 0) || 0
            },
            fixture: {
              date: targetEv.date,
              venue: { name: comp.venue?.fullName || 'Estadio José Amalfitani' },
              status: {
                short: liveEvent ? 'LIVE' : 'NS',
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
    }

    // --- B. PROCESAR PLANTEL Y ESTADÍSTICAS ---
    let squad = [];
    if (rosterRes.status === 'fulfilled' && rosterRes.value.data?.athletes) {
      const rawAthletes = rosterRes.value.data.athletes;
      let playerList = [];
      rawAthletes.forEach(item => {
        if (item.items && Array.isArray(item.items)) {
          playerList = playerList.concat(item.items);
        } else {
          playerList.push(item);
        }
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

        return {
          id: Number(p.id),
          name: p.displayName || p.fullName,
          age: p.age || null,
          number: p.jersey ? Number(p.jersey) : null,
          position: p.position?.displayName || posInfo.posLabel,
          posLabel: posInfo.posLabel,
          group: posInfo.group,
          photo: p.headshot?.href || velezEntry.team?.logos?.[0]?.href || '',
          pj: getStat(['appearances', 'GP', 'subIns']),
          goals: getStat(['totalGoals', 'G', 'goals']),
          cleanSheets: posInfo.group === 'ARQ' ? getStat(['cleanSheets', 'CS']) : null,
          yellowCards: getStat(['yellowCards', 'YC']),
          redCards: getStat(['redCards', 'RC'])
        };
      });
    }

    // --- C. PROCESAR TABLA DE POSICIONES ---
    let standingsClausura = [];
    if (standingsRes.status === 'fulfilled' && standingsRes.value.data) {
      const data = standingsRes.value.data;
      const entries = data.children?.[0]?.standings?.entries || data.standings?.entries || [];

      standingsClausura = entries.map(entry => {
        const team = entry.team || {};
        const stats = entry.stats || [];
        const findStat = (name) => {
          const s = stats.find(st => st.name === name || st.type === name || st.abbreviation === name);
          return s ? Number(s.value) : 0;
        };

        return {
          name: team.shortDisplayName || team.displayName || team.name,
          isVelez: String(team.id) === velezId,
          pj: findStat('gamesPlayed'),
          pg: findStat('wins'),
          pe: findStat('ties'),
          pp: findStat('losses'),
          gf: findStat('pointsFor'),
          gc: findStat('pointsAgainst'),
          dg: findStat('pointDifferential'),
          pts: findStat('points')
        };
      });

      // Ordenar por puntos de mayor a menor por si ESPN la manda en orden alfabético
      standingsClausura.sort((a, b) => b.pts - a.pts || b.dg - a.dg);
    }

    const payload = {
      velezEspnIdDetectado: velezId,
      currentMatch,
      lastMatches,
      upcomingMatches,
      squad,
      standingsClausura
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
