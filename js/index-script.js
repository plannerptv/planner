import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, remove, onValue, query, orderByKey, orderByChild, equalTo, startAt, endAt, get, push, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
// QUESTA È LA RIGA DA AGGIUNGERE:
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { firebaseConfig, ROOT } from '../firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app); // Ora funzionerà correttamente
// Verifica dipendenze crittografia all'avvio
if (!window.appPassword || !window.CryptoJS) {
    console.error('❌ Password o CryptoJS mancanti all\'avvio del modulo');
}

function encryptText(plaintext) {
    if (!plaintext) return plaintext;
    if (!window.appPassword) {
        console.error('❌ encryptText: Password non disponibile!');
        return plaintext;
    }
    try {
        const result = window.CryptoJS.AES.encrypt(plaintext, window.appPassword).toString();
        // Log solo in caso di debug - commentato per non intasare
        // console.log(`🔐 Criptato: "${plaintext}" → "${result.substring(0, 20)}..."`);
        return result;
    } catch (e) {
        console.error('❌ Encrypt error:', e);
        return plaintext;
    }
}

function decryptText(encrypted) {
    if (!encrypted) return encrypted;
    
    // Se il testo NON inizia con "U2FsdGVk" NON è criptato → ritorna così com'è
    if (typeof encrypted === 'string' && !encrypted.startsWith('U2FsdGVk')) {
        return encrypted;
    }
    
    if (!window.appPassword) {
        console.error('❌ decryptText: Password non disponibile!');
        return encrypted;
    }
    
    try {
        const bytes = window.CryptoJS.AES.decrypt(encrypted, window.appPassword);
        const decrypted = bytes.toString(window.CryptoJS.enc.Utf8);
        if (!decrypted) return encrypted;
        return decrypted;
    } catch (e) {
        console.error('❌ Decrypt error:', e);
        return encrypted;
    }
}

// Template hardcoded rimossi — tutte le stanze usano regole da Firebase.
// Se una stanza/giorno non ha regola, viene mostrato "Stanza non configurata".

// ===================== STATO =====================
let currentDate = new Date();
let dbState = { Categorie: [], GiroVisite: [], RegoleAttive: {}, Pazienti: [] };
let activeCatId = null, activeCatName = null;
let editingRuleId = null; // Tiene traccia della regola in modifica
let activeSlots = [], editingIdx = null, selectedDates = new Set();
let selectedRooms = [];   // filtro: id stanze visibili (vuoto = tutte)
let lastAction = null;    // ultimo oggetto per undo
let currentSlot = null;    // {catId, rowNo, label, tpl} per nuovo appt
let currentAppt = null;    // appuntamento in modifica
let movingAppt = null;     // appuntamento in spostamento
let selectedPazId = null;  // paziente selezionato nel popup (attende conferma)
let draggedId = null;      // id appt trascinato (drag&drop)
let _giroUnsub = null;     // cleanup listener GiroVisite
let _catUnsub = null;      // cleanup listener Categorie
let _regoleUnsub = null;   // cleanup listener RegoleAttive
let _pazientiUnsub = null; // cleanup listener Pazienti
let _roomOrderUnsub = null; // cleanup listener roomOrder
let _listenersActive = false; // flag: listener attivi?

// Colore di una stanza dato l'id — legge sempre dal db
function getColor(id) { const c = dbState.Categorie.find(x => String(x.id) === String(id)); return (c && c.color) || '#64748b'; }

// Helper: decripta nome/cognome da un record paziente
function getDecryptedNames(p) {
    let firstName = p.firstName || p.f || '';
    let lastName = p.lastName || p.l || '';
    if (p.firstName_enc) firstName = decryptText(p.firstName_enc);
    if (p.lastName_enc) lastName = decryptText(p.lastName_enc);
    return { firstName, lastName };
}

function getPatientName(id) {
    const p = dbState.Pazienti.find(px => String(px.id) === String(id));
    if (!p) return 'ID: ' + id;
    const { firstName, lastName } = getDecryptedNames(p);
    return (lastName + ' ' + firstName).toUpperCase().trim();
}

// Helper: formatta data di nascita (gestisce numeri seriali Excel legacy e YYYY-MM-DD)
function formatDob(dob) {
    if (!dob) return '';
    // Numero seriale Excel
    if (!isNaN(dob) && Number(dob) > 1000) {
        const excelEpoch = new Date(1899, 11, 30);
        const dateObj = new Date(excelEpoch.getTime() + Number(dob) * 86400000);
        return dateObj.toLocaleDateString('it-IT');
    }
    // YYYY-MM-DD → DD/MM/YYYY
    if (typeof dob === 'string' && dob.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const parts = dob.split('-');
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dob; // Già DD/MM/YYYY o altro
}

async function saveDailyNote() {
    const el = document.getElementById('dailyNoteText');
    const iso = currentDate.toLocaleDateString('sv-SE');
    const rawContent = el.innerHTML || null;

    // Se vuoto, cancella
    if (!rawContent || rawContent === '<br>') {
        await set(ref(db, ROOT + '/dailyNotes/' + iso), null);
        return;
    }
    // Cripta prima di salvare su Firebase
    const encrypted = encryptText(rawContent);
    await set(ref(db, ROOT + '/dailyNotes/' + iso), encrypted);
}
async function undoAction() {
    if (!lastAction) { showToast("Nessuna azione da annullare"); return; }
    try {
        if (lastAction.type === 'insert') await remove(ref(db, ROOT + '/GiroVisite/' + lastAction.id));
        else if (lastAction.type === 'delete') await set(ref(db, ROOT + '/GiroVisite/' + lastAction.id), lastAction.data);
        else if (lastAction.type === 'move') await update(ref(db, ROOT + '/GiroVisite/' + lastAction.id), lastAction.prev);
        lastAction = null;
        document.getElementById('undoBtn').disabled = true;
        showToast("↩️ Annullato", "success");
    } catch (e) { showToast("Errore undo: " + e.message, "error"); }
}

function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.className = 'toast ' + type; t.textContent = msg;
    t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500);
}

// ===================== FIREBASE =====================
let roomOrder = []; // Ordine stanze globale

// roomOrder listener viene inizializzato insieme agli altri in initializeFirebaseListeners()

// I listener Firebase vengono inizializzati DOPO l'autenticazione (vedi fine file)
function initializeFirebaseListeners() {
    if (_listenersActive) return; // Evita doppia sottoscrizione
    _listenersActive = true;
    console.log('🔌 Listener Firebase ATTIVATI');

    _roomOrderUnsub = onValue(ref(db, ROOT + '/config/roomOrder'), snap => {
        roomOrder = snap.val() || [];
        render();
    });

    _catUnsub = onValue(ref(db, ROOT + '/tblCategories'), snap => {
        const raw = snap.val();
        if (!raw) {
            dbState.Categorie = [];
            render();
            return;
        }
        // Converte oggetto Firebase in array, mantenendo tutte le proprietà
        dbState.Categorie = Object.entries(raw).map(([key, value]) => ({
            id: key,
            name: value.name || '',
            color: value.color || '#3b82f6'
        })).filter(c => c.name); // Filtra solo stanze con nome
        render();
    });
    _regoleUnsub = onValue(ref(db, ROOT + '/RegoleAttive'), snap => {
        dbState.RegoleAttive = snap.val() || {};
        render();

        // Se l'AUDIT è aperto, ri-renderizza
        const auditModal = document.getElementById('modalAudit');
        if (auditModal && auditModal.classList.contains('open')) {
            renderAuditGallery();
        }
    });
    _pazientiUnsub = onValue(ref(db, ROOT + '/pazienti'), snap => {
        const raw = snap.val();
        dbState.Pazienti = raw ? Object.entries(raw).map(([id, v]) => ({ ...v, id })) : [];
    });
}

// Stacca TUTTI i listener Firebase (per visibilitychange)
function detachFirebaseListeners() {
    if (!_listenersActive) return;
    _listenersActive = false;
    console.log('🔌 Listener Firebase DISATTIVATI (tab in background)');
    if (_roomOrderUnsub) { _roomOrderUnsub(); _roomOrderUnsub = null; }
    if (_catUnsub) { _catUnsub(); _catUnsub = null; }
    if (_regoleUnsub) { _regoleUnsub(); _regoleUnsub = null; }
    if (_pazientiUnsub) { _pazientiUnsub(); _pazientiUnsub = null; }
    if (_giroUnsub) { _giroUnsub(); _giroUnsub = null; }
}

// Riattacca tutti i listener (quando il tab torna visibile)
function reattachFirebaseListeners() {
    if (_listenersActive) return;
    console.log('🔌 Riattivazione listener Firebase (tab visibile)');
    initializeFirebaseListeners();
    fetchGiroVisite();
}
function fetchGiroVisite() {
    const iso = currentDate.toLocaleDateString('sv-SE');
    document.getElementById('datePicker').value = iso;
    if (_giroUnsub) { _giroUnsub(); _giroUnsub = null; }

    // Query filtrata: scarica SOLO gli appuntamenti della data corrente
    // Usa orderByChild('data') + equalTo per filtrare lato server
    // NOTA: richiede indice su "data" nelle regole Firebase (vedi sotto)
    const giroQuery = query(ref(db, ROOT + '/GiroVisite'), orderByChild('data'), equalTo(iso));

    _giroUnsub = onValue(giroQuery, snap => {
        const raw = snap.val();
        if (!raw) { dbState.GiroVisite = []; render(); return; }
        const filtered = Object.entries(raw).map(([id, v]) => ({ ...v, id }));

        // Mantieni anche l'appuntamento in spostamento se ha data diversa
        if (movingAppt && !filtered.find(v => v.id === movingAppt.id)) {
            filtered.push(movingAppt); // Usa la copia locale già in memoria
        }

        dbState.GiroVisite = filtered;
        render();
    });
}

// ===================== REGOLE =====================
// Helper: calcola se una data corrisponde a una specifica occorrenza mensile
function matchesMonthlyOccurrence(date, weekdays, occurrences) {
    const wd = date.getDay() === 0 ? 7 : date.getDay();
    
    // Controlla se il giorno della settimana corrisponde
    if (!weekdays.includes(wd)) return false;
    
    // Calcola quale occorrenza è questo giorno nel mese
    const year = date.getFullYear();
    const month = date.getMonth();
    const dayOfMonth = date.getDate();
    
    // Conta quante volte questo giorno della settimana appare nel mese fino a questa data
    let count = 0;
    for (let d = 1; d <= dayOfMonth; d++) {
        const testDate = new Date(year, month, d);
        const testWd = testDate.getDay() === 0 ? 7 : testDate.getDay();
        if (testWd === wd) count++;
    }
    
    // Se è richiesto "ultimo", verifica se è l'ultimo di quel giorno nel mese
    if (occurrences.includes(-1)) {
        // Conta quanti giorni di questo tipo ci sono DOPO questa data nel mese
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        let hasMore = false;
        for (let d = dayOfMonth + 1; d <= daysInMonth; d++) {
            const testDate = new Date(year, month, d);
            const testWd = testDate.getDay() === 0 ? 7 : testDate.getDay();
            if (testWd === wd) {
                hasMore = true;
                break;
            }
        }
        if (!hasMore) return true; // È l'ultimo!
    }
    
    // Controlla se l'occorrenza corrente è nella lista richiesta
    return occurrences.includes(count);
}

// Helper: calcola se una data rientra nella settimana "attiva" di una regola bisettimanale
function matchesBiweekly(date, weekdays, anchorDate) {
    const wd = date.getDay() === 0 ? 7 : date.getDay();
    
    // Controlla se il giorno della settimana corrisponde
    if (!weekdays.includes(wd)) return false;
    
    // Calcola il numero di settimana ISO dalla data di ancoraggio
    // L'anchor è la settimana "SÌ" (settimana 0), poi alterna: 0=sì, 1=no, 2=sì, 3=no...
    const anchor = new Date(anchorDate);
    anchor.setHours(0, 0, 0, 0);
    const target = new Date(date);
    target.setHours(0, 0, 0, 0);
    
    // Porta entrambe al lunedì della loro settimana
    const anchorDay = anchor.getDay() === 0 ? 7 : anchor.getDay();
    const anchorMonday = new Date(anchor);
    anchorMonday.setDate(anchor.getDate() - (anchorDay - 1));
    
    const targetDay = target.getDay() === 0 ? 7 : target.getDay();
    const targetMonday = new Date(target);
    targetMonday.setDate(target.getDate() - (targetDay - 1));
    
    // Differenza in settimane
    const diffMs = targetMonday.getTime() - anchorMonday.getTime();
    const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
    
    // Settimane pari (0, 2, 4...) = attiva, dispari (1, 3, 5...) = non attiva
    // Usiamo modulo per gestire sia date future che passate
    return ((diffWeeks % 2) + 2) % 2 === 0;
}

function findRegolaPer(catId, date) {
    const iso = date.toLocaleDateString('sv-SE');
    const wd = date.getDay() === 0 ? 7 : date.getDay();
    let best = null, bestP = -1, bestDate = null;
    
    for (const [id, r] of Object.entries(dbState.RegoleAttive)) {
        if (String(r.catId) !== String(catId)) continue;
        if (r.validaDa && iso < r.validaDa) continue;
        if (r.validaA && iso > r.validaA) continue;
        let match = false, p = 0;
        if (r.freq === 'once' && r.dataSpecifica === iso) { match = true; p = 3; }
        if (r.freq === 'monthly_specific' && r.monthlyWeekdays && r.monthlyOccurrences) {
            match = matchesMonthlyOccurrence(date, r.monthlyWeekdays, r.monthlyOccurrences);
            p = 2;
        }
        if (r.freq === 'monthly' && r.date && r.date.includes(iso)) { match = true; p = 2; }
        if (r.freq === 'weekly' && r.giorni && r.giorni.includes(wd)) { match = true; p = 1; }
        if (r.freq === 'biweekly' && r.biweeklyWeekdays && r.biweeklyAnchor) {
            match = matchesBiweekly(date, r.biweeklyWeekdays, r.biweeklyAnchor);
            p = 1.5; // Priorità tra weekly e monthly
        }

        if (match) {
            // Se priorità maggiore, prendi questa
            if (p > bestP) {
                bestP = p;
                best = r;
                bestDate = new Date(r.createdAt || 0);
            }
            // Se stessa priorità, prendi la PIÙ RECENTE
            else if (p === bestP) {
                const rDate = new Date(r.createdAt || 0);
                if (rDate > bestDate) {
                    best = r;
                    bestDate = rDate;
                }
            }
        }
    }
    
    return best;
}
function getTemplate(catId, date) {
    const reg = findRegolaPer(catId, date);
    if (reg) {
        const sortedSlots = [...reg.slots];
        sortSlots(sortedSlots);
        return { slots: sortedSlots, nome: reg.nomeStanza };
    }
    // Nessuna regola trovata per questa stanza/giorno
    return { slots: [], nome: null };
}

