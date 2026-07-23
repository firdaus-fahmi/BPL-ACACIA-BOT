require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const cron = require('node-cron');
const pino = require('pino');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const retry = require('async-retry');

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

// Status global untuk monitoring health check (Poin 9)
let isConnectedToWA = false;
let ocrQueueInstance = null;

// Lock In-Memory untuk Mencegah Race Condition per Rumah (Poin 5)
const activeHouseLocks = new Set();

// =========================================================================
// 2. PERSISTENCE DATABASE (SQLITE WITH WAL MODE) & LOGGING (Poin 2)
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

// SQLite + Optimasi WAL Mode (Write-Ahead Logging) (Poin 2)
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

// Clean-up Memory/DB otomatis
cron.schedule('0 3 * * *', () => {
    db.prepare("DELETE FROM processed_hashes WHERE processed_at < datetime('now', '-30 days')").run();
    writeLog("🧹 Housekeeping: Cleaned old hash entries from SQLite.");
});

// Backup SQLite Aman dengan WAL Checkpoint (Poin 8)
function performDatabaseBackup() {
    try {
        db.pragma('wal_checkpoint(TRUNCATE)'); // Pastikan data WAL di-flush ke DB utama
        const backupPath = path.join(__dirname, 'logs', `backup-db-${new Date().toISOString().split('T')[0]}.db`);
        fs.copyFileSync(path.join(__dirname, 'bot_data.db'), backupPath);
        writeLog("💾 Local SQLite Backup Completed Successfully.");
    } catch (err) {
        writeLog(`❌ Backup Failed: ${err.message}`);
    }
}
cron.schedule('0 2 * * *', performDatabaseBackup);

// =========================================================================
// 3. GOOGLE API & RETRY MECHANISM LENGKAP (Poin 3)
// =========================================================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash"});
const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Retry Google Sheets API dengan Exponential Backoff untuk 429, 500, 503 (Poin 3)
async function fetchSheetsWithRetry(fn) {
    return await retry(async (bail) => {
        try {
            return await fn();
        } catch (err) {
            const status = err.code || err.status || (err.response && err.response.status);
            if (status === 404 || status === 400 || status === 401) {
                bail(err); // Fatal error, jangan retry
                return;
            }
            writeLog(`⚠️ Google API Error (${status || err.message}). Retrying...`);
            throw err; // Lempar error untuk di-retry otomatis
        }
    }, {
        retries: 4,
        minTimeout: 1000,
        factor: 2
    });
}

// =========================================================================
// 4. HELPER LOGIKA BISNIS & VALIDASI OCR BERBASIS ATURAN (Poin 4, 6)
// =========================================================================

function normalizeHouseNumber(raw) {
    if (!raw) return "";
    let clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const match = clean.match(/^([A-Z]+)(\d{2})(\d{2})$/);
    if (match) return `${match[1]} ${match[2]}-${match[3]}`;
    return raw.toUpperCase().trim();
}

// Validasi OCR Berbasis Aturan/Rule-Based Validation (Poin 4 - Pengganti Confidence AI)
function validateOCRData(data, rawText) {
    if (!data || !data.no_rumah || !data.nominal) {
        return { valid: false, reason: "Data tidak lengkap" };
    }

    const normHouse = normalizeHouseNumber(data.no_rumah);
    // 1. Cek Pola Nomor Rumah (Contoh: CA 03-02 atau Blok/Nomor)
    const isValidHousePattern = /^[A-Z]+\s?\d{2}-\d{2}$|^[A-Z0-9\/\-]{3,10}$/.test(normHouse);
    if (!isValidHousePattern) {
        return { valid: false, reason: "Format nomor rumah tidak valid" };
    }

    // 2. Cek Kata Kunci Pembayaran pada Teks Hasil OCR Gemini
    const upperRaw = rawText.toUpperCase();
    const keywords = ["TRANSFER", "BERHASIL", "SUKSES", "BCA", "MANDIRI", "BRI", "BNI", "SELESAI", "TOTAL", "PAYMENT"];
    const hasKeyword = keywords.some(kw => upperRaw.includes(kw));

    if (!hasKeyword) {
        return { valid: false, reason: "Struk tidak memiliki kata kunci transaksi valid" };
    }

    return { valid: true, normalizedHouse: normHouse };
}

