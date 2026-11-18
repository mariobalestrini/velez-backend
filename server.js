const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = '10b3e0c0683e67c11dccbbcfa1070047';
const TEAM_ID = 765; // Vélez Sarsfield en API-Football
const LEAGUE_ID = 128; // Liga Profesional Argentina
const SEASON = 2026;

// Caché en memoria (60 segundos)
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
    console.error(`Error consultando API-Football (${endpoint}):`, error.message);
    throw error;
  }
}

// 1. Partido en vivo o Próximo partido
app.get('/api/velez-match', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const liveData = await fetchFromApi('fixtures', {
      team: TEAM_ID,
      date: today,
      status: '1H,HT,2H,ET,P,LIVE'
    });

    if (liveData.response && liveData.response.length > 0) {
      return res.json({ type: 'LIVE', match: liveData.response[0] });
    }

    const nextData = await fetchFromApi('fixtures', { team: TEAM_ID, next: 1 });

    if (!nextData.response || nextData.response.length === 0) {
      return res.json({ type: 'NONE', message: 'No hay partidos próximos programados.' });
    }

    const nextMatch = nextData.response[0];
    const homeTeamId = nextMatch.teams.home.id;
    const awayTeamId = nextMatch.teams.away.id;

    const [homeLast, awayLast] = await Promise.all([
      fetchFromApi('fixtures', { team: homeTeamId, last: 2 }),
      fetchFromApi('fixtures', { team: awayTeamId, last: 2 })
    ]);

    res.json({
      type: 'NEXT',
      match: nextMatch,
      homeForm: homeLast.response || [],
      awayForm: awayLast.response || []
    });

  } catch (error) {
    res.status(500).json({ error: 'Error al obtener información del partido' });
  }
});

// 2. Últimos 5 partidos de Vélez
app.get('/api/velez-last-5', async (req, res) => {
  try {
    const data = await fetchFromApi('fixtures', { team: TEAM_ID, last: 5 });
    res.json(data.response || []);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener últimos partidos' });
  }
});

// 3. Plantilla y estadísticas de jugadores
app.get('/api/velez-squad', async (req, res) => {
  try {
    const squadData = await fetchFromApi('players/squads', { team: TEAM_ID });
    if (!squadData.response || squadData.response.length === 0) {
      return res.json([]);
    }

    const players = squadData.response[0].players;
    
    const statsPromises = players.map(async (p) => {
      try {
        const pStats = await fetchFromApi('players', { id: p.id, season: SEASON, league: LEAGUE_ID });
        if (pStats.response && pStats.response.length > 0) {
          const stats = pStats.response[0].statistics[0];
          return {
            id: p.id,
            name: p.name,
            age: p.age,
            photo: p.photo,
            position: p.position,
            number: p.number,
            appearances: stats.games.appearences || 0,
            goals: stats.goals.total || 0,
            yellows: stats.cards.yellow || 0,
            reds: stats.cards.red || 0,
            cleanSheets: stats.goals.conceded === 0 ? (stats.games.appearences || 0) : 0
          };
        }
      } catch (e) {}
      return {
        id: p.id,
        name: p.name,
        age: p.age,
        photo: p.photo,
        position: p.position,
        number: p.number,
        appearances: 0,
        goals: 0,
        yellows: 0,
        reds: 0,
        cleanSheets: 0
      };
    });

    const detailedSquad = await Promise.all(statsPromises);
    res.json(detailedSquad);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener la plantilla' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor backend corriendo en puerto ${PORT}`);
});