// ===================== RENDER =====================
function render() {
    const iso = currentDate.toLocaleDateString('sv-SE');
    
    document.getElementById('datePicker').value = iso;
    document.getElementById('displayDate').innerText = currentDate.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();

    // Mostra barra spostamento con messaggio appropriato
    const moveBar = document.getElementById('moveBar');
    if (movingAppt) {
        if (conflictData && conflictData.appointments && conflictData.appointments.length > 0) {
            // Modalità conflict manager
            moveBar.innerHTML = `⚠️ GESTIONE CONFLITTI (${conflictData.appointments.length} rimanenti) — Clicca uno slot vuoto per spostare | <span style="cursor:pointer; text-decoration:underline;" onclick="backToConflictModal()">TORNA ALLA LISTA</span>`;
        } else {
            // Modalità spostamento normale
            moveBar.innerHTML = `⚠️ SPOSTAMENTO ATTIVO — clicca uno slot vuoto per spostare | ESC per annullare`;
        }
        moveBar.style.display = 'block';
    } else {
        moveBar.style.display = 'none';
    }

    document.getElementById('undoBtn').disabled = !lastAction;

    // FILTRO STANZE RIMOSSO - tutte le stanze sono sempre visibili nel layout a griglia

    // Griglia
    const grid = document.getElementById('calendarGrid'); grid.innerHTML = '';
    const cats = dbState.Categorie;  // Mostra sempre TUTTE le stanze

    // LAYOUT A GRIGLIA: 6 colonne con stanze impilate
    const colonneLayout = [
        [5],      // COL 1: PRELIEVI + box comunicazioni sotto
        [7, 6],   // COL 2: INFUSIONI LONGACTING, INFUSIONI
        [9, 8],   // COL 3: RITIRO TERAPIA, MEDICAZIONI
        [3, 11],  // COL 4: ROSSO, ROSA
        [2, 4],   // COL 5: VERDE, GIALLO
        [1, 10]   // COL 6: BLU, RICOVERI DAY HOSPITAL
    ];

    // Crea le 6 colonne
    colonneLayout.forEach((idsColonna, colIndex) => {
        const colonnaWrapper = document.createElement('div');
        colonnaWrapper.className = 'grid-column-wrapper';
        
        idsColonna.forEach(catId => {
            const cat = cats.find(c => String(c.id) === String(catId));
            if (!cat) return; // Stanza non trovata, skip
            
            const { slots: tpl, nome: nomeOvr } = getTemplate(cat.id, currentDate);
            const name = nomeOvr || cat.name, color = getColor(cat.id);

            const col = document.createElement('div'); col.className = 'room-column';
            col.setAttribute('data-cat-id', cat.id);
            const hdr = document.createElement('div'); hdr.className = 'column-header'; hdr.style.background = color;
            hdr.textContent = name;
            hdr.onclick = () => openModalRule(cat.id, cat.name);
            col.appendChild(hdr);

            // Se non ha template, mostra messaggio per configurare
            if (!tpl || !tpl.length) {
                const scrollArea = document.createElement('div');
                scrollArea.className = 'scroll-area';
                scrollArea.innerHTML = `
            <div style="padding:40px 20px; text-align:center; color:#94a3b8;">
                <div style="font-size:40px; margin-bottom:10px;">⚙️</div>
                <div style="font-size:13px; font-weight:bold; margin-bottom:8px;">Stanza non configurata</div>
                <div style="font-size:11px; line-height:1.5;">Clicca sull'intestazione<br>per configurare gli orari</div>
            </div>
        `;
                col.appendChild(scrollArea);
                colonnaWrapper.appendChild(col);
                return;
            }

            const scroll = document.createElement('div'); scroll.className = 'scroll-area';

            // Traccia ultima fascia vista per mostrare ora solo sul primo slot del gruppo
            let lastFascia = null;

            tpl.forEach((def, idx) => {
                const rowNo = idx + 1;

            // NUOVO: Cerca per oraInizio (robusto)
            const oraInizio = def.ora ? (def.ora.includes(' - ') ? def.ora.split(' - ')[0] : def.ora) : null;
            let appt = null;

            // ═══════════════════════════════════════════════════════════
            // FIX CRITICO: Cerca PRIMA per rowNo (più affidabile)
            // Poi usa oraInizio solo come fallback per appuntamenti legacy
            // ═══════════════════════════════════════════════════════════
            
            // Per fasce orarie, cerca SOLO per rowNo
            if (def.fasciaOraria) {
                appt = dbState.GiroVisite.find(v =>
                    v.data === iso &&
                    String(v.stanzaID) === String(cat.id) &&
                    String(v.rowNo) === String(rowNo)
                );
            }
            // Per slot normali: PRIMA cerca per rowNo (match esatto)
            else {
                appt = dbState.GiroVisite.find(v =>
                    v.data === iso &&
                    String(v.stanzaID) === String(cat.id) &&
                    String(v.rowNo) === String(rowNo)
                );
                
                // FALLBACK: Se non trova per rowNo E c'è un orario definito,
                // cerca per oraInizio (per retrocompatibilità con dati vecchi)
                if (!appt && oraInizio) {
                    appt = dbState.GiroVisite.find(v => {
                        if (v.data !== iso || String(v.stanzaID) !== String(cat.id)) return false;
                        if (!v.oraInizio) return false;
                        // Estrai solo l'ora di inizio
                        const apptStart = v.oraInizio.includes(' - ') ? v.oraInizio.split(' - ')[0].trim() : v.oraInizio.trim();
                        // Verifica che NON abbia già un rowNo assegnato (altrimenti sarebbe stato trovato prima)
                        if (v.rowNo) return false;
                        return apptStart === oraInizio.trim();
                    });
                }
            }

            // Se c'è un appuntamento in modalità spostamento, mostralo
            if (!appt && movingAppt && String(movingAppt.stanzaID) === String(cat.id)) {
                // Per fasce orarie, usa SOLO rowNo (più specifico)
                if (def.fasciaOraria) {
                    if (String(movingAppt.rowNo) === String(rowNo)) {
                        appt = movingAppt;
                    }
                }
                // Per slot normali, controlla sia oraInizio che rowNo
                else {
                    if ((oraInizio && movingAppt.oraInizio === oraInizio) ||
                        (String(movingAppt.rowNo) === String(rowNo))) {
                        appt = movingAppt;
                    }
                }
            }

            // Determina se è il primo slot di una nuova fascia
            const isPrimoSlotFascia = def.fasciaOraria && def.ora !== lastFascia;
            if (def.fasciaOraria) {
                lastFascia = def.ora;
            } else {
                lastFascia = null;
            }

            const cell = document.createElement('div'); cell.className = 'time-cell';
            if (def.fasciaOraria) cell.classList.add('fascia-slot');
            if (isPrimoSlotFascia) cell.classList.add('primo-fascia'); // Bordo più spesso per separare

            // 1. GESTIONE APPUNTAMENTI SPECIALI (PAUSA / BLOCCATO / UNLOCK)
            if (appt && appt.pazienteID === 'UNLOCK') {
                // UNLOCK = slot da regola sbloccato per questo giorno → mostra come VISITA vuota
                cell.style.borderLeftColor = color;
                const oraText = def.ora || '';
                cell.classList.add('vuoto');
                // Mostra tag con l'etichetta originale della pausa
                let unlockHTML = '<div class="ora">' + oraText + '</div>';
                if (appt.pazienteNome && appt.pazienteNome !== 'SBLOCCATO') {
                    unlockHTML += '<div style="font-size:8px; font-weight:800; color:#92400e; background:#fef3c7; padding:1px 4px; border-radius:3px; margin-bottom:1px; display:inline-block;">' + appt.pazienteNome + '</div>';
                }
                cell.innerHTML = unlockHTML;

                // Click → prenota
                cell.onclick = () => {
                    if (movingAppt) finalizzaSposta(cat.id, rowNo);
                    else apriNuovo(cat.id, rowNo, oraText, tpl, def.ora);
                };
                // Drag&drop target
                cell.ondragover = (e) => { e.preventDefault(); cell.classList.add('drop-target'); };
                cell.ondragleave = () => { cell.classList.remove('drop-target'); };
                cell.ondrop = async (e) => {
                    e.preventDefault(); cell.classList.remove('drop-target');
                    if (draggedId) { await finalizzaSpostaSpecifico(draggedId, cat.id, rowNo, currentDate.toLocaleDateString('sv-SE')); draggedId = null; }
                };
                // Tasto destro per ri-bloccare
                cell.oncontextmenu = (e) => {
                    e.preventDefault();
                    showCustomContextMenu(e.clientX, e.clientY, cat.id, rowNo, appt.id);
                };
            }
            else if (appt && (appt.pazienteID === 'PAUSA' || appt.pazienteID === 'BLOCCATO')) {
                if (appt.pazienteID === 'PAUSA') {
                    cell.classList.add('appt-pausa');
                    cell.innerHTML = `<span class="ora">${def.ora || ''}</span><span style="font-size:10px;font-weight:600;">☕ ${appt.pazienteNome || 'PAUSA'}</span>`;
                } else {
                    cell.classList.add('appt-bloccato');
                    cell.innerHTML = `<span class="ora">${def.ora || ''}</span><span style="font-size:10px;font-weight:600;">🚫 ${appt.pazienteNome || 'BLOCCATO'}</span>`;
                }

                // Tasto destro UNIFICATO
                cell.oncontextmenu = (e) => {
                    e.preventDefault();
                    showCustomContextMenu(e.clientX, e.clientY, cat.id, rowNo, appt.id);
                };
            }
            // 2. GESTIONE SLOT REGOLA (Se la regola stessa dice Pausa/Blocco)
            // Se c'è un appuntamento reale (paziente), va alla sezione 3
            else if (def.tipo === 'PAUSA' && !appt) {
                cell.classList.add('tipo-pausa');
                // Se label è vuota = separatore vuoto (no testo, no orario)
                const testoDisplay = def.label ? '☕ ' + def.label : '';
                const oraDisplay = def.label ? (def.fasciaOraria ? '' : (def.ora || '')) : '';
                if (testoDisplay || oraDisplay) {
                    cell.innerHTML = '<div class="ora">' + oraDisplay + '</div><span style="font-size:11px;font-weight:800;">' + testoDisplay + '</span>';
                } else {
                    // Separatore vuoto - solo spazio colorato
                    cell.innerHTML = '<div style="height:28px;"></div>';
                }

                cell.oncontextmenu = (e) => {
                    e.preventDefault();
                    showCustomContextMenu(e.clientX, e.clientY, cat.id, rowNo, null);
                };
            } else if (def.tipo === 'BLOCCATO' && !appt) {
                cell.classList.add('tipo-bloccato');
                // Se label è vuota = separatore vuoto
                const testoDisplay = def.label ? '🚫 ' + def.label : '';
                const oraDisplay = def.label ? (def.fasciaOraria ? '' : (def.ora || '')) : '';
                if (testoDisplay || oraDisplay) {
                    cell.innerHTML = '<div class="ora">' + oraDisplay + '</div><span style="font-size:11px;font-weight:700;">' + testoDisplay + '</span>';
                } else {
                    cell.innerHTML = '<div style="height:28px;"></div>';
                }

                cell.oncontextmenu = (e) => {
                    e.preventDefault();
                    showCustomContextMenu(e.clientX, e.clientY, cat.id, rowNo, null);
                };
            }
            // 3. GESTIONE SLOT VUOTO o CON PAZIENTE
            else {
                cell.style.borderLeftColor = color;
                // Per fascia oraria: mostra solo l'ora ripetuta
                let oraText;
                if (def.fasciaOraria) {
                    oraText = def.ora || '';  // Solo l'ora (es. 8:00-9:00)
                } else {
                    oraText = def.ora || '';  // Solo ora, non SLOT N
                }

                // Drag&drop target
                cell.ondragover = (e) => { e.preventDefault(); cell.classList.add('drop-target'); };
                cell.ondragleave = () => { cell.classList.remove('drop-target'); };
                cell.ondrop = async (e) => {
                    e.preventDefault(); cell.classList.remove('drop-target');
                    if (draggedId) { await finalizzaSpostaSpecifico(draggedId, cat.id, rowNo, currentDate.toLocaleDateString('sv-SE')); draggedId = null; }
                };

                if (appt) {
                    // Cella con paziente - colora con colore stanza (trasparente)
                    cell.style.background = color + '15';  // Aggiungi trasparenza (15 = ~8%)
                    cell.innerHTML = '<div class="ora">' + oraText + '</div>';
                    const card = document.createElement('div');
                    card.className = 'patient-card';
                    // Se questo è l'appuntamento in spostamento, aggiungi classe speciale
                    if (movingAppt && movingAppt.id === appt.id) {
                        card.classList.add('moving-appt');
                    }
                    card.style.borderLeftColor = color;
                    const nome = getPatientName(appt.pazienteID);

                    let cardHTML = '';
                    if (appt.pazienteNote) {
                        cardHTML += `<span class="cloud-wrapper" onmouseenter="positionNotePopup(event, this)" onmousemove="positionNotePopup(event, this)">💭<div class="custom-note-popup">${appt.pazienteNote}</div></span> `;
                    }
                    cardHTML += nome;
                    card.innerHTML = cardHTML;
                    // NESSUN TOOLTIP - il nome è già visibile nella card
                    card.draggable = true;
                    card.ondragstart = (e) => { draggedId = appt.id; e.dataTransfer.effectAllowed = 'move'; };
                    card.onclick = (e) => {
                        e.stopPropagation();
                        if (movingAppt) finalizzaSposta(cat.id, rowNo);
                        else apriModifica(appt);
                    };
                    cell.appendChild(card);
                } else {
                    // Cella vuota
                    cell.classList.add('vuoto');
                    cell.innerHTML = '<div class="ora">' + oraText + '</div>';

                    // Click sinistro: Nuovo appuntamento
                    cell.onclick = () => {
                        if (movingAppt) finalizzaSposta(cat.id, rowNo);
                        else apriNuovo(cat.id, rowNo, oraText, tpl, def.ora); // <--- FIX: Passo def.ora
                    };

                    // Click destro: Menu UNIFICATO
                    cell.oncontextmenu = (e) => {
                        console.log('TASTO DESTRO - catId:', cat.id, 'rowNo:', rowNo, 'def.ora:', def.ora);
                        e.preventDefault();
                        showCustomContextMenu(e.clientX, e.clientY, cat.id, rowNo, null);
                    };
                }
            }
            scroll.appendChild(cell);
        });
        col.appendChild(scroll);
        colonnaWrapper.appendChild(col);
        
        }); // Fine forEach stanze nella colonna
        
        // Se è la prima colonna (PRELIEVI), aggiungi box comunicazioni sotto
        if (colIndex === 0) {
            const commBox = document.createElement('div');
            commBox.className = 'comunicazioni-box';
            commBox.innerHTML = `
                <div style="background: #475569; color: white; padding: 8px; font-weight: bold; font-size: 11px; border-radius: 8px 8px 0 0;">
                    📝 COMUNICAZIONI INTERNE
                </div>
                <div id="dailyNoteText" contenteditable="true" placeholder="Note del giorno..." 
                    style="width: 100%; height: 100%; border: none; padding: 12px; overflow-y: auto; font-family: inherit; font-size: 13px; box-sizing: border-box; border-radius: 0 0 8px 8px; background: white; outline: none;"
                    onblur="saveDailyNote()"></div>
            `;
            colonnaWrapper.appendChild(commBox);
        }
        
        grid.appendChild(colonnaWrapper);
        
        // Carica note DOPO aver aggiunto al DOM
        if (colIndex === 0) {
            const noteText = document.getElementById('dailyNoteText');
            const noteKey = currentDate.toLocaleDateString('sv-SE');
            if (noteText) {
                onValue(ref(db, ROOT + '/dailyNotes/' + noteKey), snap => {
                    const raw = snap.val();
                    if (!raw) {
                        noteText.innerHTML = '';
                    } else {
                        // Decripta se criptata, altrimenti usa il valore diretto (legacy in chiaro)
                        noteText.innerHTML = decryptText(raw);
                    }
                }, { onlyOnce: true });
                
                let saveTimeout;
                noteText.addEventListener('input', () => {
                    clearTimeout(saveTimeout);
                    saveTimeout = setTimeout(() => {
                        const content = noteText.innerHTML || null;
                        if (!content || content === '<br>') {
                            set(ref(db, ROOT + '/dailyNotes/' + noteKey), null);
                        } else {
                            set(ref(db, ROOT + '/dailyNotes/' + noteKey), encryptText(content));
                        }
                    }, 1000);
                });
            }
        }
    }); // Fine forEach colonne
}

// ===================== CUSTOM CONTEXT MENU (UNIFICATO) =====================
window.showCustomContextMenu = function (x, y, catId, rowNo, apptId) {
    const menu = document.getElementById('customContextMenu');
    menu.style.display = 'block';
    // Posiziona vicino al mouse ma non fuori schermo
    if (y + menu.offsetHeight > window.innerHeight) y -= menu.offsetHeight;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Salviamo i dati per l'azione
    window.contextSlot = { catId, rowNo, apptId };
};

window.closeContextMenu = function () {
    document.getElementById('customContextMenu').style.display = 'none';
    window.contextSlot = null;
};

window.applyQuickAction = async function (type) {
    if (!window.contextSlot) return;
    const { catId, rowNo, apptId } = window.contextSlot;

    // AZIONE SBLOCCA (Cancella appuntamento speciale o sblocca slot da regola)
    if (type === 'UNLOCK') {
        if (apptId) {
            // Slot bloccato manualmente (da GiroVisite) → cancella il record
            if (confirm("Sbloccare questo slot?")) {
                try {
                    await remove(ref(db, ROOT + '/GiroVisite/' + apptId));
                    showToast("✅ Slot sbloccato");
                } catch (e) { showToast("Errore: " + e.message, "error"); }
            }
        } else {
            // Slot PAUSA/BLOCCATO da regola → crea record UNLOCK per sovrascrivere per questo giorno
            const iso = currentDate.toLocaleDateString('sv-SE');
            const tpl = getTemplate(catId, currentDate);
            const slotDef = tpl.slots && tpl.slots[rowNo - 1];
            if (slotDef && (slotDef.tipo === 'PAUSA' || slotDef.tipo === 'BLOCCATO')) {
                try {
                    const newRef = push(ref(db, ROOT + '/GiroVisite'));
                    await set(newRef, {
                        data: iso,
                        stanzaID: catId,
                        rowNo: rowNo,
                        oraInizio: slotDef.ora ? (slotDef.ora.includes(' - ') ? slotDef.ora.split(' - ')[0].trim() : slotDef.ora.trim()) : null,
                        pazienteID: 'UNLOCK',
                        pazienteNome: slotDef.label || 'SBLOCCATO',
                        pazienteNote: null
                    });
                    showToast("✅ Slot sbloccato per oggi — ora puoi prenotare");
                } catch (e) { showToast("Errore: " + e.message, "error"); }
            } else {
                showToast("Questo slot non è bloccato dalla regola", "warning");
            }
        }
    }
    // AZIONE PAUSA / BLOCCA (Crea appuntamento speciale)
    else {
        const iso = currentDate.toLocaleDateString('sv-SE');
        console.log('BLOCCA/PAUSA - catId:', catId, 'rowNo:', rowNo, 'type:', type);
        try {
            // Se c'era già qualcosa (es. passo da Pausa a Bloccato), lo sovrascrivo?
            // Firebase push crea sempre un nuovo ID. Meglio pulire prima se c'era un ID vecchio?
            // Per semplicità qui creiamo un nuovo record. Se c'è sovrapposizione, l'ultimo vince.
            // (In un sistema perfetto dovremmo aggiornare l'esistente, ma remove+push è più sicuro per ora).
            // Se c'è sovrapposizione, l'ultimo vince.
            if (apptId) await remove(ref(db, ROOT + '/GiroVisite/' + apptId));

            const newRef = push(ref(db, ROOT + '/GiroVisite'));
            const data = {
                data: iso,
                stanzaID: catId,
                rowNo: rowNo,
                pazienteID: type, // 'PAUSA' o 'BLOCCATO'
                pazienteNome: type,
                pazienteNote: null
            };
            // Se lo slot non ha ora, usa SOLO rowNo per matching
            // (come per le fasce orarie)
            console.log('Salvo slot speciale - rowNo:', rowNo, 'data:', data);
            await set(newRef, data);
            showToast("✅ Slot aggiornato: " + type);
        } catch (e) {
            showToast("Errore: " + e.message, "error");
        }
    }

    closeContextMenu();
};

// Chiudi menu se clicco fuori
document.addEventListener('click', (e) => {
    if (!e.target.closest('#customContextMenu')) closeContextMenu();
});


