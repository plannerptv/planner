import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, set, update, remove, get, push } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { firebaseConfig, ROOT } from '../firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// ESPONE LE FUNZIONI FIREBASE GLOBALMENTE
window.db = db;
window.ref = ref;
window.get = get;
window.update = update;
window.remove = remove;
window.set = set;
window.ROOT = ROOT;

let dbState = { Pazienti: [], GiroVisite: [], Categorie: [] };

// ── PASSWORD: legge quella già inserita al login (index.html) ──────────────
// Prova prima sessionStorage (sessione corrente), poi localStorage (salvata)
let appPassword = sessionStorage.getItem('app_password') || localStorage.getItem('app_password');
if (!appPassword) {
    alert("❌ Sessione scaduta o password non trovata.\nVerrai reindirizzato al login.");
    window.location.href = 'index.html';
}

const decrypt = (e) => {
    if (!e || !e.startsWith('U2FsdGVk')) return e;
    try { return CryptoJS.AES.decrypt(e, appPassword).toString(CryptoJS.enc.Utf8) || e; } catch (x) { return e; }
};

const encrypt = (text) => {
    if (!text) return '';
    return CryptoJS.AES.encrypt(text, appPassword).toString();
};

window.decrypt = decrypt;
window.push = push;

// ═══════════════════════════════════════════════════════════
// FIX CRITICO: ATTENDI AUTH PRIMA DI FARE QUALSIASI COSA
// ═══════════════════════════════════════════════════════════
let authReady = false;
let authReadyResolve;
const authReadyPromise = new Promise(resolve => { authReadyResolve = resolve; });

window.waitForAuth = () => authReadyPromise;

const formatDateIT = (val) => {
    if (!val) return '--';
    // Numero seriale Excel (anche basso, tipo 2437 = una data negli anni '00)
    if (!isNaN(val) && Number(val) > 1000) {
        const excelEpoch = new Date(1899, 11, 30);
        const d = new Date(excelEpoch.getTime() + Number(val) * 86400000);
        if (!isNaN(d.getTime())) return d.toLocaleDateString('it-IT');
    }
    // YYYY-MM-DD → DD/MM/YYYY
    if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const parts = val.split('-');
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    // Già in formato leggibile o altro
    let d = new Date(val);
    return isNaN(d.getTime()) ? val : d.toLocaleDateString('it-IT');
};

const formatDateISO = (val) => {
    if (!val) return "";
    // Numero seriale Excel
    if (!isNaN(val) && Number(val) > 1000) {
        const excelEpoch = new Date(1899, 11, 30);
        const d = new Date(excelEpoch.getTime() + Number(val) * 86400000);
        if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
    // Già YYYY-MM-DD
    if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}$/)) return val;
    let d = new Date(val);
    return isNaN(d.getTime()) ? "" : d.toISOString().split('T')[0];
};

window.openTab = (evt, id) => {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    evt.currentTarget.classList.add('active');
};

window.renderAppointments = () => {
    const tbody = document.getElementById('apptTbody');
    const counterSpan = document.getElementById('apptCount');
    const q = document.getElementById('apptSearch').value.toLowerCase();
    const start = document.getElementById('filterStart').value, end = document.getElementById('filterEnd').value, room = document.getElementById('filterRoom').value;

    // Contatore dinamico: (Filtrati / Totale)
    if (counterSpan) {
        let countText = `(Totale: ${dbState.GiroVisite.length} appuntamenti)`;
        const isFiltering = (q || start || end || room);

        if (isFiltering) {
            // Contiamo quelli che passeranno il filtro
            let visibleCount = 0;
            const pMap = {};
            dbState.Pazienti.forEach(p => pMap[p.id] = (decrypt(p.lastName_enc) + ' ' + decrypt(p.firstName_enc)).toUpperCase());

            dbState.GiroVisite.forEach(app => {
                if ((start && app.data < start) || (end && app.data > end) || (room && String(app.stanzaID) !== String(room))) return;
                const nomePaz = pMap[app.pazienteID] || (app.pazienteNome || '').toUpperCase();
                if (q && !nomePaz.toLowerCase().includes(q)) return;
                visibleCount++;
            });
            countText = `(${visibleCount} filtrati su ${dbState.GiroVisite.length} totali)`;
        }
        counterSpan.textContent = countText;
    }

    const pMap = {};
    dbState.Pazienti.forEach(p => pMap[p.id] = (decrypt(p.lastName_enc) + ' ' + decrypt(p.firstName_enc)).toUpperCase());

    let html = '';
    dbState.GiroVisite.sort((a, b) => new Date(b.data) - new Date(a.data)).forEach(app => {
        if ((start && app.data < start) || (end && app.data > end) || (room && String(app.stanzaID) !== String(room))) return;
        const nomePaz = pMap[app.pazienteID] || (app.pazienteNome || '').toUpperCase();
        if (q && !nomePaz.toLowerCase().includes(q)) return;

        const s = dbState.Categorie.find(c => String(c.id) === String(app.stanzaID));
        const timeDisplay = app.startTime || app.oraInizio ? `<span style="font-weight:bold; color:#2563eb;">${(app.startTime || app.oraInizio).substring(0, 5)}</span>` : `<span style="color:#94a3b8;">Slot ${app.rowNo}</span>`;
        html += `<tr><td>${app.data.split('-').reverse().join('/')}</td><td>${timeDisplay}</td><td><span class="tag-mini" style="background:${s?.color || '#ccc'}; color:white;">${s?.name || '?'}</span></td><td><b>${nomePaz}</b></td><td><input type="text" value="${app.pazienteNote || ''}" onblur="updateNote('${app.id}', this.value)"></td><td style="text-align:center;"><button class="btn btn-red" onclick="deleteAppt('${app.id}')">X</button></td></tr>`;
    });

    tbody.innerHTML = html;
};

window.exportExcel = () => {
    const q = document.getElementById('apptSearch').value.toLowerCase();
    const start = document.getElementById('filterStart').value, end = document.getElementById('filterEnd').value, room = document.getElementById('filterRoom').value;

    // Decidiamo cosa esportare
    let source = dbState.GiroVisite;
    const isFiltered = (q || start || end || room);

    if (isFiltered) {
        const pMap = {};
        dbState.Pazienti.forEach(p => pMap[p.id] = (decrypt(p.lastName_enc) + ' ' + decrypt(p.firstName_enc)).toUpperCase());

        source = dbState.GiroVisite.filter(app => {
            if ((start && app.data < start) || (end && app.data > end) || (room && String(app.stanzaID) !== String(room))) return false;
            const nomePaz = pMap[app.pazienteID] || (app.pazienteNome || '').toUpperCase();
            if (q && !nomePaz.toLowerCase().includes(q)) return false;
            return true;
        });
    }

    if (source.length === 0) {
        alert("Nessun dato da esportare.");
        return;
    }

    // Preparazione dati per Excel
    const pMapFull = {};
    dbState.Pazienti.forEach(p => pMapFull[p.id] = (decrypt(p.lastName_enc) + ' ' + decrypt(p.firstName_enc)).toUpperCase());

    const excelData = source.map(app => {
        const s = dbState.Categorie.find(c => String(c.id) === String(app.stanzaID));
        return {
            'DATA': app.data,
            'ORARIO/SLOT': app.startTime || app.oraInizio || ('Slot ' + app.rowNo),
            'STANZA': s?.name || '?',
            'PAZIENTE': pMapFull[app.pazienteID] || (app.pazienteNome || '').toUpperCase(),
            'NOTE': app.pazienteNote || '',
            'ID_DB': app.id
        };
    });

    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Appuntamenti");

    const fileName = isFiltered ? `Appuntamenti_Filtrati_${new Date().toISOString().split('T')[0]}.xlsx` : `Export_Totale_Appuntamenti_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, fileName);
    alert(`✅ Export completato: ${source.length} record.`);
};

window.renderPazienti = () => {
    const tbody = document.getElementById('pazTbody');
    const q = document.getElementById('pSearch').value.toLowerCase().trim();
    let html = '';
    let count = 0;
    const maxShow = 100; // Limite per evitare sovraccarico

    dbState.Pazienti.forEach(p => {
        if (count >= maxShow) return; // Mostra max 100 risultati

        // Gestisci sia nomi criptati che non criptati
        let ln = p.lastName || '';
        let fn = p.firstName || '';
        if (p.lastName_enc) ln = decrypt(p.lastName_enc);
        if (p.firstName_enc) fn = decrypt(p.firstName_enc);

        // Se c'è ricerca, filtra per nome/cognome
        if (q && !(ln + ' ' + fn).toLowerCase().includes(q)) return;

        count++;
        html += `<tr><td><b>${ln.toUpperCase()}</b> ${fn.toUpperCase()}</td><td>${formatDateIT(p.dob)}</td><td>${p.phone || ''}</td><td style="text-align:center;"><button class="btn btn-blue" onclick="editPaziente('${p.id}')">✏️</button> <button class="btn btn-red" onclick="deletePaziente('${p.id}')">🗑️</button></td></tr>`;
    });

    if (count === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#94a3b8;">Nessun paziente trovato.</td></tr>';
    } else {
        tbody.innerHTML = html;
        if (count >= maxShow) {
            tbody.innerHTML += `<tr><td colspan="4" style="text-align:center; padding:10px; background:#fff7ed; color:#c2410c; font-weight:bold;">⚠️ Mostrati solo i primi ${maxShow} risultati. Usa la ricerca per filtrare.</td></tr>`;
        }
    }
    document.getElementById('pazCount').textContent = `(${count}${count >= maxShow ? '+' : ''} pazienti)`;
};

window.editPaziente = (id) => {
    const p = dbState.Pazienti.find(x => x.id === id); if (!p) return;
    document.getElementById('pEditId').value = p.id;
    // Gestisci sia nomi criptati che non criptati e converti in MAIUSCOLO
    const ln = p.lastName_enc ? decrypt(p.lastName_enc) : (p.lastName || '');
    const fn = p.firstName_enc ? decrypt(p.firstName_enc) : (p.firstName || '');
    document.getElementById('pLastName').value = ln.toUpperCase();
    document.getElementById('pFirstName').value = fn.toUpperCase();
    document.getElementById('pDob').value = formatDateISO(p.dob);
    document.getElementById('pTel').value = p.phone || '';
    document.getElementById('pFormTitle').innerText = "✏️ Modifica Paziente";
    document.getElementById('pBtnCancel').style.display = "inline-block";
    window.scrollTo(0, 0);
};

// NOTA: normalizeText, levenshteinDistance, similarity sono in duplicate-checker.js (caricato prima)

window.savePaziente = async () => {
    const editId = document.getElementById('pEditId').value;
    const l = document.getElementById('pLastName').value.trim().toUpperCase();
    const f = document.getElementById('pFirstName').value.trim().toUpperCase();
    const d = document.getElementById('pDob').value;
    const tel = document.getElementById('pTel').value.trim();

    if (!l || !f) {
        alert('❌ Cognome e Nome sono obbligatori!');
        return;
    }

    // CONTROLLO DUPLICATI usando duplicate-checker.js (libreria condivisa)
    try {
        if (typeof findDuplicatePatients !== 'undefined') {
            const similar = findDuplicatePatients(
                dbState.Pazienti,
                l,
                f,
                d,
                editId || null,
                decrypt
            );

            if (similar.length > 0) {
                const { message, shouldBlock } = formatDuplicateMessage(similar, l, f, d);

                if (shouldBlock) {
                    alert(message);
                    return;
                } else {
                    if (!confirm(message)) {
                        return;
                    }
                }
            }
        } else {
            console.warn('⚠️ duplicate-checker.js non caricato, controllo duplicati saltato');
        }
    } catch (e) {
        console.warn("Errore controllo duplicati:", e);
    }

    try {
        if (editId) {
            // Modifica paziente esistente
            await update(ref(db, `${ROOT}/pazienti/${editId}`), {
                lastName_enc: encrypt(l),
                firstName_enc: encrypt(f),
                dob: d,
                phone: tel
            });
            alert('✅ Paziente modificato!');
        } else {
            // Nuovo paziente - Genera ID numerico progressivo
            let maxId = 0;
            dbState.Pazienti.forEach(p => {
                const numId = parseInt(p.id);
                if (!isNaN(numId) && numId > maxId) maxId = numId;
            });
            const newId = String(maxId + 1);
            
            await set(ref(db, `${ROOT}/pazienti/${newId}`), {
                id: newId,
                lastName_enc: encrypt(l),
                firstName_enc: encrypt(f),
                dob: d,
                phone: tel
            });
            alert('✅ Paziente creato!');
        }
        // Reset form
        document.getElementById('pEditId').value = '';
        document.getElementById('pLastName').value = '';
        document.getElementById('pFirstName').value = '';
        document.getElementById('pDob').value = '';
        document.getElementById('pTel').value = '';
        document.getElementById('pFormTitle').innerText = '👤 Scheda Paziente';
        document.getElementById('pBtnCancel').style.display = 'none';
    } catch (e) {
        alert('❌ Errore: ' + e.message);
    }
};

window.cancelEdit = () => {
    document.getElementById('pEditId').value = '';
    document.getElementById('pLastName').value = '';
    document.getElementById('pFirstName').value = '';
    document.getElementById('pDob').value = '';
    document.getElementById('pTel').value = '';
    document.getElementById('pFormTitle').innerText = '👤 Scheda Paziente';
    document.getElementById('pBtnCancel').style.display = 'none';
    document.getElementById('pSearch').value = '';
    renderPazienti();
};

window.newPaziente = () => {
    // Stessa logica di cancelEdit - resetta il form per nuovo paziente
    cancelEdit();
    document.getElementById('pLastName').focus(); // Focus sul primo campo
};

window.renderCategories = () => {
    const tbody = document.querySelector('#categoriesTable tbody');
    tbody.innerHTML = dbState.Categorie.map(c => `<tr><td><b>${c.name}</b></td><td><span style="background:${c.color}; padding:2px 8px; color:white; border-radius:4px;">${c.color}</span></td><td style="text-align:center;"><button class="btn btn-blue" onclick="editCat('${c.id}','${c.name}','${c.color}')">✏️</button> <button class="btn btn-red" onclick="deleteCat('${c.id}')">🗑️</button></td></tr>`).join('');
};

window.saveCategory = async () => {
    const n = document.getElementById('catName').value.trim(), c = document.getElementById('catColor').value, id = document.getElementById('editCatId').value || Date.now().toString().slice(-6);
    if (!n) return alert("Nome obbligatorio!");
    await set(ref(db, `${ROOT}/tblCategories/${id}`), { id, name: n, color: c }); resetCategoryForm();
};

window.editCat = (id, n, c) => {
    document.getElementById('editCatId').value = id; document.getElementById('catName').value = n; document.getElementById('catColor').value = c;
    document.getElementById('catFormTitle').innerText = "✏️ Modifica"; document.getElementById('btnCancelEditCat').style.display = 'inline-block';
};

window.resetCategoryForm = () => {
    document.getElementById('editCatId').value = ""; document.getElementById('catName').value = "";
    document.getElementById('catFormTitle').innerText = "🏘️ Configura Stanza"; document.getElementById('btnCancelEditCat').style.display = 'none';
};

window.backupData = async (scope) => {
    const snap = await get(ref(db, ROOT)); const v = snap.val(); let d = {};
    if (scope === 'all') d = v;
    else if (scope === 'appointments') d = { GiroVisite: v.GiroVisite, dailyNotes: v.dailyNotes };
    else if (scope === 'patients') d = { pazienti: v.pazienti };
    else if (scope === 'config') d = { tblCategories: v.tblCategories, RegoleAttive: v.RegoleAttive };
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = blobUrl; a.download = `Backup_${scope}_${new Date().toISOString().split('T')[0]}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
};

