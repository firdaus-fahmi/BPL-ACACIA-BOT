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
// 4. HELPER & NORMALISASI NOMOR RUMAH
// =========================================================================

function normalizeHouseVariants(rawInput) {
    if (!rawInput) return [];
    let clean = rawInput.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
    
    const setVariants = new Set();
    setVariants.add(clean);

    const match4Digits = clean.match(/^([A-Z]+)(\d{2})(\d{2})$/);
    if (match4Digits) {
        const prefix = match4Digits[1];
        const num1 = parseInt(match4Digits[2], 10).toString();
        const num2 = parseInt(match4Digits[3], 10).toString();

        setVariants.add(`${prefix}${num1}/${num2}`);
        setVariants.add(`${prefix} ${num1}/${num2}`);
        setVariants.add(`${prefix}${num1}/${match4Digits[3]}`);
        setVariants.add(`${prefix} ${num1}/${match4Digits[3]}`);
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

function generateMonthList(bulanText, totalBulan, targetRowData = null) {
    if (bulanText.includes('-')) {
        const parts = bulanText.split('-').map(b => b.trim().toUpperCase());
        const startIdx = LIST_BULAN.findIndex(b => b.startsWith(parts[0].substring(0, 3)));
        const endIdx = LIST_BULAN.findIndex(b => b.startsWith(parts[1].substring(0, 3)));

        if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
            return LIST_BULAN.slice(startIdx, endIdx + 1);
        }
    }

    const single = bulanText.trim().toUpperCase();
    const foundIdx = LIST_BULAN.findIndex(b => b.startsWith(single.substring(0, 3)));

    if (foundIdx !== -1) {
        if (totalBulan > 1 && targetRowData) {
            const result = [];
            for (let i = foundIdx; i < LIST_BULAN.length && result.length < totalBulan; i++) {
                const m = LIST_BULAN[i];
                const config = MONTH_COLUMN_MAP[m];
                const hasDate = targetRowData[config.tglIdx] && targetRowData[config.tglIdx].toString().trim() !== "";
                const hasNominal = targetRowData[config.nomIdx] && targetRowData[config.nomIdx].toString().trim() !== "";

                if (!hasDate && !hasNominal) {
                    result.push(m);
                }
            }
            if (result.length > 0) return result;
        }
        return LIST_BULAN.slice(foundIdx, foundIdx + totalBulan);
    }

    return LIST_BULAN.slice(0, totalBulan);
}

// -------------------------------------------------------------------------
// FITUR 1: CEK TAGIHAN (!cektagihan <no_rumah>)
// -------------------------------------------------------------------------
async function checkTagihanWarga(noRumah) {
    return await fetchSheetsWithRetry(async () => {
        const variants = normalizeHouseVariants(noRumah);

        try {
            const resTunggakan = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `'${TUNGGAKAN_SHEET}'!A4:J500`,
            });

            const rowsTunggakan = resTunggakan.data.values || [];

            for (let i = 0; i < rowsTunggakan.length; i++) {
                const cellRumah = rowsTunggakan[i][2];
                
                if (cellRumah && matchesHouse(cellRumah, variants)) {
                    const houseDisplay = cellRumah.toString().trim();
                    const namaPemilik = rowsTunggakan[i][3] || '-';
                    
                    const rawNominalJ = rowsTunggakan[i][9] || "0"; 
                    const cleanNominalStr = rawNominalJ.toString().split(',')[0].replace(/[^0-9]/g, '');
                    const totalTunggakanNominal = parseInt(cleanNominalStr, 10) || 0;

                    const rawBulanG = rowsTunggakan[i][6] || "0";
                    let totalBulanTunggakan = parseInt(rawBulanG.toString().replace(/[^0-9]/g, ''), 10);

                    if (isNaN(totalBulanTunggakan) || totalBulanTunggakan <= 0) {
                        totalBulanTunggakan = Math.round(totalTunggakanNominal / NOMINAL_IURAN_PER_BULAN);
                    }

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

// -------------------------------------------------------------------------
// FITUR 2: DAFTAR HUTANG KHUSUS RT 3 (!hutang)
// -------------------------------------------------------------------------
async function getDaftarHutangRT3() {
    return await fetchSheetsWithRetry(async () => {
        const resTunggakan = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${TUNGGAKAN_SHEET}'!A4:J500`,
        });

        const rows = resTunggakan.data.values || [];
        const listTunggakan = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length < 3) continue;

            const rtValue = (row[1] || "").toString().trim().replace(/[^0-9]/g, '');
            
            if (rtValue === "3" || rtValue === "03") {
                const noRumah = (row[2] || "-").toString().trim();
                const namaPemilik = (row[3] || "-").toString().trim();
                
                const rawNominalJ = row[9] || "0"; 
                const cleanNominalStr = rawNominalJ.toString().split(',')[0].replace(/[^0-9]/g, '');
                const totalTunggakanNominal = parseInt(cleanNominalStr, 10) || 0;

                if (totalTunggakanNominal > 0) {
                    listTunggakan.push({
                        noRumah,
                        namaPemilik,
                        totalAmount: totalTunggakanNominal
                    });
                }
            }
        }

        return listTunggakan;
    });
}

// -------------------------------------------------------------------------
// FITUR 3: PROSES PEMBAYARAN MANUAL
// -------------------------------------------------------------------------
async function processManualPayment(noRumah, bulanText, nominal, senderNumber) {
    return await fetchSheetsWithRetry(async () => {
        const variants = normalizeHouseVariants(noRumah);

        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${WARGA_SHEET}'!A5:AB1000`,
        });

        const rows = res.data.values || [];
        let rowIndex = -1;
        let houseDisplayInSheet = noRumah.toUpperCase();
        let targetRowData = null;

        for (let i = 0; i < rows.length; i++) {
            if (!rows[i] || !rows[i][2]) continue;
            if (matchesHouse(rows[i][2], variants)) {
                rowIndex = i + 5; 
                houseDisplayInSheet = rows[i][2].toString().trim();
                targetRowData = rows[i];
                break;
            }
        }

        if (rowIndex === -1) {
            return { success: false, reason: `Rumah '${noRumah}' tidak ditemukan di Sheet '${WARGA_SHEET}'.` };
        }

        const totalBulanDibayar = Math.floor(nominal / NOMINAL_IURAN_PER_BULAN) || 1;
        const targetMonths = generateMonthList(bulanText, totalBulanDibayar, targetRowData);

        const unpaidMonthsToProcess = [];
        const alreadyPaidMonths = [];

        targetMonths.forEach(m => {
            const config = MONTH_COLUMN_MAP[m];
            const hasDate = targetRowData[config.tglIdx] && targetRowData[config.tglIdx].toString().trim() !== "";
            const hasNominal = targetRowData[config.nomIdx] && targetRowData[config.nomIdx].toString().trim() !== "";

            if (hasDate || hasNominal) {
                alreadyPaidMonths.push(m);
            } else {
                unpaidMonthsToProcess.push(m);
            }
        });

        const today = new Date();
        const dd = String(today.getDate()).padStart(2, '0');
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const yyyy = today.getFullYear();
        const formattedDate = `${dd}/${mm}/${yyyy}`;

        const updateBatch = [];
        const historyRows = [];
        const dateLogStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        unpaidMonthsToProcess.forEach(monthName => {
            const colConfig = MONTH_COLUMN_MAP[monthName];
            if (colConfig) {
                updateBatch.push({
                    range: `'${WARGA_SHEET}'!${colConfig.tglCol}${rowIndex}`,
                    values: [[formattedDate]]
                });
                updateBatch.push({
                    range: `'${WARGA_SHEET}'!${colConfig.nomCol}${rowIndex}`,
                    values: [[NOMINAL_IURAN_PER_BULAN]]
                });
            }
            historyRows.push([dateLogStr, houseDisplayInSheet, monthName, NOMINAL_IURAN_PER_BULAN, senderNumber, "MANUAL_INPUT", "LUNAS"]);
        });

        if (updateBatch.length > 0) {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    valueInputOption: 'USER_ENTERED',
                    data: updateBatch
                }
            });

            try {
                await sheets.spreadsheets.values.append({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `'${HISTORI_SHEET}'!A:G`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: historyRows }
                });
            } catch (e) {
                writeLog(`⚠️ Histori log error: ${e.message}`);
            }
        }

        const requiredAmount = unpaidMonthsToProcess.length * NOMINAL_IURAN_PER_BULAN;
        const overpaymentAmount = nominal - requiredAmount;

        return { 
            success: true, 
            normalizedHouse: houseDisplayInSheet, 
            processedMonths: unpaidMonthsToProcess,
            alreadyPaidMonths: alreadyPaidMonths,
            totalProcessedMonths: unpaidMonthsToProcess.length,
            paymentDate: formattedDate,
            overpaymentAmount: overpaymentAmount > 0 ? overpaymentAmount : 0,
            hasOverpayment: overpaymentAmount > 0
        };
    });
}