// ===================== MODALE REGOLE =====================
function openModalRule(catId, catName) {
    activeCatId = catId; activeCatName = catName;
    loadedRuleId = null; // Reset
    editingRuleId = null; // Reset (verrà settato solo da loadRuleIntoEditor)
    isReactivatingRule = false; // Reset flag riattivazione
    activeSlots = []; editingIdx = null; selectedDates = new Set();

    // RESET COMPLETO campi generatore
    resetCampi();
    if (document.getElementById('genFasciaOraria')) document.getElementById('genFasciaOraria').checked = false;

    document.getElementById('ruleRoomNameOverride').value = '';
    document.getElementById('ruleName').value = '';
    document.getElementById('ruleFreq').value = 'weekly';
    document.getElementById('ruleStart').value = currentDate.toLocaleDateString('sv-SE');
    document.getElementById('ruleEnd').value = '2031-12-31';
    document.querySelectorAll('#uiSettimanale .btn-check').forEach(e => e.classList.remove('active'));
    // Reset biweekly
    document.querySelectorAll('#uiBiweekly .btn-check').forEach(e => e.classList.remove('active'));
    document.getElementById('biweeklyAnchor').value = '';
    const wd = currentDate.getDay() === 0 ? 7 : currentDate.getDay();

    // CERCA REGOLA ATTIVA
    const regola = findRegolaPer(catId, currentDate);

    // Indicatore
    const statusIndicator = document.getElementById('ruleStatusIndicator');

    if (regola && regola.slots) {
        // ✅ REGOLA SALVATA
        loadedRuleId = regola.id; // SALVA L'ID
        activeSlots = regola.slots.map(s => Object.assign({}, s));

        document.getElementById('ruleRoomNameOverride').value = regola.nomeStanza || '';
        document.getElementById('ruleName').value = regola.ruleName || '';
        document.getElementById('ruleFreq').value = regola.freq || 'weekly';
        document.getElementById('ruleStart').value = regola.validaDa || currentDate.toLocaleDateString('sv-SE');
        document.getElementById('ruleEnd').value = regola.validaA || '2031-12-31';

        if (regola.freq === 'weekly' && regola.giorni) {
            regola.giorni.forEach(function (giorno) {
                const el = document.querySelector('#uiSettimanale .btn-check[data-wd="' + giorno + '"]');
                if (el) el.classList.add('active');
            });
        } else if (regola.freq === 'biweekly') {
            if (regola.biweeklyWeekdays) {
                regola.biweeklyWeekdays.forEach(function (giorno) {
                    const el = document.querySelector('#uiBiweekly .btn-check[data-bwd="' + giorno + '"]');
                    if (el) el.classList.add('active');
                });
            }
            if (regola.biweeklyAnchor) {
                document.getElementById('biweeklyAnchor').value = regola.biweeklyAnchor;
            }
        } else if (regola.freq === 'monthly' && regola.date) {
            selectedDates = new Set(regola.date);
        } else if (regola.freq === 'once' && regola.dataSpecifica) {
            document.getElementById('onceDate').value = regola.dataSpecifica;
        }

        // Indicatore verde
        if (statusIndicator) {
            statusIndicator.innerHTML = `
        <div style="background:#dcfce7; border:2px solid #22c55e; padding:12px; border-radius:8px; margin-bottom:15px;">
            <div style="font-weight:800; color:#15803d; font-size:13px; margin-bottom:6px;">
                ✅ REGOLA SALVATA: ${regola.ruleName || 'Senza nome'}
            </div>
            <div style="font-size:11px; color:#166534; line-height:1.6;">
                Stai visualizzando una regola salvata nel database.<br>
                Cliccando SALVA, il sistema ti chiederà se vuoi aggiornarla o crearne una nuova.
            </div>
        </div>
    `;
        }
    } else {
        // Nessuna regola per questa stanza/giorno
        loadedRuleId = null;
        activeSlots = [];
        const wdEl = document.querySelector('#uiSettimanale .btn-check[data-wd="' + wd + '"]');
        if (wdEl) wdEl.classList.add('active');

        if (statusIndicator) {
            statusIndicator.innerHTML = `
        <div style="background:#fef3c7; border:2px solid #f59e0b; padding:12px; border-radius:8px; margin-bottom:15px;">
            <div style="font-weight:800; color:#92400e; font-size:13px; margin-bottom:6px;">
                ⚠️ NESSUNA REGOLA
            </div>
            <div style="font-size:11px; color:#78350f; line-height:1.6;">
                Non c'è una regola salvata per questa stanza/giorno.<br>
                Configura gli orari e clicca SALVA per creare una nuova regola.
            </div>
        </div>
    `;
        }
    }

    toggleFreqUI(); refreshEditorUI();
    document.getElementById('modalRule').classList.add('open');
}
function closeModalRule() {
    document.getElementById('modalRule').classList.remove('open');
    loadedRuleId = null;
    isReactivatingRule = false; // Reset flag riattivazione
}

// ===================== EDITOR =====================
// Ordina slot per orario
function sortSlots(slots) {
    return slots.sort((a, b) => {
        // Se entrambi hanno orario, ordina per orario
        if (a.ora && b.ora) {
            const getStartTime = (ora) => {
                const match = ora.match(/^(\d{2}):(\d{2})/);
                if (!match) return 0;
                return parseInt(match[1]) * 60 + parseInt(match[2]);
            };
            const timeA = getStartTime(a.ora);
            const timeB = getStartTime(b.ora);

            // Se hanno lo stesso orario, PAUSA/BLOCCATO vanno PRIMA di VISITA
            if (timeA === timeB) {
                const isPausaA = a.tipo === 'PAUSA' || a.tipo === 'BLOCCATO';
                const isPausaB = b.tipo === 'PAUSA' || b.tipo === 'BLOCCATO';
                if (isPausaA && !isPausaB) return -1; // A prima di B
                if (!isPausaA && isPausaB) return 1;  // B prima di A
            }

            return timeA - timeB;
        }

        // Slot senza orario vanno alla fine
        if (!a.ora && !b.ora) return 0;
        if (!a.ora) return 1;
        if (!b.ora) return -1;

        return 0;
    });
}

function refreshEditorUI() {
    // ORDINA gli slot prima di mostrarli
    sortSlots(activeSlots);

    const list = document.getElementById('slotEditorList'); list.innerHTML = '';
    activeSlots.forEach((s, i) => {
        const oraText = s.fasciaOraria ? s.ora + ' → SLOT ' + (s.slotNum || (i + 1)) : (s.ora || 'SLOT ' + (s.slotNum || (i + 1)));
        const tc = s.tipo.toLowerCase();
        const item = document.createElement('div'); item.className = 'slot-item' + (editingIdx === i ? ' editing' : '');
        const fasciaBadge = s.fasciaOraria ? '<span style="background:#64748b;color:white;padding:2px 5px;border-radius:3px;font-size:9px;margin-left:4px;">📋 FASCIA</span>' : '';
        item.innerHTML = '<span class="slot-ora">' + oraText + fasciaBadge + '</span><span class="slot-tipo ' + tc + '">' + s.tipo + (s.label ? ' · ' + s.label : '') + '</span><div class="slot-actions"><button class="btn-mini" style="background:var(--accent);color:white;" onclick="loadEdit(' + i + ')">✏️</button><button class="btn-mini" style="background:var(--danger);color:white;" onclick="deleteSlot(' + i + ')">✖</button></div>';
        list.appendChild(item);
    });
    previewLive();
}
function deleteSlot(i) { activeSlots.splice(i, 1); editingIdx = null; resetCampi(); refreshEditorUI(); }

// Resetta i campi a stato vuoto
function resetCampi() {
    document.querySelector('.gen-start-h').value = '';
    document.querySelector('.gen-start-m').value = '';
    document.getElementById('genNum').value = '';
    document.getElementById('genDur').value = '';
    document.getElementById('genTipo').value = 'VISITA';
    document.getElementById('genLabel').value = '';
    document.getElementById('btnMainAction').textContent = '+ INSERISCI';
    editingIdx = null;
}

function loadEdit(i) {
    editingIdx = i;
    const s = activeSlots[i];
    if (s.ora && s.ora.includes(' - ')) {
        const parti = s.ora.split(' - ');
        const ini = parti[0].split(':');
        const fin = parti[1].split(':');
        document.querySelector('.gen-start-h').value = ini[0];
        document.querySelector('.gen-start-m').value = ini[1];
        const minIni = parseInt(ini[0]) * 60 + parseInt(ini[1]);
        const minFin = parseInt(fin[0]) * 60 + parseInt(fin[1]);
        document.getElementById('genDur').value = String(minFin - minIni);
    } else {
        document.querySelector('.gen-start-h').value = '';
        document.querySelector('.gen-start-m').value = '';
        document.getElementById('genDur').value = '';
    }
    document.getElementById('genNum').value = '1';
    document.getElementById('genTipo').value = s.tipo;
    document.getElementById('genLabel').value = s.label || '';
    document.getElementById('btnMainAction').textContent = '💾 AGGIORNA';
    refreshEditorUI();
}

function addOrUpdateBlock() {
    const h = document.querySelector('.gen-start-h').value;
    const m = document.querySelector('.gen-start-m').value;
    const num = parseInt(document.getElementById('genNum').value) || 1;
    const dur = parseInt(document.getElementById('genDur').value) || 40;
    const tipo = document.getElementById('genTipo').value;
    const label = document.getElementById('genLabel').value.trim();
    const isFasciaOraria = document.getElementById('genFasciaOraria')?.checked || false;

    // Validazione: VISITA richiede ora, PAUSA/BLOCCATO no (tranne se fascia oraria dove serve per calcolare la fascia)
    if (tipo === 'VISITA' && (h === '' || m === '')) { showToast("Seleziona ora di inizio per VISITA", "error"); return; }
    if (isFasciaOraria && tipo !== 'PAUSA' && tipo !== 'BLOCCATO' && (h === '' || m === '')) { showToast("Seleziona ora fascia", "error"); return; }

    let curr = new Date(2000, 0, 1, parseInt(h || 0), parseInt(m || 0), 0);

    if (editingIdx !== null) {
        if (isFasciaOraria) {
            // Fascia oraria: ora è "HH:00 - HH+1:00", slotNum per identificare
            const oraInizio = curr.toTimeString().slice(0, 5).split(':')[0] + ':00';
            curr.setHours(curr.getHours() + 1);
            const oraFine = curr.toTimeString().slice(0, 5);
            activeSlots[editingIdx] = { ora: oraInizio + ' - ' + oraFine, tipo: tipo, label: label, slotNum: editingIdx + 1, fasciaOraria: true };
        } else {
            const ini = curr.toTimeString().slice(0, 5); curr.setMinutes(curr.getMinutes() + dur); const fine = curr.toTimeString().slice(0, 5);
            activeSlots[editingIdx] = { ora: ini + ' - ' + fine, tipo: tipo, label: label };
        }
    } else {
        for (let i = 0; i < num; i++) {
            if (isFasciaOraria) {
                // Fascia oraria: tutti gli slot hanno la stessa ora "HH:00 - HH+1:00"
                const oraInizio = curr.toTimeString().slice(0, 5).split(':')[0] + ':00';
                const oraFine = (parseInt(oraInizio.split(':')[0]) + 1) + ':00';
                activeSlots.push({
                    ora: oraInizio + ' - ' + oraFine,
                    tipo: tipo,
                    label: label,
                    slotNum: activeSlots.length + 1,  // PROGRESSIVO: continua la numerazione
                    fasciaOraria: true
                });
            } else {
                const ini = curr.toTimeString().slice(0, 5); curr.setMinutes(curr.getMinutes() + dur); const fine = curr.toTimeString().slice(0, 5);
                // PAUSA/BLOCCATO: conserva ora per ordinamento, ma se è separatore visivo (senza fascia) può non averla
                const oraSlot = (tipo === 'PAUSA' || tipo === 'BLOCCATO') && isFasciaOraria && (h === '' || m === '') ? null : ini + ' - ' + fine;
                activeSlots.push({ ora: oraSlot, tipo: tipo, label: label, fasciaOraria: isFasciaOraria && (tipo === 'PAUSA' || tipo === 'BLOCCATO') });
            }
        }
    }
    resetCampi(); refreshEditorUI();
}
function resetCurrentConfig() { if (confirm("Reset?")) { activeSlots = []; resetCampi(); refreshEditorUI(); } }

// NUOVA FUNZIONE: RICALCOLO MASSIVO
window.recalculateList = function () {
    const h = document.querySelector('.gen-start-h').value;
    const m = document.querySelector('.gen-start-m').value;
    const dur = parseInt(document.getElementById('genDur').value);

    if (h === "" || m === "" || !dur) {
        showToast("Imposta ORA INIZIO e DURATA in alto prima di ricalcolare!", "error");
        return;
    }
    if (!activeSlots.length) return;

    if (!confirm("⚠️ Riscrivere tutti gli orari della lista partendo dalle " + h + ":" + m + " con durata " + dur + " min?")) return;

    let curr = new Date(2000, 0, 1, parseInt(h), parseInt(m), 0);

    activeSlots.forEach(slot => {
        const ini = curr.toTimeString().slice(0, 5);
        curr.setMinutes(curr.getMinutes() + dur);
        const fine = curr.toTimeString().slice(0, 5);
        slot.ora = ini + " - " + fine;
    });

    refreshEditorUI();
    showToast("Lista ricalcolata!");
};

// ===================== ANTEPRIMA LIVE =====================
function previewLive() {
    const h = document.querySelector('.gen-start-h')?.value;
    const m = document.querySelector('.gen-start-m')?.value;
    const dur = parseInt(document.getElementById('genDur').value) || 40;
    const num = parseInt(document.getElementById('genNum').value) || 1;
    const tipo = document.getElementById('genTipo').value;
    const label = document.getElementById('genLabel').value.trim();

    const prev = document.getElementById('visualPreview');
    if (!prev) return; prev.innerHTML = '';
    const color = getColor(activeCatId);

    // Crea array combinato: slot esistenti + ghost slots
    const combined = [];

    // 1. Slot Esistenti (con edit live se editingIdx è attivo)
    activeSlots.forEach((s, i) => {
        let use = s;
        let isEdit = (i === editingIdx);
        if (isEdit) {
            if (tipo === 'PAUSA' || tipo === 'BLOCCATO') {
                use = { ora: null, tipo: tipo, label: label };
            } else if (h !== '' && m !== '' && dur > 0) {
                let curr = new Date(2000, 0, 1, parseInt(h), parseInt(m), 0);
                const ini = curr.toTimeString().slice(0, 5);
                curr.setMinutes(curr.getMinutes() + dur);
                const fine = curr.toTimeString().slice(0, 5);
                use = { ora: ini + ' - ' + fine, tipo: tipo, label: label };
            }
        }
        combined.push({ slot: use, isEdit: isEdit, isGhost: false, index: i });
    });

    // 2. Ghost Slots (NUOVI) - Solo se NON stiamo editando e abbiamo dati validi
    if (editingIdx === null && (tipo !== 'VISITA' || (h !== '' && m !== ''))) {
        let currGhost = new Date(2000, 0, 1, parseInt(h || 0), parseInt(m || 0), 0);
        for (let k = 0; k < num; k++) {
            let ghostSlot = { tipo: tipo, label: label };
            if (tipo === 'VISITA' || tipo === 'PAUSA' || tipo === 'BLOCCATO') {
                const iniG = currGhost.toTimeString().slice(0, 5);
                currGhost.setMinutes(currGhost.getMinutes() + dur);
                const fineG = currGhost.toTimeString().slice(0, 5);
                ghostSlot.ora = iniG + ' - ' + fineG;
            }
            combined.push({ slot: ghostSlot, isEdit: false, isGhost: true });
        }
    }

    // 3. ORDINA tutto per orario
    combined.sort((a, b) => {
        if (!a.slot.ora && !b.slot.ora) return 0;
        if (!a.slot.ora) return 1;
        if (!b.slot.ora) return -1;
        const getStartTime = (ora) => {
            const match = ora.match(/^(\d{2}):(\d{2})/);
            if (!match) return 0;
            return parseInt(match[1]) * 60 + parseInt(match[2]);
        };
        return getStartTime(a.slot.ora) - getStartTime(b.slot.ora);
    });

    // 4. Renderizza in ordine
    combined.forEach(item => {
        const use = item.slot;
        const isEdit = item.isEdit;
        const isGhost = item.isGhost;

        const cell = document.createElement('div'); cell.className = 'time-cell';
        if (isEdit) { cell.style.outline = '3px solid var(--accent)'; cell.style.zIndex = '10'; }
        if (isGhost) { cell.style.outline = '2px dashed var(--accent)'; cell.style.opacity = '0.7'; }

        const oraText = use.ora || 'SLOT ' + (use.slotNum || '');
        if (use.tipo === 'PAUSA') {
            cell.classList.add('tipo-pausa');
            cell.innerHTML = '<div class="ora" style="opacity:0.6;">' + (use.ora || '') + '</div><span style="font-size:11px;font-weight:700;">☕ ' + (use.label || 'PAUSA') + '</span>';
        }
        else if (use.tipo === 'BLOCCATO') {
            cell.classList.add('tipo-bloccato');
            cell.innerHTML = '<div class="ora" style="opacity:0.5;">' + (use.ora || '') + '</div><span style="font-size:11px;font-weight:700;">🚫 ' + (use.label || 'BLOCCATO') + '</span>';
        }
        else {
            cell.style.borderLeftColor = color; cell.classList.add('vuoto');
            cell.innerHTML = '<div class="ora">' + oraText + '</div>' + (use.label ? '<div class="note">' + use.label + '</div>' : '');
        }
        prev.appendChild(cell);
    });
}

// ===================== FREQUENZA =====================
function toggleFreqUI() {
    const f = document.getElementById('ruleFreq').value;
    document.getElementById('uiSettimanale').style.display = f === 'weekly' ? 'grid' : 'none';
    document.getElementById('uiBiweekly').style.display = f === 'biweekly' ? 'block' : 'none';
    document.getElementById('uiMensile').style.display = f === 'monthly' ? 'block' : 'none';
    document.getElementById('uiMonthlySpecific').style.display = f === 'monthly_specific' ? 'block' : 'none';
    document.getElementById('uiOnce').style.display = f === 'once' ? 'block' : 'none';
    if (f === 'monthly') { populateJumpers(); drawEditorCalendar(); }
    if (f === 'once') document.getElementById('onceDate').value = currentDate.toLocaleDateString('sv-SE');
    if (f === 'biweekly' && !document.getElementById('biweeklyAnchor').value) {
        document.getElementById('biweeklyAnchor').value = currentDate.toLocaleDateString('sv-SE');
    }
}
function toggleWd(el) { el.classList.toggle('active'); }

// ===================== CALENDARIO MENSILE =====================
function populateJumpers() {
    const mEl = document.getElementById('jumpMonth'), yEl = document.getElementById('jumpYear'), curY = new Date().getFullYear();
    mEl.innerHTML = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"].map((n, i) => '<option value="' + i + '"' + (i === new Date().getMonth() ? ' selected' : '') + '>' + n + '</option>').join('');
    yEl.innerHTML = Array.from({ length: 6 }, (_, i) => '<option value="' + (curY + i) + '"' + (i === 0 ? ' selected' : '') + '>' + (curY + i) + '</option>').join('');
}
function drawEditorCalendar() {
    const c = document.getElementById('editorCalendar'); c.innerHTML = '';
    const m = parseInt(document.getElementById('jumpMonth').value), y = parseInt(document.getElementById('jumpYear').value);
    ['L', 'M', 'M', 'G', 'V', 'S', 'D'].forEach(h => { const d = document.createElement('div'); d.className = 'ed-day empty'; d.style.cssText = 'font-weight:bold;color:#64748b;font-size:9px;'; d.textContent = h; c.appendChild(d); });
    const days = new Date(y, m + 1, 0).getDate(), first = new Date(y, m, 1).getDay() || 7;
    for (let i = 1; i < first; i++) { const e = document.createElement('div'); e.className = 'ed-day empty'; c.appendChild(e); }
    for (let d = 1; d <= days; d++) {
        const iso = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        const el = document.createElement('div'); el.className = 'ed-day' + (selectedDates.has(iso) ? ' sel' : ''); el.textContent = d;
        el.onclick = () => { selectedDates.has(iso) ? selectedDates.delete(iso) : selectedDates.add(iso); drawEditorCalendar(); };
        c.appendChild(el);
    }
}

