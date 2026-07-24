require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { google } = require('googleapis');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const retry = require('async-retry');

// =========================================================================
// 1. VALIDASI ENVIRONMENT VARIABLES & KONSTANTA
// =========================================================================
const requiredEnv = ["SPREADSHEET_ID", "BOT_NUMBER", "ADMIN_NUMBERS"];
const missingEnv = requiredEnv.filter(env => !process.env[env]);

if (missingEnv.length > 0) {
    console.error(`❌ FATAL ERROR: Environment Variable berikut belum diisi: ${missingEnv.join(', ')}`);
    process.exit(1);
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const BOT_NUMBER = process.env.BOT_NUMBER;
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS.split(',').map(n => n.trim().replace(/[^0-9]/g, ''));

const WARGA_SHEET = process.env.WARGA_SHEET || '2026 ALL';
const TUNGGAKAN_SHEET = process.env.TUNGGAKAN_SHEET || 'TUNGGAKAN 2RT';
const HISTORI_SHEET = process.env.HISTORI_SHEET || 'HISTORI_PEMBAYARAN';

const NOMINAL_IURAN_PER_BULAN = 210000;
let isConnectedToWA = false;

// Mapping Kolom Google Sheets untuk "2026 ALL"
const MONTH_COLUMN_MAP = {
    "JANUARI":   { tglCol: "E", nomCol: "F", tglIdx: 4, nomIdx: 5 },
    "FEBRUARI":  { tglCol: "G", nomCol: "H", tglIdx: 6, nomIdx: 7 },
    "MARET":     { tglCol: "I", nomCol: "J", tglIdx: 8, nomIdx: 9 },
    "APRIL":     { tglCol: "K", nomCol: "L", tglIdx: 10, nomIdx: 11 },
    "MEI":       { tglCol: "M", nomCol: "N", tglIdx: 12, nomIdx: 13 },
    "JUNI":      { tglCol: "O", nomCol: "P", tglIdx: 14, nomIdx: 15 },
    "JULI":      { tglCol: "Q", nomCol: "R", tglIdx: 16, nomIdx: 17 },
    "AGUSTUS":   { tglCol: "S", nomCol: "T", tglIdx: 18, nomIdx: 19 },
    "SEPTEMBER": { tglCol: "U", nomCol: "V", tglIdx: 20, nomIdx: 21 },
    "OKTOBER":   { tglCol: "W", nomCol: "X", tglIdx: 22, nomIdx: 23 },
    "NOVEMBER":  { tglCol: "Y", nomCol: "Z", tglIdx: 24, nomIdx: 25 },
    "DESEMBER":  { tglCol: "AA", nomCol: "AB", tglIdx: 26, nomIdx: 27 }
};

const LIST_BULAN = Object.keys(MONTH_COLUMN_MAP);

// =========================================================================
// 2. DATABASE & LOGGING
// =========================================================================
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function writeLog(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    console.log(message);
    const today = new Date().toISOString().split('T')[0];
    fs.appendFileSync(path.join(logDir, `bot-${today}.log`), logLine, { encoding: 'utf8' });
}

const db = new Database(path.join(__dirname, 'bot_data.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_messages (
    id TEXT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

function isMessageProcessed(msgId) {
    const stmt = db.prepare('SELECT id FROM processed_messages WHERE id = ?');
    return !!stmt.get(msgId);
}

function markMessageProcessed(msgId) {
    const stmt = db.prepare('INSERT OR IGNORE INTO processed_messages (id) VALUES (?)');
    stmt.run(msgId);
}

// =========================================================================
// 3. GOOGLE API
// =========================================================================
const credentialsPath = path.join(__dirname, 'credentials.json');
const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function fetchSheetsWithRetry(fn) {
    return await retry(async (bail) => {
        try {
            return await fn();
        } catch (err) {
            const status = err.code || err.status || (err.response && err.response.status);
            if (status === 404 || status === 400 || status === 401) {
                bail(err);
                return;
            }
            writeLog(`⚠️ Google API Error (${err.message}). Retrying...`);
            throw err;
        }
    }, { retries: 4, minTimeout: 1000, factor: 2 });
}

// =========================================================================
// 4. HELPER DENGAN NORMALISASI NOMOR RUMAH (FORMAT SLASHER & NON-SLASHER)
// =========================================================================

/**
 * Normalisasi nomor rumah agar CA1908, CA 1908, CA 19-08, CA 19/08, CA 19/8
 * Semuanya menghasilkan variasi yang seragam.
 */
function normalizeHouseVariants(rawInput) {
    if (!rawInput) return [];
    let clean = rawInput.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
    
    const setVariants = new Set();
    setVariants.add(clean); // e.g. CA1908

    // Jika pola CA1908 (Blok CA + 4 Angka) -> Buat variasi CA 19/8, CA 19/08, CA 19-8
    const match4Digits = clean.match(/^([A-Z]+)(\d{2})(\d{2})$/);
    if (match4Digits) {
        const prefix = match4Digits[1];
        const num1 = parseInt(match4Digits[2], 10).toString(); // "19" -> 19
        const num2 = parseInt(match4Digits[3], 10).toString(); // "08" -> 8

        setVariants.add(`${prefix}${num1}/${num2}`);       // CA19/8
        setVariants.add(`${prefix} ${num1}/${num2}`);      // CA 19/8
        setVariants.add(`${prefix}${num1}/${match4Digits[3]}`);  // CA19/08
        setVariants.add(`${prefix} ${num1}/${match4Digits[3]}`); // CA 19/08
    }

    return Array.from(setVariants);
}

function matchesHouse(cellValue, targetVariants) {
    if (!cellValue) return false;
    const cleanCell = cellValue.toString().toUpperCase().trim();
    const cellNoSpaceNoSlash = cleanCell.replace(/[^A-Z0-9]/g, '');

    for (const v of targetVariants) {
        const vClean = v.replace(/[^A-Z0-9]/g, '');
        if (cellNoSpaceNoSlash === vClean || cleanCell.includes(v)) {
            return true;
        }
    }
    return false;
}

// -------------------------------------------------------------------------
// FITUR 1: CEK TAGIHAN (!cektagihan <no_rumah>)
// -------------------------------------------------------------------------
async function checkTagihanWarga(noRumah) {
    return await fetchSheetsWithRetry(async () => {
        const variants = normalizeHouseVariants(noRumah);

        // 1. DAHULU CEK DI SHEET TUNGGAKAN (TUNGGAKAN 2RT)
        try {
            const resTunggakan = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `'${TUNGGAKAN_SHEET}'!A4:I500`, // Kolom C = No Rumah, Kolom I = Total Belum Bayar
            });

            const rowsTunggakan = resTunggakan.data.values || [];

            for (let i = 0; i < rowsTunggakan.length; i++) {
                const cellRumah = rowsTunggakan[i][2]; // Kolom C (No Rumah)
                if (cellRumah && matchesHouse(cellRumah, variants)) {
                    const houseDisplay = cellRumah.toString().trim();
                    const namaPemilik = rowsTunggakan[i][3] || '-'; // Kolom D
                    
                    // Ambil Total Belum Bayar dari Kolom I (Indeks 8)
                    const rawTotalBelumBayar = rowsTunggakan[i][8] || "0";
                    const cleanNominal = rawTotalBelumBayar.toString().replace(/[^0-9]/g, '');
                    const totalTunggakanNominal = parseInt(cleanNominal, 10) || 0;

                    const totalBulanTunggakan = Math.round(totalTunggakanNominal / NOMINAL_IURAN_PER_BULAN);

                    return {
                        success: true,
                        isTunggakan: true,
                        houseNumber: houseDisplay,
                        ownerName: namaPemilik,
                        totalMonths: totalBulanTunggakan,
                        totalAmount: totalTunggakanNominal
                    };
                }
            }
        } catch (errTunggakan) {
            writeLog(`⚠️ Gagal membaca Sheet Tunggakan: ${errTunggakan.message}`);
        }

        // 2. JIKA TIDAK DITEMUKAN DI TUNGGAKAN, CEK DI SHEET REGULER (2026 ALL)
        const resWarga = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${WARGA_SHEET}'!A5:AB1000`,
        });

        const rowsWarga = resWarga.data.values || [];
        let foundRow = null;
        let houseDisplayInSheet = noRumah.toUpperCase();

        for (let i = 0; i < rowsWarga.length; i++) {
            if (!rowsWarga[i] || !rowsWarga[i][2]) continue;
            if (matchesHouse(rowsWarga[i][2], variants)) {
                foundRow = rowsWarga[i];
                houseDisplayInSheet = rowsWarga[i][2].toString().trim();
                break;
            }
        }

        if (foundRow) {
            const bulanUnpaid = [];
            LIST_BULAN.forEach(m => {
                const config = MONTH_COLUMN_MAP[m];
                const hasDate = foundRow[config.tglIdx] && foundRow[config.tglIdx].trim() !== "";
                const hasNominal = foundRow[config.nomIdx] && foundRow[config.nomIdx].trim() !== "";

                if (!hasDate && !hasNominal) {
                    bulanUnpaid.push(m);
                }
            });

            const totalNominal = bulanUnpaid.length * NOMINAL_IURAN_PER_BULAN;

            return {
                success: true,
                isTunggakan: false,
                houseNumber: houseDisplayInSheet,
                unpaidMonths: bulanUnpaid,
                totalMonths: bulanUnpaid.length,
                totalAmount: totalNominal
            };
        }

        return { 
            success: false, 
            reason: `Nomor rumah '${noRumah}' tidak ditemukan di Sheet '${WARGA_SHEET}' maupun '${TUNGGAKAN_SHEET}'.` 
        };
    });
}

