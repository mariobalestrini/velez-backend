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
  if (abbr === 'G' || abbr === 'GK' || name.includes('arquero') || name.includes('goalkeeper')) {
    return { group: 'ARQ', posLabel: 'Arquero' };
  }
  if (abbr === 'D' || abbr === 'DF' || name.includes('defensor') || name.includes('defender') || name.includes('lateral')) {
    return { group: 'DEF', posLabel: 'Defensor' };
  }
  if (abbr === 'F' || abbr === 'FW' || abbr === 'A' || name.includes('delantero') || name.includes('atacante') || name.includes('forward')) {
    return { group: 'DEL', posLabel: 'Delantero' };
  }
  return { group: 'MED', posLabel: 'Mediocampista' };
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
  const tGoals = parseInt(teamObj.score?.value ?? teamObj.score?.displayValue ?? 0, 10);
  const oGoals = parseInt(oppObj.score?.value ?? oppObj.score?.displayValue ?? 0, 10);

  let outcome = 'E';
  if (tGoals > oGoals) outcome = 'G';
  else if (tGoals < oGoals) outcome = 'P';

  const d = new Date(ev.date);
  return {
    id: String(ev.id),
    fecha: ev.seasonType?.abbreviation || 'LPF',
    comp: ev.league?.shortName || 'Liga Profesional',
    date: d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' }),
    rival: oppObj.team?.shortDisplayName || oppObj.team?.displayName || 'Rival',
    rivalLogo: getTeamLogo(oppObj.team),
    cond: isHome ? 'L' : 'V',
    velezGoals: isNaN(tGoals) ? 0 : tGoals,
    rivalGoals: isNaN(oGoals) ? 0 : oGoals,
    teamGoals: isNaN(tGoals) ? 0 : tGoals,
    oppGoals: isNaN(oGoals) ? 0 : oGoals,
    score: `${isNaN(tGoals) ? 0 : tGoals} - ${isNaN(oGoals) ? 0 : oGoals}`,
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
  res.json({ status: 'OK', mensaje: 'Backend Vélez ESPN v7 activo (vallas invictas exactas por arquero). Usá /api/velez-data' });
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

    // --- CÁLCULO REAL DE VALLAS INVICTAS POR ARQUERO (Partido por partido donde rivalGoals === 0) ---
    const cleanSheetsByGoalkeeperId = new Map();
    const cleanSheetEvents = finished.filter(ev => {
      const m = formatPastMatch(ev, velezId);
      return m && m.rivalGoals === 0;
    });

    if (cleanSheetEvents.length > 0) {
      const csSummaries = await Promise.allSettled(
        cleanSheetEvents.map(ev => {
          const isCopa = (ev.league?.slug || '').includes('copa') || (ev.league?.shortName || '').toLowerCase().includes('copa');
          const baseApi = isCopa ? ESPN_COPA : ESPN_LPF;
          return axios.get(`${baseApi}/summary?event=${ev.id}&region=ar&lang=es`);
        })
      );

      csSummaries.forEach(resItem => {
        if (resItem.status !== 'fulfilled') return;
        const rosters = resItem.value.data?.rosters || [];
        const velezRoster = rosters.find(r => String(r.team?.id) === velezId);
        if (!velezRoster || !Array.isArray(velezRoster.roster)) return;

        // Buscar el arquero que jugó ese partido sin recibir goles (titular o ingresado sin goles en contra)
        const gks = velezRoster.roster.filter(item => {
          const abbr = (item.position?.abbreviation || '').toUpperCase();
          return abbr === 'G' || abbr === 'GK';
        });

        // Priorizar el titular; si hubo cambio y no recibieron goles, ambos mantuvieron su valla invicta en sus minutos
        const activeGks = gks.filter(g => g.starter === true || g.subbedIn === true);
        const targetGks = activeGks.length > 0 ? activeGks : gks.slice(0, 1);

        targetGks.forEach(gk => {
          const gkId = String(gk.athlete?.id || '');
          if (gkId) {
            cleanSheetsByGoalkeeperId.set(gkId, (cleanSheetsByGoalkeeperId.get(gkId) || 0) + 1);
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

    // --- PRÓXIMO PARTIDO, MARCADOR EN VIVO Y GOLEADORES ---
    let currentMatch = null;
    let rivalLastMatches = [];
    let rivalLast2 = [];
    const targetEv = liveEvent || upcoming[0] || finished[0];

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

      if (liveEvent && rawDetails.length === 0) {
        try {
          const liveSummary = await axios.get(`${ESPN_LPF}/summary?event=${targetEv.id}&region=ar&lang=es`);
          rawDetails = liveSummary.data?.keyEvents || liveSummary.data?.header?.competitions?.[0]?.details || [];
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

      currentMatch = {
        type: liveEvent ? 'LIVE' : 'NEXT',
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
            home: parseInt(homeC?.score?.value ?? homeC?.score?.displayValue ?? 0, 10) || 0,
            away: parseInt(awayC?.score?.value ?? awayC?.score?.displayValue ?? 0, 10) || 0
          },
          scorers,
          fixture: {
            date: isoDateStrict,
            timestamp: Math.floor(timestampMs / 1000),
            timestampMs,
            venue: { name: comp.venue?.fullName || 'Estadio José Amalfitani' },
            status: {
              short: liveEvent ? 'LIVE' : (upcoming.length > 0 ? 'NS' : 'FT'),
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
    }

    // --- ÚLTIMO 11 TITULAR REAL DE VÉLEZ ---
    let lastLineup = { formation: '4-2-3-1', rival: '', date: '', starters: [] };
    const jerseyFromMatchMap = new Map();

    if (finished.length > 0) {
      const lastGame = finished[0];
      try {
        const summaryRes = await axios.get(`${ESPN_LPF}/summary?event=${lastGame.id}&region=ar&lang=es`);
        const rosters = summaryRes.data?.rosters || [];
        const velezRoster = rosters.find(r => String(r.team?.id) === velezId);
        const oppRoster = rosters.find(r => String(r.team?.id) !== velezId);

        if (velezRoster && Array.isArray(velezRoster.roster)) {
          velezRoster.roster.forEach(item => {
            const pId = String(item.athlete?.id || '');
            const jNum = parseInt(item.jersey, 10);
            if (pId && !isNaN(jNum)) jerseyFromMatchMap.set(pId, jNum);
          });

          const startersRaw = velezRoster.roster.filter(item => item.starter === true);
          lastLineup = {
            formation: velezRoster.formation || '4-2-3-1',
            rival: oppRoster?.team?.shortDisplayName || oppRoster?.team?.displayName || '',
            date: new Date(lastGame.date).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }),
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
      } catch (err) {
        console.warn('No se pudo obtener la formación del último partido:', err.message);
      }
    }

    // --- PLANTEL ---
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
        let cleanSheets = null;

        if (posInfo.group === 'ARQ') {
          const apiCS = getStat(['cleanSheets', 'CS']);
          const matchCalculatedCS = cleanSheetsByGoalkeeperId.get(String(p.id)) || 0;
          // Prioridad al cálculo real por partido atajado con 0 goles en contra; si no, el dato nativo de ESPN (nunca mayor a sus PJ)
          cleanSheets = matchCalculatedCS > 0
            ? Math.min(pj || matchCalculatedCS, matchCalculatedCS)
            : Math.min(pj, apiCS);
        }

        const fullNameNorm = normalizeStr(p.displayName || p.fullName);
        const lastNameNorm = normalizeStr(p.lastName || fullNameNorm.split(' ').pop());

        const rawJersey =
          p.jersey ||
          jerseyFromMatchMap.get(String(p.id)) ||
          velezWebJerseys[fullNameNorm] ||
          velezWebJerseys[lastNameNorm] ||
          jerseyMap.get(String(p.id));

        const jerseyNumber = rawJersey && !isNaN(parseInt(rawJersey, 10)) ? parseInt(rawJersey, 10) : null;

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
          photo: p.headshot?.href || getTeamLogo(velezEntry.team),
          pj,
          goals: getStat(['totalGoals', 'G', 'goals']),
          cleanSheets,
          yellowCards: getStat(['yellowCards', 'YC']),
          redCards: getStat(['redCards', 'RC'])
        };
      });
    }

    // --- TABLAS ---
    let standingsClausura = [];
    let standingsAnual = [];

    if (standingsRes.status === 'fulfilled' && standingsRes.value.data) {
      const data = standingsRes.value.data;
      const children = data.children || [];

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

    const payload = {
      velezEspnIdDetectado: velezId,
      currentMatch,
      lastMatches,
      velezLast2,
      rivalLastMatches,
      rivalLast2,
      upcomingMatches,
      squad,
      lastLineup,
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