// ===================== SALVA =====================
// Funzione per verificare appuntamenti impattati - USA ORAINIZIO
async function checkImpactedAppointments(regId, newSlots, catId, freq, giorni, date, dataSpec, validaDa, validaA, monthlyWeekdays = [], monthlyOccurrences = [], biweeklyWeekdays = [], biweeklyAnchor = null) {

    // Cerca appuntamenti FUTURI per questa stanza
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toLocaleDateString('sv-SE');

    try {
const snapshot = await get(ref(db, ROOT + '/GiroVisite'));
if (!snapshot.exists()) {
    console.log("✅ Nessun appuntamento nel database");
    return { hasImpact: false, appointments: [] };
}

const allAppointments = Object.entries(snapshot.val()).map(([id, v]) => ({ ...v, id }));

// Filtra solo appuntamenti FUTURI per questa stanza

const relevantAppts = allAppointments.filter(v => {
    if (String(v.stanzaID) !== String(catId)) return false;
    if (v.pazienteID === 'PAUSA' || v.pazienteID === 'BLOCCATO') return false;

    // Check base data (futuro)
    if (v.data < todayISO) return false;

    // Check Validità Regola (se definita)
    if (validaDa && v.data < validaDa) return false;
    if (validaA && v.data > validaA) return false;

    // Controlla se questo appuntamento è in un giorno coperto dalla nuova regola
    const apptDate = new Date(v.data);
    const apptWd = apptDate.getDay() === 0 ? 7 : apptDate.getDay();

    // Se stiamo aggiornando una regola esistente, ignora gli appuntamenti gestiti da altre regole
    if (regId) {
        const activeRule = findRegolaPer(catId, apptDate);
        if (activeRule && activeRule.id !== regId) return false;
    }

    if (freq === 'weekly' && giorni && !giorni.includes(apptWd)) return false;
    if (freq === 'biweekly' && biweeklyWeekdays && biweeklyAnchor) {
        if (!matchesBiweekly(apptDate, biweeklyWeekdays, biweeklyAnchor)) return false;
    }
    if (freq === 'monthly_specific' && monthlyWeekdays && monthlyOccurrences) {
        if (!matchesMonthlyOccurrence(apptDate, monthlyWeekdays, monthlyOccurrences)) return false;
    }
    if (freq === 'monthly' && date && !date.includes(v.data)) return false;
    if (freq === 'once' && dataSpec !== v.data) return false;

    return true;
});

        // Controlla range date
        if (relevantAppts.length > 0) {
            const firstDate = relevantAppts.reduce((min, p) => p.data < min ? p.data : min, relevantAppts[0].data);
            const lastDate = relevantAppts.reduce((max, p) => p.data > max ? p.data : max, relevantAppts[0].data);
            }



        // Per ogni appuntamento, verifica se ha ancora uno slot VISITA disponibile
        const impactedAppts = relevantAppts.filter(v => {
            // NUOVO: Usa oraInizio per trovare lo slot
            const oraInizio = v.oraInizio;

            if (!oraInizio) {
                // FALLBACK: Appuntamento vecchio con solo rowNo
                const rowNo = parseInt(v.rowNo);
                const slotIndex = rowNo - 1;

                // CASO 1: Slot oltre il limite (es: 14 slot → 13 slot, rowNo=14 è perso)
                if (rowNo > newSlots.length) {
                    return true;
                }

                // CASO 2: Lo slot in quella posizione è BLOCCATO/PAUSA
                const slot = newSlots[slotIndex];
                if (!slot || slot.tipo === 'BLOCCATO' || slot.tipo === 'PAUSA') {
                    return true;
                }
                
                // CASO 3: IMPORTANTE! Se hai rimosso slot all'inizio/metà, tutti i successivi "scivolano"
                // Verifica se l'orario dello slot in questa posizione è cambiato
                // Questo succede quando rimuovi slot prima di questo rowNo
                // Per ora ritorna false - il sistema con rowNo è fragile
                // TODO: Migrare a oraInizio per risolvere definitivamente

                return false;
            }

            // Cerca lo slot per oraInizio (sistema robusto)
            const matchingSlot = newSlots.find(s => {
                if (!s.ora) return false;
                const slotOraInizio = (s.ora.includes(' - ') ? s.ora.split(' - ')[0] : s.ora).trim();
                return slotOraInizio === oraInizio.trim();
            });

            if (!matchingSlot) {
                return true;
            }

            if (matchingSlot.tipo === 'BLOCCATO' || matchingSlot.tipo === 'PAUSA') {
                return true;
            }

            // Slot OK
            return false;
        });


        // Ordina per data
        impactedAppts.sort((a, b) => {
            const dateCompare = a.data.localeCompare(b.data);
            if (dateCompare !== 0) return dateCompare;
            // Ordina per oraInizio se disponibile, altrimenti rowNo
            if (a.oraInizio && b.oraInizio) return a.oraInizio.localeCompare(b.oraInizio);
            return parseInt(a.rowNo || 999) - parseInt(b.rowNo || 999);
        });

        const newSlotCount = newSlots ? newSlots.length : 0;
        
        // Recupera la configurazione vecchia (regola attiva corrente)
        let oldSlots = [];
        let oldSlotCount = 0;
        
        // Trova la regola attiva per questa stanza alla data odierna
        const sampleDate = relevantAppts.length > 0 ? new Date(relevantAppts[0].data) : new Date();
        const currentRule = findRegolaPer(catId, sampleDate);
        if (currentRule && currentRule.slots) {
            oldSlots = currentRule.slots;
            oldSlotCount = oldSlots.filter(s => s.tipo === 'VISITA').length;
        } else {
            oldSlotCount = "N/D";
        }

        return {
            hasImpact: impactedAppts.length > 0,
            appointments: impactedAppts,
            oldSlots: oldSlots,  // NUOVO: includi gli slot vecchi
            oldCount: oldSlotCount,
            newCount: newSlotCount
        };
    } catch (e) {
        console.error("Errore controllo appuntamenti:", e);
        return { hasImpact: false, appointments: [] };
    }
}

// Variabile globale per tracciare la regola caricata
let loadedRuleId = null;
let isReactivatingRule = false; // Flag per indicare se stiamo riattivando una regola dall'audit

// Funzione di salvataggio
async function saveRuleData(regId, freq, giorni, date, dataSpec, vDa, vA, nomeOvr, ruleName, slotsData, isUpdate = false, monthlyWeekdays = [], monthlyOccurrences = [], biweeklyWeekdays = [], biweeklyAnchor = null, catId = null, catName = null) {
    // Usa i parametri se forniti, altrimenti usa le variabili globali
    const finalCatId = catId || activeCatId;
    const finalCatName = catName || activeCatName;
    
    if (!finalCatId) {
        console.error('❌ saveRuleData: catId mancante!');
        showToast('❌ Errore: stanza non identificata', 'error');
        return;
    }
    
    // Se stiamo aggiornando una regola ESISTENTE (non riattivando dall'audit), preserva il createdAt originale
    // Se stiamo riattivando dall'audit, AGGIORNA il createdAt a oggi per renderla la più recente
    const existingRule = dbState.RegoleAttive[regId];
    const createdAt = (isUpdate && existingRule && existingRule.createdAt) 
        ? existingRule.createdAt 
        : new Date().toISOString();
    
    try {
        const ruleData = {
            id: regId,
            catId: finalCatId,
            catName: finalCatName,
            freq: freq,
            giorni: giorni,
            date: date,
            dataSpecifica: dataSpec,
            validaDa: vDa,
            validaA: vA,
            nomeStanza: nomeOvr || null,
            ruleName: ruleName,
            slots: slotsData,
            createdAt: createdAt
        };
        
        // Aggiungi campi monthly_specific se presente
        if (freq === 'monthly_specific') {
            ruleData.monthlyWeekdays = monthlyWeekdays;
            ruleData.monthlyOccurrences = monthlyOccurrences;
        }
        
        // Aggiungi campi biweekly se presente
        if (freq === 'biweekly') {
            ruleData.biweeklyWeekdays = biweeklyWeekdays;
            ruleData.biweeklyAnchor = biweeklyAnchor;
        }
        
        await set(ref(db, ROOT + '/RegoleAttive/' + regId), ruleData);

        // Aggiorna dbState locale
        if (!dbState.RegoleAttive) dbState.RegoleAttive = {};
        dbState.RegoleAttive[regId] = ruleData;

        showToast(isUpdate ? "✅ Regola aggiornata!" : "✅ Nuova regola creata!", "success");
        loadedRuleId = regId;

    } catch (e) {
        console.error('❌ Errore saveRuleData:', e);
        showToast("❌ Errore: " + e.message, "error");
    }
}

// ===================== SALVATAGGIO SMART =====================
async function saveMasterRule() {
    const freq = document.getElementById('ruleFreq').value;
    const ruleName = document.getElementById('ruleName').value.trim();
    const nomeOvr = document.getElementById('ruleRoomNameOverride').value.trim();
    const vDa = document.getElementById('ruleStart').value;
    const vA = document.getElementById('ruleEnd').value;

    // 1. Validazione Base
    if (!activeSlots.length) { showToast("Aggiungi almeno uno slot!", "error"); return; }

    let giorni = [], date = [], dataSpec = null;
    let monthlyWeekdays = [], monthlyOccurrences = []; // Nuovi campi per monthly_specific
    let biweeklyWeekdays = [], biweeklyAnchor = null; // Campi per biweekly
    
    if (freq === 'weekly') {
        giorni = Array.from(document.querySelectorAll('#uiSettimanale .btn-check.active')).map(e => parseInt(e.dataset.wd));
        if (!giorni.length) { showToast("Seleziona almeno un giorno!", "error"); return; }
    } else if (freq === 'biweekly') {
        biweeklyWeekdays = Array.from(document.querySelectorAll('#uiBiweekly .btn-check.active[data-bwd]')).map(e => parseInt(e.dataset.bwd));
        biweeklyAnchor = document.getElementById('biweeklyAnchor').value;
        if (!biweeklyWeekdays.length) { showToast("Seleziona almeno un giorno della settimana!", "error"); return; }
        if (!biweeklyAnchor) { showToast("Seleziona la data di riferimento!", "error"); return; }
    } else if (freq === 'monthly_specific') {
        monthlyWeekdays = Array.from(document.querySelectorAll('#uiMonthlySpecific .btn-check.active[data-wd]')).map(e => parseInt(e.dataset.wd));
        monthlyOccurrences = Array.from(document.querySelectorAll('#uiMonthlySpecific .btn-check.active[data-occ]')).map(e => parseInt(e.dataset.occ));
        if (!monthlyWeekdays.length) { showToast("Seleziona almeno un giorno della settimana!", "error"); return; }
        if (!monthlyOccurrences.length) { showToast("Seleziona almeno un'occorrenza (primo, secondo, ecc.)!", "error"); return; }
    } else if (freq === 'monthly') {
        date = Array.from(selectedDates);
        if (!date.length) { showToast("Seleziona almeno una data!", "error"); return; }
    } else if (freq === 'once') {
        dataSpec = document.getElementById('onceDate').value;
        if (!dataSpec) { showToast("Seleziona la data!", "error"); return; }
    }

    // Preparazione dati slot
    const slotsData = activeSlots.map(s => ({
        ora: s.ora || null,
        tipo: s.tipo,
        label: s.label || null,
        slotNum: s.slotNum || null,
        fasciaOraria: s.fasciaOraria || false
    }));

    // 2. Identificazione regola: editingRuleId (da audit) oppure loadedRuleId (da apertura modale)
    const sourceRuleId = editingRuleId || loadedRuleId;
    let regId;
    let isUpdate = false;

    // Helper: normalizza uno slot nello stesso formato di slotsData
    const normalizeSlot = s => ({
        ora: s.ora || null,
        tipo: s.tipo,
        label: s.label || null,
        slotNum: s.slotNum || null,
        fasciaOraria: s.fasciaOraria || false
    });

    if (sourceRuleId) {
        // Stiamo lavorando su una regola esistente — controlla se è cambiato qualcosa
        const existingRule = dbState.RegoleAttive[sourceRuleId];

        if (existingRule) {
            // Normalizza gli slot del DB nello stesso formato di slotsData
            const existingNormalized = (existingRule.slots || []).map(normalizeSlot);
            const slotsChanged = JSON.stringify(existingNormalized) !== JSON.stringify(slotsData);
            const freqChanged = existingRule.freq !== freq;
            const giorniChanged = JSON.stringify((existingRule.giorni || []).slice().sort()) !== JSON.stringify((giorni || []).slice().sort());
            const dateChanged = JSON.stringify((existingRule.date || []).slice().sort()) !== JSON.stringify((date || []).slice().sort());
            const dataSpecChanged = (existingRule.dataSpecifica || null) !== (dataSpec || null);
            const validaDaChanged = (existingRule.validaDa || '') !== (vDa || '');
            const validaAChanged = (existingRule.validaA || '') !== (vA || '');
            const nomeChanged = (existingRule.nomeStanza || '') !== (nomeOvr || '');
            const ruleNameChanged = (existingRule.ruleName || '') !== (ruleName || '');
            const biweeklyWdChanged = JSON.stringify((existingRule.biweeklyWeekdays || []).slice().sort()) !== JSON.stringify((biweeklyWeekdays || []).slice().sort());
            const biweeklyAnchorChanged = (existingRule.biweeklyAnchor || '') !== (biweeklyAnchor || '');

            const hasChanges = slotsChanged || freqChanged || giorniChanged || dateChanged ||
                              dataSpecChanged || validaDaChanged || validaAChanged ||
                              nomeChanged || ruleNameChanged || biweeklyWdChanged || biweeklyAnchorChanged;

            if (!hasChanges && !isReactivatingRule) {
                // Nessuna modifica e non stiamo riattivando
                showToast('ℹ️ Nessuna modifica da salvare', 'info');
                closeModalRule();
                return;
            }
            
            // Se stiamo riattivando SENZA modifiche, usa lo stesso ID MA aggiorna createdAt
            if (isReactivatingRule && !hasChanges) {
                regId = sourceRuleId;
                isUpdate = false; // FALSE perché vogliamo aggiornare il createdAt a oggi
            } else {
                // Modifiche rilevate → crea NUOVA regola (la vecchia resta nell'audit)
                regId = "reg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
                isUpdate = false;
            }
        } else {
            regId = "reg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
        }
    } else {
        // Nessuna regola di partenza → NUOVA regola
        regId = "reg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
    }
    
    // Reset flag dopo aver determinato l'ID
    isReactivatingRule = false;

    showToast("🔍 Verifica conflitti in corso...", "info");

    // 3. CONTROLLO CONFLITTI (CRUCIALE)
    try {
        const impact = await checkImpactedAppointments(null, slotsData, activeCatId, freq, giorni, date, dataSpec, vDa, vA, monthlyWeekdays, monthlyOccurrences, biweeklyWeekdays, biweeklyAnchor);

        if (impact.hasImpact) {
            openConflictModal(impact, {
                regId, freq, giorni, date, dataSpec, vDa, vA, nomeOvr, ruleName, slotsData, isUpdate, monthlyWeekdays, monthlyOccurrences, biweeklyWeekdays, biweeklyAnchor
            });
            return;
        }

        // 4. Se nessun conflitto, SALVA
        await saveRuleData(regId, freq, giorni, date, dataSpec, vDa, vA, nomeOvr, ruleName, slotsData, isUpdate, monthlyWeekdays, monthlyOccurrences, biweeklyWeekdays, biweeklyAnchor);
        
        // IMPORTANTE: Chiudi modale - il listener Firebase si occuperà di aggiornare la griglia automaticamente
        closeModalRule();

    } catch (e) {
        console.error("Errore saveMasterRule:", e);
        showToast("Errore verifica: " + e.message, "error");
    }
}

// ===================== CONFLICT MANAGER v2 (Day-by-day drag&drop) =====================
let conflictData = null;
let pendingRuleData = null;
let conflictDays = [];        // Array unico di date con conflitti (ordinate)
let conflictCurrentDayIdx = 0; // Indice del giorno corrente nella navigazione
let conflictDragApptId = null; // ID appuntamento in drag

// Apre la modale di gestione conflitti (v2)
function openConflictModal(impact, ruleData) {
    conflictData = impact;
    
    pendingRuleData = {
        ...ruleData,
        catId: activeCatId,
        catName: activeCatName
    };

    // Raggruppa appuntamenti per giorno
    conflictDays = [...new Set(impact.appointments.map(a => a.data))].sort();
    conflictCurrentDayIdx = 0;

    // Popola titolo
    document.getElementById('conflictRoomName').textContent = activeCatName || 'Stanza';
    document.getElementById('conflictTotalCount').textContent = impact.appointments.length;

    // Popola select stanze destinazione
    const destRoomSel = document.getElementById('conflictDestRoom');
    destRoomSel.innerHTML = '';
    dbState.Categorie.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.name;
        if (String(cat.id) === String(activeCatId)) opt.selected = true;
        destRoomSel.appendChild(opt);
    });

    // Apri modale
    const modal = document.getElementById('modalConflict');
    modal.classList.add('open');
    modal.style.display = 'flex';

    // Render primo giorno
    conflictRenderCurrentDay();
    updateConflictSaveButton();
}

// Navigazione giorno
function conflictPrevDay() {
    if (conflictCurrentDayIdx > 0) {
        conflictCurrentDayIdx--;
        conflictRenderCurrentDay();
    }
}
function conflictNextDay() {
    if (conflictCurrentDayIdx < conflictDays.length - 1) {
        conflictCurrentDayIdx++;
        conflictRenderCurrentDay();
    }
}

// Reset destinazione (torna a stessa stanza/stesso giorno)
function conflictResetDest() {
    document.getElementById('conflictDestRoom').value = pendingRuleData.catId;
    if (conflictDays[conflictCurrentDayIdx]) {
        document.getElementById('conflictDestDate').value = conflictDays[conflictCurrentDayIdx];
    }
    conflictRenderRight();
}

// Render completo del giorno corrente
function conflictRenderCurrentDay() {
    // Ricalcola i giorni con conflitti ancora presenti
    const remainingDays = [...new Set(conflictData.appointments.map(a => a.data))].sort();
    
    if (remainingDays.length === 0) {
        // Tutti risolti!
        conflictDays = [];
        document.getElementById('conflictDayLabel').textContent = '✅ TUTTI RISOLTI!';
        document.getElementById('conflictDayProgress').textContent = '';
        document.getElementById('conflictLeftPanel').innerHTML = `
            <div style="padding:40px; text-align:center; color:#22c55e;">
                <div style="font-size:48px; margin-bottom:10px;">✅</div>
                <div style="font-size:16px; font-weight:800;">Tutti gli appuntamenti sistemati!</div>
                <div style="font-size:12px; margin-top:8px; color:#64748b;">Puoi procedere al salvataggio della regola</div>
            </div>`;
        document.getElementById('conflictRightPanel').innerHTML = '';
        updateConflictSaveButton();
        return;
    }

    conflictDays = remainingDays;
    if (conflictCurrentDayIdx >= conflictDays.length) conflictCurrentDayIdx = conflictDays.length - 1;
    if (conflictCurrentDayIdx < 0) conflictCurrentDayIdx = 0;

    const currentDayISO = conflictDays[conflictCurrentDayIdx];
    const dayDate = new Date(currentDayISO);
    const dayLabel = dayDate.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase();

    document.getElementById('conflictDayLabel').textContent = '📅 ' + dayLabel;
    document.getElementById('conflictDayProgress').textContent = 
        `Giorno ${conflictCurrentDayIdx + 1} di ${conflictDays.length} — Tot. rimanenti: ${conflictData.appointments.length}`;

    // Default destinazione = stessa stanza, stesso giorno
    document.getElementById('conflictDestRoom').value = pendingRuleData.catId;
    document.getElementById('conflictDestDate').value = currentDayISO;

    // Render pannello sinistro (appuntamenti di questo giorno)
    conflictRenderLeft(currentDayISO);
    
    // Render pannello destro (slot destinazione)
    conflictRenderRight();
    
    updateConflictSaveButton();
}

