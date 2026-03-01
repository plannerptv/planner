// ═══════════════════════════════════════════════════════════════════════════
// STORICO-SCRIPT.JS — Gestione Archivio Storico (GiroVisite_Storico)
// Caricamento lazy: i dati storici vengono scaricati SOLO su richiesta esplicita
// ═══════════════════════════════════════════════════════════════════════════

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { firebaseConfig, ROOT } from '../firebase-config.js';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getDatabase(app);

let cacheP = null;
let cacheC = null;
let recordsCaricati = [];

function dec(val) {
    if (!val) return '';
    if (!val.startsWith || !val.startsWith('U2FsdGVk')) return val;
    try {
        const pw = window.appPassword;
        if (!pw || !window.CryptoJS) return val;
        return window.CryptoJS.AES.decrypt(val, pw).toString(window.CryptoJS.enc.Utf8) || val;
    } catch { return val; }
}

function getNome(pazienteID, pazienti) {
    const p = pazienti.find(px => String(px.id) === String(pazienteID));
    if (!p) return 'ID: ' + pazienteID;
    const nome = dec(p.firstName_enc || p.firstName || p.f || '');
    const cognome = dec(p.lastName_enc || p.lastName || p.l || '');
    return (cognome + ' ' + nome).trim().toUpperCase() || 'ID: ' + pazienteID;
}

function getNomeStanza(stanzaID, categorie) {
    const c = categorie.find(x => String(x.id) === String(stanzaID));
    return c ? c.name : 'Stanza ' + stanzaID;
}

function formatDataIT(iso) {
    if (!iso) return '—';
    const p = iso.split('-');
    return `${p[2]}/${p[1]}/${p[0]}`;
}

let cacheNotes = null;

async function loadLookups() {
    if (cacheP && cacheC) return;
    const [snapP, snapC] = await Promise.all([
        get(ref(db, ROOT + '/pazienti')),
        get(ref(db, ROOT + '/tblCategories'))
    ]);
    const rawP = snapP.val() || {};
    cacheP = Object.entries(rawP).map(([k, v]) => ({ ...v, id: k }));
    const rawC = snapC.val() || {};
    cacheC = Object.entries(rawC).map(([k, v]) => ({ ...v, id: k }));
}

async function loadNotesRange(da, a) {
    // Legge da ENTRAMBI i nodi: storico e vivo (per compatibilità)
    const [snapStorico, snapVivo] = await Promise.all([
        get(ref(db, ROOT + '/dailyNotes_Storico')),
        get(ref(db, ROOT + '/dailyNotes'))
    ]);
    const rawStorico = snapStorico.val() || {};
    const rawVivo = snapVivo.val() || {};
    // Unisce i due nodi, lo storico ha priorità
    const raw = { ...rawVivo, ...rawStorico };
    cacheNotes = {};
    for (const [date, val] of Object.entries(raw)) {
        if (date >= da && date <= a) {
            cacheNotes[date] = dec(val) || '';
        }
    }
}

window.openStoricoModal = async () => {
    const modal = document.getElementById('modalStorico');
    if (!modal) return;
    modal.classList.add('open');

    // Legge soglia da Firebase e mette stessa data su Da e A (default: ultimo giorno dello storico)
    let soglia;
    try {
        const snap = await get(ref(db, ROOT + '/config/archivio'));
        const cfg = snap.val();
        const mesi = (cfg && cfg.mesi) ? cfg.mesi : 3;
        const d = new Date();
        d.setMonth(d.getMonth() - mesi);
        d.setDate(d.getDate() - 1); // ultimo giorno IN storico = soglia - 1
        soglia = d.toISOString().split('T')[0];
    } catch {
        const d = new Date(); d.setMonth(d.getMonth() - 3); d.setDate(d.getDate() - 1);
        soglia = d.toISOString().split('T')[0];
    }

    document.getElementById('storicoDataDa').value = soglia;
    document.getElementById('storicoDataA').value = soglia;
    document.getElementById('storicoCognomeFiltro').value = '';
    document.getElementById('storicoStanzaFiltro').value = '';
    document.getElementById('storicoTable').style.display = 'none';
    document.getElementById('storicoStatus').style.display = 'block';
    document.getElementById('storicoStatus').textContent = 'Seleziona un intervallo di date e clicca Carica per consultare lo storico.';
    recordsCaricati = [];
};

window.chiudiStorico = () => {
    const modal = document.getElementById('modalStorico');
    if (modal) modal.classList.remove('open');
    document.getElementById('storicoTbody').innerHTML = '';
    document.getElementById('storicoTable').style.display = 'none';
    recordsCaricati = [];
};

