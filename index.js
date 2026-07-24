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

// Mengunci nama Sheet ke "2026 ALL" (mengabaikan kesalahan nama sheet di .env jika ada)
const WARGA_SHEET = (process.env.WARGA_SHEET && process.env.WARGA_SHEET !== 'TAGIHAN 2RT 19072026') 
    ? process.env.WARGA_SHEET 
    : '2026 ALL';

const HISTORI_SHEET = process.env.HISTORI_SHEET || 'HISTORI_PEMBAYARAN';
const NOMINAL_IURAN_PER_BULAN = 210000;
let isConnectedToWA = false;

// Mapping Kolom Google Sheets untuk "2026 ALL"
// Kolom A=0, B=1, C=2 (No Rumah), D=3 (Nama)
const MONTH_COLUMN_MAP = {
    "JANUARI":   { tglCol: "E", nomCol: "F" },
    "FEBRUARI":  { tglCol: "G", nomCol: "H" },
    "MARET":     { tglCol: "I", nomCol: "J" },
    "APRIL":     { tglCol: "K", nomCol: "L" },
    "MEI":       { tglCol: "M", nomCol: "N" },
    "JUNI":      { tglCol: "O", nomCol: "P" },
    "JULI":      { tglCol: "Q", nomCol: "R" },
    "AGUSTUS":   { tglCol: "S", nomCol: "T" },
    "SEPTEMBER": { tglCol: "U", nomCol: "V" },
    "OKTOBER":   { tglCol: "W", nomCol: "X" },
    "NOVEMBER":  { tglCol: "Y", nomCol: "Z" },
    "DESEMBER":  { tglCol: "AA", nomCol: "AB" }
};

const LIST_BULAN = Object.keys(MONTH_COLUMN_MAP);

// =========================================================================
// 2. PERSISTENCE DATABASE & LOGGING
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
// 4. HELPER & LOGIKA BISNIS
// =========================================================================
// Pencocokan Nomor Rumah Sangat Fleksibel (CA1802 -> CA182 & 1802)
function extractDigits(raw) {
    return raw ? raw.replace(/[^0-9]/g, '').replace(/^0+/, '') : "";
}

function generateMonthList(bulanText, totalBulan) {
    if (!bulanText.includes('-')) {
        const single = bulanText.trim().toUpperCase();
        const found = LIST_BULAN.find(b => b.startsWith(single.substring(0, 3)));
        return [found || single];
    }

    const parts = bulanText.split('-').map(b => b.trim().toUpperCase());
    const startIdx = LIST_BULAN.findIndex(b => b.startsWith(parts[0].substring(0, 3)));
    const endIdx = LIST_BULAN.findIndex(b => b.startsWith(parts[1].substring(0, 3)));

    if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        return LIST_BULAN.slice(startIdx, endIdx + 1);
    }

    return LIST_BULAN.slice(0, totalBulan);
}

function getDefaultPaymentInfo() {
    return `🏦 *PEMBAYARAN IPL CLUSTER ACACIA*

Silakan melakukan pembayaran melalui Virtual Account berikut:

💳 *Virtual Account (VA) Bank Mandiri*
Format VA: 85485 + Nomor Rumah + 0

Contoh:
• Rumah CA 03-01 ➔ 8548503010
• Rumah CA 18-02 ➔ 8548518020

━━━━━━━━━━━━━━━━━━━━━━
📌 *CARA KONFIRMASI PEMBAYARAN:*

Kirim pesan format berikut:
👉 *<No_Rumah> <Bulan> <Nominal>*

Contoh (1 Bulan):
\`CA 03-01 Juni 210000\`

Contoh (Multi-Bulan):
\`CA1802 Januari-Desember 2520000\`

Terima kasih 🙏`;
}

