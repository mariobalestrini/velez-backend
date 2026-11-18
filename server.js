const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = '10b3e0c0683e67c11dccbbcfa1070047';
const TEAM_ID = 765; // ID oficial de Vélez Sarsfield en API-Football
const LEAGUE_ID = 128; // Liga Profesional Argentina
const SEASON = 2026;

// Sistema de caché en memoria (60 segundos)
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

// Endpoint unificado que devuelve todos los datos en vivo para tu frontend
app.get('/api/velez-data', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // 1. Consultar partido en vivo hoy o próximo partido
    const liveData = await fetchFromApi('fixtures', {
      team: TEAM_ID,
      date: today,
      status: '1H,HT,2H,ET,P,LIVE'
    });

    let currentMatch = null;
    if (liveData.response && liveData.response.length > 0) {
      currentMatch = { type: 'LIVE', match: liveData.response[0] };
    } else {
      const nextData = await fetchFromApi('fixtures', { team: TEAM_ID, next: 1, season: SEASON });
      if (nextData.response && nextData.response.length > 0) {
        currentMatch = { type: 'NEXT', match: nextData.response[0] };
      }
    }

    // 2. Últimos partidos de Vélez
    const lastFixtures = await fetchFromApi('fixtures', { team: TEAM_ID, last: 5, season: SEASON });

    // 3. Plantilla de jugadores de Vélez
    const squadData = await fetchFromApi('players/squads', { team: TEAM_ID });
    
    res.json({
      currentMatch,
      lastMatches: lastFixtures.response || [],
      squad: squadData.response ? squadData.response[0].players : []
    });

  } catch (error) {
    res.status(500).json({ error: 'Error al sincronizar con API-Football' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend corriendo en puerto ${PORT}`);
});
