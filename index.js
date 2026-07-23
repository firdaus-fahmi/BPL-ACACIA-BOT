require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, downloadMediaMessage, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const cron = require('node-cron');
const pino = require('pino');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const retry = require('async-retry');

// Fix Universal Import untuk p-queue (Mendukung CommonJS & ESM)
const PQueueModule = require('p-queue');
const PQueue = PQueueModule.default || PQueueModule;

// =========================================================================
// 1. VALIDASI ENVIRONMENT VARIABLES
// =========================================================================
const requiredEnv = ["GEMINI_API_KEY", "SPREADSHEET_ID", "BOT_NUMBER", "ADMIN_NUMBERS"];
const missingEnv = requiredEnv.filter(env => !process.env[env]);

if (missingEnv.length > 0) {
    console.error(`❌ FATAL ERROR: Environment Variable berikut belum diisi: ${missingEnv.join(', ')}`);
    process.exit(1);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const BOT_NUMBER = process.env.BOT_NUMBER;
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS.split(',').map(n => n.trim().replace(/[^0-9]/g, ''));

const WARGA_SHEET = process.env.WARGA_SHEET || 'TAGIHAN 2RT 19072026';
const SETTING_SHEET = process.env.SETTING_SHEET || 'Setting';
const HISTORI_SHEET = process.env.HISTORI_SHEET || 'HISTORI_PEMBAYARAN';

let isConnectedToWA = false;
const ocrQueueInstance = new PQueue({ concurrency: 1 });
const activeHouseLocks = new Set();

// =========================================================================
// 2. PERSISTENCE DATABASE (SQLITE WITH WAL MODE) & LOGGING
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
    CREATE TABLE IF NOT EXISTS processed_hashes (
        hash TEXT PRIMARY KEY,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_cooldowns (
        sender_id TEXT PRIMARY KEY,
        last_upload INTEGER
    );
`);

cron.schedule('0 3 * * *', () => {
    db.prepare("DELETE FROM processed_hashes WHERE processed_at < datetime('now', '-30 days')").run();
    writeLog("🧹 Housekeeping: Cleaned old hash entries from SQLite.");
});

function performDatabaseBackup() {
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const backupPath = path.join(__dirname, 'logs', `backup-db-${new Date().toISOString().split('T')[0]}.db`);
        fs.copyFileSync(path.join(__dirname, 'bot_data.db'), backupPath);
        writeLog("💾 Local SQLite Backup Completed Successfully.");
    } catch (err) {
        writeLog(`❌ Backup Failed: ${err.message}`);
    }
}
cron.schedule('0 2 * * *', performDatabaseBackup);

// =========================================================================
// 3. GOOGLE API & RETRY MECHANISM
// =========================================================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModelName = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest";
const model = genAI.getGenerativeModel({ model: geminiModelName });

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
    }, {
        retries: 4,
        minTimeout: 1000,
        factor: 2
    });
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

function validateOCRData(data, rawText) {
    if (!data || !data.no_rumah || !data.nominal) {
        return { valid: false, reason: "Data nomor rumah atau nominal tidak terdeteksi" };
    }

    const normHouse = normalizeHouseNumber(data.no_rumah);
    const isValidHousePattern = /^[A-Z]+\s?\d{2}-\d{2}$|^[A-Z0-9\/\-]{3,10}$/.test(normHouse);
    if (!isValidHousePattern) {
        return { valid: false, reason: "Format nomor rumah tidak valid" };
    }

    const upperRaw = rawText.toUpperCase();
    const keywords = ["TRANSFER", "BERHASIL", "SUKSES", "BCA", "MANDIRI", "BRI", "BNI", "SELESAI", "TOTAL", "PAYMENT", "VA", "AKUN"];
    const hasKeyword = keywords.some(kw => upperRaw.includes(kw));

    if (!hasKeyword) {
        return { valid: false, reason: "Struk tidak memiliki kata kunci transaksi valid" };
    }

    return { valid: true, normalizedHouse: normHouse };
}

async function getRekeningInfoFromSheets() {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${SETTING_SHEET}'!A2:B10`,
        });
        const rows = res.data.values || [];
        if (rows.length === 0) return null;

        const config = {};
        rows.forEach(r => { if (r[0] && r[1]) config[r[0].trim()] = r[1].trim(); });
        
        if (!config.BANK || !config.ACCOUNT_NUMBER) return null;

        return `🏦 *PEMBAYARAN IPL CLUSTER ACACIA*

Silakan melakukan pembayaran melalui salah satu metode berikut:

*1️⃣ Transfer Bank*

🏦 Bank : ${config.BANK}
👤 A/N : ${config.ACCOUNT_NAME || 'Pengurus RT'}
💳 No. Rekening :
${config.ACCOUNT_NUMBER}

━━━━━━━━━━━━━━━━━━━━━━

*2️⃣ Virtual Account (VA)*

Bank ${config.BANK} Virtual Account

Format VA:
${config.VA_PREFIX || '85485'} + Nomor Rumah + 0

Contoh:
• Rumah A01 → ${config.VA_PREFIX || '85485'}A010
• Rumah B12 → ${config.VA_PREFIX || '85485'}B120
• Rumah C105 → ${config.VA_PREFIX || '85485'}C1050

━━━━━━━━━━━━━━━━━━━━━━

📌 Setelah melakukan pembayaran, mohon kirim bukti transfer dengan mengetik:

*.konfirmasi*

atau kirim foto bukti transfer ke bot.

Terima kasih 🙏`;
    } catch (err) {
        return null;
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

                return {
                    no_rumah: noRumahVal,
                    nama: namaVal,
                    total_tunggakan: totalNominal
                };
            })
            .filter(item => item !== null);
    });
}