// RENDER PANNELLO SINISTRO: mostra la giornata COM'È (vecchia configurazione + tutti gli appuntamenti)
function conflictRenderLeft(dayISO) {
    const panel = document.getElementById('conflictLeftPanel');
    panel.innerHTML = '';

    const catId = pendingRuleData.catId;
    const dayDate = new Date(dayISO);
    
    // Prendi vecchi slot per questa stanza/giorno
    const oldRule = findRegolaPer(catId, dayDate);
    const oldSlots = oldRule && oldRule.slots ? [...oldRule.slots] : [];
    sortSlots(oldSlots);

    // Appuntamenti in conflitto per questo giorno (dalla lista conflitti — fonte di verità)
    const conflictAppts = conflictData.appointments.filter(a => a.data === dayISO);
    const conflictIds = new Set(conflictAppts.map(a => a.id));

    // Appuntamenti regolari di questo giorno (da dbState, escludendo quelli in conflitto)
    const regularAppts = dbState.GiroVisite.filter(v => 
        v.data === dayISO && String(v.stanzaID) === String(catId) && !conflictIds.has(v.id)
    );

    // Unisci: conflitti (dati originali) + regolari (dati correnti)
    const allDayAppts = [...conflictAppts, ...regularAppts];

    // Info header
    document.getElementById('conflictLeftInfo').textContent = 
        `Stanza: ${activeCatName} | ${conflictAppts.length} in conflitto`;

    if (oldSlots.length === 0) {
        panel.innerHTML = '<div style="padding:20px; text-align:center; color:#94a3b8;">Nessuna configurazione per questo giorno</div>';
        return;
    }

    // Mostra TUTTI gli slot della vecchia configurazione con i relativi appuntamenti
    oldSlots.forEach((slot, idx) => {
        const rowNo = idx + 1;
        const oraInizio = slot.ora ? (slot.ora.includes(' - ') ? slot.ora.split(' - ')[0] : slot.ora).trim() : null;

        // Cerca appuntamento in questo slot (con match robusto)
        let apptHere = allDayAppts.find(v => {
            if (v.oraInizio && oraInizio) {
                const apptStart = v.oraInizio.includes(' - ') ? v.oraInizio.split(' - ')[0].trim() : v.oraInizio.trim();
                if (apptStart === oraInizio) return true;
            }
            return String(v.rowNo) === String(rowNo);
        });

        const isConflict = apptHere && conflictIds.has(apptHere.id);
        const isPausaBloccato = apptHere && (apptHere.pazienteID === 'PAUSA' || apptHere.pazienteID === 'BLOCCATO');
        const hasPatient = apptHere && !isPausaBloccato;

        const slotDiv = document.createElement('div');
        slotDiv.style.cssText = `
            padding: 8px 10px;
            margin: 3px 0;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
            ${slot.tipo === 'PAUSA' ? 'background:#fef3c7; border:1px solid #fbbf24; color:#92400e;' : ''}
            ${slot.tipo === 'BLOCCATO' ? 'background:#f1f5f9; border:1px solid #94a3b8; color:#64748b;' : ''}
            ${slot.tipo === 'VISITA' && isConflict ? 'background:#fee2e2; border:2px solid #ef4444; cursor:grab;' : ''}
            ${slot.tipo === 'VISITA' && hasPatient && !isConflict ? 'background:#eff6ff; border:1px solid #93c5fd;' : ''}
            ${slot.tipo === 'VISITA' && !hasPatient && !isPausaBloccato ? 'background:#f8fafc; border:1px solid #e2e8f0;' : ''}
        `;

        // Colonna orario
        const oraSpan = document.createElement('span');
        oraSpan.style.cssText = 'min-width:70px; font-size:10px; color:#64748b;';
        oraSpan.textContent = slot.ora || `SLOT ${rowNo}`;
        slotDiv.appendChild(oraSpan);

        // Contenuto slot
        if (slot.tipo === 'PAUSA') {
            const span = document.createElement('span');
            span.textContent = '☕ ' + (slot.label || 'PAUSA');
            slotDiv.appendChild(span);
        } else if (slot.tipo === 'BLOCCATO') {
            const span = document.createElement('span');
            span.textContent = '🚫 ' + (slot.label || 'BLOCCATO');
            slotDiv.appendChild(span);
        } else if (isPausaBloccato) {
            // Slot VISITA ma con pausa/blocco manuale
            const span = document.createElement('span');
            span.textContent = apptHere.pazienteID === 'PAUSA' 
                ? '☕ ' + (apptHere.pazienteNome || 'PAUSA') 
                : '🚫 ' + (apptHere.pazienteNome || 'BLOCCATO');
            slotDiv.appendChild(span);
        } else if (hasPatient && isConflict) {
            // Appuntamento IN CONFLITTO: draggable
            const nome = getPatientName(apptHere.pazienteID);
            const cardDiv = document.createElement('div');
            cardDiv.style.cssText = 'flex:1; display:flex; align-items:center; justify-content:space-between;';
            
            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'font-weight:800; color:#dc2626;';
            nameSpan.textContent = '⚠️ ' + nome;
            cardDiv.appendChild(nameSpan);
            
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-mini';
            delBtn.style.cssText = 'background:var(--danger); color:white; font-size:9px; padding:2px 6px;';
            delBtn.textContent = '🗑️';
            delBtn.onclick = (e) => { e.stopPropagation(); deleteConflictAppt(apptHere.id); };
            cardDiv.appendChild(delBtn);
            
            slotDiv.appendChild(cardDiv);

            // Drag support
            slotDiv.draggable = true;
            slotDiv.ondragstart = (e) => {
                conflictDragApptId = apptHere.id;
                e.dataTransfer.effectAllowed = 'move';
                slotDiv.style.opacity = '0.5';
            };
            slotDiv.ondragend = () => {
                slotDiv.style.opacity = '1';
                conflictDragApptId = null;
            };
        } else if (hasPatient && !isConflict) {
            // Appuntamento regolare (non in conflitto) - solo visualizzazione
            const nome = getPatientName(apptHere.pazienteID);
            const span = document.createElement('span');
            span.style.cssText = 'color:#1e40af;';
            span.textContent = '✓ ' + nome;
            slotDiv.appendChild(span);
        } else {
            // Slot vuoto
            const span = document.createElement('span');
            span.style.cssText = 'color:#cbd5e1;';
            span.textContent = '— vuoto —';
            slotDiv.appendChild(span);
        }

        panel.appendChild(slotDiv);
    });
}

// RENDER PANNELLO DESTRO: slot disponibili della destinazione
function conflictRenderRight() {
    const panel = document.getElementById('conflictRightPanel');
    panel.innerHTML = '';

    const destCatId = document.getElementById('conflictDestRoom').value;
    const destDateISO = document.getElementById('conflictDestDate').value;

    if (!destDateISO) {
        panel.innerHTML = '<div style="padding:20px; text-align:center; color:#94a3b8;">Seleziona una data</div>';
        return;
    }

    const destDate = new Date(destDateISO);
    const destCat = dbState.Categorie.find(c => String(c.id) === String(destCatId));
    const destCatName = destCat ? destCat.name : '?';

    // Scelgo gli slot da mostrare:
    // Se destinazione = stessa stanza della regola in modifica → usa i NUOVI slot (pendingRuleData.slotsData)
    // Altrimenti → usa la regola già attiva per quella stanza/giorno
    let destSlots = [];
    const isSameRoom = String(destCatId) === String(pendingRuleData.catId);

    if (isSameRoom) {
        // Usa la nuova configurazione proposta
        destSlots = pendingRuleData.slotsData ? [...pendingRuleData.slotsData] : [];
    } else {
        // Usa la regola attiva per la stanza di destinazione
        const destRule = findRegolaPer(destCatId, destDate);
        destSlots = destRule && destRule.slots ? [...destRule.slots] : [];
    }
    sortSlots(destSlots);

    // Info header
    document.getElementById('conflictRightInfo').textContent = 
        `${destCatName} | ${destDate.toLocaleDateString('it-IT', { weekday:'short', day:'2-digit', month:'2-digit' })} | ${destSlots.length} slot`;

    if (destSlots.length === 0) {
        panel.innerHTML = '<div style="padding:20px; text-align:center; color:#94a3b8;">Nessuno slot configurato per questa stanza/giorno</div>';
        return;
    }

    // Prendi gli appuntamenti GIÀ presenti nella destinazione
    const existingAppts = dbState.GiroVisite.filter(v =>
        v.data === destDateISO && String(v.stanzaID) === String(destCatId)
    );

    destSlots.forEach((slot, idx) => {
        const rowNo = idx + 1;
        const oraInizio = slot.ora ? (slot.ora.includes(' - ') ? slot.ora.split(' - ')[0] : slot.ora).trim() : null;

        // Cerca appuntamento già presente in questo slot
        let existingAppt = existingAppts.find(v => {
            if (v.oraInizio && oraInizio) return v.oraInizio.trim() === oraInizio;
            return String(v.rowNo) === String(rowNo);
        });

        const isOccupied = existingAppt && existingAppt.pazienteID !== 'PAUSA' && existingAppt.pazienteID !== 'BLOCCATO';
        const isVisita = slot.tipo === 'VISITA';
        const isDroppable = isVisita && !isOccupied;

        const slotDiv = document.createElement('div');
        slotDiv.style.cssText = `
            padding: 8px 10px;
            margin: 3px 0;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.15s;
            ${slot.tipo === 'PAUSA' ? 'background:#fef3c7; border:1px solid #fbbf24; color:#92400e;' : ''}
            ${slot.tipo === 'BLOCCATO' ? 'background:#f1f5f9; border:1px solid #94a3b8; color:#64748b;' : ''}
            ${isDroppable ? 'background:#dcfce7; border:2px dashed #86efac; cursor:pointer;' : ''}
            ${isOccupied ? 'background:#eff6ff; border:1px solid #93c5fd; color:#1e40af;' : ''}
        `;

        // Ora slot
        const oraSpan = document.createElement('span');
        oraSpan.style.cssText = 'min-width:70px; font-size:10px; color:#64748b;';
        oraSpan.textContent = slot.ora || `SLOT ${rowNo}`;
        slotDiv.appendChild(oraSpan);

        if (slot.tipo === 'PAUSA') {
            slotDiv.innerHTML += `<span>☕ ${slot.label || 'PAUSA'}</span>`;
        } else if (slot.tipo === 'BLOCCATO') {
            slotDiv.innerHTML += `<span>🚫 ${slot.label || 'BLOCCATO'}</span>`;
        } else if (isOccupied) {
            const nome = getPatientName(existingAppt.pazienteID);
            slotDiv.innerHTML += `<span style="color:#1e40af;">✓ ${nome}</span>`;
        } else {
            // Slot vuoto e disponibile — SOLO drop target, l'utente trascina
            const availSpan = document.createElement('span');
            availSpan.style.cssText = 'color:#22c55e;';
            availSpan.textContent = '🟢 disponibile — trascina qui';
            slotDiv.appendChild(availSpan);

            // Drop target
            slotDiv.ondragover = (e) => {
                e.preventDefault();
                slotDiv.style.background = '#bbf7d0';
                slotDiv.style.borderColor = '#22c55e';
                slotDiv.style.borderStyle = 'solid';
            };
            slotDiv.ondragleave = () => {
                slotDiv.style.background = '#dcfce7';
                slotDiv.style.borderColor = '#86efac';
                slotDiv.style.borderStyle = 'dashed';
            };
            slotDiv.ondrop = async (e) => {
                e.preventDefault();
                slotDiv.style.background = '#dcfce7';
                if (conflictDragApptId) {
                    await conflictMoveAppt(conflictDragApptId, destCatId, rowNo, destDateISO, oraInizio, slot);
                    conflictDragApptId = null;
                }
            };
        }

        panel.appendChild(slotDiv);
    });
}

// Sposta un appuntamento dalla lista conflitti a un nuovo slot
async function conflictMoveAppt(apptId, destCatId, destRowNo, destDateISO, destOraInizio, destSlot) {
    const appt = conflictData.appointments.find(a => a.id === apptId);
    if (!appt) {
        showToast("❌ Appuntamento non trovato", "error");
        return;
    }

    const pazNome = getPatientName(appt.pazienteID);

    // Per fasce orarie NON salvare oraInizio
    let oraToSave = null;
    if (destSlot && !destSlot.fasciaOraria && destOraInizio) {
        oraToSave = destOraInizio;
    }

    try {
        await update(ref(db, ROOT + '/GiroVisite/' + apptId), {
            stanzaID: destCatId,
            rowNo: destRowNo,
            data: destDateISO,
            oraInizio: oraToSave
        });

        // Rimuovi dalla lista conflitti
        conflictData.appointments = conflictData.appointments.filter(a => a.id !== apptId);

        // Aggiorna contatore totale
        document.getElementById('conflictTotalCount').textContent = conflictData.appointments.length;

        const destCat = dbState.Categorie.find(c => String(c.id) === String(destCatId));
        showToast(`✅ ${pazNome} → ${destCat ? destCat.name : ''} slot ${destRowNo}`, "success");

        // Aggiorna anche dbState.GiroVisite locale per il rendering corretto
        const localAppt = dbState.GiroVisite.find(v => v.id === apptId);
        if (localAppt) {
            localAppt.stanzaID = destCatId;
            localAppt.rowNo = destRowNo;
            localAppt.data = destDateISO;
            localAppt.oraInizio = oraToSave;
        }

        // Re-render giorno corrente
        conflictRenderCurrentDay();

    } catch (e) {
        console.error("Errore spostamento conflitto:", e);
        showToast("❌ Errore: " + e.message, "error");
    }
}

// Salva la regola dalla modale conflitti
// Se restano appuntamenti non spostati, chiede conferma
function conflictSaveRule() {
    const remaining = conflictData ? conflictData.appointments.length : 0;
    if (remaining > 0) {
        if (!confirm(`⚠️ Ci sono ancora ${remaining} appuntamenti non spostati.\n\nSalvare la regola comunque?\nGli appuntamenti rimasti saranno assegnati a slot che potrebbero non esistere più.`)) {
            return;
        }
        // Svuota la lista per permettere il salvataggio
        conflictData.appointments = [];
    }
    proceedWithRuleSave();
}

// Aggiorna lo stato del pulsante SALVA (mostra conteggio rimanenti)
function updateConflictSaveButton() {
    const btn = document.getElementById('btnProceedSave');
    if (!btn) return;

    const remaining = conflictData ? conflictData.appointments.length : 0;
    if (remaining > 0) {
        btn.innerHTML = `💾 SALVA REGOLA (${remaining} ancora da spostare)`;
    } else {
        btn.innerHTML = '💾 SALVA REGOLA ✅';
    }
}