async function getPenunggakFromSheets() {
    return await fetchSheetsWithRetry(async () => {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "'2026 ALL'!A2:E1000",
        });

        const rows = res.data.values || [];
        return rows.filter(row => row[3] && row[3].toUpperCase() !== 'LUNAS').map(row => ({
            no_rumah: normalizeHouseNumber(row[0]),
            nama: row[1],
            no_hp: row[2] ? row[2].replace(/[^0-9]/g, '') : '',
            status: row[3],
            total_tunggakan: parseInt(row[4] || "0")
        }));
    });
}

// Transaction Logging termasuk Kolom RAW Response Gemini (Poin 6)
async function processPaymentAndLog(noRumah, nominal, sender, imageHash, rawGeminiText) {
    return await fetchSheetsWithRetry(async () => {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "'2026 ALL'!A2:E1000",
        });

        const rows = res.data.values || [];
        let rowIndex = -1;
        let currentSisaTagihan = 0;
        const targetNorm = normalizeHouseNumber(noRumah);

        for (let i = 0; i < rows.length; i++) {
            if (rows[i][0] && normalizeHouseNumber(rows[i][0]) === targetNorm) {
                rowIndex = i + 2;
                currentSisaTagihan = parseInt(rows[i][4] || rows[i][3] || "210000");
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

        // Update Sheet Utama
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'2026 ALL'!D${rowIndex}:E${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[newStatus, newSisa]] },
        });

        // Append Audit Log + Teks RAW Gemini (Poin 6)
        const dateStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: "'HISTORI_PEMBAYARAN'!A:G",
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
// 5. SERVER EXPRESS & HEALTH CHECK MONITORING (Poin 9)
// =========================================================================
const app = express();

app.get('/', (req, res) => res.send('🤖 Bot WhatsApp Cluster Acacia Active!'));

// Endpoint Health Check untuk Monitoring / Uptime Robot (Poin 9)
app.get('/health', (req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        connected: isConnectedToWA,
        queueLength: ocrQueueInstance ? ocrQueueInstance.size : 0,
        timestamp: new Date().toISOString()
    });
});

app.listen(process.env.PORT || 10000);

// =========================================================================
// 6. MAIN BOT INIT & WHATSAPP CONNECTION (SINGLETON & SAFE RECONNECT)
// =========================================================================

