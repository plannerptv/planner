// ===================================================================
// AGGIUNGI QUESTA FUNZIONE IN admin-script.js
// DOPO la funzione backupData (circa linea 391)
// ===================================================================

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

    if (!confirm(`🔐 ESPORTAZIONE PAZIENTI DECRIPTATI\n\n` +
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
            if (dob && typeof dob === 'string' && dob.match(/^\d{4}-\d{2}-\d{2}$/)) {
                // Converti YYYY-MM-DD in formato leggibile
                const [y, m, d] = dob.split('-');
                dob = `${d}/${m}/${y}`;
            }

            return {
                PatientID: p.id,
                LastName: lastName.toUpperCase(),
                FirstName: firstName.toUpperCase(),
                DateOfBirth: dob,
                Telephone: p.telefono || p.phone || ''
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