// Esporta la lista appuntamenti in conflitto come file CSV
function exportConflictList() {
    if (!conflictData || !conflictData.appointments || conflictData.appointments.length === 0) {
        showToast("Nessun appuntamento da esportare", "warning");
        return;
    }

    let csv = "Data,Giorno,Paziente,Slot,Stanza\n";

    conflictData.appointments.forEach(app => {
        const nome = getPatientName(app.pazienteID);
        const data = new Date(app.data);
        const dataStr = data.toLocaleDateString('it-IT');
        const giornoStr = data.toLocaleDateString('it-IT', { weekday: 'long' });
        const stanza = dbState.Categorie.find(c => String(c.id) === String(app.stanzaID));
        const nomeStanza = stanza ? stanza.name : "N/A";

        csv += `"${dataStr}","${giornoStr}","${nome}","${app.rowNo}","${nomeStanza}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `appuntamenti_conflitto_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast("✅ Lista esportata!", "success");
}

// Elimina tutti gli appuntamenti in conflitto
async function deleteAllConflicts() {
    if (!conflictData || !conflictData.appointments || conflictData.appointments.length === 0) {
        showToast("Nessun appuntamento da eliminare", "warning");
        return;
    }

    const count = conflictData.appointments.length;
    if (!confirm(`⚠️ ATTENZIONE!\n\nStai per eliminare ${count} appuntamenti.\n\nQuesta operazione NON può essere annullata.\n\nConfermi?`)) return;

    try {
        const promises = conflictData.appointments.map(app =>
            remove(ref(db, ROOT + '/GiroVisite/' + app.id))
        );
        await Promise.all(promises);
        conflictData.appointments = [];

        showToast(`✅ ${count} appuntamenti eliminati`, "success");
        conflictRenderCurrentDay();
        updateConflictSaveButton();
    } catch (e) {
        showToast("❌ Errore durante l'eliminazione: " + e.message, "error");
    }
}

// Elimina un singolo appuntamento in conflitto
async function deleteConflictAppt(apptId) {
    if (!confirm("Eliminare questo appuntamento?")) return;

    try {
        await remove(ref(db, ROOT + '/GiroVisite/' + apptId));

        if (conflictData && conflictData.appointments) {
            conflictData.appointments = conflictData.appointments.filter(a => a.id !== apptId);
            document.getElementById('conflictTotalCount').textContent = conflictData.appointments.length;
            showToast("✅ Appuntamento eliminato", "success");
            conflictRenderCurrentDay();
            updateConflictSaveButton();
        }
    } catch (e) {
        showToast("Errore eliminazione: " + e.message, "error");
        console.error("Errore in deleteConflictAppt:", e);
    }
}

// Torna alla modale conflitti (usata dalla barra di spostamento)
async function backToConflictModal() {
    movingAppt = null;
    if (conflictData && conflictData.appointments && conflictData.appointments.length > 0) {
        const modal = document.getElementById('modalConflict');
        modal.classList.add('open');
        modal.style.display = 'flex';
        conflictRenderCurrentDay();
    }
}

// Chiude la modale e annulla il salvataggio
function closeConflictModal() {
    document.getElementById('modalConflict').classList.remove('open');
    document.getElementById('modalConflict').style.display = '';
    conflictData = null;
    pendingRuleData = null;
    conflictDays = [];
    conflictCurrentDayIdx = 0;
    movingAppt = null;

    render();
    showToast("Gestione conflitti chiusa — regola NON salvata", "warning");
}

// Procede con il salvataggio della regola dopo aver risolto i conflitti
async function proceedWithRuleSave() {
    if (!pendingRuleData) {
        showToast("❌ Errore: dati regola non trovati", "error");
        console.error("pendingRuleData è null!");
        return;
    }

    if (conflictData && conflictData.appointments && conflictData.appointments.length > 0) {
        showToast(`⚠️ Ci sono ancora ${conflictData.appointments.length} appuntamenti da sistemare!`, "error");
        return;
    }

    const { regId, freq, giorni, date, dataSpec, vDa, vA, nomeOvr, ruleName, slotsData, isUpdate, catId, catName, monthlyWeekdays, monthlyOccurrences, biweeklyWeekdays, biweeklyAnchor } = pendingRuleData;
    
    console.log("💾 Salvo regola dopo conflict manager:", { regId, isUpdate, catId, catName });

    try {
        document.getElementById('modalConflict').classList.remove('open');
        document.getElementById('modalConflict').style.display = 'none';

        await saveRuleData(regId, freq, giorni, date, dataSpec, vDa, vA, nomeOvr, ruleName, slotsData, isUpdate, monthlyWeekdays, monthlyOccurrences, biweeklyWeekdays, biweeklyAnchor, catId, catName);

        conflictData = null;
        pendingRuleData = null;
        conflictDays = [];
        conflictCurrentDayIdx = 0;
        movingAppt = null;

        closeModalRule();
        await fetchGiroVisite();

        showToast(isUpdate ? "✅ Regola aggiornata!" : "✅ Regola creata!", "success");

    } catch (e) {
        showToast("Errore salvataggio: " + e.message, "error");
        console.error("Errore in proceedWithRuleSave:", e);
    }
}

// Compatibilità con vecchie funzioni (non più usate ma referenziate)
function startConflictMove(apptId) { /* deprecated - ora si usa drag&drop */ }
function startConflictMoveOther(apptId) { /* deprecated - ora si cambia stanza/giorno nel pannello destro */ }
function moveConflictToNewSlot(apptId, newSlotIndex) { /* deprecated */ }

// ===================== AUDIT =====================
function openAuditModal() {
    document.getElementById('auditTitle').textContent = activeCatName || '';
    document.getElementById('modalAudit').classList.add('open');
    renderAuditGallery();
}
function closeAuditModal() { document.getElementById('modalAudit').classList.remove('open'); }
function renderAuditGallery() {
    const gal = document.getElementById('auditGallery'); gal.innerHTML = '';
    const color = getColor(activeCatId);
    const wdN = { 1: "LUN", 2: "MAR", 3: "MER", 4: "GIO", 5: "VEN", 6: "SAB", 7: "DOM" };
    let regs = Object.entries(dbState.RegoleAttive).filter(function (e) { return String(e[1].catId) === String(activeCatId); });
    if (!regs.length) { gal.innerHTML = '<div style="color:#94a3b8;font-size:13px;padding:20px;">Nessuna regola salvata.</div>'; return; }

    // ORDINA PER DATA CREAZIONE (più recenti in alto)
    regs.sort(function (a, b) {
        const dateA = new Date(a[1].createdAt || 0);
        const dateB = new Date(b[1].createdAt || 0);
        return dateB - dateA; // Decrescente
    });

    regs.forEach(function (e) {
        const id = e[0], r = e[1];
        const card = document.createElement('div'); card.className = 'audit-card';
        let sub = '';
        if (r.freq === 'weekly' && r.giorni) sub = r.giorni.map(function (g) { return wdN[g]; }).join(', ');
        else if (r.freq === 'biweekly' && r.biweeklyWeekdays) {
            const wdNames = r.biweeklyWeekdays.map(g => wdN[g]).join(', ');
            const anchorStr = r.biweeklyAnchor ? ' (da ' + new Date(r.biweeklyAnchor).toLocaleDateString('it-IT') + ')' : '';
            sub = '⟲ ' + wdNames + anchorStr;
        }
        else if (r.freq === 'monthly_specific') {
            const wdNames = (r.monthlyWeekdays || []).map(g => wdN[g]).join(', ');
            const occNames = (r.monthlyOccurrences || []).map(o => {
                if (o === -1) return 'Ultimo';
                if (o === 1) return '1°';
                if (o === 2) return '2°';
                if (o === 3) return '3°';
                if (o === 4) return '4°';
                return o + '°';
            }).join(', ');
            sub = occNames + ' ' + wdNames;
        }
        else if (r.freq === 'monthly' && r.date) sub = r.date.length + ' date';
        else if (r.freq === 'once') sub = r.dataSpecifica || '';

        // Formatta data creazione
        const createdDate = r.createdAt ? new Date(r.createdAt) : null;
        const dateStr = createdDate ? createdDate.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + createdDate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '';

        card.innerHTML = '<div class="audit-card-header" style="background:' + color + '"><span>' + (r.ruleName || sub) + '</span><small style="opacity:0.8">' + (r.ruleName ? sub : '') + '</small></div>' +
            (dateStr ? '<div style="font-size:10px;color:#64748b;padding:4px 8px;background:#f8fafc;"><strong>Creato:</strong> ' + dateStr + '</div>' : '') +
            '<div class="audit-card-slots">' + (r.slots || []).map(function (s) {
                let slotColor = '#94a3b8';
                let slotBg = 'transparent';
                if (s.tipo === 'PAUSA') {
                    slotColor = '#f59e0b';
                    slotBg = '#fffbeb';
                } else if (s.tipo === 'BLOCCATO') {
                    slotColor = '#64748b';
                    slotBg = '#f1f5f9';
                }
                return '<div style="background:' + slotBg + ';padding:2px 4px;border-radius:3px;margin:1px 0;">' + (s.ora || 'SLOT') + ' <span style="color:' + slotColor + ';font-weight:700;">[' + s.tipo + ']</span></div>';
            }).join('') + '</div><div class="audit-card-actions"><button class="btn-mini" style="background:var(--accent);color:white;flex:1;" onclick="loadRuleIntoEditor(\'' + id + '\')">✏️ CARICA</button><button class="btn-mini" style="background:var(--danger);color:white;" onclick="deleteRule(\'' + id + '\')">🗑️</button></div>';
        card.onclick = function () { document.querySelectorAll('.audit-card').forEach(function (c) { c.classList.remove('selected'); }); card.classList.add('selected'); highlightYear(r); };
        gal.appendChild(card);
    });
}
function loadRuleIntoEditor(regId) {
    const r = dbState.RegoleAttive[regId]; if (!r) return;
    editingRuleId = regId; // Salva l'ID - stiamo modificando questa regola
    isReactivatingRule = true; // Flag: stiamo riattivando questa regola, non creando una nuova versione
    activeSlots = (r.slots || []).map(function (s) { return Object.assign({}, s); });
    document.getElementById('ruleName').value = r.ruleName || '';
    document.getElementById('ruleRoomNameOverride').value = r.nomeStanza || '';
    document.getElementById('ruleFreq').value = r.freq;
    document.getElementById('ruleStart').value = r.validaDa || '';
    document.getElementById('ruleEnd').value = r.validaA || '';
    document.querySelectorAll('#uiSettimanale .btn-check').forEach(function (e) { e.classList.remove('active'); });
    if (r.freq === 'weekly' && r.giorni) r.giorni.forEach(function (wd) { const e = document.querySelector('[data-wd="' + wd + '"]'); if (e) e.classList.add('active'); });
    if (r.freq === 'biweekly') {
        // Carica giorni settimana bisettimanali
        document.querySelectorAll('#uiBiweekly .btn-check[data-bwd]').forEach(e => e.classList.remove('active'));
        if (r.biweeklyWeekdays) {
            r.biweeklyWeekdays.forEach(wd => {
                const e = document.querySelector('#uiBiweekly .btn-check[data-bwd="' + wd + '"]');
                if (e) e.classList.add('active');
            });
        }
        // Carica data di riferimento
        if (r.biweeklyAnchor) {
            document.getElementById('biweeklyAnchor').value = r.biweeklyAnchor;
        }
    }
    if (r.freq === 'monthly_specific') {
        // Carica giorni settimana
        document.querySelectorAll('#uiMonthlySpecific .btn-check[data-wd]').forEach(e => e.classList.remove('active'));
        if (r.monthlyWeekdays) {
            r.monthlyWeekdays.forEach(wd => {
                const e = document.querySelector('#uiMonthlySpecific .btn-check[data-wd="' + wd + '"]');
                if (e) e.classList.add('active');
            });
        }
        // Carica occorrenze
        document.querySelectorAll('#uiMonthlySpecific .btn-check[data-occ]').forEach(e => e.classList.remove('active'));
        if (r.monthlyOccurrences) {
            r.monthlyOccurrences.forEach(occ => {
                const e = document.querySelector('#uiMonthlySpecific .btn-check[data-occ="' + occ + '"]');
                if (e) e.classList.add('active');
            });
        }
    }
    if (r.freq === 'monthly' && r.date) selectedDates = new Set(r.date);
    if (r.freq === 'once') document.getElementById('onceDate').value = r.dataSpecifica || '';
    toggleFreqUI(); refreshEditorUI(); closeAuditModal();
    showToast("Regola caricata - premi SALVA per riattivarla");
}
async function deleteRule(regId) {
    if (!confirm("Eliminare questa regola?")) return;
    try { await remove(ref(db, ROOT + '/RegoleAttive/' + regId)); showToast("✅ Eliminata", "success"); renderAuditGallery(); }
    catch (e) { showToast("Errore: " + e.message, "error"); }
}
let currentAuditYear = new Date().getFullYear();
let currentAuditRule = null;

function highlightYear(rule, year) {
    if (!year) year = currentAuditYear;
    currentAuditRule = rule;
    currentAuditYear = year;

    const c = document.getElementById('auditYearView'); c.innerHTML = '';
    document.getElementById('auditYearDisplay').textContent = year;

    ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"].forEach(function (mN, mI) {
        const mini = document.createElement('div'); mini.className = 'mini-month';
        mini.innerHTML = '<div class="mini-month-title">' + mN + ' ' + year + '</div><div class="mini-month-grid"></div>';
        const grid = mini.querySelector('.mini-month-grid');
        ['L', 'M', 'M', 'G', 'V', 'S', 'D'].forEach(function (h) { const d = document.createElement('div'); d.className = 'm-day hdr'; d.textContent = h; grid.appendChild(d); });
        const days = new Date(year, mI + 1, 0).getDate(), first = new Date(year, mI, 1).getDay() || 7;
        for (let i = 1; i < first; i++) { const e = document.createElement('div'); grid.appendChild(e); }
        for (let d = 1; d <= days; d++) {
            const cur = new Date(year, mI, d), iso = cur.toLocaleDateString('sv-SE'), wd = cur.getDay() === 0 ? 7 : cur.getDay();
            let active = false;
            if (rule.freq === 'weekly' && rule.giorni) active = rule.giorni.includes(wd);
            else if (rule.freq === 'biweekly' && rule.biweeklyWeekdays && rule.biweeklyAnchor) {
                active = matchesBiweekly(cur, rule.biweeklyWeekdays, rule.biweeklyAnchor);
            }
            else if (rule.freq === 'monthly_specific' && rule.monthlyWeekdays && rule.monthlyOccurrences) {
                active = matchesMonthlyOccurrence(cur, rule.monthlyWeekdays, rule.monthlyOccurrences);
            }
            else if (rule.freq === 'monthly' && rule.date) active = rule.date.includes(iso);
            else if (rule.freq === 'once') active = rule.dataSpecifica === iso;
            if (active && rule.validaDa && iso < rule.validaDa) active = false;
            if (active && rule.validaA && iso > rule.validaA) active = false;
            const el = document.createElement('div'); el.className = 'm-day' + (active ? ' active-rule' : ''); el.textContent = d;
            grid.appendChild(el);
        }
        c.appendChild(mini);
    });
}

function changeAuditYear(delta) {
    if (!currentAuditRule) return;
    currentAuditYear += delta;
    highlightYear(currentAuditRule, currentAuditYear);
}

function goToAuditCurrentYear() {
    if (!currentAuditRule) return;
    currentAuditYear = new Date().getFullYear();
    highlightYear(currentAuditRule, currentAuditYear);
}


// ===================== TIME SEL =====================
function buildTimeSel(prefix, val) {
    var h = '', m = '';
    if (val && val.includes(':')) { var p = val.split(':'); h = p[0]; m = p[1]; }
    var hH = '<select class="' + prefix + '-h" style="padding:6px;font-weight:bold;border-radius:5px;border:1px solid #cbd5e1;font-size:12px;">';
    hH += '<option value="" disabled' + (h === '' ? ' selected' : '') + '>--</option>';
    for (var i = 7; i <= 20; i++) hH += '<option value="' + String(i).padStart(2, '0') + '"' + (h !== '' && parseInt(h) === i ? ' selected' : '') + '>' + String(i).padStart(2, '0') + '</option>';
    hH += '</select>';
    var mH = '<select class="' + prefix + '-m" style="padding:6px;font-weight:bold;border-radius:5px;border:1px solid #cbd5e1;font-size:12px;">';
    mH += '<option value="" disabled' + (m === '' ? ' selected' : '') + '>--</option>';
    for (var j = 0; j < 60; j += 5) mH += '<option value="' + String(j).padStart(2, '0') + '"' + (m !== '' && parseInt(m) === j ? ' selected' : '') + '>' + String(j).padStart(2, '0') + '</option>';
    mH += '</select>';
    return '<div style="display:flex;align-items:center;gap:4px;">' + hH + '<span style="font-weight:bold;">:</span>' + mH + '</div>';
}


// ===================== FUNZIONI PAZIENTE =====================
function mostraFormNuovo() { 
    document.getElementById("newPatientForm").style.display = "block";
    // Precompila cognome/nome dal testo di ricerca
    const searchText = (document.getElementById('searchPaziente').value || '').trim();
    if (searchText) {
        const parts = searchText.split(/\s+/);
        // Se c'è un solo termine → metti in cognome; se due+ → cognome + nome
        const cognome = parts[0] || '';
        const nome = parts.slice(1).join(' ') || '';
        const elL = document.getElementById('newL');
        const elF = document.getElementById('newF');
        if (elL && !elL.value) elL.value = cognome.charAt(0).toUpperCase() + cognome.slice(1).toLowerCase();
        if (elF && !elF.value && nome) elF.value = nome.charAt(0).toUpperCase() + nome.slice(1).toLowerCase();
    }
    // Se c'era un paziente selezionato, deseleziona
    if (selectedPazId) deselectPaziente();
}
function chiudiModal(id) { document.getElementById(id).classList.remove('open'); }

function apriNuovo(catId, rowNo, label, tpl, oraRaw) {
    currentSlot = { catId, rowNo, label, tpl, ora: oraRaw }; // <--- FIX: salvo oraRaw in .ora
    selectedPazId = null; // Reset selezione paziente
    if(document.getElementById('searchPaziente')) document.getElementById('searchPaziente').value = '';
    if(document.getElementById('searchResults')) document.getElementById('searchResults').innerHTML = '<div class="sr-item" style="color:var(--success);font-weight:bold;" onclick="mostraFormNuovo()">+ Nuovo paziente</div>';
    if(document.getElementById('newPatientForm')) document.getElementById('newPatientForm').style.display = 'none';
    if(document.getElementById('selectedPazArea')) document.getElementById('selectedPazArea').style.display = 'none';
    
    // SAFE CHECK: Evita crash se gli elementi non esistono
    ['newL', 'newF', 'newD', 'newP', 'newNote', 'pauseLabel'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = '';
    });

    const modal = document.getElementById('modalNuovo');
    if(modal) modal.classList.add('open');
}

function apriModifica(appt) {
    currentAppt = appt;
    const p = dbState.Pazienti.find(px => String(px.id) === String(appt.pazienteID)) || {};

    const { firstName: f, lastName: l } = getDecryptedNames(p);

    if(document.getElementById('editL')) document.getElementById('editL').value = l;
    if(document.getElementById('editF')) document.getElementById('editF').value = f;
    
    if(document.getElementById('editD')) document.getElementById('editD').value = formatDob(p.dob || p.d || '');
    if(document.getElementById('editP')) document.getElementById('editP').value = p.phone || p.telefono || '';
    if(document.getElementById('editNote')) document.getElementById('editNote').value = appt.pazienteNote || '';
    
    const modal = document.getElementById('modalEdit');
    if(modal) modal.classList.add('open');
}

function searchPazienti() {
    const q = document.getElementById('searchPaziente').value.trim().toLowerCase();
    const res = document.getElementById('searchResults'); res.innerHTML = '';
    if (!q) {
        res.innerHTML = '<div class="sr-item" style="color:var(--success);font-weight:bold;" onclick="mostraFormNuovo()">+ Nuovo paziente</div>';
        document.getElementById('newPatientForm').style.display = 'none';
        return;
    }
    const found = dbState.Pazienti.filter(p => {
        const { firstName, lastName } = getDecryptedNames(p);
        return (lastName + ' ' + firstName).toLowerCase().includes(q);
    });
    if (!found.length) {
        res.innerHTML = '<div class="sr-item" style="color:#94a3b8;">Nessun paziente trovato</div><div class="sr-item" style="color:var(--success);font-weight:bold;" onclick="mostraFormNuovo()">+ Nuovo paziente</div>';
        mostraFormNuovo();
    } else {
        document.getElementById('newPatientForm').style.display = 'none';
        found.forEach(p => {
            const item = document.createElement('div'); item.className = 'sr-item';

            const { firstName, lastName } = getDecryptedNames(p);
            const dobDisplay = formatDob(p.dob || p.d || '');
            item.innerHTML = '<strong>' + (lastName + ' ' + firstName).toUpperCase() + '</strong> <span style="color:#94a3b8;font-size:11px;">' + dobDisplay + '</span>';
            item.onclick = () => selezionaPaziente(p.id);
            res.appendChild(item);
        });
    }
}

async function prenotaPaziente(pazId) {
    const iso = currentDate.toLocaleDateString('sv-SE');
    const note = document.getElementById('newNote').value.trim();
    try {
        // Estrai oraInizio dallo slot corrente
        const oraInizio = currentSlot.ora ? (currentSlot.ora.includes(' - ') ? currentSlot.ora.split(' - ')[0] : currentSlot.ora) : null;

        const newRef = push(ref(db, ROOT + '/GiroVisite'));
        await set(newRef, {
            data: iso,
            stanzaID: currentSlot.catId,
            rowNo: currentSlot.rowNo,  // Teniamo per compatibilità temporanea
            oraInizio: oraInizio,      // NUOVO: orario specifico (robusto)
            pazienteID: pazId,
            // pazienteNome rimosso: il nome si legge da /pazienti (criptato) tramite pazienteID
            pazienteNote: note || null
        });
        lastAction = { type: 'insert', id: newRef.key };
        document.getElementById('undoBtn').disabled = false;
        chiudiModal('modalNuovo');
        showToast("✅ Prenotato", "success");
    } catch (e) { showToast("Errore: " + e.message, "error"); }
}

