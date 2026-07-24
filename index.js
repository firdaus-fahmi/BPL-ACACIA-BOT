require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { google } = require('googleapis');
const cron = require('node-cron');
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

const WARGA_SHEET = process.env.WARGA_SHEET || 'TAGIHAN 2RT 19072026';
const SETTING_SHEET = process.env.SETTING_SHEET || 'Setting';
const HISTORI_SHEET = process.env.HISTORI_SHEET || 'HISTORI_PEMBAYARAN';

const NOMINAL_IURAN_PER_BULAN = 210000; // Nominal standar IPL per bulan
let isConnectedToWA = false;

// =========================================================================
// 2. PERSISTENCE DATABASE (SQLITE) & LOGGING
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
// 3. GOOGLE API & RETRY MECHANISM
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
// 4. HELPER LOGIKA BISNIS & GOOGLE SHEETS
// =========================================================================
function normalizeHouseNumber(raw) {
    if (!raw) return "";
    let clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const match = clean.match(/^([A-Z]+)(\d{2})(\d{2})$/);
    if (match) return `${match[1]} ${match[2]}-${match[3]}`;
    return raw.toUpperCase().trim();
}

function getDefaultPaymentInfo() {
    return `🏦 *PEMBAYARAN IPL CLUSTER ACACIA*

Silakan melakukan pembayaran melalui salah satu metode berikut:

💳 *Virtual Account (VA)*
Bank Mandiri Virtual Account

Format VA:
85485 + Nomor Rumah + 0

Contoh:
• Rumah CA1712 → 8548517120
• Rumah CA0203 → 8548502030
• Rumah CA1810 → 8548518100

━━━━━━━━━━━━━━━━━━━━━━
📌 *Cara Pembayaran:*

1. *Livin' by Mandiri:*
   Pilih Bayar ➔ Cari "Balai Pengelola Lingkungan Acacia" atau nomor biller ➔ Masukkan Nomor VA ➔ Lanjut Bayar.

2. *Bank Lain (Non-Mandiri):*
   Pilih Transfer ➔ Bank Mandiri ➔ No. Rekening diisi Nomor VA ➔ Nominal sesuai tagihan (Rp 210.000) ➔ Submit ➔ Selesai.
━━━━━━━━━━━━━━━━━━━━━━

📌 *CARA KONFIRMASI PEMBAYARAN:*

Setelah bayar, silakan ketik *!konfirmasi* untuk melihat petunjuk, ATAU langsung kirim pesan dengan format:

👉 *<No_Rumah> <Bulan> <Nominal>*

Contoh (1 Bulan):
\`CA1712 Juni 210000\`

Contoh (Multi-Bulan):
\`CA1712 Juni-Juli 420000\`

Terima kasih 🙏`;
}

async function getRekeningInfoFromSheets() {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${SETTING_SHEET}'!A2:B10`,
        });
        const rows = res.data.values || [];
        if (rows.length === 0) return getDefaultPaymentInfo();

        const config = {};
        rows.forEach(r => { if (r[0] && r[1]) config[r[0].trim()] = r[1].trim(); });
        
        if (!config.BANK || !config.ACCOUNT_NUMBER) return getDefaultPaymentInfo();

        return `🏦 *PEMBAYARAN IPL CLUSTER ACACIA*

Silakan melakukan pembayaran melalui metode berikut:

💳 *Virtual Account (VA)*
Bank ${config.BANK} Virtual Account

Format VA:
${config.VA_PREFIX || '85485'} + Nomor Rumah + 0

Contoh:
• Rumah CA1712 → ${config.VA_PREFIX || '85485'}17120

━━━━━━━━━━━━━━━━━━━━━━
📌 *CARA KONFIRMASI PEMBAYARAN:*

Setelah bayar, silakan ketik *!konfirmasi* atau kirim format teks:
👉 *<No_Rumah> <Bulan> <Nominal>*

Contoh:
\`CA1712 Juni 210000\`

Terima kasih 🙏`;
    } catch (err) {
        return getDefaultPaymentInfo();
    }
}

async function getPenunggakFromSheets() {
    return await fetchSheetsWithRetry(async () => {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${WARGA_SHEET}'!A5:Z1000`,
        });

        const rows = res.data.values || [];
        
        return rows
            .map(row => {
                if (!row || row.length === 0) return null;
                const noRumahVal = row[2] ? row[2].toString().trim() : "";
                const namaVal = row[3] ? row[3].toString().trim() : "Warga";
                const rawNominal = row[9] || "0";
                const cleanNominalStr = rawNominal.toString().replace(/[^0-9]/g, '');
                const parsedNominal = parseInt(cleanNominalStr, 10);
                const totalNominal = isNaN(parsedNominal) ? 0 : parsedNominal;

                if (!noRumahVal || totalNominal <= 0) return null;

                return { no_rumah: noRumahVal, nama: namaVal, total_tunggakan: totalNominal };
            })
            .filter(item => item !== null);
    });
}

