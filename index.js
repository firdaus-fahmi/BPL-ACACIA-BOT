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

// Definisi Nama Sheet
const SHEET_WARGA_ALL = '2026 ALL'; // Untuk update pembayaran & cross-check
const SHEET_TUNGGAKAN = 'RT003';    // Khusus untuk pengecekan !tunggakan
const HISTORI_SHEET = process.env.HISTORI_SHEET || 'HISTORI_PEMBAYARAN';

const NOMINAL_IURAN_PER_BULAN = 210000;
let isConnectedToWA = false;

// Mapping Kolom Google Sheets untuk Sheet (Jan s/d Des)
// Kolom C: No Rumah (Index Array: 2)
// Jan: E/F (Idx 4,5) | Feb: G/H (Idx 6,7) | Mar: I/J (Idx 8,9) ... dst.
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
📌 *PETUNJUK BOT:*

1️⃣ *Cek Tunggakan:*
   👉 \`!tunggakan <No_Rumah>\`
   Contoh: \`!tunggakan CA 03-09\`

2️⃣ *Konfirmasi Pembayaran:*
   👉 \`<No_Rumah> <Bulan> <Nominal>\`
   Contoh: \`CA0309 Januari-Desember 2520000\`

Terima kasih 🙏`;
}

// -------------------------------------------------------------------------
// FITUR 1: CEK TUNGGAKAN / TAGIHAN (MENGGUNAKAN SHEET 'RT003')
// -------------------------------------------------------------------------
async function checkTagihanWarga(noRumah) {
    return await fetchSheetsWithRetry(async () => {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${SHEET_TUNGGAKAN}'!A5:AB1000`,
        });

        const rows = res.data.values || [];
        const inputDigits = extractDigits(noRumah);
        let foundRow = null;
        let houseDisplayInSheet = noRumah.toUpperCase();

        for (let i = 0; i < rows.length; i++) {
            if (!rows[i] || !rows[i][2]) continue;
            const sheetDigits = extractDigits(rows[i][2]);
            if (inputDigits && sheetDigits && inputDigits === sheetDigits) {
                foundRow = rows[i];
                houseDisplayInSheet = rows[i][2].toString().trim();
                break;
            }
        }

        if (!foundRow) {
            return { success: false, reason: `Nomor rumah '${noRumah}' tidak ditemukan di Sheet '${SHEET_TUNGGAKAN}'.` };
        }

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
            houseNumber: houseDisplayInSheet,
            unpaidMonths: bulanUnpaid,
            totalMonths: bulanUnpaid.length,
            totalAmount: totalNominal
        };
    });
}