// =========================================================================
// 5. SERVER EXPRESS & WHATSAPP CONNECTION
// =========================================================================
const app = express();
app.get('/', (req, res) => res.send('🤖 Bot WA Kas Cluster Active!'));
app.listen(process.env.PORT || 10000);

let sock = null;
let isReconnecting = false;

async function notifyAdmins(messageText) {
    for (const adminNum of ADMIN_NUMBERS) {
        try {
            const adminJid = `${adminNum}@s.whatsapp.net`;
            await sock.sendMessage(adminJid, { text: messageText });
        } catch (err) {
            writeLog(`⚠️ Gagal mengirim notifikasi admin ke ${adminNum}: ${err.message}`);
        }
    }
}

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
            const isGroup = remoteJid.endsWith('@g.us');
            const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid;
            const senderNumber = senderJid.replace(/[^0-9]/g, '');

            const msgText = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption || 
                ''
            ).trim();

            if (remoteJid === 'status@broadcast' || !msgText) return;

            const cleanCmd = msgText.toLowerCase().replace(/^[!.\s]+/, '').trim();

            // -----------------------------------------------------------------
            // COMMAND !konfirmasi ATAU .konfirmasi
            // -----------------------------------------------------------------
            if (cleanCmd === 'konfirmasi') {
                const konfirmasiText = 
`📝 *CARA KONFIRMASI PEMBAYARAN IPL*

Untuk melakukan konfirmasi pembayaran, silakan kirimkan pesan dengan format berikut:

👉 *<No_Rumah> <Bulan> <Nominal>*

*Contoh:*
\`CA0309 Februari 210000\`
\`CA1712 Januari-Maret 630000\`

---
💡 *Catatan:*
• Pastikan format spasi sesuai contoh.
• Bot akan secara otomatis mencatat pembayaran ke sistem dan memperbarui data tagihan Anda.
• Jika Anda menyertakan foto bukti transfer, pastikan memasukkan format teks di atas pada *caption* foto.

Terima kasih atas partisipasinya! 🙏`;

                await sock.sendMessage(remoteJid, { text: konfirmasiText }, { quoted: msg });
                return;
            }

            // -----------------------------------------------------------------
            // COMMAND !rekening
            // -----------------------------------------------------------------
            if (cleanCmd === 'rekening') {
                const rekeningText = 
`🏦 *PEMBAYARAN IPL CLUSTER ACACIA*

Silakan melakukan pembayaran melalui salah satu metode berikut:

*Virtual Account (VA)*

*Bank Mandiri Virtual Account*

Format VA:
\`85485 + Nomor Rumah + 0\`

Contoh:
• Rumah CA1712 → \`8548517120\`
• Rumah CA0203 → \`8548502030\`
• Rumah CA1810 → \`8548518100\`

1. Untuk pembayaran melalui channel *livin by mandiri* bisa dipilih : menu bayar - search "*Balai Pengelola Lingkungan Acacia*" atau nomor biller - klik - Bayar

2. Untuk pembayaran *non Bank Mandiri* : login ke mobile banking - pilih transfer - bank tujuan Bank Mandiri - no rek diisi sesuai dengan nomor VA - isi nominal pembayaran sesuai dengan tagihan yaitu Rp210.000 - submit - pin mobile banking - selesai
━━━━━━━━━━━━━━━━━━━━━━

📌 Setelah melakukan pembayaran, mohon kirim bukti transfer dengan mengetik:

*.konfirmasi*

atau kirim foto bukti transfer ke bot.

Terima kasih 🙏`;

                await sock.sendMessage(remoteJid, { text: rekeningText }, { quoted: msg });
                return;
            }

            // -----------------------------------------------------------------
            // COMMAND !hutang (KHUSUS RT 03)
            // -----------------------------------------------------------------
            if (cleanCmd === 'hutang') {
                await sock.sendMessage(remoteJid, { text: `⏳ *Memuat daftar tunggakan khusus RT 03...*` }, { quoted: msg });

                try {
                    const listHutang = await getDaftarHutangRT3();

                    if (listHutang.length === 0) {
                        await sock.sendMessage(remoteJid, { text: `🎉 *Luar Biasa!* Tidak ada daftar tunggakan iuran untuk warga RT 03.` }, { quoted: msg });
                        return;
                    }

                    let messageText = `📌 *DAFTAR TUNGGAKAN IURAN WAKTU/IPL (KHUSUS RT 03)*\n\n`;
                    let grandTotal = 0;

                    listHutang.forEach((item, index) => {
                        grandTotal += item.totalAmount;
                        messageText += `${index + 1}. *${item.namaPemilik}* (${item.noRumah})\n`;
                        messageText += `   └ Tagihan: *Rp ${item.totalAmount.toLocaleString('id-ID')}*\n\n`;
                    });

                    messageText += `━━━━━━━━━━━━━━━━━━━━━━\n`;
                    messageText += `💰 *TOTAL TUNGGAKAN RT 03: Rp ${grandTotal.toLocaleString('id-ID')}*\n\n`;

                    messageText += `*Himbauan Bersama:*\n`;
                    messageText += `_Iuran lingkungan ini adalah amanah bersama demi kenyamanan, kebersihan, dan keamanan lingkungan tempat kita tinggal sehari-hari. Sangat diharapkan kesadaran Bapak/Ibu dalam daftar di atas untuk dapat segera melunasinya. Mohon diingat, fasilitas dan fasilitas lingkungan kita nikmati bersama, alangkah bijaknya jika kewajibannya pun kita tanggung bersama tanpa membiarkan tetangga lainnya berjuang sendiri tiap bulannya._ 🙏\n\n`;
                    
                    messageText += `@all`;

                    await sock.sendMessage(remoteJid, { text: messageText }, { quoted: msg });

                } catch (e) {
                    writeLog(`❌ Hutang Command Error: ${e.message}`);
                    await sock.sendMessage(remoteJid, { text: `⚠️ Gagal mengambil daftar hutang: ${e.message}` }, { quoted: msg });
                }
                return;
            }

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
• Status: *LUNAS TOTAL*