// Fungsi Memecah Pembayaran Multi-Bulan ke Google Sheets
async function processManualPayment(noRumah, bulanText, nominal, senderNumber) {
    return await fetchSheetsWithRetry(async () => {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${WARGA_SHEET}'!A5:Z1000`,
        });

        const rows = res.data.values || [];
        let rowIndex = -1;
        let currentSisaTagihan = 0;
        const targetNorm = normalizeHouseNumber(noRumah);

        for (let i = 0; i < rows.length; i++) {
            const currentHouse = rows[i][2] ? normalizeHouseNumber(rows[i][2]) : "";
            if (currentHouse === targetNorm) {
                rowIndex = i + 5;
                const rawVal = rows[i][9] || "0";
                currentSisaTagihan = parseInt(rawVal.toString().replace(/[^0-9]/g, ''), 10) || 0;
                break;
            }
        }

        if (rowIndex === -1) return { success: false, reason: "Rumah tidak ditemukan di database Google Sheets." };

        // Hitung perkiraan berapa bulan yang dibayar berdasarkan nominal
        const totalBulanDibayar = Math.floor(nominal / NOMINAL_IURAN_PER_BULAN) || 1;
        const nominalPerBulan = Math.floor(nominal / totalBulanDibayar);

        // Update sisa tagihan di Sheet WARGA
        let newSisa = currentSisaTagihan - nominal;
        if (newSisa < 0) newSisa = 0;

        let statusText = newSisa === 0 ? "LUNAS" : `SEBAGIAN (Sisa Rp ${newSisa.toLocaleString('id-ID')})`;

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${WARGA_SHEET}'!J${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[newSisa]] },
        });

        // Simpan Log ke Sheet HISTORI (Auto-Split jika bayar multi-bulan)
        const dateStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const historyRows = [];

        if (totalBulanDibayar > 1 && bulanText.includes('-')) {
            const listBulan = bulanText.split('-').map(b => b.trim());
            for (let b = 0; b < totalBulanDibayar; b++) {
                const labelBulan = listBulan[b] || `${bulanText} (Bagian ${b + 1})`;
                historyRows.push([dateStr, targetNorm, labelBulan, nominalPerBulan, senderNumber, "MANUAL_INPUT", statusText]);
            }
        } else {
            historyRows.push([dateStr, targetNorm, bulanText, nominal, senderNumber, "MANUAL_INPUT", statusText]);
        }

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${HISTORI_SHEET}'!A:G`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: historyRows }
        });

        writeLog(`✅ Manual Payment Logged: ${targetNorm} | ${bulanText} | Total: Rp ${nominal} (${totalBulanDibayar} Bulan)`);
        return { 
            success: true, 
            normalizedHouse: targetNorm, 
            status: statusText, 
            totalBulan: totalBulanDibayar,
            sisaTagihan: newSisa
        };
    });
}

// =========================================================================
// 5. SERVER EXPRESS (HEALTH CHECK)
// =========================================================================
const app = express();
app.get('/', (req, res) => res.send('🤖 Bot WhatsApp Cluster Acacia Active!'));
app.get('/health', (req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), connected: isConnectedToWA });
});
app.listen(process.env.PORT || 10000);