// -------------------------------------------------------------------------
// FITUR 2: PROSES PEMBAYARAN + CROSS CHECK OVERPAYMENT (MENGGUNAKAN SHEET '2026 ALL')
// -------------------------------------------------------------------------
async function processManualPayment(noRumah, bulanText, nominal, senderNumber) {
    return await fetchSheetsWithRetry(async () => {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${SHEET_WARGA_ALL}'!A5:AB1000`,
        });

        const rows = res.data.values || [];
        let rowIndex = -1;
        let houseDisplayInSheet = noRumah.toUpperCase();
        let targetRowData = null;

        const inputDigits = extractDigits(noRumah);

        for (let i = 0; i < rows.length; i++) {
            if (!rows[i] || !rows[i][2]) continue;
            const sheetDigits = extractDigits(rows[i][2]);

            if (inputDigits && sheetDigits && inputDigits === sheetDigits) {
                rowIndex = i + 5; 
                houseDisplayInSheet = rows[i][2].toString().trim();
                targetRowData = rows[i];
                break;
            }
        }

        if (rowIndex === -1) {
            return { success: false, reason: `Rumah '${noRumah}' tidak ditemukan di Kolom C Sheet '${SHEET_WARGA_ALL}'.` };
        }

        const totalBulanDibayar = Math.floor(nominal / NOMINAL_IURAN_PER_BULAN) || 1;
        const targetMonths = generateMonthList(bulanText, totalBulanDibayar);

        const unpaidMonthsToProcess = [];
        const alreadyPaidMonths = [];

        // Cross Check Pembayaran
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
                    range: `'${SHEET_WARGA_ALL}'!${colConfig.tglCol}${rowIndex}`,
                    values: [[formattedDate]]
                });
                updateBatch.push({
                    range: `'${SHEET_WARGA_ALL}'!${colConfig.nomCol}${rowIndex}`,
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
                writeLog(`⚠️ Histori log skipped: ${e.message}`);
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

            // -----------------------------------------------------------------
            // COMMAND !tunggakan / !cektagihan / !tagihan (Sheet: RT003)
            // -----------------------------------------------------------------
            if (cleanCmd.startsWith('cektagihan') || cleanCmd.startsWith('tunggakan') || cleanCmd.startsWith('tagihan')) {
                const args = msgText
                    .replace(/^[!.\s]*(cektagihan|tunggakan|tagihan)/i, '')
                    .trim();

                if (!args) {
                    await sock.sendMessage(remoteJid, { 
                        text: `⚠️ *Format Salah!*\n\nGunakan format:\n👉 *!tunggakan <No_Rumah>*\n\nContoh:\n\`!tunggakan CA 03-09\`\n\`!tunggakan CA0309\`` 
                    }, { quoted: msg });
                    return;
                }

                await sock.sendMessage(remoteJid, { text: `⏳ *Memeriksa data tunggakan untuk ${args} pada Sheet RT003...*` }, { quoted: msg });

                try {
                    const tagihan = await checkTagihanWarga(args);

                    if (tagihan.success) {
                        if (tagihan.totalMonths === 0) {
                            const resMsg = 
`🎉 *INFORMASI TUNGGAKAN IPL (RT003)*

• Rumah: *${tagihan.houseNumber}*
• Status: *LUNAS TOTAL (12 Bulan)*

Seluruh iuran IPL tahun 2026 sudah terbayarkan. Tidak ada tunggakan. Terima kasih! 🙏`;
                            await sock.sendMessage(remoteJid, { text: resMsg }, { quoted: msg });
                        } else {
                            const resMsg = 
`📋 *INFORMASI TUNGGAKAN IPL 2026 (RT003)*

• Rumah: *${tagihan.houseNumber}*
• Total Tunggakan: *${tagihan.totalMonths} Bulan*
• Rincian Bulan: *${tagihan.unpaidMonths.join(', ')}*
• Total Nominal: *Rp ${tagihan.totalAmount.toLocaleString('id-ID')}*

━━━━━━━━━━━━━━━━━━━━━━
💳 Pembayaran dapat dilakukan via VA Mandiri (85485 + No Rumah + 0) dan lakukan konfirmasi setelah transfer. Terima kasih! 🙏`;
                            await sock.sendMessage(remoteJid, { text: resMsg }, { quoted: msg });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ ${tagihan.reason}` }, { quoted: msg });
                    }
                } catch (e) {
                    writeLog(`❌ Cek Tagihan Error: ${e.message}`);
                    await sock.sendMessage(remoteJid, { text: `⚠️ Gagal mengecek tunggakan: ${e.message}` }, { quoted: msg });
                }
                return;
            }

            // -----------------------------------------------------------------
            // FORMAT KONFIRMASI PEMBAYARAN: <No_Rumah> <Bulan> <Nominal> (Sheet: 2026 ALL)
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

                await sock.sendMessage(remoteJid, { text: "⏳ *Sedang memproses & mengecek status pembayaran di Sheet 2026 ALL...*" }, { quoted: msg });

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
                            replyMsg += `\n\n📌 *KONFIRMASI PENGGUNAAN SISA DANA:*`;
                            replyMsg += `\nMohon konfirmasi ke Pengurus/Admin apakah sisa dana *Rp ${result.overpaymentAmount.toLocaleString('id-ID')}* hendak:`;
                            replyMsg += `\n1️⃣ *Dikembalikan (Refund)*`;
                            replyMsg += `\n2️⃣ *Otomatis dialokasikan untuk pembayaran bulan/tahun berikutnya.*`;
                        }

                        replyMsg += `\n\n_Data Sheet '2026 ALL' telah disesuaikan secara otomatis. Terima kasih!_ 🙏`;

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

            if (cleanCmd === 'konfirmasi' || cleanCmd === 'bayar' || cleanCmd === 'rekening') {
                await sock.sendMessage(remoteJid, { text: getDefaultPaymentInfo() }, { quoted: msg });
            }
        });

    } catch (err) {
        writeLog(`❌ Connection Error: ${err.message}`);
        isReconnecting = false;
    }
}

initAndStart();
