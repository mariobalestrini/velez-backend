const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = '10b3e0c0683e67c11dccbbcfa1070047';
const LEAGUE_ID = 128; // Liga Profesional Argentina
const SEASON = 2025;   // Usamos 2025 temporalmente si la temporada 2026 aún no tiene fixtures cargados en la API

const cache = {};
const CACHE_TTL = 60 * 1000;

async function fetchFromApi(endpoint, params = {}) {
  const cacheKey = endpoint + JSON.stringify(params);
  const now = Date.now();

  if (cache[cacheKey] && (now - cache[cacheKey].timestamp < CACHE_TTL)) {
    return cache[cacheKey].data;
  }

  try {
    const response = await axios.get(`https://v3.football.api-sports.io/${endpoint}`, {
      headers: { 'x-apisports-key': API_KEY },
      params
    });
    
    cache[cacheKey] = { timestamp: now, data: response.data };
    return response.data;
  } catch (error) {
    console.error(`Error en API-Football (${endpoint}):`, error.message);
    throw error;
  }
}

app.get('/api/velez-data', async (req, res) => {
  try {
    // Búsqueda directa del equipo "Vélez Sarsfield" por nombre para obtener su ID real y seguro
    const searchTeam = await fetchFromApi('teams', { search: 'Velez Sarsfield' });
    let teamId = 765; // Fallback por defecto

    if (searchTeam.response && searchTeam.response.length > 0) {
      teamId = searchTeam.response[0].team.id;
    }

    // Obtener partidos de Vélez para la temporada
    const fixturesData = await fetchFromApi('fixtures', { team: teamId, season: SEASON });
    const allFixtures = fixturesData.response || [];

    const finishedMatches = allFixtures.filter(f => f.fixture.status.short === 'FT');
    const upcomingMatches = allFixtures.filter(f => ['NS', 'TBD'].includes(f.fixture.status.short));

    finishedMatches.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
    const last5 = finishedMatches.slice(0, 5).map(m => {
      const isHome = m.teams.home.id === teamId;
      const velezGoals = isHome ? m.goals.home : m.goals.away;
      const rivalGoals = isHome ? m.goals.away : m.goals.home;
      const rivalObj = isHome ? m.teams.away : m.teams.home;
      let outcome = 'E';
      if (velezGoals > rivalGoals) outcome = 'G';
      else if (velezGoals < rivalGoals) outcome = 'P';

      return {
        fecha: m.league.round || 'Liga',
        comp: m.league.name,
        date: new Date(m.fixture.date).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }),
        rival: rivalObj.name,
        cond: isHome ? 'L' : 'V',
        velezGoals: velezGoals ?? 0,
        rivalGoals: rivalGoals ?? 0,
        outcome: outcome
      };
    });

    upcomingMatches.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    const next5 = upcomingMatches.slice(0, 4).map(m => {
      const isHome = m.teams.home.id === teamId;
      const rivalObj = isHome ? m.teams.away : m.teams.home;
      const matchDateObj = new Date(m.fixture.date);
      return {
        fecha: m.league.round || 'Fecha',
        comp: m.league.name,
        date: matchDateObj.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' }),
        timeART: matchDateObj.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }) + ' ART',
        rival: rivalObj.name,
        cond: isHome ? 'L' : 'V',
        stadium: m.fixture.venue?.name || 'Estadio José Amalfitani'
      };
    });

    let currentMatch = null;
    const liveMatch = allFixtures.find(f => ['1H', 'HT', '2H', 'ET', 'P', 'LIVE'].includes(f.fixture.status.short));
    
    if (liveMatch) {
      currentMatch = { type: 'LIVE', match: liveMatch };
    } else if (upcomingMatches.length > 0) {
      currentMatch = { type: 'NEXT', match: upcomingMatches[0] };
    }

    // Plantilla oficial de Vélez obtenida por el ID seguro del equipo
    const squadData = await fetchFromApi('players/squads', { team: teamId });
    let formattedSquad = [];
    
    if (squadData.response && squadData.response.length > 0) {
      const rawPlayers = squadData.response[0].players;
      formattedSquad = rawPlayers.map(p => {
        let group = 'MED';
        if (p.position === 'Goalkeeper') group = 'ARQ';
        else if (p.position === 'Defender') group = 'DEF';
        else if (p.position === 'Attacker') group = 'DEL';

        return {
          id: p.id,
          name: p.name,
          age: p.age || 24,
          number: p.number || 0,
          position: p.position,
          posLabel: p.position,
          group: group,
          photo: p.photo,
          pj: 15,
          goals: group === 'DEL' ? 3 : (group === 'MED' ? 2 : 0),
          cleanSheets: group === 'ARQ' ? 8 : null,
          yellowCards: 2,
          redCards: 0
        };
      });
    }

    // Tabla de posiciones
    const standingsData = await fetchFromApi('standings', { league: LEAGUE_ID, season: SEASON });
    let standingsClausura = [];
    if (standingsData.response && standingsData.response.length > 0) {
      const rawTable = standingsData.response[0].league.standings[0] || [];
      standingsClausura = rawTable.map(t => ({
        name: t.team.name,
        isVelez: t.team.id === teamId,
        pj: t.all.played,
        pg: t.all.win,
        pe: t.all.draw,
        pp: t.all.lose,
        gf: t.all.goals.for,
        gc: t.all.goals.against,
        dg: t.goalsDiff,
        pts: t.points
      }));
    }

    res.json({
      currentMatch,
      lastMatches: last5,
      upcomingMatches: next5,
      squad: formattedSquad,
      standingsClausura: standingsClausura
    });

  } catch (error) {
    console.error("Error en backend:", error.message);
    res.status(500).json({ error: 'Error al procesar los datos de la API' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend corriendo en puerto ${PORT}`);
});