// =========================================================================
// 5. SERVER EXPRESS & BOT WHATSAPP
// =========================================================================
const app = express();
app.get('/', (req, res) => res.send('🤖 Bot WA Kas Cluster Active!'));
app.listen(process.env.PORT || 10000);

let sock = null;
let isReconnecting = false;

async function initAndStart() {
    if (isReconnecting) return;
    isReconnecting = true;

    try {
        if (sock) {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.ev.removeAllListeners('messages.upsert');
            try { sock.end(undefined); } catch (e) {}
            sock = null;
        }

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                isConnectedToWA = false;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    writeLog(`⚠️ Koneksi terputus. Reconnecting dalam 5 detik...`);
                    await delay(5000);
                    isReconnecting = false;
                    initAndStart();
                } else {
                    writeLog("❌ Session Logged Out.");
                    isReconnecting = false;
                }
            } else if (connection === 'open') {
                isConnectedToWA = true;
                isReconnecting = false;
                writeLog("✅ BOT CONNECTED TO WHATSAPP!");
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(5000);
            try {
                const cleanBotNumber = BOT_NUMBER.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(cleanBotNumber);
                writeLog(`🔑 KODE PAIRING: ${code}`);
            } catch (err) {
                writeLog(`❌ Pairing Error: ${err.message}`);
            }
        }

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const msgId = msg.key.id;
            if (isMessageProcessed(msgId)) return;
            markMessageProcessed(msgId);

            const remoteJid = msg.key.remoteJid;
            const msgText = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                ''
            ).trim();

            if (remoteJid === 'status@broadcast' || !msgText) return;

            const cleanCmd = msgText.toLowerCase().replace(/^[!.\s]+/, '').trim();

            // -----------------------------------------------------------------
            // COMMAND !cektagihan
            // -----------------------------------------------------------------
            if (cleanCmd.startsWith('cektagihan')) {
                const args = msgText.replace(/^!cektagihan/i, '').trim();

                if (!args) {
                    await sock.sendMessage(remoteJid, { 
                        text: `⚠️ *Format Salah!*\n\nGunakan format:\n👉 *!cektagihan <No_Rumah>*\n\nContoh:\n\`!cektagihan CA1908\`` 
                    }, { quoted: msg });
                    return;
                }

                await sock.sendMessage(remoteJid, { text: `⏳ *Memeriksa data tagihan untuk ${args}...*` }, { quoted: msg });

                try {
                    const tagihan = await checkTagihanWarga(args);

                    if (tagihan.success) {
                        if (tagihan.isTunggakan) {
                            // TAMPILAN JIKA TERDAPAT DI SHEET TUNGGAKAN 2RT
                            const resMsg = 
`📋 *INFORMASI TAGIHAN (TUNGGAKAN)*

• Rumah: *${tagihan.houseNumber}*
• Pemilik: *${tagihan.ownerName}*
• Status: *Tercatat di List Tunggakan*
• Total Tunggakan: *Rp ${tagihan.totalAmount.toLocaleString('id-ID')}*
• Total Belum Dibayar: *${tagihan.totalMonths} Bulan* (Perhitungan Rp 210.000/bulan)

━━━━━━━━━━━━━━━━━━━━━━
💳 Pembayaran dapat dilakukan via VA Mandiri (85485 + No Rumah + 0) dan lakukan konfirmasi setelah transfer. Terima kasih! 🙏`;
                            await sock.sendMessage(remoteJid, { text: resMsg }, { quoted: msg });
                        } else if (tagihan.totalMonths === 0) {
                            const resMsg = 
`🎉 *INFORMASI TAGIHAN IPL*

• Rumah: *${tagihan.houseNumber}*
• Status: *LUNAS TOTAL (12 Bulan)*

Seluruh iuran IPL tahun 2026 sudah terbayarkan. Terima kasih! 🙏`;
                            await sock.sendMessage(remoteJid, { text: resMsg }, { quoted: msg });
                        } else {
                            const resMsg = 
`📋 *INFORMASI TAGIHAN IPL 2026*

• Rumah: *${tagihan.houseNumber}*
• Belum Dibayar: *${tagihan.totalMonths} Bulan*
• Rincian Bulan: *${tagihan.unpaidMonths.join(', ')}*
• Total Tagihan: *Rp ${tagihan.totalAmount.toLocaleString('id-ID')}*

━━━━━━━━━━━━━━━━━━━━━━
💳 Pembayaran dapat dilakukan via VA Mandiri (85485 + No Rumah + 0) dan lakukan konfirmasi setelah transfer. Terima kasih! 🙏`;
                            await sock.sendMessage(remoteJid, { text: resMsg }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ ${tagihan.reason}` }, { quoted: msg });
                    }
                } catch (e) {
                    writeLog(`❌ Cek Tagihan Error: ${e.message}`);
                    await sock.sendMessage(remoteJid, { text: `⚠️ Gagal mengecek tagihan: ${e.message}` }, { quoted: msg });
                }
                return;
            }
        });

    } catch (err) {
        writeLog(`❌ Connection Error: ${err.message}`);
        isReconnecting = false;
    }
}

initAndStart();