Seluruh iuran IPL tahun ini sudah terbayarkan. Terima kasih! 🙏`;
                            await sock.sendMessage(remoteJid, { text: resMsg }, { quoted: msg });
                        } else {
                            const resMsg = 
`📋 *INFORMASI TAGIHAN IPL*

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

            // -----------------------------------------------------------------
            // FORMAT KONFIRMASI PEMBAYARAN: <No_Rumah> <Bulan> <Nominal>
            // -----------------------------------------------------------------
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

                await sock.sendMessage(remoteJid, { text: "⏳ *Sedang memproses & mengecek status pembayaran...*" }, { quoted: msg });

                try {
                    const result = await processManualPayment(rawNoRumah, bulanText, nominal, senderNumber);

                    if (result.success) {
                        let replyMsg = `✅ *PEMBAYARAN DITERIMA!*\n\n• Rumah: *${result.normalizedHouse}*\n• Tanggal Input: *${result.paymentDate}*`;

                        if (result.totalProcessedMonths > 0) {
                            replyMsg += `\n• Bulan Diperbarui: *${result.processedMonths.join(', ')}* (${result.totalProcessedMonths} Bulan)`;
                        }

                        if (result.alreadyPaidMonths.length > 0) {
                            replyMsg += `\n\n⚠️ *DITEMUKAN BULAN SUDAH DIBAYAR:*`;
                            replyMsg += `\nBulan *${result.alreadyPaidMonths.join(', ')}* tercatat *SUDAH LUNAS* sebelumnya, sehingga tidak diisi ulang.`;
                        }

                        if (result.hasOverpayment) {
                            replyMsg += `\n\n💵 *INFORMASI LEBIH BAYAR:*`;
                            replyMsg += `\n• Nominal Masuk: *Rp ${nominal.toLocaleString('id-ID')}*`;
                            replyMsg += `\n• Nominal Digunakan: *Rp ${(result.totalProcessedMonths * NOMINAL_IURAN_PER_BULAN).toLocaleString('id-ID')}*`;
                            replyMsg += `\n• *Kelebihan Bayar: Rp ${result.overpaymentAmount.toLocaleString('id-ID')}*`;

                            const adminAlert = 
`🔔 *ALERT LEBIH BAYAR (OVERPAYMENT)*
• Rumah: *${result.normalizedHouse}*
• Pengirim WA: *${senderNumber}*
• Kelebihan Dana: *Rp ${result.overpaymentAmount.toLocaleString('id-ID')}*
• Tanggal: *${result.paymentDate}*`;
                            await notifyAdmins(adminAlert);
                        }

                        replyMsg += `\n\n_Data Sheet telah disesuaikan secara otomatis. Terima kasih!_ 🙏`;

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
        });

    } catch (err) {
        writeLog(`❌ Connection Error: ${err.message}`);
        isReconnecting = false;
    }
}

initAndStart();
