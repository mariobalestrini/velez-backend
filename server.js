// --- PRÓXIMO PARTIDO, MARCADOR EN VIVO Y GOLEADORES MINUTO A MINUTO ---
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

      // Extraer goleadores y minutos (si está en vivo o recién terminado)
      const scorers = { home: [], away: [] };
      let rawDetails = comp.details || [];

      // Si está en vivo y el evento base no trajo el detalle de goles, consultamos el summary en vivo
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
