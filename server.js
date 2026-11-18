function renderStandingsTable() {
            const thead = document.getElementById('standings-thead');
            const tbody = document.getElementById('standings-tbody');
            const tabBtnTorneo = document.getElementById('tab-TORNEO');
            const tab = STATE.activeTableTab;

            if (tabBtnTorneo) {
                tabBtnTorneo.textContent = `Posiciones ${STATE.activeTournamentName}`;
            }

            const sourceList = tab === 'TORNEO' ? STATE.standingsClausura : STATE.standingsAnual;
            if (!sourceList || sourceList.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-slate-500 text-xs">Sincronizando tabla de posiciones...</td></tr>`;
                return;
            }

            const teams = [...sourceList].sort((a, b) => b.pts - a.pts || b.dg - a.dg || (b.gf || 0) - (a.gf || 0));
            const titleCol = tab === 'TORNEO' ? `Equipo (${STATE.activeTournamentName})` : 'Equipo (Tabla Anual Apertura + Clausura)';
            thead.innerHTML = `<th class="py-2.5 px-3 text-center w-12">#</th><th class="py-2.5 px-3">${titleCol}</th><th class="py-2.5 px-2 text-center font-bold text-white">Pts</th><th class="py-2.5 px-2 text-center">PJ</th><th class="py-2.5 px-2 text-center">PG</th><th class="py-2.5 px-2 text-center">PE</th><th class="py-2.5 px-2 text-center">PP</th><th class="py-2.5 px-3 text-center">DG</th>`;

            // Verificar si ESPN ya asignó notas oficiales de clasificación a Copas en la tabla
            const hasOfficialCupNotes = teams.some(t => t.cupType === 'LIBERTADORES' || t.cupType === 'SUDAMERICANA');

            tbody.innerHTML = teams.map((t, idx) => {
                const pos = idx + 1;
                let rowStyle = 'hover:bg-pizarra-cardHover/60 text-slate-300';
                let posBadge = `<span class="font-mono text-xs text-slate-400">${pos}</span>`;
                let cupTag = '';

                // En Tabla Anual, priorizar las notas reales de ESPN (que incluyen campeones fuera del top 9)
                let effectiveCup = t.cupType;
                if (tab === 'ANUAL' && !hasOfficialCupNotes) {
                    if (pos <= 3) effectiveCup = 'LIBERTADORES';
                    else if (pos <= 9) effectiveCup = 'SUDAMERICANA';
                }

                if (tab === 'ANUAL' || t.cupType) {
                    if (effectiveCup === 'LIBERTADORES') {
                        const labelText = t.cupNote || 'Copa Libertadores';
                        rowStyle = 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-100 border-l-4 border-l-emerald-500';
                        posBadge = `<span class="inline-flex items-center justify-center w-6 h-6 rounded bg-emerald-500 text-slate-950 font-mono font-extrabold text-xs shadow">${pos}</span>`;
                        cupTag = `<span class="ml-auto px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[9px] uppercase tracking-wider hidden sm:inline-block">${labelText}</span>`;
                    } else if (effectiveCup === 'SUDAMERICANA') {
                        const labelText = t.cupNote || 'Copa Sudamericana';
                        rowStyle = 'bg-amber-400/15 hover:bg-amber-400/25 text-amber-100 border-l-4 border-l-amber-400';
                        posBadge = `<span class="inline-flex items-center justify-center w-6 h-6 rounded bg-amber-400 text-slate-950 font-mono font-extrabold text-xs shadow">${pos}</span>`;
                        cupTag = `<span class="ml-auto px-1.5 py-0.5 rounded bg-amber-400/20 border border-amber-400/40 text-amber-300 font-mono text-[9px] uppercase tracking-wider hidden sm:inline-block">${labelText}</span>`;
                    }
                }

                if (t.isVelez) {
                    if ((tab === 'ANUAL' || t.cupType) && effectiveCup === 'LIBERTADORES') {
                        rowStyle = 'bg-emerald-500/30 hover:bg-emerald-500/35 text-white font-bold border-l-4 border-l-emerald-400 ring-1 ring-inset ring-emerald-400/50';
                    } else if ((tab === 'ANUAL' || t.cupType) && effectiveCup === 'SUDAMERICANA') {
                        rowStyle = 'bg-amber-400/30 hover:bg-amber-400/35 text-white font-bold border-l-4 border-l-amber-300 ring-1 ring-inset ring-amber-300/50';
                    } else {
                        rowStyle = 'bg-[#0055a5]/30 font-bold text-white border-l-4 border-l-pizarra-electric';
                        posBadge = `<span class="inline-flex items-center justify-center w-6 h-6 rounded bg-pizarra-accent text-white font-mono font-extrabold text-xs">${pos}</span>`;
                    }
                }

                return `
                    <tr class="${rowStyle} transition-colors">
                        <td class="py-2.5 px-3 text-center">${posBadge}</td>
                        <td class="py-2.5 px-3 flex items-center gap-2.5">
                            ${renderEscudoImg(t.name, 'w-5 h-5 flex-shrink-0', t.logo)}
                            <span class="${t.isVelez ? 'text-white font-bold' : ''}">${t.name}</span>
                            ${cupTag}
                        </td>
                        <td class="py-2.5 px-2 text-center font-mono font-bold text-white bg-white/[0.04]">${t.pts}</td>
                        <td class="py-2.5 px-2 text-center font-mono opacity-85">${t.pj}</td>
                        <td class="py-2.5 px-2 text-center font-mono opacity-85">${t.pg}</td>
                        <td class="py-2.5 px-2 text-center font-mono opacity-85">${t.pe}</td>
                        <td class="py-2.5 px-2 text-center font-mono opacity-85">${t.pp}</td>
                        <td class="py-2.5 px-3 text-center font-mono font-semibold ${t.dg >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${t.dg > 0 ? '+' + t.dg : t.dg}</td>
                    </tr>
                `;
            }).join('');
        }