// ===================== SELEZIONE PAZIENTE (senza chiudere il popup) =====================
function selezionaPaziente(pazId) {
    selectedPazId = pazId;
    const name = getPatientName(pazId);
    const area = document.getElementById('selectedPazArea');
    const nameEl = document.getElementById('selectedPazName');
    if (area && nameEl) {
        nameEl.textContent = '👤 ' + name;
        area.style.display = 'block';
    }
    // Nascondi la lista risultati ma mostra comunque "+ Nuovo paziente"
    const res = document.getElementById('searchResults');
    res.innerHTML = '<div class="sr-item" style="color:var(--success);font-weight:bold;" onclick="mostraFormNuovo()">+ Nuovo paziente</div>';
    // Nascondi form nuovo paziente se era aperto
    document.getElementById('newPatientForm').style.display = 'none';
    // Focus sulla textarea delle note, così l'utente può aggiungere note prima di salvare
    const noteEl = document.getElementById('newNote');
    if (noteEl) noteEl.focus();
}

function deselectPaziente() {
    selectedPazId = null;
    const area = document.getElementById('selectedPazArea');
    if (area) area.style.display = 'none';
    // Rilancia la ricerca per rimostrare i risultati
    searchPazienti();
    const input = document.getElementById('searchPaziente');
    if (input) input.focus();
}

function confermaPrenotazione() {
    if (!selectedPazId) {
        showToast("⚠️ Nessun paziente selezionato", "error");
        return;
    }
    prenotaPaziente(selectedPazId);
}


// ===== ANTI-DUPLICATI: Usa js/duplicate-checker.js (libreria condivisa) =====

// ===================== PAUSA E BLOCCO COME APPUNTAMENTI =====================
async function setPauseFromModal() {
    if (!currentSlot) return;
    const label = document.getElementById('pauseLabel').value.trim() || 'PAUSA';
    // QUI STA IL TRUCCO: Invece di creare una regola, creo un appuntamento speciale
    await saveFakeAppointment(currentSlot.catId, currentSlot.rowNo, 'PAUSA', label);
    chiudiModal('modalNuovo');
}
async function toggleSlotFromModal() {
    if (!currentSlot) return;
    await saveFakeAppointment(currentSlot.catId, currentSlot.rowNo, 'BLOCCATO', 'BLOCCATO');
    chiudiModal('modalNuovo');
}
// Funzione che salva pausa/blocco nella tabella VISITE (non Regole)
async function saveFakeAppointment(catId, rowNo, typeID, label) {
    const iso = currentDate.toLocaleDateString('sv-SE');
    try {
        const newRef = push(ref(db, ROOT + '/GiroVisite'));
        await set(newRef, {
            data: iso, stanzaID: catId, rowNo: rowNo,
            pazienteID: typeID, // "PAUSA" o "BLOCCATO"
            pazienteNome: label, pazienteNote: null
        });
        showToast("✅ Salvato", "success");
    } catch (e) { showToast("Errore: " + e.message, "error"); }
}
function rimuoviPausaDalloSlot() {
    // Non serve fare nulla di speciale, basta chiud이re. 
    // Se c'era un appuntamento speciale, l'utente lo cancella col tasto eliminaAppt o sblocca.
    chiudiModal('modalNuovo');
}

// ===================== FUNZIONE CERCA STORICO =====================
window.openSearchModal = function () {
    const m = document.getElementById('modalHistory');
    if(m) m.classList.add('open');
    const i = document.getElementById('histInput');
    if(i) i.focus();
};

window.doSearchHistory = async function (txt) {
    let resDiv = document.getElementById('histResults');
    resDiv.innerHTML = '';
    if (txt.length < 2) return;

    txt = txt.toLowerCase();

    // A. Cerca i pazienti che corrispondono al nome (dalla cache locale, sempre in memoria)
    let pazTrovati = dbState.Pazienti.filter(p => {
        const { firstName, lastName } = getDecryptedNames(p);
        const full = (lastName + " " + firstName).toLowerCase();
        const fullRev = (firstName + " " + lastName).toLowerCase();
        return full.includes(txt) || fullRev.includes(txt);
    });

    if (pazTrovati.length === 0) {
        resDiv.innerHTML = '<div style="padding:10px;color:#94a3b8;">Nessun paziente trovato.</div>';
        return;
    }

    resDiv.innerHTML = '<div style="padding:10px;color:#64748b;">🔍 Ricerca appuntamenti in corso...</div>';

    // B. Scarica TUTTI gli appuntamenti UNA TANTUM (get, non listener)
    try {
        const snap = await get(ref(db, ROOT + '/GiroVisite'));
        const raw = snap.val();
        const sourceList = raw ? Object.entries(raw).map(([id, v]) => ({ ...v, id })) : [];
        
        resDiv.innerHTML = '';
        let count = 0;

    pazTrovati.forEach(p => {
        let appuntamenti = sourceList.filter(g => String(g.pazienteID) === String(p.id));

        // Ordina per data (dal più recente)
        appuntamenti.sort((a, b) => new Date(b.data) - new Date(a.data));

        if (appuntamenti.length > 0) {
            const { firstName, lastName } = getDecryptedNames(p);

            // Intestazione Paziente
            let pHeader = document.createElement('div');
            pHeader.style.cssText = "background:#e2e8f0;padding:5px 10px;font-weight:bold;font-size:12px;margin-top:10px;border-radius:4px;";
            pHeader.innerText = (lastName + " " + firstName).toUpperCase();
            resDiv.appendChild(pHeader);

            appuntamenti.forEach(app => {
                // Recupera nome stanza
                let stanza = dbState.Categorie.find(c => String(c.id) === String(app.stanzaID));
                let nomeStanza = stanza ? stanza.name : "Stanza Cancellata";

                let row = document.createElement('div');
                row.className = 'hist-item';
                row.innerHTML = `
            <div class="hist-date">${app.data.split('-').reverse().join('/')}</div>
            <div class="hist-info">
                <span class="hist-room">${nomeStanza} (Slot ${app.rowNo})</span>
                <span class="hist-note">${app.pazienteNote || 'Nessuna nota'}</span>
            </div>
            <div class="hist-action">➔</div>
        `;
                row.onclick = function () {
                    window.jumpToDate(app.data);
                    document.getElementById('modalHistory').classList.remove('open');
                    setTimeout(() => {
                        let allCards = document.querySelectorAll('.patient-card');
                        allCards.forEach(c => {
                            const lastName = p.lastName || p.l || '';
                            if (lastName && c.innerText.toUpperCase().includes(lastName.toUpperCase())) {
                                c.style.boxShadow = "0 0 0 4px #f59e0b";
                                setTimeout(() => c.style.boxShadow = "none", 2000);
                            }
                        });
                    }, 500);
                };
                resDiv.appendChild(row);
            });
            count++;
        }
    });

    if (count === 0) {
        resDiv.innerHTML += '<div style="padding:10px;color:#94a3b8;">Paziente trovato in anagrafica, ma nessun appuntamento registrato.</div>';
    }
    } catch (e) {
        console.error('❌ Errore ricerca storica:', e);
        resDiv.innerHTML = '<div style="padding:10px;color:#ef4444;">Errore durante la ricerca. Riprova.</div>';
    }
};



// ESC handler
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Se c'è la modale conflitti aperta, chiedi conferma
        const conflictModal = document.getElementById('modalConflict');
        if (conflictModal && conflictModal.classList.contains('open')) {
            closeConflictModal();
            return;
        }

        // Altrimenti comportamento normale
        if (movingAppt) {
            // Se stiamo gestendo conflitti, torna alla modale
            if (conflictData && conflictData.appointments && conflictData.appointments.length > 0) {
                backToConflictModal();
            } else {
                movingAppt = null;
                render();
            }
        }
        chiudiModal('modalNuovo');
        chiudiModal('modalEdit');
        document.getElementById('modalHistory').classList.remove('open');
        document.getElementById('modalTimePicker').classList.remove('open');
    }
});


// ===================== NAV =====================
function changeDate(n) { currentDate.setDate(currentDate.getDate() + n); fetchGiroVisite(); }
function goToday() { currentDate = new Date(); fetchGiroVisite(); }

// ===================== ZOOM =====================
let zoomLevel = 110; // Percentuale zoom (80%, 90%, 100%, 120%, ecc.) - default 90%

function updateZoom() {
    const root = document.documentElement;
    const factor = zoomLevel / 100;

    const cellHeight = 23;  // FISSO a 20px
    const fasciaHeight = 23;  // FISSO a 20px
    const columnWidth = Math.round(210 * factor);
    const fontOra = Math.round(9 * factor);
    const fontPaziente = Math.round(11 * factor);

    root.style.setProperty('--zoom-cell-height', cellHeight + 'px');
    root.style.setProperty('--zoom-cell-fascia-height', fasciaHeight + 'px');
    root.style.setProperty('--zoom-column-width', columnWidth + 'px');
    root.style.setProperty('--zoom-font-ora', fontOra + 'px');
    root.style.setProperty('--zoom-font-paziente', fontPaziente + 'px');

    const zoomDisplay = document.getElementById('zoomLevel');
    if (zoomDisplay) zoomDisplay.textContent = zoomLevel + '%';

    const btnOut = document.getElementById('zoomOutBtn');
    const btnIn = document.getElementById('zoomInBtn');
    if (btnOut && btnIn) {
        btnOut.disabled = (zoomLevel <= 60);
        btnIn.disabled = (zoomLevel >= 150);
    }
}

function zoomIn() {
    if (zoomLevel < 150) { zoomLevel += 10; updateZoom(); localStorage.setItem('planningZoom', zoomLevel); }
}

function zoomOut() {
    if (zoomLevel > 60) { zoomLevel -= 10; updateZoom(); localStorage.setItem('planningZoom', zoomLevel); }
}

// Carica zoom salvato all'avvio (DOPO che DOM è pronto)
document.addEventListener('DOMContentLoaded', () => {
    const savedZoom = localStorage.getItem('planningZoom');
    if (savedZoom) {
        zoomLevel = parseInt(savedZoom);
    }
    updateZoom(); // Applica zoom (anche se è default 100%)
});

// ===================== BACKUP VELOCE =====================
async function quickBackup() {
    try {
        const snapshot = await get(ref(db, ROOT));
        const data = snapshot.val();

        if (!data) {
            showToast("Nessun dato da salvare", "error");
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `Backup_COMPLETO_${timestamp}.json`;

        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast("✅ Backup scaricato!", "success");
    } catch (error) {
        showToast("❌ Errore backup: " + error.message, "error");
        console.error('Errore backup:', error);
    }
}


// ===================== STAMPA =====================
function openPrintModal() {
    const modal = document.getElementById('modalPrint');
    const dateDisplay = document.getElementById('printDate');
    const roomsList = document.getElementById('printRoomsList');

    dateDisplay.textContent = currentDate.toLocaleDateString('it-IT', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });

    roomsList.innerHTML = '';
    dbState.Categorie.forEach(cat => {
        const item = document.createElement('label');
        item.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px; background:white; border-radius:6px; border:1px solid #e2e8f0; cursor:pointer;';
        item.innerHTML = `
    <input type="checkbox" class="print-room-check" data-cat-id="${cat.id}" style="width:18px; height:18px; cursor:pointer;">
    <div style="width:20px; height:20px; border-radius:4px; background:${getColor(cat.id)}; border:2px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.1);"></div>
    <span style="font-weight:700; color:var(--primary); flex:1;">${cat.name}</span>
`;
        roomsList.appendChild(item);
    });

    modal.classList.add('open');
}

function toggleAllPrintRooms(select) {
    document.querySelectorAll('.print-room-check').forEach(cb => {
        cb.checked = select;
    });
}

function executePrint() {
    const selectedRooms = Array.from(document.querySelectorAll('.print-room-check:checked'))
        .map(cb => cb.dataset.catId);

    if (selectedRooms.length === 0) {
        showToast("Seleziona almeno una stanza", "error");
        return;
    }

    // Verifica che i pazienti siano caricati
    if (!dbState.Pazienti || dbState.Pazienti.length === 0) {
        showToast("Caricamento pazienti in corso... Riprova tra un momento", "error");
        return;
    }

    document.getElementById('modalPrint').classList.remove('open');
    generatePrintHTML(selectedRooms);
}

function generatePrintHTML(roomIds) {
    const iso = currentDate.toLocaleDateString('sv-SE');
    const dateStr = currentDate.toLocaleDateString('it-IT', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });

    const isPortrait = roomIds.length === 1;
    const orientation = isPortrait ? 'portrait' : 'landscape';

    // Recupera la nota giornaliera dal DOM
    const dailyNoteEl = document.getElementById('dailyNoteText');
    const dailyNoteHTML = dailyNoteEl ? dailyNoteEl.innerHTML.trim() : '';
    const hasDailyNote = dailyNoteHTML && dailyNoteHTML !== '' && dailyNoteHTML !== '<br>';

    let html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Planning ${dateStr}</title>
    <style>
@page { size: A4 ${orientation}; margin: 8mm; }
@media print {
    html, body { height: 100%; overflow: hidden; margin: 0; padding: 0; }
    .no-print { display: none !important; }
    .container { max-height: ${isPortrait ? '27.5cm' : '18.5cm'} !important; }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; font-size: ${isPortrait ? '7px' : '6px'}; line-height: 1.05; }
