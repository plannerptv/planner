/**
 * DUPLICATE CHECKER LIBRARY - Versione compatibile
 */

function normalizeText(str) {
    if(!str) return '';
    return str.toString()
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function levenshteinDistance(a, b) {
    const matrix = [];
    for(let i = 0; i <= b.length; i++) matrix[i] = [i];
    for(let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for(let i = 1; i <= b.length; i++) {
        for(let j = 1; j <= a.length; j++) {
            if(b.charAt(i-1) === a.charAt(j-1)) {
                matrix[i][j] = matrix[i-1][j-1];
            } else {
                matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, matrix[i][j-1] + 1, matrix[i-1][j] + 1);
            }
        }
    }
    return matrix[b.length][a.length];
}

function similarity(str1, str2) {
    const s1 = normalizeText(str1);
    const s2 = normalizeText(str2);
    if(!s1 || !s2) return 0;
    const maxLen = Math.max(s1.length, s2.length);
    if(maxLen === 0) return 100;
    const dist = levenshteinDistance(s1, s2);
    return ((maxLen - dist) / maxLen) * 100;
}

function normalizeDob(dob) {
    if(!dob) return null;
    if(!isNaN(dob) && Number(dob) > 1000) {
        const excelEpoch = new Date(1899, 11, 30);
        const dateObj = new Date(excelEpoch.getTime() + Number(dob) * 86400000);
        return dateObj.toISOString().split('T')[0];
    }
    if(typeof dob === 'string' && dob.match(/^\d{4}-\d{2}-\d{2}$/)) return dob;
    if(typeof dob === 'string' && dob.includes('/')) {
        const parts = dob.split('/');
        if(parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    }
    return dob;
}

// Funzione principale
function findDuplicatePatients(patientsList, lastName, firstName, dob, excludeId = null, decryptFunc = null) {
    const similar = [];
    const nameSearch = normalizeText(lastName + ' ' + firstName);
    const normalizedDob = normalizeDob(dob);
    
    patientsList.forEach(p => {
        if(excludeId && String(p.id) === String(excludeId)) return;
        let pLastName = p.lastName || p.l || '';
        let pFirstName = p.firstName || p.f || '';
        if(decryptFunc) {
            if(p.lastName_enc) pLastName = decryptFunc(p.lastName_enc);
            if(p.firstName_enc) pFirstName = decryptFunc(p.firstName_enc);
        }
        const pName = normalizeText(pLastName + ' ' + pFirstName);
        const sim = similarity(nameSearch, pName);
        const pNormalizedDob = normalizeDob(p.dob);
        const sameDob = normalizedDob && pNormalizedDob && normalizedDob === pNormalizedDob;
        
        if(sim === 100 && sameDob) {
            similar.push({ patient: p, similarity: 100, sameDob: true, exactDuplicate: true, displayName: `${pLastName} ${pFirstName}` });
        } else if(sim >= 70 && sameDob) {
            similar.push({ patient: p, similarity: Math.round(sim), sameDob: true, likelyDuplicate: true, displayName: `${pLastName} ${pFirstName}` });
        } else if(sim >= 85) {
            similar.push({ patient: p, similarity: Math.round(sim), sameDob: sameDob, possibleDuplicate: true, displayName: `${pLastName} ${pFirstName}` });
        }
    });
    return similar.sort((a, b) => b.similarity - a.similarity);
}

function formatDobForDisplay(dob) {
    if (!dob) return 'N/A';
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
    return dob;
}

function formatDuplicateMessage(similar, newLastName, newFirstName, newDob) {
    if (!similar || similar.length === 0) {
        return { message: '', shouldBlock: false };
    }

    let hasExactDuplicate = false;
    let msg = '⚠️ ATTENZIONE! Trovati pazienti simili:\n\n';

    similar.forEach((s, i) => {
        const pDob = formatDobForDisplay(s.patient.dob);

        msg += `${i + 1}. ${s.displayName.toUpperCase()} (nato ${pDob}) - Similarità: ${s.similarity}%`;

        if (s.exactDuplicate) {
            msg += ' 🚫 DUPLICATO ESATTO!';
            hasExactDuplicate = true;
        } else if (s.likelyDuplicate) {
            msg += ' ⚠️ PROBABILE DUPLICATO (stessa data nascita)!';
        } else if (s.sameDob) {
            msg += ' ⚠️ STESSA DATA NASCITA!';
        }
        msg += '\n';
    });

    if (hasExactDuplicate) {
        msg += '\n🚫 INSERIMENTO BLOCCATO: esiste già un paziente identico.\n';
        msg += 'Usa il paziente esistente oppure verifica i dati.';
        return { message: msg, shouldBlock: true };
    }

    msg += `\n❓ Vuoi salvare comunque:\n${newLastName} ${newFirstName} (${formatDobForDisplay(newDob)})?`;
    return { message: msg, shouldBlock: false };
}

// AGANCIO GLOBALE PER IL MODULO
window.findDuplicatePatients = findDuplicatePatients;
window.formatDuplicateMessage = formatDuplicateMessage;