window.cercaNelloStorico = async () => {
    const da = document.getElementById('storicoDataDa').value;
    const a = document.getElementById('storicoDataA').value;
    const status = document.getElementById('storicoStatus');
    if (!da || !a) { alert('Seleziona entrambe le date!'); return; }
    if (da > a) { alert('La data "Da" deve essere precedente alla data "A"!'); return; }
    status.style.display = 'block';
    status.innerHTML = '⏳ Caricamento dati storici…';
    document.getElementById('storicoTable').style.display = 'none';
    document.getElementById('storicoTbody').innerHTML = '';
    try {
        await loadLookups();
        await loadNotesRange(da, a);
        const snap = await get(ref(db, ROOT + '/GiroVisite_Storico'));
        const raw = snap.val();
        if (!raw) { status.innerHTML = '📭 Nessun dato nello storico.'; return; }
        recordsCaricati = Object.entries(raw)
            .map(([k, v]) => ({ ...v, id: k }))
            .filter(r => r.data && r.data >= da && r.data <= a)
            .sort((x, y) => x.data.localeCompare(y.data));
        if (recordsCaricati.length === 0) {
            status.innerHTML = `📭 Nessun record tra il <strong>${formatDataIT(da)}</strong> e il <strong>${formatDataIT(a)}</strong>.`;
            return;
        }
        // Popola select stanze
        const sel = document.getElementById('storicoStanzaFiltro');
        if (sel) {
            const stanzePresenti = [...new Set(recordsCaricati.map(r => r.stanzaID))];
            sel.innerHTML = '<option value="">— Tutte le stanze —</option>' +
                stanzePresenti.map(id => {
                    const nome = getNomeStanza(id, cacheC);
                    return `<option value="${id}">${nome}</option>`;
                }).join('');
        }
        status.style.display = 'none';
        renderTabella(recordsCaricati);
    } catch (err) {
        console.error('Errore storico:', err);
        status.innerHTML = '❌ Errore: ' + err.message;
    }
};

function applicaFiltri() {
    if (!recordsCaricati.length) return;
    const q = document.getElementById('storicoCognomeFiltro').value.trim().toLowerCase();
    const stanza = document.getElementById('storicoStanzaFiltro').value;
    let filtrati = recordsCaricati;
    if (q) filtrati = filtrati.filter(r => getNome(r.pazienteID, cacheP).toLowerCase().includes(q));
    if (stanza) filtrati = filtrati.filter(r => String(r.stanzaID) === String(stanza));
    renderTabella(filtrati, q);
}
window.filtraStoricoCognome = applicaFiltri;
window.filtraStoricoStanza = applicaFiltri;

function renderTabella(records, filtro = '') {
    const tbl = document.getElementById('storicoTable');
    const tbody = document.getElementById('storicoTbody');
    const status = document.getElementById('storicoStatus');
    const counter = document.getElementById('storicoCounter');

    if (records.length === 0) {
        tbl.style.display = 'none';
        status.style.display = 'block';
        status.innerHTML = filtro ? `📭 Nessun risultato per "<strong>${filtro}</strong>".` : '📭 Nessun record trovato.';
        if (counter) counter.textContent = '';
        return;
    }

    // Raggruppa per data
    const perGiorno = {};
    for (const r of records) {
        if (!perGiorno[r.data]) perGiorno[r.data] = [];
        perGiorno[r.data].push(r);
    }

    let html = '';
    let rigaIdx = 0;
    for (const data of Object.keys(perGiorno).sort()) {
        const nota = (cacheNotes && cacheNotes[data]) ? cacheNotes[data] : '';
        // Riga separatore giornaliera
        html += `<tr>
            <td colspan="5" style="
                padding: 8px 12px;
                background: linear-gradient(90deg, #0e7490 0%, #0891b2 60%, #e0f2fe 100%);
                border-left: 5px solid #0e7490;
                border-top: 2px solid #0891b2;
            ">
                <span style="color:white; font-weight:700; font-size:13px; margin-right:16px;">
                    📅 ${formatDataIT(data)}
                </span>
                <span style="color:#e0f2fe; font-size:12px; font-style:italic;">
                    ${nota ? '📝 ' + nota : ''}
                </span>
            </td>
        </tr>`;

        // Righe appuntamenti del giorno
        for (const r of perGiorno[data]) {
            const nome = getNome(r.pazienteID, cacheP);
            const stanza = getNomeStanza(r.stanzaID, cacheC);
            const orario = r.startTime ? `${r.startTime}${r.endTime ? ' → ' + r.endTime : ''}` : (r.oraInizio || '—');
            const noteAppt = dec(r.pazienteNote) || '—';
            const bg = rigaIdx % 2 === 0 ? '#f8fafc' : '#ffffff';
            rigaIdx++;
            html += `<tr style="border-bottom:1px solid #e2e8f0; background:${bg};">
                <td style="padding:7px 8px; white-space:nowrap; color:#64748b; font-size:12px;">${formatDataIT(r.data)}</td>
                <td style="padding:7px 8px; font-weight:600;">${nome}</td>
                <td style="padding:7px 8px;">${stanza}</td>
                <td style="padding:7px 8px; white-space:nowrap; color:#0e7490;">${orario}</td>
                <td style="padding:7px 8px; color:#64748b; font-size:12px;">${noteAppt}</td>
            </tr>`;
        }
    }

    tbody.innerHTML = html;
    status.style.display = 'none';
    tbl.style.display = 'table';
    if (counter) counter.textContent = `${records.length} record${filtro ? ' (filtrati)' : ''}`;
}