async function processPaymentAndLog(noRumah, nominal, sender, imageHash, rawGeminiText) {
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

        if (rowIndex === -1) return { success: false, reason: "NOT_FOUND" };

        let newStatus = "LUNAS";
        let newSisa = 0;

        if (nominal < currentSisaTagihan) {
            newSisa = currentSisaTagihan - nominal;
            newStatus = `SEBAGIAN (Sisa Rp ${newSisa.toLocaleString('id-ID')})`;
        }

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${WARGA_SHEET}'!J${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[newSisa]] },
        });

        const dateStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${HISTORI_SHEET}'!A:G`,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[dateStr, targetNorm, nominal, sender, imageHash, newStatus, rawGeminiText.substring(0, 300)]]
            }
        });

        writeLog(`✅ Audit Log Executed: ${targetNorm} paid Rp ${nominal}`);
        return { success: true, status: newStatus, sisa: newSisa };
    });
}

// =========================================================================
// 5. SERVER EXPRESS
// =========================================================================
const app = express();
app.get('/', (req, res) => res.send('🤖 Bot WhatsApp Cluster Acacia Active!'));
app.get('/health', (req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        connected: isConnectedToWA,
        queueLength: ocrQueueInstance.size,
        timestamp: new Date().toISOString()
    });
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

        const { version, isLatest } = await fetchLatestBaileysVersion();
        writeLog(`🔄 Menggunakan Baileys v${version.join('.')}` + (isLatest ? ' (Terbaru)' : ''));

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

                writeLog(`⚠️ Koneksi terputus (Status Code: ${statusCode || 'Unknown'}). Reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    await delay(5000);
                    isReconnecting = false;
                    initAndStart();
                } else {
                    writeLog("❌ Session Logged Out/Expired. Silakan hapus folder 'auth_info_baileys' dan jalankan ulang.");
                    isReconnecting = false;
                }
            } else if (connection === 'open') {
                isConnectedToWA = true;
                isReconnecting = false;
                writeLog("✅ BOT ENTERPRISE BERHASIL TERHUBUNG SEPENUHNYA!");
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
                msg.message.imageMessage?.caption ||
                ''
            ).trim();

            if (remoteJid === 'status@broadcast') return;

            const cleanCmd = msgText.toLowerCase().replace(/^[!.\s]+/, '').trim();

            // -----------------------------------------------------------------
            // A. OCR ENGINE (Membaca Gambar Bukti Transfer)
            // -----------------------------------------------------------------
            const isImage = msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

            if (isImage) {
                const now = Date.now();
                const coolRow = db.prepare("SELECT last_upload FROM user_cooldowns WHERE sender_id = ?").get(senderJid);
                if (coolRow && (now - coolRow.last_upload < 10000)) {
                    await sock.sendMessage(remoteJid, { text: "⏳ Mohon tunggu 10 detik sebelum mengunggah bukti berikutnya." }, { quoted: msg });
                    return;
                }
                db.prepare("INSERT OR REPLACE INTO user_cooldowns (sender_id, last_upload) VALUES (?, ?)").run(senderJid, now);

                await sock.sendMessage(remoteJid, { text: "🔎 *Bukti transfer diterima!* Sedang diverifikasi oleh AI..." }, { quoted: msg });

                ocrQueueInstance.add(async () => {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const imageHash = crypto.createHash('sha256').update(buffer).digest('hex');

                        const dupCheck = db.prepare("SELECT hash FROM processed_hashes WHERE hash = ?").get(imageHash);
                        if (dupCheck) {
                            await sock.sendMessage(remoteJid, { text: "⚠️ Bukti transfer ini sudah pernah diproses sebelumnya!" }, { quoted: msg });
                            return;
                        }

                        const mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';
                        const prompt = `Ekstrak data dari struk ini. Balas HANYA JSON valid tanpa teks lain: {"no_rumah": "CA 09-03", "nominal": 210000}. Jika tidak ada set null.`;

                        const result = await model.generateContent([prompt, { inlineData: { data: buffer.toString("base64"), mimeType } }]);
                        const rawGeminiText = result.response.text();
                        
                        // String replacement aman dari RegEx SyntaxError
                        const cleanJsonText = rawGeminiText.replace(/```json/gi, '').replace(/```/g, '').trim();
                        const jsonMatch = cleanJsonText.match(/\{[\s\S]*\}/);

                        if (!jsonMatch) throw new Error("AI tidak menemukan format JSON valid dari gambar ini");
                        const data = JSON.parse(jsonMatch[0]);

                        const ocrVal = validateOCRData(data, cleanJsonText);
                        if (!ocrVal.valid) {
                            await sock.sendMessage(remoteJid, { text: `⚠️ Foto tidak memenuhi syarat konfirmasi otomatis (${ocrVal.reason}). Kirimkan foto yang lebih jelas.` }, { quoted: msg });
                            return;
                        }

                        const targetNorm = ocrVal.normalizedHouse;

                        if (activeHouseLocks.has(targetNorm)) {
                            await sock.sendMessage(remoteJid, { text: `⏳ Pembayaran untuk rumah ${targetNorm} sedang diproses. Mohon tunggu sebentar.` }, { quoted: msg });
                            return;
                        }

                        activeHouseLocks.add(targetNorm);

                        try {
                            if (data.nominal < 10000 || data.nominal > 20000000) {
                                await sock.sendMessage(remoteJid, { text: `⚠️ Nominal Rp ${data.nominal.toLocaleString('id-ID')} terdeteksi di luar batas wajar. Hubungi Bendahara.` }, { quoted: msg });
                                return;
                            }

                            const updateRes = await processPaymentAndLog(targetNorm, data.nominal, senderNumber, imageHash, rawGeminiText);

                            if (updateRes.success) {
                                db.prepare("INSERT INTO processed_hashes (hash) VALUES (?)").run(imageHash);
                                let replyText = `✅ *PEMBAYARAN IPL TERKONFIRMASI*\n\n• No. Rumah: *${targetNorm}*\n• Nominal Masuk: *Rp ${data.nominal.toLocaleString('id-ID')}*\n• Status Tagihan: *${updateRes.status}*`;
                                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                            } else {
                                await sock.sendMessage(remoteJid, { text: `❌ Nomor rumah *${targetNorm}* tidak ditemukan di data Google Sheets!` }, { quoted: msg });
                            }
                        } finally {
                            activeHouseLocks.delete(targetNorm);
                        }

                    } catch (err) {
                        writeLog(`❌ OCR Processing Error: ${err.message}`);
                        await sock.sendMessage(remoteJid, { text: `⚠️ Gagal memproses gambar: ${err.message}. Pastikan gambar yang dikirim jelas.` }, { quoted: msg });
                    }
                });
            }

            // -----------------------------------------------------------------
            // B. COMMAND HANDLERS (Teks Pesan)
            // -----------------------------------------------------------------
            const isAdmin = ADMIN_NUMBERS.includes(senderNumber);

            if (cleanCmd === 'rekening' || cleanCmd === 'bayar') {
                let replyText = await getRekeningInfoFromSheets();

                if (!replyText) {
                    replyText = 
`🏦 *PEMBAYARAN IPL CLUSTER ACACIA*

Silakan melakukan pembayaran melalui salah satu metode berikut:

*1️⃣ Transfer Bank*

🏦 Bank : Mandiri
👤 A/N : GALUH SUGIYANTI
💳 No. Rekening :
1840006586760

━━━━━━━━━━━━━━━━━━━━━━

*2️⃣ Virtual Account (VA)*

Bank Mandiri Virtual Account

Format VA:
85485 + Nomor Rumah + 0

Contoh:
• Rumah A01 → 85485A010
• Rumah B12 → 85485B120
• Rumah C105 → 85485C1050

━━━━━━━━━━━━━━━━━━━━━━

📌 Setelah melakukan pembayaran, mohon kirim bukti transfer dengan mengetik:

*.konfirmasi*

atau kirim foto bukti transfer ke bot.

Terima kasih 🙏`;
                }

                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
            } 
            else if (cleanCmd === 'tunggakan' || cleanCmd === 'cek') {
                try {
                    writeLog(`🔍 Memproses command !tunggakan dari ${senderNumber}`);
                    const penunggak = await getPenunggakFromSheets();
                    
                    if (!penunggak || penunggak.length === 0) {
                        await sock.sendMessage(remoteJid, { text: "🎉 *LUNAS SEMUA!* Semua warga telah melunasi IPL." }, { quoted: msg });
                    } else {
                        let teks = `📊 *DAFTAR BELUM BAYAR IPL (${penunggak.length} Rumah)*\n\n`;
                        
                        penunggak.forEach((w, i) => {
                            const namaWarga = w.nama || "Warga";
                            const noRumah = w.no_rumah || "-";
                            const nominalFormatted = typeof w.total_tunggakan === 'number' 
                                ? w.total_tunggakan.toLocaleString('id-ID') 
                                : "0";

                            teks += `${i + 1}. *${noRumah}* (${namaWarga}) - Rp ${nominalFormatted}\n`;
                        });

                        await sock.sendMessage(remoteJid, { text: teks }, { quoted: msg });
                    }
                } catch (err) {
                    writeLog(`❌ ERROR COMMAND TUNGGAKAN: ${err.stack || err.message}`);
                    await sock.sendMessage(remoteJid, { 
                        text: `⚠️ Gagal membaca data tunggakan. Mohon pastikan file *credentials.json* ada di folder bot dan tab nama sheet *'${WARGA_SHEET}'* sudah sesuai.` 
                    }, { quoted: msg });
                }
            }
            else if (cleanCmd === 'konfirmasi') {
                await sock.sendMessage(remoteJid, { text: "📸 Silakan *kirimkan foto/gambar bukti transfer* ke chat ini. Bot akan secara otomatis membaca dan memproses konfirmasi pembayaran Anda." }, { quoted: msg });
            }
            else if (cleanCmd === 'status') {
                if (!isAdmin) return;
                await sock.sendMessage(remoteJid, { text: `🤖 *SYSTEM STATUS*\n• Connected: ${isConnectedToWA}\n• Queue Size: ${ocrQueueInstance.size}\n• Active Locks: ${activeHouseLocks.size}` }, { quoted: msg });
            }
            else if (cleanCmd === 'menu' || cleanCmd === 'help') {
                await sock.sendMessage(remoteJid, { text: `🤖 *BOT KAS CLUSTER ACACIA*\n\nPerintah yang tersedia:\n• *.bayar* / *.rekening* : Informasi nomor rekening & VA\n• *.cek* / *.tunggakan* : Cek daftar tagihan warga\n• *.konfirmasi* : Panduan konfirmasi pembayaran\n• *Kirim Foto Struk* : Konfirmasi otomatis via AI` }, { quoted: msg });
            }
        });

    } catch (err) {
        writeLog(`❌ Fatal Error di initAndStart: ${err.message}`);
        isReconnecting = false;
    }
}

// -------------------------------------------------------------------------
// C. GRACEFUL SHUTDOWN HANDLER
// -------------------------------------------------------------------------
const handleShutdown = async (signal) => {
    writeLog(`⚠️ Signal ${signal} diterima. Memulai Graceful Shutdown...`);
    
    ocrQueueInstance.clear();

    if (sock) {
        try { sock.end(undefined); } catch (e) {}
    }

    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
        writeLog("✅ SQLite Database closed cleanly.");
    } catch (e) {
        writeLog(`❌ Error closing DB: ${e.message}`);
    }

    process.exit(0);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

initAndStart();