.header { text-align: center; margin-bottom: ${isPortrait ? '6px' : '4px'}; border-bottom: 1px solid #0f172a; padding-bottom: ${isPortrait ? '4px' : '2px'}; }
.header h1 { margin: 0 0 2px 0; font-size: ${isPortrait ? '12px' : '10px'}; color: #0f172a; }
.header h2 { margin: 0; font-size: ${isPortrait ? '9px' : '8px'}; color: #64748b; font-weight: normal; }
.container { display: ${isPortrait ? 'block' : 'flex'}; gap: 2px; max-height: ${isPortrait ? '27.5cm' : '18.5cm'}; overflow: hidden; }
.room-column { ${isPortrait ? 'width:100%' : 'flex:1'}; border: 1px solid #cbd5e1; border-radius: 3px; overflow: hidden; display: flex; flex-direction: column; max-height: 100%; }
.room-header { background: #0f172a; color: white; padding: ${isPortrait ? '4px' : '2px'}; text-align: center; font-weight: bold; font-size: ${isPortrait ? '9px' : '7px'}; flex-shrink: 0; }
.room-body { overflow: hidden; flex: 1; }
.slot { border-bottom: 1px solid #e2e8f0; padding: ${isPortrait ? '3px 4px' : '2px 3px'}; }
.slot:last-child { border-bottom: none; }
.slot-time { font-weight: bold; color: #475569; font-size: ${isPortrait ? '7px' : '6px'}; margin-bottom: 1px; }
.slot-patient { font-weight: 800; color: #0f172a; font-size: ${isPortrait ? '8px' : '7px'}; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slot-phone { color: #64748b; font-size: ${isPortrait ? '7px' : '6px'}; margin-top: 1px; }
.slot-note { color: #94a3b8; font-size: ${isPortrait ? '6px' : '5px'}; font-style: italic; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slot-empty { color: #cbd5e1; font-style: italic; font-size: ${isPortrait ? '7px' : '6px'}; }
.slot-pause { background: #fef3c7; text-align: center; font-weight: bold; color: #f59e0b; font-size: ${isPortrait ? '7px' : '6px'}; padding: 2px; }
.slot-blocked { background: #f1f5f9; text-align: center; font-weight: bold; color: #64748b; font-size: ${isPortrait ? '7px' : '6px'}; padding: 2px; }
.btn-print { background: #10b981; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: bold; margin: 8px auto; display: block; }
.btn-print:hover { background: #059669; }
.daily-note-box { margin: ${isPortrait ? '4px 0 6px 0' : '3px 0 4px 0'}; padding: ${isPortrait ? '5px 8px' : '3px 6px'}; background: #fffbeb; border: 1.5px solid #f59e0b; border-radius: 4px; }
.daily-note-label { font-size: ${isPortrait ? '8px' : '7px'}; font-weight: 900; color: #b45309; text-transform: uppercase; margin-bottom: 2px; }
.daily-note-content { font-size: ${isPortrait ? '7px' : '6px'}; color: #1e293b; line-height: 1.4; }
    </style>
</head>
<body>
    <button class="btn-print no-print" onclick="window.print()">🖨️ STAMPA</button>
    <div class="header">
<h1>🏥 PLANNING OSPEDALE</h1>
<h2>${dateStr.toUpperCase()}</h2>
    </div>
    ${hasDailyNote ? `<div class="daily-note-box"><div class="daily-note-label">📝 NOTE DEL GIORNO</div><div class="daily-note-content">${dailyNoteHTML}</div></div>` : ''}
    <div class="container">
`;

    roomIds.forEach(catId => {
        const cat = dbState.Categorie.find(c => String(c.id) === String(catId));
        if (!cat) return;

        const { slots: tpl, nome: nomeOvr } = getTemplate(catId, currentDate);
        const roomName = nomeOvr || cat.name;
        const color = getColor(catId);

        html += `
<div class="room-column">
    <div class="room-header" style="background:${color}">${roomName}</div>
    <div class="room-body">
`;

        tpl.forEach((def, idx) => {
            const rowNo = idx + 1;
            const appt = dbState.GiroVisite.find(v =>
                v.data === iso &&
                String(v.stanzaID) === String(catId) &&
                String(v.rowNo) === String(rowNo)
            );

            if (appt && appt.pazienteID && appt.pazienteID !== 'PAUSA' && appt.pazienteID !== 'BLOCCATO') {
                const paz = dbState.Pazienti.find(p => String(p.id) === String(appt.pazienteID));
                const oraText = def.fasciaOraria ? 'SLOT ' + (def.slotNum || rowNo) : (def.ora || '');

                // Gestisci nomi criptati
                let patientName = appt.pazienteNome || 'N/D';
                if (paz) {
                    const { firstName, lastName } = getDecryptedNames(paz);
                    patientName = (lastName + ' ' + firstName).trim().toUpperCase();
                }

                html += `
    <div class="slot">
        <div class="slot-time">${oraText}</div>
        <div class="slot-patient">${patientName}</div>
        ${paz && (paz.telefono || paz.phone) ? `<div class="slot-phone">Tel: ${paz.telefono || paz.phone}</div>` : ''}
        <div class="slot-note">Note: ${appt.pazienteNote || '___________________________________________'}</div>
    </div>
`;
            }
            else if (appt && appt.pazienteID === 'PAUSA') {
                html += `<div class="slot slot-pause">☕ ${appt.pazienteNome || 'PAUSA'}</div>`;
            }
            else if (appt && appt.pazienteID === 'BLOCCATO') {
                html += `<div class="slot slot-blocked">🚫 ${appt.pazienteNome || 'BLOCCATO'}</div>`;
            }
            else if (def.tipo === 'PAUSA') {
                html += `<div class="slot slot-pause">☕ ${def.label || 'PAUSA'}</div>`;
            }
            else if (def.tipo === 'BLOCCATO') {
                html += `<div class="slot slot-blocked">🚫 ${def.label || 'BLOCCATO'}</div>`;
            }
            else {
                const oraText = def.fasciaOraria ? 'SLOT ' + (def.slotNum || rowNo) : (def.ora || '');
                html += `<div class="slot"><div class="slot-time">${oraText}</div><div class="slot-empty">(vuoto)</div></div>`;
            }
        });

        html += `
    </div>
</div>
`;
    });

    html += `
    </div>
    <script>
    setTimeout(() => window.print(), 100);
    window.onafterprint = function() {
setTimeout(() => window.close(), 300);
    };
    <\/script>
</body>
</html>
`;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(html);
    printWindow.document.close();
}

function jumpToDate(v) { if (v) { currentDate = new Date(v + "T12:00:00"); fetchGiroVisite(); } }

// ===================== MODIFICA, SPOSTA, ELIMINA APPUNTAMENTO =====================

async function salvaModifica() {
    if (!currentAppt) return;
    
    const lastName = document.getElementById('editL').value.trim();
    const firstName = document.getElementById('editF').value.trim();
    const dob = document.getElementById('editD').value.trim();
    const phone = document.getElementById('editP').value.trim();
    const note = document.getElementById('editNote').value.trim();
    
    // Mostra toast subito
    showToast("⏳ Salvataggio in corso...", "info");
    
    try {
        // Trova il paziente
        const paziente = dbState.Pazienti.find(p => String(p.id) === String(currentAppt.pazienteID));
        
        if (paziente) {
            // Aggiorna i dati del paziente se sono cambiati
            const updates = {};
            
            if (lastName || firstName) {
                if (lastName) updates.lastName_enc = encryptText(lastName);
                if (firstName) updates.firstName_enc = encryptText(firstName);
            }
            if (dob) updates.dob = dob;
            if (phone !== undefined) updates.telefono = phone || null;
            
            if (Object.keys(updates).length > 0) {
                await update(ref(db, ROOT + '/Pazienti/' + paziente.id), updates);
                
                // Aggiorna anche dbState.Pazienti
                Object.assign(paziente, updates);
            }
        }
        
        // Aggiorna le note dell'appuntamento
        if (note !== currentAppt.pazienteNote) {
            await update(ref(db, ROOT + '/GiroVisite/' + currentAppt.id), {
                pazienteNote: note || null
            });
        }
        
        chiudiModal('modalEdit');
        showToast("✅ Modifiche salvate", "success");
        
    } catch (e) {
        showToast("❌ Errore: " + e.message, "error");
        console.error("Errore salvataggio:", e);
    }
}

function startMove() {
    if (!currentAppt) return;
    
    movingAppt = currentAppt;
    chiudiModal('modalEdit');
    showToast("🔄 Clicca sulla nuova posizione per spostare", "");
    
    // Evidenzia l'appuntamento in movimento
    const cells = document.querySelectorAll('.patient-card');
    cells.forEach(card => {
        if (card.textContent.includes(getPatientName(currentAppt.pazienteID))) {
            card.classList.add('moving-appt');
        }
    });
}

async function finalizzaSpostaSpecifico(id, catId, rowNo, targetDate) {
    const old = dbState.GiroVisite.find(v => v.id === id);
    if (!old) {
        console.error('❌ Appuntamento non trovato:', id);
        return;
    }
    
    lastAction = { type: 'move', id, prev: { stanzaID: old.stanzaID, rowNo: old.rowNo, data: old.data, oraInizio: old.oraInizio } };

    // Trova l'orario dello slot di destinazione
    const iso = targetDate || currentDate.toLocaleDateString('sv-SE');
    const destDate = new Date(iso);
    const destTemplate = getTemplate(catId, destDate);
    const destSlot = destTemplate.slots[rowNo - 1];
    
    // Per fasce orarie, NON salvare oraInizio (tutti gli slot hanno la stessa ora)
    // Usa solo rowNo per distinguerli
    let oraInizio = null;
    if (destSlot && !destSlot.fasciaOraria && destSlot.ora) {
        oraInizio = destSlot.ora.includes(' - ') ? destSlot.ora.split(' - ')[0] : destSlot.ora;
    }


    // IMPORTANTE: Reset movingAppt PRIMA dell'update per evitare che il listener mostri duplicati
    const wasMoving = movingAppt !== null;
    movingAppt = null;

    await update(ref(db, ROOT + '/GiroVisite/' + id), {
        stanzaID: catId,
        rowNo: rowNo,
        data: iso,
        oraInizio: oraInizio
    });
    
    
    document.getElementById('undoBtn').disabled = false;
}

async function finalizzaSposta(catId, rowNo) {
    if (!movingAppt) return;

    try {
        const movedApptId = movingAppt.id;
        const wasInConflictMode = (conflictData && conflictData.appointments && conflictData.appointments.length > 0);

        // IMPORTANTE: Chiama finalizzaSpostaSpecifico (che resetterà movingAppt)
        await finalizzaSpostaSpecifico(movedApptId, catId, rowNo, currentDate.toLocaleDateString('sv-SE'));

        // Se stiamo gestendo conflitti, aggiorna la lista
        if (wasInConflictMode && conflictData && conflictData.appointments) {
            conflictData.appointments = conflictData.appointments.filter(a => a.id !== movedApptId);

            document.getElementById('conflictTotalCount').textContent = conflictData.appointments.length;
            updateConflictSaveButton();

            movingAppt = null;

            // Riapri la modale conflitti con rendering aggiornato
            setTimeout(() => {
                const modal = document.getElementById('modalConflict');
                if (modal) {
                    modal.classList.add('open');
                    modal.style.display = 'flex';
                    conflictRenderCurrentDay();
                }
            }, 300);

            if (conflictData.appointments.length > 0) {
                showToast(`✅ Appuntamento spostato! Ne restano ${conflictData.appointments.length}`, "success");
            } else {
                showToast("✅ Tutti sistemati! Clicca SALVA per confermare.", "success");
            }
            return;
        }

        // Spostamento NORMALE (non da conflict manager)
        movingAppt = null;
        render();

    } catch (e) {
        showToast("Errore spostamento: " + e.message, "error");
        console.error("Errore in finalizzaSposta:", e);

        movingAppt = null;
        render();

        if (conflictData && conflictData.appointments && conflictData.appointments.length > 0) {
            setTimeout(() => {
                const modal = document.getElementById('modalConflict');
                if (modal) modal.classList.add('open');
            }, 500);
        }
    }
}

async function eliminaAppt() {
    if (!currentAppt) return;
    
    const pazienteNome = getPatientName(currentAppt.pazienteID);
    
    if (!confirm(`🗑️ Eliminare l'appuntamento di ${pazienteNome}?`)) {
        return;
    }
    
    try {
        // Salva per undo
        const snapshot = await get(ref(db, ROOT + '/GiroVisite/' + currentAppt.id));
        lastAction = {
            type: 'delete',
            id: currentAppt.id,
            data: snapshot.val()
        };
        document.getElementById('undoBtn').disabled = false;
        
        // Elimina
        await remove(ref(db, ROOT + '/GiroVisite/' + currentAppt.id));
        
        chiudiModal('modalEdit');
        showToast("✅ Appuntamento eliminato", "success");
        
    } catch (e) {
        showToast("❌ Errore: " + e.message, "error");
        console.error("Errore eliminazione:", e);
    }
}

// ===================== CREA NUOVO PAZIENTE E PRENOTA =====================
async function creaERiserva() {
    // Verifica che duplicate-checker.js sia caricato
    if (typeof findDuplicatePatients === 'undefined') {
        console.error('❌ ERRORE: duplicate-checker.js non è caricato!');
        showToast("⚠️ Errore sistema anti-duplicati", "error");
        return;
    }
    
    if (!window.appPassword) {
        alert('❌ ERRORE: Password non disponibile! Ricarica la pagina.');
        return;
    }
    
    const lastName = document.getElementById('newL').value.trim();
    const firstName = document.getElementById('newF').value.trim();
    const dob = document.getElementById('newD').value.trim();
    const phone = document.getElementById('newP').value.trim();
    const note = document.getElementById('newNote').value.trim();
    
    // Validazione base
    if (!lastName || !firstName) {
        showToast("⚠️ Compila cognome e nome", "error");
        return;
    }
    
    // ===== CONTROLLO DUPLICATI usando duplicate-checker.js =====
    try {
        const similar = findDuplicatePatients(
            dbState.Pazienti,
            lastName,
            firstName,
            dob,
            null,  // excludeId (null perché è un nuovo paziente)
            decryptText  // funzione per decriptare nomi criptati
        );
        
        if (similar.length > 0) {
            const { message, shouldBlock } = formatDuplicateMessage(similar, lastName, firstName, dob);
            
            if (shouldBlock) {
                // DUPLICATO ESATTO - BLOCCA
                alert(message);
                return;
            } else {
                // DUPLICATO PROBABILE/POSSIBILE - CHIEDI CONFERMA
                if (!confirm(message)) {
                    return;  // Utente ha annullato
                }
            }
        }
    } catch (e) {
        console.warn("Errore controllo duplicati:", e);
        // Continua comunque se il controllo fallisce
    }
    
    // ===== CREA IL NUOVO PAZIENTE =====
    try {
        // Genera ID numerico progressivo (trova il max tra gli ID numerici esistenti + 1)
        let maxId = 0;
        dbState.Pazienti.forEach(p => {
            const numId = parseInt(p.id);
            if (!isNaN(numId) && numId > maxId) maxId = numId;
        });
        const newPatientId = String(maxId + 1);
        
        const encryptedLastName = encryptText(lastName);
        const encryptedFirstName = encryptText(firstName);
        
        const patientData = {
            id: newPatientId,
            lastName_enc: encryptedLastName,
            firstName_enc: encryptedFirstName,
            dob: dob,
            telefono: phone || null,
            dataCreazione: new Date().toISOString()
        };
        
        await set(ref(db, ROOT + '/pazienti/' + newPatientId), patientData);
        
        // ===== AGGIUNGI IL PAZIENTE A dbState.Pazienti SUBITO =====
        // Così getPatientName lo trova immediatamente!
        dbState.Pazienti.push({
            id: newPatientId,
            ...patientData
        });
        
        // ===== PRENOTA SUBITO LO SLOT =====
        const iso = currentDate.toLocaleDateString('sv-SE');
        const oraInizio = currentSlot.ora ? (currentSlot.ora.includes(' - ') ? currentSlot.ora.split(' - ')[0] : currentSlot.ora) : null;
        
        const newApptRef = push(ref(db, ROOT + '/GiroVisite'));
        await set(newApptRef, {
            data: iso,
            stanzaID: currentSlot.catId,
            rowNo: currentSlot.rowNo,
            oraInizio: oraInizio,
            pazienteID: newPatientId,
            // NON salviamo pazienteNome - verrà letto e decriptato dal record Pazienti
            pazienteNote: note || null
        });
        
        lastAction = { type: 'insert', id: newApptRef.key };
        document.getElementById('undoBtn').disabled = false;
        
        chiudiModal('modalNuovo');
        showToast("✅ Paziente creato e prenotato!", "success");
        
    } catch (e) {
        showToast("❌ Errore: " + e.message, "error");
        console.error("Errore creazione paziente:", e);
    }
}

// ===================== EXPOSE GLOBALI (script type=module non esporta) =====================
window.changeDate = changeDate;
window.goToday = goToday;
window.jumpToDate = jumpToDate;
window.openModalRule = openModalRule;
window.closeModalRule = closeModalRule;
window.toggleFreqUI = toggleFreqUI;
window.toggleWd = toggleWd;
window.matchesBiweekly = matchesBiweekly;
window.drawEditorCalendar = drawEditorCalendar;
window.addOrUpdateBlock = addOrUpdateBlock;
window.resetCurrentConfig = resetCurrentConfig;
window.loadEdit = loadEdit;
window.deleteSlot = deleteSlot;
window.saveMasterRule = saveMasterRule;
window.saveRuleData = saveRuleData;
window.checkImpactedAppointments = checkImpactedAppointments;
window.openConflictModal = openConflictModal;
window.closeConflictModal = closeConflictModal;
window.startConflictMove = startConflictMove;
window.startConflictMoveOther = startConflictMoveOther;
window.moveConflictToNewSlot = moveConflictToNewSlot;
window.deleteConflictAppt = deleteConflictAppt;
window.proceedWithRuleSave = proceedWithRuleSave;
window.backToConflictModal = backToConflictModal;
window.exportConflictList = exportConflictList;
window.deleteAllConflicts = deleteAllConflicts;
window.updateConflictSaveButton = updateConflictSaveButton;
window.conflictPrevDay = conflictPrevDay;
window.conflictNextDay = conflictNextDay;
window.conflictResetDest = conflictResetDest;
window.conflictRenderRight = conflictRenderRight;
window.conflictRenderCurrentDay = conflictRenderCurrentDay;
window.conflictMoveAppt = conflictMoveAppt;
window.conflictSaveRule = conflictSaveRule;
window.openAuditModal = openAuditModal;
window.closeAuditModal = closeAuditModal;
window.loadRuleIntoEditor = loadRuleIntoEditor;
window.deleteRule = deleteRule;
window.previewLive = previewLive;
window.resetCampi = resetCampi;
window.undoAction = undoAction;
window.saveDailyNote = saveDailyNote;
window.mostraFormNuovo = mostraFormNuovo;
window.chiudiModal = chiudiModal;
window.searchPazienti = searchPazienti;
window.creaERiserva = creaERiserva;
window.prenotaPaziente = prenotaPaziente;
window.selezionaPaziente = selezionaPaziente;
window.deselectPaziente = deselectPaziente;
window.confermaPrenotazione = confermaPrenotazione;
window.salvaModifica = salvaModifica;
window.startMove = startMove;
window.finalizzaSposta = finalizzaSposta;
window.finalizzaSpostaSpecifico = finalizzaSpostaSpecifico;
window.eliminaAppt = eliminaAppt;
window.apriModifica = apriModifica;
window.setPauseFromModal = setPauseFromModal;
window.rimuoviPausaDalloSlot = rimuoviPausaDalloSlot;
window.toggleSlotFromModal = toggleSlotFromModal;
window.openSearchModal = openSearchModal;
window.doSearchHistory = doSearchHistory;
window.recalculateList = recalculateList;
window.zoomIn = zoomIn;
window.zoomOut = zoomOut;
window.quickBackup = quickBackup;
window.changeAuditYear = changeAuditYear;
window.goToAuditCurrentYear = goToAuditCurrentYear;
window.openPrintModal = openPrintModal;
window.toggleAllPrintRooms = toggleAllPrintRooms;
window.executePrint = executePrint;
window.dbState = dbState;
window.findRegolaPer = findRegolaPer;
window.getPatientName = getPatientName;
window.currentDate = currentDate;

// Posiziona il popup della nota vicino al mouse
window.positionNotePopup = function (event, cloudWrapper) {
    const popup = cloudWrapper.querySelector('.custom-note-popup');
    if (popup) {
        // Usa le coordinate RELATIVE alla viewport invece che assolute
        // Così funziona anche se le colonne vengono riordinate
        const rect = cloudWrapper.getBoundingClientRect();
        
        // Calcola posizione ideale: a destra della nuvoletta
        let left = rect.right + 10; // 10px a destra della nuvoletta
        let top = rect.top;
        
        // Se esce dallo schermo a destra, mostralo a sinistra
        if (left + 250 > window.innerWidth) {
            left = rect.left - 260; // A sinistra della nuvoletta
        }
        
        // Se esce dallo schermo in basso, aggiusta
        if (top + 100 > window.innerHeight) {
            top = window.innerHeight - 110;
        }
        
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
    }
};

// ===================== VISIBILITY CHANGE: risparmio letture Firebase =====================
// Quando il tab va in background, stacca tutti i listener per non consumare banda/letture.
// Quando torna visibile, riattacca tutto e ricevi dati freschi.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Tab in background → stacca listener
        detachFirebaseListeners();
    } else {
        // Tab visibile → riattacca listener (solo se erano stati staccati)
        reattachFirebaseListeners();
    }
});

// ===================== INIT =====================
document.getElementById('genStartContainer').innerHTML = buildTimeSel('gen-start', '');
populateJumpers();

// Listener anteprima live: ogni cambio campo → previewLive()
document.querySelector('.gen-start-h').addEventListener('change', previewLive);
document.querySelector('.gen-start-m').addEventListener('change', previewLive);
document.getElementById('genDur').addEventListener('input', previewLive);
document.getElementById('genNum').addEventListener('input', previewLive);
document.getElementById('genTipo').addEventListener('change', previewLive);
document.getElementById('genLabel').addEventListener('input', previewLive);

// Funzione che aspetta che la password sia disponibile
function waitForPassword() {
    return new Promise((resolve) => {
        // Se la password è già disponibile, risolvi immediatamente
        if (window.appPassword) {
            console.log('✅ Password già disponibile');
            resolve();
            return;
        }
        
        // Altrimenti, controlla ogni 100ms fino a quando non è disponibile
        const checkInterval = setInterval(() => {
            if (window.appPassword) {
                console.log('✅ Password ora disponibile');
                clearInterval(checkInterval);
                resolve();
            }
        }, 100);
        
        // Timeout dopo 10 secondi
        setTimeout(() => {
            clearInterval(checkInterval);
            console.error('❌ Timeout: password non disponibile dopo 10 secondi');
            resolve(); // Risolvi comunque per non bloccare l'app
        }, 10000);
    });
}

// Eseguiamo l'accesso anonimo e aspettiamo la password prima di caricare i dati
signInAnonymously(auth)
    .then(() => {
        // Controllo di sicurezza: mostra l'ID del progetto attivo nella console del browser
        console.log("🚀 Database Attivo:", firebaseConfig.projectId); 
        console.log("✅ Accesso Anonimo riuscito.");
        
        // Aspetta che la password sia disponibile prima di caricare i dati
        return waitForPassword();
    })
    .then(() => {
        console.log("🔓 Password verificata. Caricamento dati...");
        
        // Inizializza i listener Firebase DOPO che la password è disponibile
        initializeFirebaseListeners();
        
        // Carica i dati GiroVisite
        fetchGiroVisite(); // Ora l'app ha il permesso di scaricare i dati
    })
    .catch((error) => {
        console.error("❌ Errore critico di autenticazione:", error.code, error.message);
        // Avvisa l'utente se la connessione sicura fallisce
        if (typeof showToast === "function") {
            showToast("Errore di connessione sicura al database", "error");
        }
    });

// NOTA: Gli stili per grid-wrapper, grid-container, room-column, scroll-area
// sono definiti nel CSS di index.html