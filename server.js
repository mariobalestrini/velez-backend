const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuración oficial de ESPN Deportes Argentina
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1';
const ESPN_WEB_API = 'https://site.web.api.espn.com/apis/v2/sports/soccer/arg.1';
const VELEZ_ESPN_ID = '21'; // ID único de Club Atlético Vélez Sarsfield en ESPN

let cacheData = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 minuto de caché

// Traductor de posiciones al español con los grupos de tu frontend
function mapPosition(posAbbr, posName) {
  const abbr = (posAbbr || '').toUpperCase();
  if (abbr === 'G' || abbr === 'GK' || (posName && posName.toLowerCase().includes('arquero'))) {
    return { group: 'ARQ', posLabel: 'Arquero' };
  }
  if (abbr === 'D' || abbr === 'DF' || (posName && posName.toLowerCase().includes('defensor'))) {
    return { group: 'DEF', posLabel: 'Defensor' };
  }
  if (abbr === 'F' || abbr === 'FW' || abbr === 'A' || (posName && posName.toLowerCase().includes('delantero')) || (posName && posName.toLowerCase().includes('atacante'))) {
    return { group: 'DEL', posLabel: 'Delantero' };
  }
  return { group: 'MED', posLabel: 'Mediocampista' };
}

app.get('/api/velez-data', async (req, res) => {
  const now = Date.now();
  if (cacheData && (now - cacheTime < CACHE_TTL)) {
    return res.json(cacheData);
  }

  try {
    // 1. Peticiones en paralelo a ESPN Argentina (Calendario, Plantel y Tabla de Posiciones)
    const [scheduleRes, rosterRes, standingsRes] = await Promise.allSettled([
      axios.get(`${ESPN_BASE}/teams/${VELEZ_ESPN_ID}/schedule?region=ar&lang=es`),
      axios.get(`${ESPN_BASE}/teams/${VELEZ_ESPN_ID}/roster?region=ar&lang=es`),
      axios.get(`${ESPN_WEB_API}/standings?region=ar&lang=es`)
    ]);

    // --- A. PROCESAR PARTIDOS (ÚLTIMOS, PRÓXIMOS Y EN VIVO) ---
    let lastMatches = [];
    let upcomingMatches = [];
    let currentMatch = null;

    if (scheduleRes.status === 'fulfilled' && scheduleRes.value.data.events) {
      const events = scheduleRes.value.data.events;

      const finished = [];
      const upcoming = [];
      let liveEvent = null;

      events.forEach(ev => {
        const comp = ev.competitions?.[0];
        if (!comp) return;

        const state = comp.status?.type?.state; // 'pre' (futuro), 'in' (en vivo), 'post' (finalizado)
        if (state === 'post') finished.push(ev);
        else if (state === 'pre') upcoming.push(ev);
        else if (state === 'in') liveEvent = ev;
      });

      // Ordenar finalizados del más reciente al más antiguo
      finished.sort((a, b) => new Date(b.date) - new Date(a.date));
      lastMatches = finished.slice(0, 5).map(ev => {
        const comp = ev.competitions[0];
        const competitors = comp.competitors || [];
        const velez = competitors.find(c => String(c.id) === VELEZ_ESPN_ID || c.team?.id === VELEZ_ESPN_ID);
        const rival = competitors.find(c => String(c.id) !== VELEZ_ESPN_ID && c.team?.id !== VELEZ_ESPN_ID);

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
          velezGoals: vGoals,
          rivalGoals: rGoals,
          outcome: outcome
        };
      });

      // Ordenar próximos del más cercano al más lejano
      upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
      upcomingMatches = upcoming.slice(0, 4).map(ev => {
        const comp = ev.competitions[0];
        const competitors = comp.competitors || [];
        const velez = competitors.find(c => String(c.id) === VELEZ_ESPN_ID || c.team?.id === VELEZ_ESPN_ID);
        const rival = competitors.find(c => String(c.id) !== VELEZ_ESPN_ID && c.team?.id !== VELEZ_ESPN_ID);

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

      // Armar el objeto currentMatch con el formato exacto que espera tu index.html
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
              home: parseInt(homeC?.score?.value ?? homeC?.score?.displayValue ?? 0),
              away: parseInt(awayC?.score?.value ?? awayC?.score?.displayValue ?? 0)
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
              name: targetEv.league?.name || 'Liga Profesional Argentina',
              round: comp.status?.type?.shortDetail || 'Torneo Local'
            }
          }
        };
      }
    }

    // --- B. PROCESAR PLANTEL Y ESTADÍSTICAS REALES ---
    let squad = [];
    if (rosterRes.status === 'fulfilled' && rosterRes.value.data.athletes) {
      const rawAthletes = rosterRes.value.data.athletes;

      // En ESPN los jugadores pueden venir directos o agrupados por posición
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

        // Extraer estadísticas de la temporada en curso desde el objeto de ESPN
        const splits = p.statistics?.splits?.categories || [];
        const getStat = (statName) => {
          for (const cat of splits) {
            const found = (cat.stats || []).find(s => s.name === statName || s.abbreviation === statName);
            if (found && found.value !== undefined) return Number(found.value);
          }
          return 0;
        };

        return {
          id: Number(p.id),
          name: p.displayName || p.fullName,
          age: p.age || null,
          number: p.jersey ? Number(p.jersey) : null,
          position: p.position?.name || posInfo.posLabel,
          posLabel: posInfo.posLabel,
          group: posInfo.group,
          photo: p.headshot?.href || `https://a.espncdn.com/i/teamlogos/soccer/500/${VELEZ_ESPN_ID}.png`,
          pj: getStat('appearances') || getStat('GP'),
          goals: getStat('totalGoals') || getStat('G'),
          cleanSheets: posInfo.group === 'ARQ' ? (getStat('cleanSheets') || getStat('CS')) : null,
          yellowCards: getStat('yellowCards') || getStat('YC'),
          redCards: getStat('redCards') || getStat('RC')
        };
      });
    }

    // --- C. PROCESAR TABLA DE POSICIONES EN VIVO ---
    let standingsClausura = [];
    if (standingsRes.status === 'fulfilled' && standingsRes.value.data) {
      const data = standingsRes.value.data;
      // Buscar las entradas de la tabla actual
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
          isVelez: String(team.id) === VELEZ_ESPN_ID,
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
    }

    const payload = {
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
    console.error("Error al consultar ESPN Argentina:", error.message);
    res.status(500).json({
      error: 'Error al consultar ESPN Argentina',
      detalle: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor conectado a ESPN Argentina en puerto ${PORT}`);
});