// Proses Input Pembayaran ke Sheet "2026 ALL"
async function processManualPayment(noRumah, bulanText, nominal, senderNumber) {
    return await fetchSheetsWithRetry(async () => {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${WARGA_SHEET}'!A5:C1000`,
        });

        const rows = res.data.values || [];
        let rowIndex = -1;
        let houseDisplayInSheet = noRumah.toUpperCase();
        
        const inputDigits = extractDigits(noRumah);

        // 1. Cari Baris Rumah di Kolom C berdasarkan Digit Angka
        for (let i = 0; i < rows.length; i++) {
            if (!rows[i] || !rows[i][2]) continue;
            
            const rawSheetHouse = rows[i][2].toString().trim();
            const sheetDigits = extractDigits(rawSheetHouse);

            if (inputDigits && sheetDigits && inputDigits === sheetDigits) {
                rowIndex = i + 5; // Karena data dimulai dari baris 5
                houseDisplayInSheet = rawSheetHouse;
                break;
            }
        }

        if (rowIndex === -1) {
            return { success: false, reason: `Rumah '${noRumah}' tidak ditemukan di Kolom C Sheet '${WARGA_SHEET}'. Pastikan nomor rumah cocok.` };
        }

        // 2. Hitung Bulan
        const totalBulanDibayar = Math.floor(nominal / NOMINAL_IURAN_PER_BULAN) || 1;
        const targetMonths = generateMonthList(bulanText, totalBulanDibayar);

        // Format Tanggal Hari Ini (dd/mm/yyyy)
        const today = new Date();
        const dd = String(today.getDate()).padStart(2, '0');
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const yyyy = today.getFullYear();
        const formattedDate = `${dd}/${mm}/${yyyy}`;

        // 3. Update Kolom Tanggal & Nominal per Bulan di Google Sheets
        const updateBatch = [];
        const historyRows = [];
        const dateLogStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        for (let b = 0; b < targetMonths.length; b++) {
            const monthName = targetMonths[b];
            const colConfig = MONTH_COLUMN_MAP[monthName];

            if (colConfig) {
                // Tanggal
                updateBatch.push({
                    range: `'${WARGA_SHEET}'!${colConfig.tglCol}${rowIndex}`,
                    values: [[formattedDate]]
                });
                // Nominal
                updateBatch.push({
                    range: `'${WARGA_SHEET}'!${colConfig.nomCol}${rowIndex}`,
                    values: [[NOMINAL_IURAN_PER_BULAN]]
                });
            }

            historyRows.push([dateLogStr, houseDisplayInSheet, monthName, NOMINAL_IURAN_PER_BULAN, senderNumber, "MANUAL_INPUT", "LUNAS"]);
        }

        // Batch Update ke Sheet "2026 ALL"
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
                valueInputOption: 'USER_ENTERED',
                data: updateBatch
            }
        });

        // Log Histori Pembayaran
        try {
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `'${HISTORI_SHEET}'!A:G`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: historyRows }
            });
        } catch (e) {
            writeLog(`⚠️ Histori Log skipped: ${e.message}`);
        }

        writeLog(`✅ Success Payment: ${houseDisplayInSheet} | ${targetMonths.join(', ')} | Total: Rp ${nominal}`);
        
        return { 
            success: true, 
            normalizedHouse: houseDisplayInSheet, 
            totalBulan: targetMonths.length,
            processedMonths: targetMonths.join(', '),
            paymentDate: formattedDate
        };
    });
}

// =========================================================================
// 5. SERVER EXPRESS & WHATSAPP CONNECTION
// =========================================================================
const app = express();
app.get('/', (req, res) => res.send('🤖 Bot WA Kas Cluster Acacia Active!'));
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

            const remoteJid = msg.key.remoteJid;
            const isGroup = remoteJid.endsWith('@g.us');
            const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid;
            const senderNumber = senderJid.replace(/[^0-9]/g, '');

            const msgText = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                ''
            ).trim();

            if (remoteJid === 'status@broadcast' || !msgText) return;

            const cleanCmd = msgText.toLowerCase().replace(/^[!.\s]+/, '').trim();

            if (cleanCmd === 'konfirmasi') {
                await sock.sendMessage(remoteJid, { 
                    text: `📝 *PETUNJUK KONFIRMASI PEMBAYARAN IPL*\n\nFormat Teks:\n👉 *<No_Rumah> <Bulan> <Nominal>*\n\nContoh:\n\`CA 03-01 Juni 210000\`\n\`CA1802 Januari-Desember 2520000\`` 
                }, { quoted: msg });
                return;
            }

            const paymentPattern = /^([A-Z0-9\/\-\s]{3,12})\s+([A-Za-z\s\-]+)\s+(\d[\d\.\,]*)$/i;
            const match = msgText.match(paymentPattern);

            if (match) {
                const rawNoRumah = match[1].trim();
                const bulanText = match[2].trim();
                const rawNominal = match[3].replace(/[^0-9]/g, '');
                const nominal = parseInt(rawNominal, 10);

                if (isNaN(nominal) || nominal < 10000) {
                    await sock.sendMessage(remoteJid, { text: "⚠️ Nominal tidak valid!" }, { quoted: msg });
                    return;
                }

                await sock.sendMessage(remoteJid, { text: "⏳ *Sedang memproses & memperbarui Sheet 2026 ALL...*" }, { quoted: msg });

                try {
                    const result = await processManualPayment(rawNoRumah, bulanText, nominal, senderNumber);

                    if (result.success) {
                        const replyMsg = 
`✅ *PEMBAYARAN DITERIMA!*

• Rumah: *${result.normalizedHouse}*
• Tanggal: *${result.paymentDate}*
• Bulan: *${result.processedMonths}* (${result.totalBulan} Bulan)
• Total Masuk: *Rp ${nominal.toLocaleString('id-ID')}*

_Data tanggal & nominal telah otomatis diisikan pada Sheet '2026 ALL'._ Terima kasih! 🙏`;

                        await sock.sendMessage(remoteJid, { text: replyMsg }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ ${result.reason}` }, { quoted: msg });
                    }
                } catch (err) {
                    writeLog(`❌ Error Payment: ${err.message}`);
                    await sock.sendMessage(remoteJid, { text: `⚠️ Kesalahan sistem: ${err.message}` }, { quoted: msg });
                }
                return;
            }

            if (cleanCmd === 'bayar' || cleanCmd === 'rekening') {
                await sock.sendMessage(remoteJid, { text: getDefaultPaymentInfo() }, { quoted: msg });
            }
        });

    } catch (err) {
        writeLog(`❌ Connection Error: ${err.message}`);
        isReconnecting = false;
    }
}

initAndStart();