window.triggerRestore = (mode) => { document.getElementById('restoreMode').value = mode; document.getElementById('restoreFile').click(); };
window.processRestoreFile = () => {
    const file = document.getElementById('restoreFile').files[0], mode = document.getElementById('restoreMode').value;
    if (!file || !confirm(`⚠️ Sovrascrivere ${mode.toUpperCase()}?`)) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        const json = JSON.parse(e.target.result);
        if (mode === 'all') await set(ref(db, ROOT), json);
        else if (mode === 'appointments') { if (json.GiroVisite) await update(ref(db, ROOT + '/GiroVisite'), json.GiroVisite); }
        else if (mode === 'patients') { if (json.pazienti) await set(ref(db, ROOT + '/pazienti'), json.pazienti); }
        alert("✅ Ripristino completato!"); window.location.reload();
    };
    reader.readAsText(file);
};

/**
 * ESPORTA PAZIENTI DECRIPTATI IN EXCEL
 * Formato compatibile con importa_pazienti-PROD.html
 * Usa questa funzione quando devi cambiare la password di criptazione
 */
window.exportPatientsDecrypted = async () => {
    if (!dbState.Pazienti || dbState.Pazienti.length === 0) {
        alert('❌ Nessun paziente da esportare!');
        return;
    }

    if (!confirm(`🔓 ESPORTAZIONE PAZIENTI DECRIPTATI\n\n` +
        `Questa funzione esporterà ${dbState.Pazienti.length} pazienti in formato CHIARO (non criptato).\n\n` +
        `⚠️ ATTENZIONE: Il file conterrà nomi e cognomi in chiaro!\n\n` +
        `Usa questo file per:\n` +
        `1. Cambiare la password di criptazione\n` +
        `2. Migrare i dati su altro sistema\n\n` +
        `Confermi l'esportazione?`)) {
        return;
    }

    try {
        // Prepara i dati per Excel
        const excelData = dbState.Pazienti.map(p => {
            // Decripta nome e cognome
            const lastName = decrypt(p.lastName_enc) || p.lastName || '';
            const firstName = decrypt(p.firstName_enc) || p.firstName || '';
            
            // Formatta data di nascita
            let dob = p.dob || '';
            // Numero seriale Excel
            if (dob && !isNaN(dob) && Number(dob) > 1000) {
                const excelEpoch = new Date(1899, 11, 30);
                const dateObj = new Date(excelEpoch.getTime() + Number(dob) * 86400000);
                dob = dateObj.toLocaleDateString('it-IT');
            }
            // YYYY-MM-DD → DD/MM/YYYY
            else if (dob && typeof dob === 'string' && dob.match(/^\d{4}-\d{2}-\d{2}$/)) {
                const [y, m, d] = dob.split('-');
                dob = `${d}/${m}/${y}`;
            }

            return {
                PatientID: p.id,
                LastName: lastName.toUpperCase(),
                FirstName: firstName.toUpperCase(),
                DateOfBirth: dob,
                Telephone: p.phone || p.telefono || ''
            };
        });

        // Ordina per cognome
        excelData.sort((a, b) => a.LastName.localeCompare(b.LastName));

        // Crea il workbook
        const ws = XLSX.utils.json_to_sheet(excelData, {
            header: ['PatientID', 'LastName', 'FirstName', 'DateOfBirth', 'Telephone']
        });

        // Imposta larghezza colonne
        ws['!cols'] = [
            { wch: 12 },  // PatientID
            { wch: 25 },  // LastName
            { wch: 25 },  // FirstName
            { wch: 15 },  // DateOfBirth
            { wch: 18 }   // Telephone
        ];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Pazienti');

        // Genera il nome file con timestamp
        const now = new Date();
        const timestamp = now.toISOString().split('T')[0].replace(/-/g, '');
        const filename = `tblPatients_DECRYPTED_${timestamp}.xlsx`;

        // Scarica il file
        XLSX.writeFile(wb, filename);

        alert(`✅ ESPORTAZIONE COMPLETATA!\n\n` +
            `File: ${filename}\n` +
            `Pazienti esportati: ${excelData.length}\n\n` +
            `⚠️ IMPORTANTE:\n` +
            `- Il file contiene dati in CHIARO\n` +
            `- Conservalo in luogo sicuro\n` +
            `- Eliminalo dopo l'uso\n\n` +
            `Per reimportare con nuova password:\n` +
            `1. Apri importa_pazienti-PROD.html\n` +
            `2. Inserisci la NUOVA password\n` +
            `3. Carica questo file Excel`);

    } catch (error) {
        console.error('Errore esportazione:', error);
        alert('❌ Errore durante l\'esportazione:\n' + error.message);
    }
};

// ═══════════════════════════════════════════════════════════
// FIREBASE LISTENERS SEPARATI — risparmio letture/traffico
// Ogni listener ascolta SOLO il suo path:
//   se cambia un appuntamento → ricarica SOLO GiroVisite
//   se cambia un paziente    → ricarica SOLO pazienti
//   ecc. (invece di scaricare tutto ogni volta)
// ═══════════════════════════════════════════════════════════
function loadData() {
    // 1. CATEGORIE (stanze) — cambiano raramente
    onValue(ref(db, ROOT + '/tblCategories'), snap => {
        const raw = snap.val() || {};
        dbState.Categorie = Object.entries(raw).map(([k, v]) => ({ id: k, name: v.name, color: v.color }));
        // Aggiorna il filtro stanze nel tab Appuntamenti
        const sel = document.getElementById('filterRoom');
        if (sel) sel.innerHTML = '<option value="">-- TUTTE --</option>' + dbState.Categorie.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        renderCategories();
        renderAppointments();
    });

    // 2. PAZIENTI — cambiano moderatamente
    onValue(ref(db, ROOT + '/pazienti'), snap => {
        const raw = snap.val() || {};
        dbState.Pazienti = Object.entries(raw).map(([k, v]) => ({ ...v, id: k }));
        renderPazienti();
        renderAppointments(); // aggiorna nomi negli appuntamenti
    });

    // 3. APPUNTAMENTI — cambiano spesso (modifiche giornaliere)
    onValue(ref(db, ROOT + '/GiroVisite'), snap => {
        const raw = snap.val() || {};
        dbState.GiroVisite = Object.entries(raw).map(([k, v]) => ({ ...v, id: k }));
        renderAppointments();
    });
}

// AUTENTICAZIONE - Avvia e poi risolvi promise
signInAnonymously(auth)
    .then(() => {
        authReady = true;
        authReadyResolve();
        console.log("✅ Admin: Accesso anonimo riuscito");
        console.log("🚀 Database Attivo:", firebaseConfig.projectId);
        loadData();
        // Precarica data odierna nel datepicker note
        const today = new Date().toLocaleDateString('sv-SE');
        const dp = document.getElementById('noteDatePicker');
        if (dp) { dp.value = today; loadNoteForDate(); }
    })
    .catch((error) => {
        console.error("❌ Errore autenticazione admin:", error.code, error.message);
        alert("❌ ERRORE AUTH!\n\n" + error.message + "\n\nSe vedi 'operation-not-allowed':\n→ Firebase Console\n→ Authentication\n→ Sign-in method\n→ Abilita 'Anonymous'");
    });

// ═══════════════════════════════════════════════════════════
// NOTE DEL GIORNO — Lettura e decriptazione
// ═══════════════════════════════════════════════════════════

// Carica e mostra la nota per la data selezionata nel datepicker
window.loadNoteForDate = async () => {
    const dp = document.getElementById('noteDatePicker');
    if (!dp || !dp.value) return;
    const iso = dp.value; // YYYY-MM-DD

    const label = document.getElementById('noteSingleLabel');
    const content = document.getElementById('noteSingleContent');
    if (label) label.textContent = iso.split('-').reverse().join('/');
    if (content) content.textContent = '⏳ Caricamento...';

    try {
        const snap = await get(ref(db, ROOT + '/dailyNotes/' + iso));
        const raw = snap.val();
        if (!raw) {
            content.innerHTML = '<span style="color:#94a3b8; font-style:italic;">Nessuna nota per questa data.</span>';
        } else {
            // Decripta (gestisce sia testo criptato che legacy in chiaro)
            const plain = decrypt(raw);
            // Rimuove tag HTML e mostra testo leggibile
            const tmp = document.createElement('div');
            tmp.innerHTML = plain;
            content.textContent = tmp.innerText || tmp.textContent || plain;
        }
    } catch (e) {
        if (content) content.textContent = '❌ Errore: ' + e.message;
    }
};

// Cache di tutte le note (caricata una sola volta)
let _allNotesCache = null;