// Destructuring fungsi Baileys tambahan
const { fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

// Variabel Global Singleton Socket
let sock = null;
let isReconnecting = false;

async function initAndStart() {
    // 1. Inisialisasi PQueue secara aman sekali saja
    if (!ocrQueueInstance) {
        const { default: PQueue } = await import('p-queue');
        ocrQueueInstance = new PQueue({ concurrency: 1 });
    }

    // 2. Cegah Pembuatan Socket Ganda jika sedang dalam proses reconnect
    if (isReconnecting) return;
    isReconnecting = true;

    try {
        // Membersihkan instance socket lama jika ada
        if (sock) {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.ev.removeAllListeners('messages.upsert');
            try { sock.end(undefined); } catch (e) {}
            sock = null;
        }

        // Ambil versi WA Web terbaru otomatis
        const { version, isLatest } = await fetchLatestBaileysVersion();
        writeLog(`🔄 Menggunakan Baileys v${version.join('.')}` + (isLatest ? ' (Terbaru)' : ''));

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        // Inisialisasi Socket Baru
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        sock.ev.on('creds.update', saveCreds);

        // Management Connection Event
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                isConnectedToWA = false;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                writeLog(`⚠️ Koneksi terputus (Status Code: ${statusCode || 'Unknown'}). Reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    // Beri jeda 5 detik sebelum reconnect agar server WA tidak throttling
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

        // Request Pairing Code HANYA jika akun belum terdaftar
        if (!sock.authState.creds.registered) {
            await delay(5000); // Waktu tunggu agar socket stabil
            try {
                const cleanBotNumber = BOT_NUMBER.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(cleanBotNumber);
                writeLog(`🔑 KODE PAIRING WHATSAPP: ${code}`);
            } catch (err) {
                writeLog(`❌ Gagal request pairing code: ${err.message}`);
            }
        }

        // Handling Incoming Messages
        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const remoteJid = msg.key.remoteJid;
            const senderJid = msg.key.participant || remoteJid;
            const senderNumber = senderJid.replace(/[^0-9]/g, '');
            const msgText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

            // -----------------------------------------------------------------
            // A. OCR ENGINE (Dengan Race Condition Locking & Rule Validation)
            // -----------------------------------------------------------------
            if (msg.message.imageMessage) {
                const now = Date.now();
                const coolRow = db.prepare("SELECT last_upload FROM user_cooldowns WHERE sender_id = ?").get(senderJid);
                if (coolRow && (now - coolRow.last_upload < 10000)) {
                    await sock.sendMessage(remoteJid, { text: "⏳ Mohon tunggu 10 detik sebelum mengunggah bukti berikutnya." }, { quoted: msg });
                    return;
                }
                db.prepare("INSERT OR REPLACE INTO user_cooldowns (sender_id, last_upload) VALUES (?, ?)").run(senderJid, now);

                ocrQueueInstance.add(async () => {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const imageHash = crypto.createHash('sha256').update(buffer).digest('hex');

                        const dupCheck = db.prepare("SELECT hash FROM processed_hashes WHERE hash = ?").get(imageHash);
                        if (dupCheck) {
                            await sock.sendMessage(remoteJid, { text: "⚠️ Bukti transfer ini sudah pernah diproses sebelumnya!" }, { quoted: msg });
                            return;
                        }

                        const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
                        const prompt = `Ekstrak data dari struk ini. Balas HANYA JSON valid: {"no_rumah": "CA 03-02", "nominal": 210000}. Jika tidak ada set null.`;

                        const result = await model.generateContent([prompt, { inlineData: { data: buffer.toString("base64"), mimeType } }]);
                        const rawGeminiText = result.response.text();
                        const jsonMatch = rawGeminiText.match(/\{[\s\S]*\}/);
                        
                        if (!jsonMatch) throw new Error("JSON tidak ditemukan pada respon AI");
                        const data = JSON.parse(jsonMatch[0]);

                        const ocrVal = validateOCRData(data, rawGeminiText);
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
                            if (data.nominal < 10000 || data.nominal > 10000000) {
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
                    }
                });
            }

            // -----------------------------------------------------------------
            // B. COMMANDS & ADMIN RESTRICTIONS
            // -----------------------------------------------------------------
            const cmd = msgText.toLowerCase();
            const isAdmin = ADMIN_NUMBERS.includes(senderNumber);

            if (cmd === '!rekening' || cmd === '!bayar') {
                await sock.sendMessage(remoteJid, { text: `💳 *REKENING KAS CLUSTER ACACIA*\n\n• Bank: *BCA*\n• No. Rekening: *1234-5678-90*\n• A.N: *Kas Cluster Acacia*` }, { quoted: msg });
            } 
            else if (cmd === '!tunggakan' || cmd === '!cek') {
                const penunggak = await getPenunggakFromSheets();
                if (penunggak.length === 0) {
                    await sock.sendMessage(remoteJid, { text: "🎉 *LUNAS SEMUA!* Semua warga telah melunasi IPL." }, { quoted: msg });
                } else {
                    let teks = `📊 *DAFTAR UNPAID IPL (${penunggak.length} Rumah)*\n\n`;
                    penunggak.slice(0, 30).forEach((w, i) => {
                        teks += `${i + 1}. *${w.nama}* (${w.no_rumah}) - Rp ${w.total_tunggakan.toLocaleString('id-ID')}\n`;
                    });
                    await sock.sendMessage(remoteJid, { text: teks }, { quoted: msg });
                }
            }
            else if (cmd === '!status') {
                if (!isAdmin) return;
                await sock.sendMessage(remoteJid, { text: `🤖 *SYSTEM STATUS*\n• Connected: ${isConnectedToWA}\n• Queue Size: ${ocrQueueInstance.size}\n• Active Locks: ${activeHouseLocks.size}` }, { quoted: msg });
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
    
    if (ocrQueueInstance) {
        ocrQueueInstance.clear();
    }

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

// Jalankan bot
initAndStart();