// =========================================================================
// 6. MAIN BOT INIT & WHATSAPP CONNECTION
// =========================================================================
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
                    writeLog("❌ Session Logged Out/Expired.");
                    isReconnecting = false;
                }
            } else if (connection === 'open') {
                isConnectedToWA = true;
                isReconnecting = false;
                writeLog("✅ BOT ENTERPRISE BERHASIL TERHUBUNG!");
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(5000);
            try {
                const cleanBotNumber = BOT_NUMBER.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(cleanBotNumber);
                writeLog(`🔑 KODE PAIRING WHATSAPP: ${code}`);
            } catch (err) {
                writeLog(`❌ Gagal request pairing code: ${err.message}`);
            }
        }

        // =================================================================
        // HANDLING INCOMING MESSAGES
        // =================================================================
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

            // -----------------------------------------------------------------
            // 1. COMMAND !konfirmasi
            // -----------------------------------------------------------------
            if (cleanCmd === 'konfirmasi') {
                const petunjukText = 
`📝 *PETUNJUK KONFIRMASI PEMBAYARAN IPL*

Silakan kirimkan pesan dengan format berikut:

👉 *<No_Rumah> <Bulan> <Total_Nominal>*

📌 *Contoh Pembayaran 1 Bulan:*
\`CA1712 Juni 210000\`

📌 *Contoh Pembayaran Multi-Bulan:*
\`CA1712 Juni-Juli 420000\`
\`CA1712 Mei-Juli 630000\`

*Catatan:*
• Iuran per bulan: *Rp 210.000*
• Pembayaran multi-bulan otomatis dipisah pada laporan spreadsheet.`;

                await sock.sendMessage(remoteJid, { text: petunjukText }, { quoted: msg });
                return;
            }

            // -----------------------------------------------------------------
            // 2. DETEKSI FORMAT PEMBAYARAN TEKS (Contoh: CA1712 Juni-Juli 420000)
            // -----------------------------------------------------------------
            const paymentPattern = /^([A-Z0-9\/\-]{3,10})\s+([A-Za-z\s\-]+)\s+(\d[\d\.\,]*)$/i;
            const match = msgText.match(paymentPattern);

            if (match) {
                const rawNoRumah = match[1].trim();
                const bulanText = match[2].trim();
                const rawNominal = match[3].replace(/[^0-9]/g, '');
                const nominal = parseInt(rawNominal, 10);

                if (isNaN(nominal) || nominal < 10000) {
                    await sock.sendMessage(remoteJid, { text: "⚠️ Nominal pembayaran tidak valid!" }, { quoted: msg });
                    return;
                }

                await sock.sendMessage(remoteJid, { text: "⏳ *Sedang memproses konfirmasi pembayaran...*" }, { quoted: msg });

                try {
                    const result = await processManualPayment(rawNoRumah, bulanText, nominal, senderNumber);

                    if (result.success) {
                        const replyMsg = 
`✅ *PEMBAYARAN DITERIMA & DICATAT*

• No. Rumah: *${result.normalizedHouse}*
• Pembayaran Bulan: *${bulanText}* (${result.totalBulan} Bulan)
• Total Masuk: *Rp ${nominal.toLocaleString('id-ID')}*
• Status Tagihan: *${result.status}*

_Data telah otomatis diperbarui di Google Sheets._ Terima kasih! 🙏`;

                        await sock.sendMessage(remoteJid, { text: replyMsg }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ Gagal: ${result.reason}` }, { quoted: msg });
                    }
                } catch (err) {
                    writeLog(`❌ Error Process Payment: ${err.message}`);
                    await sock.sendMessage(remoteJid, { text: `⚠️ Terjadi kesalahan saat mencatat ke Spreadsheet: ${err.message}` }, { quoted: msg });
                }
                return;
            }

            // -----------------------------------------------------------------
            // 3. COMMAND UMUM LAINNYA
            // -----------------------------------------------------------------
            if (cleanCmd === 'rekening' || cleanCmd === 'bayar') {
                const replyText = await getRekeningInfoFromSheets();
                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
            } 
            else if (cleanCmd === 'tunggakan' || cleanCmd === 'cek') {
                try {
                    const penunggak = await getPenunggakFromSheets();
                    if (!penunggak || penunggak.length === 0) {
                        await sock.sendMessage(remoteJid, { text: "🎉 *LUNAS SEMUA!* Semua warga telah melunasi IPL." }, { quoted: msg });
                    } else {
                        let teks = `📊 *DAFTAR BELUM BAYAR IPL (${penunggak.length} Rumah)*\n\n`;
                        penunggak.forEach((w, i) => {
                            const nominalFormatted = w.total_tunggakan.toLocaleString('id-ID');
                            teks += `${i + 1}. *${w.no_rumah}* (${w.nama}) - Rp ${nominalFormatted}\n`;
                        });
                        await sock.sendMessage(remoteJid, { text: teks }, { quoted: msg });
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `⚠️ Gagal membaca data tunggakan.` }, { quoted: msg });
                }
            }
            else if (cleanCmd === 'menu' || cleanCmd === 'help') {
                await sock.sendMessage(remoteJid, { text: `🤖 *BOT KAS CLUSTER ACACIA*\n\nPerintah:\n• *!bayar* : Info Virtual Account Mandiri\n• *!cek* : Cek tunggakan warga\n• *!konfirmasi* : Cara konfirmasi pembayaran\n• *Format Teks* : CA1712 Juni 210000` }, { quoted: msg });
            }
        });

    } catch (err) {
        writeLog(`❌ Fatal Error di initAndStart: ${err.message}`);
        isReconnecting = false;
    }
}

// -------------------------------------------------------------------------
// 7. SHUTDOWN HANDLER
// -------------------------------------------------------------------------
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

initAndStart();