// Carica TUTTE le note e mostra la tabella
window.loadAllNotes = async () => {
    document.getElementById('noteSingleView').style.display = 'none';
    document.getElementById('noteAllView').style.display = 'block';

    const tbody = document.getElementById('noteAllTbody');
    tbody.innerHTML = '<tr><td colspan="2" style="text-align:center; padding:20px; color:#94a3b8;">⏳ Caricamento...</td></tr>';

    try {
        const snap = await get(ref(db, ROOT + '/dailyNotes'));
        const raw = snap.val();

        if (!raw) {
            tbody.innerHTML = '<tr><td colspan="2" style="text-align:center; padding:20px; color:#94a3b8;">Nessuna nota trovata nel database.</td></tr>';
            document.getElementById('noteCount').textContent = '';
            return;
        }

        // Costruisce array ordinato per data DESC
        _allNotesCache = Object.entries(raw)
            .map(([date, val]) => {
                const plain = decrypt(val);
                const tmp = document.createElement('div');
                tmp.innerHTML = plain;
                const text = (tmp.innerText || tmp.textContent || plain).trim();
                return { date, text };
            })
            .filter(n => n.text)
            .sort((a, b) => b.date.localeCompare(a.date));

        document.getElementById('noteCount').textContent = `(${_allNotesCache.length} note totali)`;
        renderNoteTable(_allNotesCache);

    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="2" style="color:#ef4444; padding:20px;">❌ Errore: ${e.message}</td></tr>`;
    }
};

function renderNoteTable(notes) {
    const tbody = document.getElementById('noteAllTbody');
    if (!notes || notes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" style="text-align:center; padding:20px; color:#94a3b8;">Nessuna nota trovata.</td></tr>';
        return;
    }
    tbody.innerHTML = notes.map(n => {
        const dateIT = n.date.split('-').reverse().join('/');
        // Preview testo (max 200 chars)
        const preview = n.text.length > 200 ? n.text.substring(0, 200) + '…' : n.text;
        return `<tr>
            <td style="font-weight:700; white-space:nowrap; color:var(--blue);">${dateIT}</td>
            <td style="white-space:pre-wrap; font-size:12px; line-height:1.5;">${preview.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
        </tr>`;
    }).join('');
}

// Filtra le note per testo cercato
window.filterNotes = () => {
    if (!_allNotesCache) return;
    const q = document.getElementById('noteSearch').value.toLowerCase().trim();
    if (!q) { renderNoteTable(_allNotesCache); return; }
    const filtered = _allNotesCache.filter(n => n.text.toLowerCase().includes(q) || n.date.includes(q));
    renderNoteTable(filtered);
};

// Torna alla vista singola data
window.closeAllNotes = () => {
    document.getElementById('noteAllView').style.display = 'none';
    document.getElementById('noteSingleView').style.display = 'block';
};

// Legacy handler - reindirizza al V8
window.handleAccessFile = () => {
    const input = document.getElementById('accessFile');
    if (input) handleAccessUpload({ target: input });
};

window.commitAccessImport = async () => {
    if (!window.accessDataFull) return;
    if (!confirm("⚠️ Confermi l'importazione Access?\n\nIl sistema cercherà di abbinare gli appuntamenti per aggiornare l'ORARIO.\nQuesta operazione sovrascriverà gli orari attuali.")) return;

    const updates = {};
    let matched = 0;
    let errors = 0;
    let missed = []; // Array per log mancati match

    // 1. Mappa colonne (EURISTICA o NOMI FISSI da ACCESS)
    const sample = window.accessDataFull[0];

    // Cerchiamo colonne probabili
    const colDate = Object.keys(sample).find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('data'));
    const colTime = Object.keys(sample).find(k => k.toLowerCase().includes('time') || k.toLowerCase().includes('ora'));
    const colRoom = Object.keys(sample).find(k => k.toLowerCase().includes('room') || k.toLowerCase().includes('stanza') || k.toLowerCase().includes('cat'));
    const colPat = Object.keys(sample).find(k => k.toLowerCase().includes('patient') || k.toLowerCase().includes('paziente') || k.toLowerCase().includes('cognome'));

    if (!colDate || !colTime) {
        alert(`❌ Impossibile identificare colonne DATA e ORA.\nColonne trovate: ${Object.keys(sample).join(', ')}`);
        return;
    }

    console.log(`Mapping: DATE=${colDate}, TIME=${colTime}, ROOM=${colRoom}, PAT=${colPat}`);

    // Scarichiamo stato attuale DB per fare matching
    const snap = await get(ref(db, ROOT + '/GiroVisite'));
    const currentDB = snap.val() || {};
    const dbArr = Object.entries(currentDB).map(([k, v]) => ({ ...v, id: k }));

    for (const row of window.accessDataFull) {
        let dateStr = null;
        let patNameEx = "";

        try {
            // Parsing Data Excel
            const rawDate = row[colDate];
            if (typeof rawDate === 'number') {
                const dateObj = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
                dateStr = dateObj.toISOString().split('T')[0];
            } else if (rawDate && typeof rawDate === 'string' && rawDate.includes('/')) {
                const parts = rawDate.split('/');
                if (parts.length === 3) dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
            } else if (rawDate && typeof rawDate === 'string') {
                dateStr = rawDate.split('T')[0];
            }

            // Parsing Ora
            let timeStr = "";
            const rawTime = row[colTime];
            if (typeof rawTime === 'number') {
                const totalSeconds = Math.floor(rawTime * 86400);
                const hours = Math.floor(totalSeconds / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            } else if (typeof rawTime === 'string' && rawTime.includes('T')) {
                timeStr = rawTime.split('T')[1].substring(0, 5);
            } else if (typeof rawTime === 'string') {
                timeStr = rawTime.substring(0, 5);
            }

            if (!dateStr || !timeStr) {
                missed.push({ row, motivo: "Data o Ora mancante/invalida" });
                continue;
            }

            // MATCHING
            let match = null;
            if (colPat && row[colPat]) patNameEx = normalizeText(row[colPat]);

            // Filtra candidati per data
            const candidates = dbArr.filter(dbApp => dbApp.data === dateStr);

            if (patNameEx) {
                // Cerca per nome paziente (normalizzato)
                match = candidates.find(dbApp => {
                    const dbName = dbApp.pazienteNome ? normalizeText(dbApp.pazienteNome) : "";
                    // Cerchiamo una contenimento o uguaglianza
                    return dbName && (dbName === patNameEx || dbName.includes(patNameEx) || patNameEx.includes(dbName));
                });
            }

            if (match) {
                updates[match.id + '/oraInizio'] = timeStr;
                matched++;
            } else {
                missed.push({
                    data: dateStr,
                    ora: timeStr,
                    paziente: row[colPat] || 'N/A',
                    stanza: row[colRoom] || 'N/A',
                    motivo: candidates.length > 0 ? "Paziente non trovato in questa data" : "Nessun appuntamento in questa data"
                });
            }

        } catch (e) {
            console.warn("Errore riga excel", row, e);
            errors++;
            missed.push({ row, motivo: "Eccezione: " + e.message });
        }
    }

    if (matched > 0) {
        await update(ref(db, ROOT + '/GiroVisite'), updates);
    }

    // Creazione Report
    let msg = `📊 RISULTATO IMPORTAZIONE\n\n`;
    msg += `✅ Aggiornati: ${matched}\n`;
    msg += `⚠️ Non trovati (Missed): ${missed.length}\n`;
    msg += `❌ Errori dati: ${errors}\n\n`;

    if (missed.length > 0) {
        msg += `Vuoi scaricare la lista degli appuntamenti NON TROVATI per controllarli?`;
        if (confirm(msg)) {
            let csv = "Data,Ora,PazienteExcel,StanzaExcel,Motivo\n";
            missed.forEach(m => {
                csv += `${m.data},${m.ora},"${m.paziente}","${m.stanza}","${m.motivo}"\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "report_mancati_match_access.csv";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        location.reload();
    } else {
        alert("✅ TUTTI GLI APPUNTAMENTI SONO STATI ABBINATI PERFETTAMENTE!");
        location.reload();
    }
};

// Helper accessibile globalmente
window.accessDataFull = [];
window.commitAccessImportV2 = async () => {
    if (!window.accessDataFull) return;
    if (!confirm("⚠️ Confermi l'importazione Access (V2)?\n\nIl sistema cercherà di abbinare gli appuntamenti per aggiornare l'ORARIO.\nQuesta operazione sovrascriverà gli orari attuali.")) return;

    const updates = {};
    let matched = 0;
    let errors = 0;
    let missed = []; // Array per log mancati match

    // 1. Mappa colonne (EURISTICA)
    const sample = window.accessDataFull[0];
    const colDate = Object.keys(sample).find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('data'));
    const colTime = Object.keys(sample).find(k => k.toLowerCase().includes('time') || k.toLowerCase().includes('ora') || k.toLowerCase().includes('timevalue'));
    const colRoom = Object.keys(sample).find(k => k.toLowerCase().includes('room') || k.toLowerCase().includes('stanza') || k.toLowerCase().includes('cat'));
    const colPat = Object.keys(sample).find(k => k.toLowerCase().includes('patient') || k.toLowerCase().includes('paziente') || k.toLowerCase().includes('cognome'));

    if (!colDate || !colTime) {
        alert(`❌ Errore Colonne: Impossibile trovare 'Data' e 'Ora'.\nColonne nel file: ${Object.keys(sample).join(', ')}`);
        return;
    }

    console.log(`Mapping: DATE=${colDate}, TIME=${colTime}, ROOM=${colRoom}, PAT=${colPat}`);

    // Scarichiamo stato attuale DB
    const snap = await get(ref(db, ROOT + '/GiroVisite'));
    const currentDB = snap.val() || {};
    const dbArr = Object.entries(currentDB).map(([k, v]) => ({ ...v, id: k }));

    for (const row of window.accessDataFull) {
        // Valori per il report (estratti safe)
        const rawDate = row[colDate];
        const rawTime = row[colTime];
        const rawPat = colPat ? (row[colPat] || '') : '';
        const rawRoom = colRoom ? (row[colRoom] || '') : '';

        let dateStr = null;
        let timeStr = null;

        try {
            // Parsing Data
            if (typeof rawDate === 'number') {
                const dateObj = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
                dateStr = dateObj.toISOString().split('T')[0];
            } else if (typeof rawDate === 'string' && rawDate.includes('/')) {
                const parts = rawDate.split('/'); // DD/MM/YYYY
                if (parts.length === 3) dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
            } else if (typeof rawDate === 'string') {
                dateStr = rawDate.split('T')[0]; // YYYY-MM-DD...
            }

            // Parsing Ora
            if (typeof rawTime === 'number') {
                const totalSeconds = Math.floor(rawTime * 86400);
                const hours = Math.floor(totalSeconds / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            } else if (typeof rawTime === 'string' && rawTime.includes('T')) {
                timeStr = rawTime.split('T')[1].substring(0, 5); // ...T09:00:00
            } else if (typeof rawTime === 'string') {
                timeStr = rawTime.substring(0, 5); // 09:00
            }

            // Validazione Base
            if (!dateStr || !timeStr || dateStr.length !== 10 || timeStr.length !== 5) {
                missed.push({
                    data: rawDate, ora: rawTime, paziente: rawPat, stanza: rawRoom,
                    motivo: "Formato Data/Ora non valido nel file Access"
                });
                continue;
            }

            // MATCHING
            let match = null;
            const normPatExcel = normalizeText(rawPat);

            // Filtra candidati per data esatta
            const candidates = dbArr.filter(dbApp => dbApp.data === dateStr);

            if (normPatExcel) {
                // Cerca per nome
                match = candidates.find(dbApp => {
                    const dbName = dbApp.pazienteNome ? normalizeText(dbApp.pazienteNome) : "";
                    // Match lasco: uguaglianza o contenimento
                    return dbName && (dbName === normPatExcel || dbName.includes(normPatExcel) || normPatExcel.includes(dbName));
                });
            }

            if (match) {
                // Applica aggiornamento
                updates[match.id + '/oraInizio'] = timeStr;
                matched++;
            } else {
                // Log Mancato Match
                missed.push({
                    data: dateStr,
                    ora: timeStr,
                    paziente: rawPat,
                    stanza: rawRoom,
                    motivo: candidates.length > 0
                        ? `Nessun paziente '${rawPat}' trovato in data ${dateStr} (Trovati ${candidates.length} altri appuntamenti)`
                        : `Nessun appuntamento esistente in data ${dateStr} (Nessun candidato)`
                });
            }

        } catch (e) {
            console.warn("Errore riga excel", row, e);
            errors++;
            missed.push({
                data: rawDate, ora: rawTime, paziente: rawPat, stanza: rawRoom,
                motivo: "Eccezione JS: " + e.message
            });
        }
    }

    // Commit Firebase
    if (matched > 0) {
        await update(ref(db, ROOT + '/GiroVisite'), updates);
    }

    // GENERAZIONE REPORT CSV
    if (missed.length > 0) {
        // BOM per Excel (feff) + contenuto CSV
        let csvContent = "\uFEFFData;Ora;Paziente_Excel;Stanza_Excel;Motivo_Errore\n"; // Usa ; per Excel ITA

        missed.forEach(m => {
            const clean = (val) => String(val || '').replace(/"/g, '""').replace(/;/g, ' ');
            csvContent += `"${clean(m.data)}";"${clean(m.ora)}";"${clean(m.paziente)}";"${clean(m.stanza)}";"${clean(m.motivo)}"\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const msg = `📊 RISULTATO IMPORTAZIONE V2\n` +
            `✅ Aggiornati: ${matched}\n` +
            `⚠️ NON TROVATI: ${missed.length} (Vedi Report)\n\n` +
            `Clicca OK per SCARICARE IL REPORT ERRORI e analizzare i mancati match.`;

        if (confirm(msg)) {
            const a = document.createElement("a");
            a.href = url;
            a.download = `report_mancati_match_v2_${new Date().getTime()}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    } else {
        alert(`✅ SUCCESSO TOTALE!\nTutti i ${matched} record del file Excel sono stati abbinati e aggiornati.`);
    }

    setTimeout(() => location.reload(), 1000);
};

window.deleteAppt = (id) => confirm("Eliminare?") && remove(ref(db, `${ROOT}/GiroVisite/${id}`));
window.updateNote = async (id, value) => {
    try {
        await update(ref(db, `${ROOT}/GiroVisite/${id}`), { pazienteNote: value || null });
    } catch(e) { alert("❌ Errore salvataggio nota: " + e.message); }
};
window.deletePaziente = (id) => confirm("Eliminare?") && remove(ref(db, `${ROOT}/pazienti/${id}`));
window.deleteCat = (id) => confirm("Eliminare stanza?") && remove(ref(db, `${ROOT}/tblCategories/${id}`));
window.analyzeAccessFile = () => {
    if (!window.accessDataFull || window.accessDataFull.length === 0) {
        alert("⚠️ Nessun file caricato o file vuoto!\n\nPer favore:\n1. Clicca su 'SELEZIONA FILE'\n2. Scegli il file Excel\n3. Aspetta che appaia l'anteprima");
        return;
    }
    const rows = window.accessDataFull.slice(0, 3);
    let report = "🧐 ANALISI DELLE PRIME 3 RIGHE:\n\n";
    rows.forEach((r, i) => {
        report += `--- RIGA ${i + 1} ---\n`;
        Object.keys(r).forEach(k => {
            report += `[${k}]: ${r[k]} \n`;
        });
        report += "\n";
    });
    report += "Se vedi i dati qui sopra, il file è letto correttamente!";
    alert(report);
};
// --- LOGICA V4 (TimeSlots Lookup) ---
window.slotsMap = {};

window.handleSlotsFile = () => {
    const file = document.getElementById('slotsFile').files[0];
    if (!file) return;
    document.getElementById('slotsFileName').innerText = "✅ " + file.name;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

            const sample = jsonData[0];
            const keys = Object.keys(sample);
            const colID = keys.find(k => k.toLowerCase().includes('id') || k.toLowerCase().includes('row'));
            const colTime = keys.find(k => k.toLowerCase().includes('time') || k.toLowerCase().includes('start'));

            if (!colID || !colTime) {
                alert("❌ File TimeSlots non valido.\nColonne attese: ID/RowNo e StartTime.\nTrovate: " + keys.join(', '));
                return;
            }

            window.slotsMap = {};
            jsonData.forEach(row => {
                let t = row[colTime];
                if (typeof t === 'number') {
                    const totalSeconds = Math.round(t * 86400);
                    const h = Math.floor(totalSeconds / 3600);
                    const m = Math.floor((totalSeconds % 3600) / 60);
                    t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                } else if (typeof t === 'string' && t.includes('T')) {
                    t = t.split('T')[1].substring(0, 5);
                } else if (typeof t === 'string') {
                    t = t.substring(0, 5);
                }
                if (row[colID] && t) window.slotsMap[String(row[colID])] = t;
            });

            document.getElementById('slotsStatus').innerText = `✅ CARTA ORARIA OK (${Object.keys(window.slotsMap).length} slot)`;
            document.getElementById('slotsStatus').style.color = 'green';
            checkReadiness();
        } catch (e) {
            alert("Errore lettura slots: " + e.message);
        }
    };
    reader.readAsArrayBuffer(file);
};

window.checkReadiness = () => {
    const hasAppts = window.accessDataFull && window.accessDataFull.length > 0;
    const hasSlots = Object.keys(window.slotsMap).length > 0;
    const btn = document.getElementById('btnImportAccess');
    if (btn) {
        btn.disabled = !(hasAppts && hasSlots);
        btn.innerText = (hasAppts && hasSlots) ? "🚀 AVVIA MIGRAZIONE V5 (SLOT → ORARIO)" : "⚠️ Carica entrambi i file per procedere";
    }
};

// Wrapper per aggiornare stato UI dopo il caricamento Appuntamenti
// Helper LOG LIVE
window.logLive = function (msg, type = 'info') {
    const logDiv = document.getElementById('importLog');
    const logContainer = document.getElementById('importLogContainer');
    if (logDiv && logContainer) { // FIX: defined container variable
        logContainer.style.display = 'block';
        const color = type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#cbd5e1');
        const time = new Date().toLocaleTimeString();
        logDiv.innerHTML += `<div style="color:${color}">[${time}] ${msg}</div>`;
        logDiv.scrollTop = logDiv.scrollHeight;
    }
    console.log(msg); // Mantieni anche su console
};

window.commitAccessImportV4 = async () => {
    if (!window.accessDataFull) { alert("Nessun file caricato!"); return; }
    if (Object.keys(window.slotsMap).length === 0) { alert("Manca il file TimeSlots!"); return; }

    if (!confirm("⚠️ Confermi IMPORTAZIONE V4?\n\nIl processo potrebbe impiegare qualche minuto.")) return;

    try {
        // Pulisci Log e forza display
        const logDiv = document.getElementById('importLog');
        const logContainer = document.getElementById('importLogContainer');

        logContainer.style.display = 'block';
        logDiv.innerHTML = ''; // SVUOTA IL "Waiting..."

        logLive("🚀 AVVIO PROCESSO DI IMPORTAZIONE (V4)...", "info");

        // Forza render immediato
        await new Promise(r => setTimeout(r, 50));

        logLive(`📂 Dati Excel caricati: ${window.accessDataFull.length} righe`, "info");
        logLive("⏳ Scaricamento database Firebase in corso...", "info");

        // Forza render
        await new Promise(r => setTimeout(r, 50));

        const updates = {};
        let matched = 0;
        let errors = 0;
        let missed = [];

        const sample = window.accessDataFull[0];
        const keys = Object.keys(sample);
        const findKey = (candidates) => keys.find(k => candidates.some(c => k.toLowerCase().includes(c)));

        const colDate = findKey(['date', 'data']);
        const colPatID = findKey(['patientid', 'pazienteid', 'idpaziente', 'patient_id', 'paziente_id']);
        const colPatName = findKey(['patient', 'paziente', 'cognome']);
        const colRowNo = findKey(['rowno', 'row_no', 'riga', 'slot', 'id']);

        // Scarico DB
        const snapGV = await get(ref(db, ROOT + '/GiroVisite'));
        const dbAppts = Object.entries(snapGV.val() || {}).map(([k, v]) => ({ ...v, id: k }));
        logLive(`✅ Database scaricato: ${dbAppts.length} appuntamenti trovati`, "success");

        logLive("⚙️ Inizio elaborazione righe...", "info");

        // PROCESSO A BLOCCHI PIÙ FREQUENTE PER NON BLOCCARE
        const CHUNK_SIZE = 10;
        const totalRows = window.accessDataFull.length;

        for (let i = 0; i < totalRows; i++) {
            const row = window.accessDataFull[i];

            // Aggiorna GUI ogni 10 righe
            if (i % CHUNK_SIZE === 0) {
                logLive(`Processing riga ${i + 1} di ${totalRows}...`);
                await new Promise(r => setTimeout(r, 20)); // Pausa reale per il rendering
            }
            try {
                // 3. MATCHING PRELIMINARE
                const rawPatID = colPatID ? row[colPatID] : null;
                const rawPatName = colPatName ? row[colPatName] : '';
                const displayPat = rawPatName || rawPatID || 'N/A';

                // 1. DATA
                let dateVal = row[colDate];
                let dateStr = null;
                if (typeof dateVal === 'number') {
                    const dateObj = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
                    dateStr = dateObj.toISOString().split('T')[0];
                } else if (typeof dateVal === 'string') dateStr = dateVal.split('T')[0];

                // 2. ORA (Lookup)
                const rowNo = row[colRowNo];
                const timeStr = window.slotsMap[String(rowNo)];

                if (!dateStr || !timeStr) {
                    // Se manca l'orario, segnalalo
                    const reason = !dateStr ? "Data mancante" : `Orario non trovato per RowNo ${rowNo}`;
                    missed.push({ d: dateStr || 'N/A', t: timeStr || 'N/A', p: displayPat, err: reason });
                    continue;
                }

                // Cerca esatto (o data+1)
                let candidates = dbAppts.filter(a => a.data === dateStr);
                if (candidates.length === 0) {
                    let dCheck = new Date(dateStr); dCheck.setDate(dCheck.getDate() + 1);
                    const dateStrPlus1 = dCheck.toISOString().split('T')[0];
                    if (dbAppts.some(a => a.data === dateStrPlus1)) {
                        candidates = dbAppts.filter(a => a.data === dateStrPlus1);
                        dateStr = dateStrPlus1; // Adjust date
                    }
                }

                let match = null;
                if (rawPatID && candidates.length > 0) match = candidates.find(a => String(a.pazienteID) === String(rawPatID));
                if (!match && rawPatName && candidates.length > 0) {
                    const search = normalizeText(rawPatName);
                    match = candidates.find(a => (a.pazienteNome && normalizeText(a.pazienteNome).includes(search)));
                }

                if (match) {
                    updates[match.id + '/oraInizio'] = timeStr;
                    matched++;
                } else {
                    missed.push({ d: dateStr, t: timeStr, p: displayPat, err: "Nessun appuntamento corrispondente nel DB" });
                }
            } catch (e) { errors++; }
        }

        logLive("💾 Salvataggio modifiche su Firebase...", "info");
        if (matched > 0) {
            await update(ref(db, ROOT + '/GiroVisite'), updates);
            logLive(`✅ SALVATAGGIO COMPLETATO! ${matched} record aggiornati.`, "success");
        } else {
            logLive("⚠️ Nessun record abbinato, nulla da salvare.", "error");
        }

        logLive("🏁 PROCESSO TERMINATO.", "info");

        if (missed.length > 0) {
            if (confirm(`✅ FINITO!\n\n📊 STATISTICHE:\n- Totale: ${window.accessDataFull.length}\n- ✅ Aggiornati: ${matched}\n- ⚠️ Skippati: ${missed.length}\n\nScarica Report Errori?`)) {
                const csv = "\uFEFFData;Ora;Paziente;Motivo\n" + missed.map(x => `"${x.d}";"${x.t}";"${x.p}";"${x.err}"`).join('\n');
                const v4BlobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                const a = document.createElement("a"); a.href = v4BlobUrl; a.download = "report_v4.csv"; a.click();
                setTimeout(() => URL.revokeObjectURL(v4BlobUrl), 1000);
            }
        } else {
            alert("✅ IMPORTAZIONE PERFETTA! Nessun errore.");
        }
    } catch (globalErr) {
        console.error(globalErr);
        logLive("❌ ERRORE CRITICO SCRIPT: " + globalErr.message, "error");
        alert("Errore durante l'esecuzione: " + globalErr.message);
    }

    // Reload ritardato per far leggere il log
    // setTimeout(() => location.reload(), 5000); 
};

// ============ MIGRAZIONE V5 ============
// ============================================================================
// SCRIPT MIGRAZIONE V5: DA MODELLO SLOT A MODELLO ORARIO
// ============================================================================
// Questo script aggiorna admin.html per la migrazione completa
// 
// OBIETTIVO:
// - Stanze con orari (5,6,7,8,9): rowNo → startTime/endTime
// - Stanze lista (1,2,3,4,10,11): rowNo → orderIndex (rinominato per chiarezza)
//
// USO:
// 1. Sostituisci la funzione commitAccessImportV4 in admin.html
// 2. Carica tblTimeSlots.xlsx e tblAppointments.xlsx
// 3. Clicca "AVVIA MIGRAZIONE V5"
// ============================================================================

/**
 * CONFIGURAZIONE STANZE
 * Definisci quali stanze hanno orari vincolati e quali sono liste libere
 */
const STANZE_CONFIG = {
    // Stanze con orari fissi (usano startTime/endTime)
    CON_ORARI: [5, 6, 7, 8, 9],

    // Stanze lista (usano orderIndex, senza vincoli orari)
    LISTA: [1, 2, 3, 4, 10, 11]
};

/**
 * FUNZIONE PRINCIPALE DI MIGRAZIONE V5
 */
window.commitAccessImportV5 = async () => {
    if (!window.accessDataFull) {
        alert("❌ Nessun file tblAppointments.xlsx caricato!");
        return;
    }
    if (Object.keys(window.slotsMap).length === 0) {
        alert("❌ Manca il file tblTimeSlots.xlsx!");
        return;
    }

    const confirmMsg = `⚠️ MIGRAZIONE V5: MODELLO SLOT → MODELLO ORARIO

STANZE CON ORARI (${STANZE_CONFIG.CON_ORARI.length}):
  → Aggiungerà startTime + endTime

STANZE LISTA (${STANZE_CONFIG.LISTA.length}):
  → Rinominerà rowNo → orderIndex

APPUNTAMENTI TOTALI DA MIGRARE: ${window.accessDataFull.length}

⚠️ OPERAZIONE IRREVERSIBILE!
(Fai un backup prima di procedere)

Confermi?`;

    if (!confirm(confirmMsg)) return;

    try {
        // Setup UI
        const logDiv = document.getElementById('importLog');
        const logContainer = document.getElementById('importLogContainer');
        logContainer.style.display = 'block';
        logDiv.innerHTML = '';

        logLive("🚀 AVVIO MIGRAZIONE V5...", "info");
        await sleep(50);

        logLive(`📂 File Excel: ${window.accessDataFull.length}`, "info");
        logLive(`🔧 Slots caricati: ${Object.keys(window.slotsMap).length}`, "info");
        logLive("⏳ Download database Firebase...", "info");
        await sleep(50);

        // === 1. SCARICA DATABASE ===
        const snapGV = await get(ref(db, ROOT + '/GiroVisite'));
        const dbAppts = Object.entries(snapGV.val() || {}).map(([k, v]) => ({ ...v, id: k }));
        logLive(`✅ Database scaricato: ${dbAppts.length} appuntamenti`, "success");

        // === 2. PREPARA UPDATES ===
        const updates = {};
        const stats = {
            total: 0,
            conOrari: 0,
            lista: 0,
            matched: 0,
            notFound: 0,
            errors: []
        };

        // Auto-detect colonne
        const sample = window.accessDataFull[0];
        const keys = Object.keys(sample);
        const findKey = (candidates) => keys.find(k => candidates.some(c => k.toLowerCase().includes(c)));

        const colDate = findKey(['apptdate', 'date', 'data']);
        const colPatID = findKey(['patientid', 'pazienteid']);
        const colCatID = findKey(['categoryid', 'stanzaid', 'groupid']);
        const colStartTime = findKey(['apptstarttime', 'starttime', 'start']);
        const colEndTime = findKey(['apptendtime', 'endtime', 'end']);

        logLive(`📋 Colonne rilevate: Date=${colDate}, PatID=${colPatID}, CatID=${colCatID}`, "info");
        logLive("⚙️ Inizio elaborazione...", "info");
        await sleep(50);

        // === 3. ELABORA OGNI RIGA ===
        const CHUNK_SIZE = 10;
        for (let i = 0; i < window.accessDataFull.length; i++) {
            const row = window.accessDataFull[i];
            stats.total++;

            // Log progress ogni 10 righe
            if (i % CHUNK_SIZE === 0) {
                logLive(`⏳ Riga ${i + 1}/${window.accessDataFull.length}...`);
                await sleep(20);
            }

            try {
                // === 3.1 ESTRAI DATI BASE ===
                const rawPatID = colPatID ? row[colPatID] : null;
                const rawCatID = colCatID ? row[colCatID] : null;

                // Data
                let dateVal = row[colDate];
                let dateStr = null;
                if (typeof dateVal === 'number') {
                    const dateObj = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
                    dateStr = dateObj.toISOString().split('T')[0];
                } else if (typeof dateVal === 'string') {
                    dateStr = dateVal.split('T')[0];
                }

                if (!dateStr || !rawPatID || !rawCatID) {
                    stats.errors.push({ row: i + 1, reason: "Dati mancanti", data: row });
                    continue;
                }

                // === 3.2 ESTRAI ORARI DA EXCEL ===
                let startTime = null;
                let endTime = null;

                // Funzione helper per convertire time Excel
                const extractTime = (val) => {
                    if (!val) return null;
                    if (typeof val === 'string') {
                        // Formato "00/01/1900 08:00:00"
                        if (val.includes(' ')) {
                            const timePart = val.split(' ')[1];
                            return timePart.substring(0, 5); // "08:00"
                        }
                        return val.substring(0, 5);
                    }
                    if (typeof val === 'number') {
                        // Excel decimal time
                        const sec = Math.round(val * 86400);
                        const h = Math.floor(sec / 3600);
                        const m = Math.floor((sec % 3600) / 60);
                        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                    }
                    return null;
                };

                startTime = extractTime(row[colStartTime]);
                endTime = extractTime(row[colEndTime]);

                // === 3.3 TROVA APPUNTAMENTO IN FIREBASE ===
                let match = dbAppts.find(a =>
                    String(a.pazienteID) === String(rawPatID) &&
                    a.data === dateStr &&
                    String(a.stanzaID) === String(rawCatID)
                );

                if (!match) {
                    stats.notFound++;
                    stats.errors.push({
                        row: i + 1,
                        reason: "Appuntamento non trovato in Firebase",
                        patID: rawPatID,
                        date: dateStr,
                        catID: rawCatID
                    });
                    continue;
                }

                // === 3.4 AGGIORNA IN BASE AL TIPO STANZA ===
                const catID = parseInt(rawCatID);

                if (STANZE_CONFIG.CON_ORARI.includes(catID)) {
                    // STANZA CON ORARI → Aggiungi startTime/endTime
                    if (startTime && endTime) {
                        updates[`${match.id}/startTime`] = startTime;
                        updates[`${match.id}/endTime`] = endTime;
                        // Mantieni rowNo per compatibilità temporanea
                        stats.conOrari++;
                    } else {
                        stats.errors.push({
                            row: i + 1,
                            reason: "Orari mancanti per stanza CON_ORARI",
                            patID: rawPatID
                        });
                    }
                } else if (STANZE_CONFIG.LISTA.includes(catID)) {
                    // STANZA LISTA → Rinomina rowNo → orderIndex
                    if (match.rowNo) {
                        updates[`${match.id}/orderIndex`] = match.rowNo;
                        updates[`${match.id}/rowNo`] = null; // Rimuovi vecchio campo
                        stats.lista++;
                    }
                } else {
                    // Stanza non configurata - segnala
                    stats.errors.push({
                        row: i + 1,
                        reason: `Stanza ${catID} non configurata in STANZE_CONFIG`
                    });
                }

                stats.matched++;

            } catch (err) {
                stats.errors.push({ row: i + 1, reason: err.message });
            }
        }

        // === 4. SALVA SU FIREBASE ===
        logLive("💾 Salvataggio modifiche...", "info");
        await sleep(100);

        if (stats.matched > 0) {
            await update(ref(db, ROOT + '/GiroVisite'), updates);
            logLive(`✅ SALVATO! ${stats.matched} record aggiornati`, "success");
        } else {
            logLive("⚠️ Nessun record da aggiornare", "error");
        }

        // === 5. REPORT FINALE ===
        logLive("🏁 MIGRAZIONE COMPLETATA!", "success");

        const report = `
✅ MIGRAZIONE V5 COMPLETATA!

📊 STATISTICHE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Totale righe Excel: ${stats.total}
  ✅ Abbinati: ${stats.matched}
  🕒 Con orari aggiunti: ${stats.conOrari}
  📋 Liste (orderIndex): ${stats.lista}
  ❌ Non trovati: ${stats.notFound}
  ⚠️ Errori: ${stats.errors.length}

${stats.errors.length > 0 ? '⚠️ Scarica report errori per dettagli' : '✅ Nessun errore!'}`;

        alert(report);

        if (stats.errors.length > 0 && confirm("Vuoi scaricare il report errori?")) {
            const csv = "\uFEFFRiga;Motivo;Dettagli\n" +
                stats.errors.map(e =>
                    `"${e.row}";"${e.reason}";"${JSON.stringify(e)}"`
                ).join('\n');

            const blob = new Blob([csv], { type: 'text/csv' });
            const v5BlobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = v5BlobUrl;
            a.download = `migration_v5_errors_${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(v5BlobUrl), 1000);
        }

        // Chiedi conferma prima di ricaricare
        if (confirm("✅ Migrazione completata!\n\nRicaricare la pagina per vedere i dati aggiornati?")) {
            location.reload();
        }

    } catch (globalErr) {
        console.error(globalErr);
        logLive(`❌ ERRORE CRITICO: ${globalErr.message}`, "error");
        alert(`❌ Errore: ${globalErr.message}`);
    }
};

// Helper function sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================================



// ==========================================
//  SIMULAZIONE V8 (DRY RUN)
// ==========================================
window.simulateAccessImportV8 = async () => {
    if (!window.accessDataFull) { alert("Nessun file caricato!"); return; }
    if (Object.keys(window.slotsMap).length === 0) { alert("Manca il file TimeSlots!"); return; }

    const logLive = console.log;
    const json = window.accessDataFull;
    const STANZE_LISTA = [8, 9];

    // COPIA LOGICA MAPPING (Identica a V8)
    const sample = json[0];
    const keys = Object.keys(sample);
    const findKey = (candidates) => keys.find(k => candidates.some(c => k.toLowerCase().includes(c)));
    const colDate = findKey(['date', 'data', 'apptdate']);
    const colStartTime = findKey(['starttime', 'start_time', 'apptstart', 'orainizio']);
    const colRowNo = findKey(['rowno', 'row_no', 'riga', 'slot']);
    const colCategoryID = findKey(['categoryid', 'category_id', 'stanzaid', 'idstanza']);

    function extractTimeSim(excelDate) {
        if (!excelDate) return null;
        if (excelDate instanceof Date) {
            const hours = excelDate.getUTCHours().toString().padStart(2, '0');
            const minutes = excelDate.getUTCMinutes().toString().padStart(2, '0');
            return `${hours}:${minutes}`;
        }
        return null; // Semplificato per sim
    }

    let html = "<div style='position:fixed;top:5%;left:5%;width:90%;height:90%;background:white;border:2px solid black;z-index:9999;overflow:auto;padding:20px;box-shadow:0 0 20px rgba(0,0,0,0.5)'>";
    html += "<h2>🧪 RISULTATO SIMULAZIONE (Primi 50 Record)</h2>";
    html += "<p>Questi sono i dati che VERRANNO scritti nel database. Controlla se le date sono corrette (AAAA-MM-GG) e gli orari sensati.</p>";
    html += "<button onclick='this.parentElement.remove()' style='background:red;color:white;padding:10px;margin-bottom:10px;cursor:pointer'>CHIUDI ANTEPRIMA</button>";
    html += "<table border='1' cellpadding='5' style='border-collapse:collapse;width:100%'>";
    html += "<tr style='background:#eee'><th>Riga</th><th>Data RAW (Excel)</th><th>📅 DATA FINALE (DB)</th><th>⏰ ORA (DB)</th><th>Stanza</th><th>Esito</th></tr>";

    for (let i = 0; i < Math.min(50, json.length); i++) {
        const row = json[i];
        const dateVal = row[colDate];
        let dateStr = "???";
        let rawShow = dateVal instanceof Date ? dateVal.toISOString() : dateVal;

        // LOGICA V8 FIX DATE
        if (dateVal instanceof Date) {
            const safeDate = new Date(dateVal.getTime() + (12 * 60 * 60 * 1000));
            dateStr = safeDate.toISOString().split('T')[0];
        }

        // LOGICA V8 ORARI
        let oraInizio = null;
        let source = "";
        const isLista = STANZE_LISTA.includes(parseInt(row[colCategoryID] || 0));

        if (isLista) {
            oraInizio = "-";
            source = "LISTA (OK)";
        } else {
            // Prova diretta
            if (colStartTime) oraInizio = extractTimeSim(row[colStartTime]);

            // Fallback Lookup
            if (!oraInizio || oraInizio === '00:00') {
                const timeStr = window.slotsMap[String(row[colRowNo])];
                if (timeStr && timeStr.length >= 5 && !timeStr.includes('1900')) {
                    oraInizio = timeStr.substring(0, 5); source = "LOOKUP";
                } else {
                    oraInizio = "NULL"; source = "MANCANTE";
                }
            } else {
                source = "EXCEL";
            }
        }

        const colorDate = dateStr.includes('-') && !dateStr.includes('1899') ? 'green' : 'red';
        const colorTime = oraInizio !== 'NULL' && oraInizio !== '-' ? 'blue' : 'gray';

        html += `<tr>
            <td>${i + 1}</td>
            <td style="font-size:0.8em;color:#666">${rawShow}</td>
            <td style="font-weight:bold;color:${colorDate}">${dateStr}</td>
            <td style="font-weight:bold;color:${colorTime}">${oraInizio} <span style='font-size:0.7em'>(${source})</span></td>
            <td>${row[colCategoryID]}</td>
            <td>${dateStr.includes('2025') ? '✅' : '❌'}</td>
         </tr>`;
    }
    html += "</table></div>";

    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div);
}

console.log("🚀 V8 SCRIPT LOADED");

// POPUP RIMOSSO
// setTimeout(() => {
//     alert("✅ SCRIPT V8 AGGIORNATO E CARICATO!\\n\\nSe vedi questo messaggio, il codice è NUOVO.\\nPuoi procedere con l'importazione 'V8 REBOOT'.");
// }, 1000);

// Indicatore visivo che lo script è attivo
const title = document.querySelector('.header h2');
if (title) title.innerHTML += " <span style='font-size:12px; color:white; background:#ef4444; padding:2px 6px; border-radius:4px;'>v8.0 REBOOT</span>";

// Funzioni Logiche
window.slotsMap = {};
window.accessDataFull = [];

function logStatus(msg, color = 'black') {
    console.log(msg);
    // Opzionale: notifiche a schermo
}

// 1. GESTORE SLOTS
const handleSlotsUpload = function (evt) {
    const file = evt.target.files[0];
    if (!file) return;

    const nameDiv = document.getElementById('slotsFileName');
    if (nameDiv) { nameDiv.innerText = "⏳ Lettura..."; nameDiv.style.color = "orange"; }

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });

            if (json.length === 0) throw new Error("File vuoto");

            // Mapping
            // Mapping V8: TimeGroupID + TimeSlotRow -> Time
            window.slotsMap = {}; // Format: "GroupID_RowNo" -> "HH:MM"

            const keys = Object.keys(json[0]);
            const colGroup = keys.find(k => /group/i.test(k)); // TimeGroupID
            const colRow = keys.find(k => /row|riga/i.test(k) && !/group/i.test(k)); // TimeSlotRow
            // Cerca colonna orario: StartEndTimes, Time, Orario — escludi ID, Group, Row
            const colTime = keys.find(k => /startend|orario/i.test(k)) 
                || keys.find(k => /time/i.test(k) && !/group|row|slot.*id|timeslotid/i.test(k));

            if (!colGroup || !colRow || !colTime) {
                // Fallback per vecchi formati (ID -> Time) se proprio non trova i gruppi
                console.warn("Colonne Gruppi non trovate, tento ID semplice...");
                const colID = keys.find(k => /id/i.test(k));
                if (colID && colTime) {
                    json.forEach(row => {
                        let t = parseExcelTime(row[colTime]);
                        if (row[colID] && t) window.slotsMap[String(row[colID])] = t;
                    });
                    console.log("Fallback ID semplice usato.");
                    alert("⚠️ Attenzione: File Slots semplice. E' consigliato usare quello con TimeGroupID e TimeSlotRow.");
                } else {
                    throw new Error("Colonne Group/Row/Time mancanti.");
                }
            } else {
                // Logica V8 Corretta
                json.forEach(row => {
                    const g = row[colGroup];
                    const r = row[colRow];
                    let t = parseExcelTime(row[colTime]);

                    if (g && r && t) {
                        window.slotsMap[`${g}_${r}`] = t;
                    }
                });
            }

            function parseExcelTime(t) {
                if (!t && t !== 0) return null;
                // Range "08:40 - 09:20" → solo inizio
                if (typeof t === 'string' && t.includes(' - ')) t = t.split(' - ')[0].trim();
                // Numero frazionario Excel
                if (typeof t === 'number') {
                    const fraction = t % 1;
                    if (fraction === 0 && t > 1) return null;
                    const totalMinutes = Math.round(fraction * 1440);
                    const h = Math.floor(totalMinutes / 60);
                    const m = totalMinutes % 60;
                    const result = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                    return result === '00:00' ? null : result;
                }
                // Stringa
                if (typeof t === 'string') {
                    if (t.includes('T')) t = t.split('T')[1];
                    const match = t.match(/(\d{1,2}):(\d{2})/);
                    if (match) return `${match[1].padStart(2, '0')}:${match[2]}`;
                }
                return null;
            }

            if (nameDiv) { nameDiv.innerText = "✅ " + file.name; nameDiv.style.color = "green"; }

            const statusDiv = document.getElementById('slotsStatus');
            if (statusDiv) {
                statusDiv.innerText = `✅ OK (${Object.keys(window.slotsMap).length} slot)`;
                statusDiv.style.color = "green";
            }

            updateButtons();

        } catch (err) {
            alert("Errore file Slots: " + err.message);
            if (nameDiv) { nameDiv.innerText = "❌ Errore"; nameDiv.style.color = "red"; }
        }
    };
    reader.readAsArrayBuffer(file);
};

// 2. GESTORE APPUNTAMENTI
const handleAccessUpload = function (evt) {
    const file = evt.target.files[0];
    if (!file) return;

    const nameDiv = document.getElementById('accessFileName');
    if (nameDiv) nameDiv.innerText = "⏳ Lettura...";

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array', cellDates: true });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            // FIX CRITICO: raw: true serve per ottenere oggetti Date veri (grazie a cellDates: true)
            // Se usassimo raw: false, otterremmo stringhe corrotte tipo "1/0/00"
            const json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });

            window.accessDataFull = json;

            if (nameDiv) { nameDiv.innerText = "✅ " + file.name; nameDiv.style.color = "blue"; }

            document.getElementById('accTotal').innerText = json.length;
            document.getElementById('accessStats').style.display = 'block';

            // Anteprima intelligente
            const cols = Object.keys(json[0] || {});
            const thead = document.querySelector('#accessPreviewTable thead');
            const tbody = document.querySelector('#accessPreviewTable tbody');

            if (thead && json.length > 0) {
                thead.innerHTML = `<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`;

                // Mostra ultime 30 righe ordinate dal più futuro
                const colDate = cols.find(c => /date|data/i.test(c));
                const sorted = [...json].sort((a, b) => {
                    const da = colDate && a[colDate] instanceof Date ? a[colDate] : new Date(0);
                    const db = colDate && b[colDate] instanceof Date ? b[colDate] : new Date(0);
                    return db - da;
                });

                tbody.innerHTML = sorted.slice(0, 30).map(r => {
                    const cells = cols.map(c => {
                        let v = r[c];
                        // Formattazione per preview (SOLO VISIVA)
                        if (v instanceof Date) {
                            // Formato italiano: 23/04/2025
                            return `<td>${v.toLocaleDateString('it-IT')}</td>`;
                        }
                        return `<td>${v}</td>`;
                    }).join('');
                    return `<tr>${cells}</tr>`;
                }).join('');

                document.getElementById('accessPreview').style.display = 'block';
            }

            updateButtons();

        } catch (err) {
            alert("Errore file Appuntamenti: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
};

// 3. AGGIORNAMENTO UI
function updateButtons() {
    const hasSlots = Object.keys(window.slotsMap || {}).length > 0;
    const hasAppts = (window.accessDataFull || []).length > 0;

    const slotsStatus = document.getElementById('slotsStatus');
    if (slotsStatus) slotsStatus.innerHTML = hasSlots 
        ? `SI ✅ (${Object.keys(window.slotsMap).length} slot)` 
        : 'NO ❌';
}

// ==========================================
// DRY RUN: Scannerizza TUTTE le righe, mostra solo problemi
// ==========================================
window.dryRunImport = async () => {
    if (!window.accessDataFull || window.accessDataFull.length === 0) {
        alert("Carica prima il file Appuntamenti!"); return;
    }

    const logDiv = document.getElementById('importLog');
    const logContainer = document.getElementById('importLogContainer');
    logContainer.style.display = 'block';
    logDiv.innerHTML = '';
    const log = window.logLive;

    const STANZE_LISTA = [5, 8, 9];
    const sample = window.accessDataFull[0];
    const keys = Object.keys(sample);
    const findKey = (candidates) => keys.find(k => candidates.some(c => k.toLowerCase().includes(c)));

    const colDate = findKey(['date', 'data', 'apptdate']);
    const colStartTime = findKey(['starttime', 'start_time', 'apptstart', 'orainizio']);
    const colEndTime = findKey(['endtime', 'end_time', 'apptend', 'orafine']);
    const colPatID = findKey(['patientid', 'pazienteid']);
    const colCategoryID = findKey(['categoryid', 'category_id', 'stanzaid']);
    const colRowNo = findKey(['rowno', 'row_no', 'riga']);

    const total = window.accessDataFull.length;
    log(`🔍 SCANSIONE COMPLETA: ${total} righe...`, "info");

    // Helper identico a quello nell'import V8
    function testExtractTime(val) {
        if (!val && val !== 0) return null;
        if (typeof val === 'number') {
            const fraction = val % 1;
            if (fraction === 0 && val > 1) return null;
            const totalMinutes = Math.round(fraction * 1440);
            const h = Math.floor(totalMinutes / 60);
            const m = totalMinutes % 60;
            const result = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            return result === '00:00' ? null : result;
        }
        if (val instanceof Date) {
            const h = val.getHours(); const m = val.getMinutes();
            if (h === 0 && m === 0) return null;
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
        if (typeof val === 'string') {
            if (val.includes(' - ')) val = val.split(' - ')[0].trim();
            if (val.includes('T')) val = val.split('T')[1];
            const match = val.match(/(\d{1,2}):(\d{2})/);
            if (match) { const r = `${match[1].padStart(2, '0')}:${match[2]}`; return r === '00:00' ? null : r; }
        }
        return null;
    }

    let okDirect = 0, okLookup = 0, lista = 0;
    const problems = []; // Solo righe problematiche

    for (let i = 0; i < total; i++) {
        // Aggiorna progresso ogni 5000 righe
        if (i % 5000 === 0 && i > 0) {
            log(`  ... ${i}/${total} analizzate, ${problems.length} problemi trovati`, "info");
            await new Promise(r => setTimeout(r, 0));
        }

        const row = window.accessDataFull[i];
        const catID = parseInt(row[colCategoryID]);
        const isLista = STANZE_LISTA.includes(catID);

        if (isLista) { lista++; continue; }

        const rawStart = colStartTime ? row[colStartTime] : null;
        const converted = testExtractTime(rawStart);

        if (converted) {
            okDirect++;
        } else {
            // Prova lookup
            const rowNo = row[colRowNo];
            const HARDCODED_GROUPS = {"1":6,"2":5,"3":21,"4":8,"5":18,"6":9,"7":15,"8":20,"9":20,"10":9,"11":21};
            const groupID = HARDCODED_GROUPS[String(catID)];
            const lookupKey = groupID ? `${groupID}_${rowNo}` : null;
            const fromLookup = lookupKey ? window.slotsMap[lookupKey] : null;

            if (fromLookup) {
                okLookup++;
            } else {
                problems.push({
                    row: i + 2,
                    raw: rawStart,
                    type: typeof rawStart,
                    cat: catID,
                    rowNo: rowNo,
                    pat: row[colPatID],
                    date: row[colDate],
                    lookupKey: lookupKey
                });
            }
        }
    }

    log("─".repeat(60), "info");
    log(`📊 RISULTATO SCANSIONE COMPLETA (${total} righe):`, "info");
    log(`  ✅ Orario diretto OK: ${okDirect}`, "success");
    log(`  🔍 Orario da lookup OK: ${okLookup}`, okLookup > 0 ? "success" : "info");
    log(`  📋 Stanze lista (no orario): ${lista}`, "info");
    log(`  ❌ PROBLEMI: ${problems.length}`, problems.length > 0 ? "error" : "success");
    log("─".repeat(60), "info");

    if (problems.length === 0) {
        log("🎉 NESSUN PROBLEMA! Puoi procedere con l'import.", "success");
    } else {
        log(`\n⚠️ DETTAGLIO ${problems.length} RIGHE PROBLEMATICHE:`, "error");
        problems.forEach(p => {
            log(`  Riga ${p.row}: Raw=[${p.type}] ${JSON.stringify(p.raw)} | Stanza ${p.cat} | RowNo ${p.rowNo} | Paz ${p.pat} | Lookup: ${p.lookupKey || 'N/A'}`, "error");
        });

        log(`\n💡 Queste ${problems.length} righe verranno SALTATE durante l'import (no orario = no import per stanze con orario).`, "warning");
        log(`   Su ${total} righe totali, rappresentano lo ${(problems.length/total*100).toFixed(2)}% — probabilmente accettabile.`, "info");
    }
};

// ==========================================
// IMPORT V8 REBOOT: FINAL (Logica Stanze Corretta + Fix Date)
// ==========================================
window.commitAccessImportV8_Final = async () => {
    // ════════════════════════════════════════════════════════
    // ASPETTA CHE AUTH SIA COMPLETATA
    // ════════════════════════════════════════════════════════
    if (!authReady) {
        console.log("⏳ Attendo autenticazione Firebase...");
        await window.waitForAuth();
    }
    console.log("✅ Auth verificata, procedo con import");
    
    const logLive = window.logLive;
    const decrypt = window.decrypt;
    const push = window.push;

    // CONFIGURAZIONE STANZE DEFINITIVA
    // CONFIGURAZIONE STANZE DEFINITIVA
    // Stanze 8 (Medicazioni), 9 (Ritiro Terapia), 5 (Prelievi) sono LISTE -> Niente orari
    const STANZE_LISTA = [5, 8, 9]; // Stanze a slot: 5=Prelievi, 8=Medicazioni, 9=Ritiro Terapia


    if (!window.accessDataFull) { alert("Nessun file caricato!"); return; }
    if (Object.keys(window.slotsMap).length === 0) { alert("Manca il file TimeSlots!"); return; }

    const WIPE_MODE = confirm("💣 ATTENZIONE: MODALITÀ RIPRISTINO TOTALE (V8 REBOOT)\\n\\nQuesta operazione:\\n1. CANCELLA tutti gli appuntamenti esistenti\\n2. IMPORTA i nuovi dati con la logica corretta per stanze lista vs orario\\n\\n- Stanze 1-7, 10-11: Avranno ORARI\\n- Stanze 8-9: Saranno LISTE (senza orario)\\n\\nProcedere?");

    if (!WIPE_MODE) return;

    if (!confirm("⚠️ Sei DAVVERO sicuro?\nI dati attuali verranno persi irrimediabilmente.")) return;

    // Setup Log
    const logDiv = document.getElementById('importLog');
    const logContainer = document.getElementById('importLogContainer');
    logContainer.style.display = 'block';
    logDiv.innerHTML = '';

    logLive(`🚀 AVVIO IMPORTAZIONE V7 FINAL...`, "info");
    logLive(`📂 Righe Excel: ${window.accessDataFull.length}`, "info");

    // 1. SCARICA DATI DI RIFERIMENTO
    logLive("⏳ Caricamento anagrafiche...", "info");

    let pazientiMap, categorieMap;
    try {
        const snapPaz = await get(ref(db, ROOT + '/pazienti'));
        pazientiMap = snapPaz.val() || {};

        const snapCat = await get(ref(db, ROOT + '/tblCategories'));
        categorieMap = snapCat.val() || {};

        logLive(`✅ Riferimenti: ${Object.keys(pazientiMap).length} Pazienti, ${Object.keys(categorieMap).length} Stanze.`, "success");
    } catch (error) {
        logLive(`❌ ERRORE LETTURA: ${error.message}`, "error");
        
        if (error.message.includes('Permission denied')) {
            logLive(`\n💥 FIREBASE RULES BLOCCANO LA LETTURA`, "error");
            logLive(`\n🔧 SOLUZIONE:`, "warning");
            logLive(`1. Apri: https://console.firebase.google.com`, "warning");
            logLive(`2. Progetto: ospedale-appuntamenti`, "warning");
            logLive(`3. Realtime Database → Rules`, "warning");
            logLive(`4. Cambia in:`, "warning");
            logLive(`   {`, "warning");
            logLive(`     "rules": {`, "warning");
            logLive(`       ".read": "auth != null",`, "warning");
            logLive(`       ".write": "auth != null"`, "warning");
            logLive(`     }`, "warning");
            logLive(`   }`, "warning");
            logLive(`5. Clicca PUBLISH`, "warning");
            logLive(`6. Aspetta 15 secondi`, "warning");
            logLive(`7. Riprova`, "warning");
        }
        
        alert("❌ Impossibile leggere dal database!\n\nVedi log per dettagli.");
        return;
    }

    // 2. MAPPING COLONNE
    const sample = window.accessDataFull[0];
    const keys = Object.keys(sample);
    const findKey = (candidates) => keys.find(k => candidates.some(c => k.toLowerCase().includes(c)));

    const colDate = findKey(['date', 'data', 'apptdate']);
    const colPatID = findKey(['patientid', 'pazienteid', 'idpaziente', 'patient_id']);
    const colCategoryID = findKey(['categoryid', 'category_id', 'stanzaid', 'idstanza']);
    const colRowNo = findKey(['rowno', 'row_no', 'riga', 'slot']);
    const colNote = findKey(['note', 'notes', 'descrizione', 'apptnotes']);
    const colStartTime = findKey(['starttime', 'start_time', 'apptstart', 'orainizio']);
    const colEndTime = findKey(['endtime', 'end_time', 'apptend', 'orafine']);

    // 3. FUNZIONE HELPER: Estrai ora da qualsiasi formato SheetJS
    function extractTime(val) {
        if (!val && val !== 0) return null;

        // CASO 1: Numero frazionario (SheetJS default per time)
        // 0.3333 = 08:00, 0.5 = 12:00, 0.75 = 18:00
        if (typeof val === 'number') {
            const fraction = val % 1; // ignora parte intera (giorni)
            if (fraction === 0 && val > 1) return null; // È solo un intero, non un tempo
            const totalMinutes = Math.round(fraction * 1440);
            const h = Math.floor(totalMinutes / 60);
            const m = totalMinutes % 60;
            const result = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            return result === '00:00' ? null : result; // 00:00 = probabilmente non un orario valido
        }

        // CASO 2: Oggetto Date (SheetJS con cellDates:true)
        if (val instanceof Date) {
            const h = val.getHours();
            const m = val.getMinutes();
            if (h === 0 && m === 0) return null;
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }

        // CASO 3: Stringa
        if (typeof val === 'string') {
            // Range "08:40 - 09:20" → prendi solo inizio
            if (val.includes(' - ')) val = val.split(' - ')[0].trim();
            // ISO "1900-01-01T08:00:00" → prendi dopo T
            if (val.includes('T')) val = val.split('T')[1];
            // Cerca HH:MM
            const match = val.match(/(\d{1,2}):(\d{2})/);
            if (match) {
                const result = `${match[1].padStart(2, '0')}:${match[2]}`;
                return result === '00:00' ? null : result;
            }
        }

        return null;
    }


    // 4. CARICA REGOLE FIREBASE (per risolvere orari mancanti)
    const snapReg = await get(ref(db, ROOT + '/RegoleAttive'));
    const regoleAttive = snapReg.val() || {};
    
    // Helper: trova orario dallo slot della regola per stanza/data/rowNo
    function resolveTimeFromRule(stanzaID, dateStr, rowNo) {
        const date = new Date(dateStr + 'T12:00:00');
        const wd = date.getDay() === 0 ? 7 : date.getDay();
        const iso = dateStr;
        
        // Trova regola migliore (stessa logica di findRegolaPer in index-script)
        let best = null, bestP = -1, bestDate = null;
        for (const [id, r] of Object.entries(regoleAttive)) {
            if (String(r.catId) !== String(stanzaID)) continue;
            if (r.validaDa && iso < r.validaDa) continue;
            if (r.validaA && iso > r.validaA) continue;
            let match = false, p = 0;
            if (r.freq === 'once' && r.dataSpecifica === iso) { match = true; p = 3; }
            if (r.freq === 'monthly' && r.date && r.date.includes(iso)) { match = true; p = 2; }
            if (r.freq === 'weekly' && r.giorni && r.giorni.includes(wd)) { match = true; p = 1; }
            if (match && (p > bestP || (p === bestP && new Date(r.createdAt || 0) > (bestDate || new Date(0))))) {
                bestP = p; best = r; bestDate = new Date(r.createdAt || 0);
            }
        }
        
        if (!best || !best.slots) return null;
        
        // Slot al rowNo (1-based)
        const slot = best.slots[rowNo - 1];
        if (!slot || !slot.ora) return null;
        
        // Estrai inizio da "08:40 - 09:20"
        return slot.ora.includes(' - ') ? slot.ora.split(' - ')[0] : slot.ora;
    }

    // 5. ELABORAZIONE
    const newAppts = {};
    let created = 0;
    let skipped = [];

    // Statistiche
    let sDirect = 0; // Orari diretti
    let sLookup = 0; // Orari da lookup
    let sLista = 0; // Stanze lista (no orario)
    let sNull = 0; // Orari mancanti
    let sFromRule = 0; // Orari risolti da regole Firebase
    let sDuplicates = 0; // Duplicati saltati
    let missingErrors = []; // Array per tracciare errori

    window.processedKeys = new Set();

    const CHUNK_SIZE = 50;

    for (let i = 0; i < window.accessDataFull.length; i++) {
        if (i % CHUNK_SIZE === 0) {
            logLive(`Elaborazione riga ${i +
                1}...`); await new Promise(r => setTimeout(r, 0));
        }

        const row = window.accessDataFull[i];
        try {
            // A. Data
            const patID = row[colPatID]; // SPOSTATO QUI PER EVITARE REFERENCE ERROR
            let dateStr = null;
            const dateVal = row[colDate];

            if (dateVal instanceof Date) {
                // FIX DEFINITIVO LOCAL DATE:
                // Ignoriamo UTC/Offset e prendiamo i numeri "faccia a vista"
                const year = dateVal.getFullYear();
                const month = String(dateVal.getMonth() + 1).padStart(2, '0');
                const day = String(dateVal.getDate()).padStart(2, '0');
                dateStr = `${year}-${month}-${day}`;
            } else if (typeof dateVal === 'number') {
                // Numero seriale Excel
                const dateObj = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
                dateStr = dateObj.toISOString().split('T')[0];
            } else if (typeof dateVal === 'string') {
                // Gestione formati stringa vari (M/D/Y o ISO o altro)
                const d = new Date(dateVal);
                if (!isNaN(d.getTime())) {
                    dateStr = d.toISOString().split('T')[0];
                } else {
                    // Fallback brutale: prendi primi 10 caratteri se sembra ISO
                    if (dateVal.includes('-')) dateStr = dateVal.split('T')[0];
                }
            }

            if (!dateStr) {
                missingErrors.push({
                    row: i + 2,
                    reason: "Data invalida",
                    details: `Valore: ${dateVal}, Paziente: ${row[colPatID]}`
                });
                continue;
            }

            // B. Stanza e Tipo
            const categoryID = row[colCategoryID];
            const finalRoomID = String(categoryID || '');

            // Verifica se stanza valida
            if (!Object.values(categorieMap).find(c => String(c.id) === String(finalRoomID))) {
                missingErrors.push({ row: i + 2, reason: "Stanza non trovata", details: `CategoryID: ${finalRoomID}` });
                continue;
            }

            // CHECK DUPLICATI RIMOSSO DA QUI - Spostato dopo calcolo rowNo

            const isLista = STANZE_LISTA.includes(parseInt(finalRoomID));

            // C. Orari
            let oraInizio = null;
            let oraFine = null; // Backend supporta opzionalmente oraFine

            if (isLista) {
                // CASO 1: STANZA LISTA -> Nessun orario
                oraInizio = null;
                sLista++;
            } else {
                // CASO 2: STANZA ORARIO -> Cerca orario diretto o lookup

                // Cerca diretto (dall'Excel ha ApptStartTime/ApptEndTime)
                if (colStartTime) oraInizio = extractTime(row[colStartTime]);
                if (colEndTime) oraFine = extractTime(row[colEndTime]);

                // Se diretto fallisce, prova lookup Slots
                if (!oraInizio) {
                    const rowNo = row[colRowNo];

                    // LOGICA V8: Lookup per TimeGroupID + RowNo
                    let timeStr = null;
                    const roomCat = categorieMap[finalRoomID]; // Recupera categoria
                    // FALLBACK HARDCODED COMPLETO (Recuperati da analisi TimeSlots)
                    // Mapping verificato con tblCategories.xlsx
                    const HARDCODED_GROUPS = {
                        "1": 6,   // BLU
                        "2": 5,   // VERDE
                        "3": 21,  // ROSSO
                        "4": 8,   // GIALLO
                        "5": 18,  // PRELIEVI (Lista a slot)
                        "6": 9,   // INFUSIONI (5 slot da 1h: 09-10, 10-11, 11-12, 12-13, 13-14)
                        "7": 15,  // INFUSIONI LONG ACTING (Lista a slot)
                        "8": 20,  // MEDICAZIONI (Lista a slot)
                        "9": 20,  // RITIRO TERAPIA (Lista a slot)
                        "10": 9,  // DAY HOSPITAL
                        "11": 21  // ROSA
                    };

                    const groupID = (roomCat && roomCat.TimeGroupID) ? roomCat.TimeGroupID : HARDCODED_GROUPS[finalRoomID];

                    if (groupID) {
                        // Prova chiave composta (Best Practice)
                        const lookupKey = `${groupID}_${rowNo}`;
                        timeStr = window.slotsMap[lookupKey];

                        if (!timeStr && i < 10) {
                            logLive(`⚠️ Lookup fallito: Stanza ${finalRoomID} (Grp ${groupID}) Row ${rowNo}`, "warning");
                        }
                    } else if (finalRoomID === '3') {
                        // Fallback specifico Giallo se non abbiamo ID
                        // Tentativo con ID generici se esistono
                    }

                    // Fallback: Prova chiave semplice (se slotsMap è vecchio stile o GroupID mancante)
                    if (!timeStr) {
                        timeStr = window.slotsMap[String(rowNo)];
                    }

                    if (timeStr && timeStr.length >= 5) {
                        oraInizio = timeStr;
                        sLookup++;
                    } else {
                        // Nessun orario da slotsMap — prova dalle regole Firebase
                        oraInizio = null;
                    }
                } else {
                    sDirect++;
                }
            }

            // D. Paziente (Già definito sopra per error handling)
            // const patID = row[colPatID];
            // Logica nomi qui se servisse, ma Firebase usa ID

            // E. Note
            const note = row[colNote] || '';

            // F. RowNo (sempre utile per ordinamento liste o fallback)
            // 🔧 FIX VALIDAZIONE - Max RowNo = 31 (numero massimo slot)
            let rowNo = row[colRowNo];
            
            // SheetJS a volte interpreta numeri come Date
            if (rowNo instanceof Date) {
                rowNo = rowNo.getDate();
            }
            
            rowNo = parseInt(rowNo);
            
            if (isNaN(rowNo) || rowNo < 1 || rowNo > 50) {
                missingErrors.push({
                    row: i + 2,
                    reason: "RowNo invalido o fuori range",
                    details: `Valore: ${JSON.stringify(row[colRowNo])}`
                });
                continue;
            }

            // CHECK DUPLICATI (De-duplicazione)
            // CHIAVE CORRETTA: Include rowNo per gestire pazienti generici (es. "PRIMA VISITA")
            const uniqueKey = `${dateStr}_${patID}_${finalRoomID}_${rowNo}`;
            if (window.processedKeys.has(uniqueKey)) {
                sDuplicates++;
                // LOG DUPLICATO
                if (!window.duplicatesList) window.duplicatesList = [];
                window.duplicatesList.push({
                    riga: i + 2,
                    data: dateStr,
                    paziente: patID,
                    stanza: finalRoomID,
                    rowNo: rowNo
                });
                continue;
            }
            window.processedKeys.add(uniqueKey);

            // Se oraInizio è ancora null e non è stanza lista, prova a risolvere dalla regola Firebase
            if (!oraInizio && !isLista) {
                const ruleTime = resolveTimeFromRule(finalRoomID, dateStr, rowNo);
                if (ruleTime) {
                    oraInizio = ruleTime;
                    sFromRule++;
                } else {
                    sNull++;
                }
            }

            // Costruzione Oggetto
            const newRef = push(ref(db, ROOT + '/GiroVisite')).key;

            newAppts[newRef] = {
                id: newRef,
                data: dateStr,
                oraInizio: oraInizio,
                startTime: oraInizio,
                endTime: oraFine,
                rowNo: rowNo,
                pazienteID: String(patID),
                stanzaID: finalRoomID,
                pazienteNote: note,
                stato: 'CONFERMATO'
            };
            created++;
        } catch (e) {
            missingErrors.push({
                row: i + 2,
                reason: "Eccezione JS",
                details: e.message
            });
            logLive(`❌ Err riga ${i}: ${e.message}`, "error");
        }
    }

    // CHECK FINALE
    const totalRows = window.accessDataFull.length;
    const accountedFor = created + missingErrors.length;

    logLive(`------------------------------------------------`, "info");
    logLive(`📊 AUDIT TOTALE RIGHE: ${totalRows}`, "info");
    logLive(`✅ Valide da importare: ${created}`, "success");
    logLive(`♻️ Duplicati Uniti: ${sDuplicates}`, "warning");
    logLive(`❌ Errori/Saltate: ${missingErrors.length}`, "error");

    if (accountedFor + sDuplicates !== totalRows) {
        logLive(`⚠️ DISCREPANZA: ${totalRows - (accountedFor + sDuplicates)} righe perse nel nulla!`, "error");
    }

    // 5. COMMIT
    if (created > 0) {
        logLive("🧹 WIPE DB...", "error");
        
        try {
            await set(ref(db, ROOT + '/GiroVisite'), null);
        } catch (error) {
            logLive(`❌ ERRORE WIPE: ${error.message}`, "error");
            if (error.message.includes('Permission denied')) {
                logLive(`💥 Rules bloccano la SCRITTURA - Vedi soluzione sopra`, "error");
            }
            alert("❌ Impossibile cancellare dati esistenti!");
            return;
        }

        logLive(`💾 SALVATAGGIO ${created} RECORD...`, "info");
        
        try {
            await update(ref(db, ROOT + '/GiroVisite'), newAppts);
        } catch (error) {
            logLive(`❌ ERRORE SALVATAGGIO: ${error.message}`, "error");
            alert("❌ Impossibile salvare! Database svuotato ma nuovi dati non salvati!");
            return;
        }

        logLive("✅ OPERAZIONE COMPLETATA.", "success");
        logLive(`📊 REPORT FINALE:`, "info");
        logLive(` ✅ Importati: ${created}`, "success");
        logLive(` 🕒 Orari Diretti: ${sDirect}`, "info");
        logLive(` 🔍 Orari Lookup: ${sLookup}`, "info");
        logLive(` 🏥 Orari da Regole Firebase: ${sFromRule}`, sFromRule > 0 ? "success" : "info");
        logLive(` 📋 Liste (No Orario): ${sLista}`, "info");
        logLive(` ⚠️ Senza orario: ${sNull}`, sNull > 0 ? "warning" : "info");
        logLive(` ♻️ Duplicati: ${sDuplicates}`, sDuplicates > 0 ? "warning" : "info");
        logLive(` ❌ Errori: ${missingErrors.length}`, missingErrors.length > 0 ? "error" : "success");

        if (missingErrors.length > 0) {
            window.lastImportErrors = missingErrors;
            logLive(`\n❌ DETTAGLIO ERRORI (${missingErrors.length}):`, "error");
            missingErrors.forEach((err, idx) => {
                logLive(`  ${idx+1}. Riga ${err.row}: ${err.reason} | ${err.details}`, "error");
            });
        }
        
        // LOG DUPLICATI DETTAGLIATO
        if (sDuplicates > 0 && window.duplicatesList) {
            logLive(`\n⚠️ LISTA DUPLICATI (${sDuplicates}):`, "warning");
            window.duplicatesList.slice(0, 20).forEach((dup, idx) => {
                logLive(`  ${idx+1}. Riga ${dup.riga}: Data ${dup.data}, Paziente ${dup.paziente}, Stanza ${dup.stanza}, RowNo ${dup.rowNo}`, "warning");
            });
            if (window.duplicatesList.length > 20) {
                logLive(`  ... e altri ${window.duplicatesList.length - 20} duplicati`, "warning");
            }
            logLive(`\n💡 DUPLICATI = stesso paziente, stessa stanza, stesso giorno`, "info");
            logLive(`   Lo script tiene solo il PRIMO e salta gli altri.`, "info");
        }

        logLive(`✨ TUTTO FATTO! Usa i pulsanti qui sotto per gestire gli errori.`, "success");

        // 🆕 AUDIT FINALE RowNo
        logLive(`\n🔍 AUDIT RowNo - Verifica record importati...`, "info");
        const dbSnap = await get(ref(db, ROOT + '/GiroVisite'));
        const dbRecords = Object.values(dbSnap.val() || {});
        
        let rowNoValid = 0;
        let rowNoAnomaly = 0;
        const anomalyList = [];
        
        dbRecords.forEach(rec => {
            const rNo = parseInt(rec.rowNo);
            if (isNaN(rNo)) return;
            
            if (rNo >= 1 && rNo <= 31) {
                rowNoValid++;
            } else {
                rowNoAnomaly++;
                anomalyList.push({
                    id: rec.id,
                    rowNo: rNo,
                    data: rec.data,
                    paziente: rec.pazienteID,
                    stanza: rec.stanzaID,
                    orario: rec.startTime || rec.oraInizio
                });
            }
        });
        
        logLive(`📊 RowNo validi (1-31): ${rowNoValid}`, "success");
        
        if (rowNoAnomaly > 0) {
            logLive(`❌ RowNo ANOMALI (fuori 1-31): ${rowNoAnomaly}`, "error");
            logLive(`🚨 ATTENZIONE: Alcuni record hanno RowNo fuori range!`, "error");
            
            // Mostra primi 10 anomali
            anomalyList.slice(0, 10).forEach((a, idx) => {
                logLive(`  ${idx+1}. RowNo=${a.rowNo}, Data=${a.data}, Paz=${a.paziente}, Stanza=${a.stanza}`, "error");
            });
            
            if (anomalyList.length > 10) {
                logLive(`  ... e altri ${anomalyList.length - 10} record anomali`, "error");
            }
            
            // Salva in window per debug
            window.anomalyRowNoRecords = anomalyList;
            logLive(`💾 Record anomali salvati in: window.anomalyRowNoRecords`, "warning");
        } else {
            logLive(`✅ Tutti i RowNo sono nel range valido!`, "success");
        }

        // 🆕 AUDIT: Appuntamenti senza orario in stanze con orario
        const STANZE_LISTA_AUDIT = [5, 8, 9];
        const noTimeRecords = dbRecords.filter(r => {
            const hasTime = r.oraInizio || r.startTime;
            const isLista = STANZE_LISTA_AUDIT.includes(parseInt(r.stanzaID));
            return !hasTime && !isLista;
        });

        if (noTimeRecords.length > 0) {
            logLive(`\n⚠️ APPUNTAMENTI SENZA ORARIO in stanze con orario: ${noTimeRecords.length}`, "warning");
            
            // Raggruppa per stanza
            const byRoom = {};
            noTimeRecords.forEach(r => {
                const key = r.stanzaID;
                if (!byRoom[key]) byRoom[key] = [];
                byRoom[key].push(r);
            });

            // Decripta nomi pazienti
            const pMap = {};
            const snapPaz = await get(ref(db, ROOT + '/pazienti'));
            const pazienti = Object.values(snapPaz.val() || {});
            pazienti.forEach(p => {
                const ln = p.lastName_enc ? decrypt(p.lastName_enc) : (p.lastName || '');
                const fn = p.firstName_enc ? decrypt(p.firstName_enc) : (p.firstName || '');
                pMap[p.id] = (ln + ' ' + fn).toUpperCase().trim();
            });

            const catSnap = await get(ref(db, ROOT + '/tblCategories'));
            const cats = catSnap.val() || {};

            Object.entries(byRoom).forEach(([roomId, records]) => {
                const catName = Object.values(cats).find(c => String(c.id) === String(roomId))?.name || `Stanza ${roomId}`;
                logLive(`\n  📍 ${catName} (ID:${roomId}): ${records.length} appuntamenti senza orario`, "warning");
                
                // Raggruppa per RowNo per capire il pattern
                const byRowNo = {};
                records.forEach(r => {
                    const rn = r.rowNo || '?';
                    if (!byRowNo[rn]) byRowNo[rn] = 0;
                    byRowNo[rn]++;
                });
                logLive(`     RowNo coinvolti: ${Object.entries(byRowNo).map(([rn, c]) => `Slot ${rn} (${c}x)`).join(', ')}`, "info");
                
                // Mostra primi 5
                records.slice(0, 5).forEach(r => {
                    const nome = pMap[r.pazienteID] || `Paz.${r.pazienteID}`;
                    logLive(`     - ${r.data} | Slot ${r.rowNo} | ${nome}`, "warning");
                });
                if (records.length > 5) logLive(`     ... e altri ${records.length - 5}`, "warning");
            });

            window.noTimeRecords = noTimeRecords;
            logLive(`\n💡 Per risolvere: verifica che le regole delle stanze abbiano abbastanza slot.`, "info");
        } else {
            logLive(`\n✅ Tutti gli appuntamenti in stanze con orario hanno un orario!`, "success");
        }

        // Feedback finale non bloccante via Log invece che Alert continuo
        logLive(`✨ TUTTO FATTO! Usa i pulsanti qui sotto per gestire gli errori.`, "success");

        // --- INIEZIONE BOTTONI ALLA FINE PER EVITARE SOVRASCRITTURA ---
        if (missingErrors.length > 0) {
            const btnContainer = document.createElement('div');
            btnContainer.style.marginTop = '15px';
            btnContainer.style.padding = '10px';
            btnContainer.style.borderTop = '1px solid #ddd';
            btnContainer.style.display = 'flex';
            btnContainer.style.gap = '10px';
            btnContainer.style.flexWrap = 'wrap';

            // 1. CSV
            const btnCsv = document.createElement('button');
            btnCsv.className = 'btn-mini';
            btnCsv.innerHTML = '📥 SCARICA CSV ERRORI';
            btnCsv.style.cssText = 'background:#ef4444; color:white; padding:5px 10px; cursor:pointer; border:none; border-radius:4px;';
            btnCsv.onclick = () => {
                const csv = "\uFEFFRiga;Motivo;Dettagli\n" +
                    missingErrors.map(e => `"${e.row}";"${e.reason}";"${e.details}"`).join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const v8BlobUrl = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = v8BlobUrl;
                a.download = `import_errors_${new Date().toISOString().split('T')[0]}.csv`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(v8BlobUrl), 1000);
            };

            // 2. VERIFICA DB
            const btnVerify = document.createElement('button');
            btnVerify.className = 'btn-mini';
            btnVerify.innerHTML = '🕵️‍♂️ VERIFICA "FALSI POSITIVI"';
            btnVerify.style.cssText = 'background:#3b82f6; color:white; padding:5px 10px; cursor:pointer; border:none; border-radius:4px;';
            btnVerify.onclick = () => window.verifyMissingInDb();

            btnContainer.appendChild(btnCsv);
            btnContainer.appendChild(btnVerify);
            logDiv.appendChild(btnContainer);
        }

        // Bottone Reload SEMPRE presente alla fine
        const divReload = document.createElement('div');
        divReload.style.marginTop = '10px';
        const btnReload = document.createElement('button');
        btnReload.innerHTML = '🔄 RICARICA PAGINA / CHIUDI';
        btnReload.style.cssText = 'background:#64748b; color:white; padding:5px 10px; cursor:pointer; border:none; border-radius:4px;';
        btnReload.onclick = () => location.reload();
        divReload.appendChild(btnReload);
        logDiv.appendChild(divReload);


        // Unico alert finale leggero
        // Unico alert finale leggero
        setTimeout(() => {
            alert(`✅ IMPORT COMPLETATO!\n\nImportati: ${created}\nOrari diretti: ${sDirect}\nOrari da lookup: ${sLookup}\nOrari da regole Firebase: ${sFromRule}\nSenza orario: ${sNull}\nErrori reali: ${missingErrors.length}\n\nControlla il log per i dettagli.`);
        }, 500);
    } // Chiude IF created > 0
}; // Chiude FUNCTION commitAccessImportV8_Final

// ===================== TOOL DI VERIFICA ERRORI =====================
window.verifyMissingInDb = async () => {
    if (!window.lastImportErrors || window.lastImportErrors.length === 0) {
        alert("Nessun errore da verificare.");
        return;
    }

    const log = window.logLive;
    log("------------------------------------------------", "info");
    log("🕵️‍♂️ AVVIO VERIFICA CROSS-CHECK CON FIREBASE...", "info");

    // 1. Fetch Fresh Data
    const snap = await get(ref(db, ROOT + '/GiroVisite'));
    const dbData = Object.values(snap.val() || {});
    log(`📥 Scaricati ${dbData.length} appuntamenti attuali dal DB.`, "info");

    let foundCount = 0;
    let reallyMissingCount = 0;
    let reportDB = [];

    window.lastImportErrors.forEach(err => {
        // Parsing details string: "Data: 2025-04-23, Paziente: 123, Stanza: 5, Slot: 14"
        const dMatch = err.details.match(/Data: ([^,]+)/);
        const pMatch = err.details.match(/Paziente: ([^,]+)/);
        const rMatch = err.details.match(/Stanza: ([^,]+)/);

        if (!dMatch || !pMatch || !rMatch) {
            reallyMissingCount++;
            return;
        }

        const date = dMatch[1].trim();
        const patID = pMatch[1].trim();
        const roomID = rMatch[1].trim();

        // Cerca corrispondenza nel DB (ignorando rowNo che potrebbe essere diverso)
        const match = dbData.find(a =>
            a.data === date &&
            String(a.pazienteID) === String(patID) &&
            String(a.stanzaID) === String(roomID)
        );

        if (match) {
            foundCount++;
            const orario = match.startTime || match.oraInizio || 'NULL';
            reportDB.push(`✅ RITROVATO IN DB: Riga ${err.row} -> ID: ${match.id} (Ora: ${orario})`);
        } else {
            reallyMissingCount++;
        }
    });

    // 3. Output
    log(`📊 RISULTATO VERIFICA:`, "info");
    log(`✅ Trovati nel DB (Falsi allarmi): ${foundCount}`, "success");
    log(`❌ Veramente mancanti: ${reallyMissingCount}`, "error");

    if (foundCount > 0) {
        log(`📝 Dettaglio ritrovati (ultimi 10):`, "info");
        reportDB.slice(-10).forEach(r => log(r, "success"));
        alert(`⚠️ ATTENZIONE: ${foundCount} record che sembravano errori SONO IN REALTÀ NEL DB!\n\nConsulta il log per i dettagli.`);
    } else {
        alert(`Confermo: I ${reallyMissingCount} record sono davvero assenti dal database.`);
    }
};

// 5. ATTACH LISTENERS
const sInput = document.getElementById('slotsFile');
const aInput = document.getElementById('accessFile');
const btnImport = document.getElementById('btnImportAccess');
const btnDry = document.getElementById('btnDryRun');

if (sInput) sInput.onchange = handleSlotsUpload;
if (aInput) aInput.onchange = handleAccessUpload;
if (btnImport) btnImport.onclick = () => window.commitAccessImportV8_Final();
if (btnDry) btnDry.onclick = () => window.dryRunImport();

const btnLog = document.getElementById('btnDownloadLog');
if (btnLog) btnLog.onclick = () => {
    const text = document.getElementById('importLog').innerText;
    const blob = new Blob([text], {type: 'text/plain'});
    const a = document.createElement('a');
    const blobUrl = URL.createObjectURL(blob);
    a.href = blobUrl;
    a.download = 'import-log.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
};


// ═══════════════════════════════════════════════════════════════════════════
// GESTIONE ARCHIVIO STORICO — Migrazione automatica GiroVisite → GiroVisite_Storico
// ═══════════════════════════════════════════════════════════════════════════

const ARCHIVIO_CONFIG_PATH = 'config/archivio';
const MIGRAZIONE_MAX_INTERVALLO_GIORNI = 7; // esegue al massimo 1 volta a settimana

// ── Calcola la soglia data (es. oggi - 3 mesi) ──────────────────────────────
function calcolaSoglia(mesi) {
    const d = new Date();
    d.setMonth(d.getMonth() - mesi);
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── Legge il parametro archivio da Firebase ─────────────────────────────────
async function getConfigArchivio() {
    try {
        const snap = await get(ref(db, ROOT + '/' + ARCHIVIO_CONFIG_PATH));
        const val = snap.val();
        if (val) return val;
    } catch (e) {}
    // Default se non esiste ancora
    return { mesi: 3, ultima_migrazione: null };
}

// ── Aggiorna label nell'UI admin ────────────────────────────────────────────
async function caricaStatoArchivio() {
    const statusEl = document.getElementById('archivioStatus');
    const labelEl = document.getElementById('archivioMesiLabel');
    if (!statusEl) return;

    statusEl.innerHTML = '⏳ Caricamento…';

    try {
        const cfg = await getConfigArchivio();
        if (labelEl) labelEl.textContent = cfg.mesi || 3;
        const inputEl = document.getElementById('archivioMesiInput');
        if (inputEl) inputEl.value = cfg.mesi || 3;

        // Conta record nel nodo storico
        const snapS = await get(ref(db, ROOT + '/GiroVisite_Storico'));
        const totStorico = snapS.val() ? Object.keys(snapS.val()).length : 0;

        // Conta record nel nodo vivo
        const snapV = await get(ref(db, ROOT + '/GiroVisite'));
        const totVivi = snapV.val() ? Object.keys(snapV.val()).length : 0;

        const soglia = calcolaSoglia(cfg.mesi || 3);
        const ultimaMig = cfg.ultima_migrazione
            ? new Date(cfg.ultima_migrazione).toLocaleDateString('it-IT')
            : 'Mai eseguita';

        statusEl.innerHTML = `
            ✅ <strong>Parametro attivo:</strong> ${cfg.mesi || 3} mesi &nbsp;|&nbsp;
            📅 <strong>Soglia:</strong> ${soglia} &nbsp;|&nbsp;
            🗓️ <strong>Ultima migrazione:</strong> ${ultimaMig}<br>
            📋 <strong>GiroVisite (vivi):</strong> ${totVivi} record &nbsp;|&nbsp;
            📦 <strong>GiroVisite_Storico:</strong> ${totStorico} record
        `;
    } catch (err) {
        statusEl.innerHTML = '❌ Errore nel caricamento stato: ' + err.message;
    }
}
window.caricaStatoArchivio = caricaStatoArchivio;

// ── Salva parametro mesi ────────────────────────────────────────────────────
window.salvaParametroArchivio = async () => {
    const inputEl = document.getElementById('archivioMesiInput');
    const mesi = parseInt(inputEl?.value);
    if (!mesi || mesi < 1 || mesi > 36) {
        alert('Inserisci un valore tra 1 e 36 mesi!');
        return;
    }

    const cfg = await getConfigArchivio();
    const vecchiMesi = cfg.mesi || 3;

    await update(ref(db, ROOT + '/' + ARCHIVIO_CONFIG_PATH), { mesi });

    const labelEl = document.getElementById('archivioMesiLabel');
    if (labelEl) labelEl.textContent = mesi;

    if (mesi !== vecchiMesi) {
        const conferma = confirm(
            `Parametro aggiornato a ${mesi} mesi.\n\n` +
            `Vuoi eseguire subito la migrazione con il nuovo parametro?\n` +
            `(Se hai aumentato i mesi, i record rientrati verranno riportati in GiroVisite)`
        );
        if (conferma) {
            await eseguiMigrazione(mesi);
        }
    } else {
        alert(`✅ Parametro salvato: ${mesi} mesi`);
    }
};

// ── Migrazione manuale (dal pulsante Admin) ─────────────────────────────────
window.eseguiMigrazioneManuale = async () => {
    const cfg = await getConfigArchivio();
    const mesi = cfg.mesi || 3;
    const conferma = confirm(
        `Avviare la migrazione con parametro attuale (${mesi} mesi)?\n\n` +
        `• Record più vecchi di ${mesi} mesi → GiroVisite_Storico\n` +
        `• Record rientrati nel range → riportati in GiroVisite`
    );
    if (conferma) await eseguiMigrazione(mesi);
};

// ── Funzione principale di migrazione ──────────────────────────────────────
async function eseguiMigrazione(mesi) {
    const statusEl = document.getElementById('archivioStatus');
    if (statusEl) statusEl.innerHTML = '⏳ Migrazione in corso… non chiudere la pagina.';

    try {
        const soglia = calcolaSoglia(mesi);
        const oggi = new Date().toISOString().split('T')[0];

        // Legge tutti i nodi necessari
        const [snapVivi, snapStorico, snapNote, snapNoteStorico] = await Promise.all([
            get(ref(db, ROOT + '/GiroVisite')),
            get(ref(db, ROOT + '/GiroVisite_Storico')),
            get(ref(db, ROOT + '/dailyNotes')),
            get(ref(db, ROOT + '/dailyNotes_Storico'))
        ]);

        const viviRaw = snapVivi.val() || {};
        const storicoRaw = snapStorico.val() || {};
        const noteRaw = snapNote.val() || {};
        const noteStoricoRaw = snapNoteStorico.val() || {};

        const updatesVivi = {};
        const updatesStorico = {};
        const updatesNote = {};
        const updatesNoteStorico = {};
        let spostatiInStorico = 0;
        let riportatiInVivi = 0;
        let noteSpostate = 0;
        let noteRiportate = 0;

        // 1. GiroVisite: sposta in storico record con data < soglia
        for (const [k, v] of Object.entries(viviRaw)) {
            if (v.data && v.data < soglia) {
                updatesStorico[k] = v;
                updatesVivi[k] = null;
                spostatiInStorico++;
            }
        }

        // 2. GiroVisite: riporta in vivi se parametro aumentato
        for (const [k, v] of Object.entries(storicoRaw)) {
            if (v.data && v.data >= soglia) {
                updatesVivi[k] = v;
                updatesStorico[k] = null;
                riportatiInVivi++;
            }
        }

        // 3. dailyNotes: sposta note con data < soglia
        for (const [date, val] of Object.entries(noteRaw)) {
            if (date < soglia) {
                updatesNoteStorico[date] = val;
                updatesNote[date] = null; // cancella dal vivo
                noteSpostate++;
            }
        }

        // 4. dailyNotes: riporta note rientrate nel range
        for (const [date, val] of Object.entries(noteStoricoRaw)) {
            if (date >= soglia) {
                updatesNote[date] = val;
                updatesNoteStorico[date] = null;
                noteRiportate++;
            }
        }

        // Esegue tutti gli aggiornamenti
        if (Object.keys(updatesVivi).length > 0)
            await update(ref(db, ROOT + '/GiroVisite'), updatesVivi);
        if (Object.keys(updatesStorico).length > 0)
            await update(ref(db, ROOT + '/GiroVisite_Storico'), updatesStorico);
        if (Object.keys(updatesNote).length > 0)
            await update(ref(db, ROOT + '/dailyNotes'), updatesNote);
        if (Object.keys(updatesNoteStorico).length > 0)
            await update(ref(db, ROOT + '/dailyNotes_Storico'), updatesNoteStorico);

        // Aggiorna flag ultima migrazione
        await update(ref(db, ROOT + '/' + ARCHIVIO_CONFIG_PATH), {
            ultima_migrazione: oggi,
            mesi: mesi
        });

        const msg = `✅ Migrazione completata!\n📦 Appuntamenti → Storico: ${spostatiInStorico}\n📝 Note giorno → Storico: ${noteSpostate}\n↩️ Appuntamenti riportati in GiroVisite: ${riportatiInVivi}\n↩️ Note riportate in GiroVisite: ${noteRiportate}`;
        alert(msg);
        await caricaStatoArchivio();

    } catch (err) {
        console.error('Errore migrazione:', err);
        alert('❌ Errore durante la migrazione: ' + err.message);
        if (statusEl) statusEl.innerHTML = '❌ Errore: ' + err.message;
    }
}

// ── Migrazione automatica (eseguita al caricamento, max 1 volta a settimana) ─
async function migrazioneAutomatica() {
    try {
        const cfg = await getConfigArchivio();
        const oggi = new Date();
        const ultimaMig = cfg.ultima_migrazione ? new Date(cfg.ultima_migrazione) : null;

        if (ultimaMig) {
            const giorniPassati = Math.floor((oggi - ultimaMig) / (1000 * 60 * 60 * 24));
            if (giorniPassati < MIGRAZIONE_MAX_INTERVALLO_GIORNI) {
                console.log(`✅ Migrazione non necessaria (ultima: ${cfg.ultima_migrazione}, ${giorniPassati} giorni fa)`);
                return;
            }
        }

        console.log('🔄 Avvio migrazione automatica…');
        await eseguiMigrazione(cfg.mesi || 3);
        console.log('✅ Migrazione automatica completata');
    } catch (err) {
        console.warn('⚠️ Migrazione automatica fallita (non bloccante):', err.message);
    }
}

// ── Inizializzazione: carica stato e avvia migrazione automatica ────────────
// Aspetta che Firebase sia pronto prima di partire
waitForAuth().then(() => {
    caricaStatoArchivio();
    migrazioneAutomatica();
});
