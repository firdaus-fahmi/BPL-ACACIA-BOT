const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const cron = require('node-cron');

// =========================================================================
// 1. SERVER EXPRESS (Wajib untuk Render Web Service Gratis)
// =========================================================================
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => res.send('🤖 Bot WhatsApp Cluster Acacia Aktif!'));
app.listen(port, () => console.log(`Server web aktif di port ${port}`));

// =========================================================================
// 2. KONFIGURASI ENVIRONMENT & GOOGLE API
// =========================================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const BOT_NUMBER = process.env.BOT_NUMBER;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function getPenunggakFromSheets() {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "'2026 ALL'!A2:E100", 
        });

        const rows = res.data.values || [];
        const penunggak = [];

        rows.forEach(row => {
            const noRumah = row[0];
            const nama = row[1];
            const noHp = row[2];
            const status = row[3];
            const total = parseInt(row[4] || "210000");

            if (status && status.toUpperCase() !== 'LUNAS') {
                penunggak.push({
                    no_rumah: noRumah,
                    nama: nama,
                    no_hp: noHp ? noHp.replace(/[^0-9]/g, '') : '',
                    total_tunggakan: total
                });
            }
        });
        return penunggak;
    } catch (err) {
        console.error("Error reading Google Sheets:", err);
        return [];
    }
}

async function updateSheetLunas(noRumah) {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "'2026 ALL'!A2:D100",
        });

        const rows = res.data.values || [];
        let rowIndex = -1;

        for (let i = 0; i < rows.length; i++) {
            if (rows[i][0] && rows[i][0].toLowerCase().trim() === noRumah.toLowerCase().trim()) {
                rowIndex = i + 2;
                break;
            }
        }

        if (rowIndex !== -1) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `'2026 ALL'!D${rowIndex}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [['LUNAS']] },
            });
            console.log(`✅ Success updating ${noRumah} to LUNAS`);
            return true;
        }
        return false;
    } catch (err) {
        console.error("Error updating Google Sheets:", err);
        return false;
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        if (!BOT_NUMBER) {
            console.log("❌ ERROR: Variabel BOT_NUMBER belum dimasukkan di Render!");
            return;
        }
        await delay(4000);
        const code = await sock.requestPairingCode(BOT_NUMBER.replace(/[^0-9]/g, ''));
        console.log("\n==================================================");
        console.log(`🔑 KODE PAIRING WHATSAPP ANDA: ${code}`);
        console.log("==================================================\n");
    }

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'close') {
            console.log("⚠️ Koneksi terputus. Menghubungkan ulang...");
            connectToWhatsApp();
        } else if (connection === 'open') {
            console.log("✅ BOT BERHASIL TERHUBUNG KE WHATSAPP!");
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const msgText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

        if (remoteJid.endsWith('@g.us')) {
            console.log(`📌 ID GRUP INI ADALAH: ${remoteJid}`);
        }

        // BUKTI TRANSFER (OCR GEMINI)
        if (msg.message.imageMessage) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const prompt = "Ekstrak informasi dari gambar bukti transfer ini. Balas HANYA dengan format JSON valid: {\"no_rumah\": \"CA 03-02\", \"nominal\": 210000}. Jika nomor rumah tidak ada di gambar set null.";
                const imagePart = { inlineData: { data: buffer.toString("base64"), mimeType: "image/jpeg" } };

                const result = await model.generateContent([prompt, imagePart]);
                const cleanJson = result.response.text().replace(/```json|```/g, "").trim();
                const data = JSON.parse(cleanJson);

                if (data.no_rumah && data.nominal >= 210000) {
                    const isUpdated = await updateSheetLunas(data.no_rumah);
                    if (isUpdated) {
                        await sock.sendMessage(remoteJid, { text: `✅ *PEMBAYARAN IPL TERKONFIRMASI*\n\n• No. Rumah: *${data.no_rumah}*\n• Nominal: *Rp ${data.nominal.toLocaleString('id-ID')}*\n• Status: *LUNAS*\n\nTerima kasih! 🙏` }, { quoted: msg });
                    }
                }
            } catch (err) {
                console.error("Error OCR:", err);
            }
        }

        // COMMANDS
        if (msgText.toLowerCase() === '!rekening' || msgText.toLowerCase() === '!bayar') {
            await sock.sendMessage(remoteJid, { text: `💳 *REKENING PEMBAYARAN IPL*\n\n• Bank: *BCA*\n• No. Rekening: *1234-5678-90*\n• A.N: *Kas Cluster Acacia*` }, { quoted: msg });
        } else if (msgText.toLowerCase() === '!tunggakan' || msgText.toLowerCase() === '!cek') {
            const penunggak = await getPenunggakFromSheets();
            if (penunggak.length === 0) {
                await sock.sendMessage(remoteJid, { text: "🎉 *LUNAS SEMUA!* Semua warga telah melunasi IPL." }, { quoted: msg });
            } else {
                let teks = `📊 *DAFTAR TAGIHAN IPL SAAT INI*\n\n`;
                penunggak.forEach((w, i) => {
                    teks += `${i + 1}. *${w.nama}* (${w.no_rumah}) - Rp ${w.total_tunggakan.toLocaleString('id-ID')}\n`;
                });
                await sock.sendMessage(remoteJid, { text: teks }, { quoted: msg });
            }
        } else if (msgText.toLowerCase() === '!menu' || msgText.toLowerCase() === '!help') {
            await sock.sendMessage(remoteJid, { text: `🤖 *BOT IPL CLUSTER ACACIA*\n\nCommand:\n• *!rekening* : Cek Rekening Kas\n• *!tunggakan* : Cek Daftar Penunggak\n\n💡 Upload foto bukti transfer di grup untuk konfirmasi otomatis.` }, { quoted: msg });
        }
    });

    // CRON JOBS
    cron.schedule('0 9 */3 * *', async () => {
        const penunggak = await getPenunggakFromSheets();
        if (penunggak.length > 0) {
            const targetJid = process.env.GROUP_JID || "120363000000000000@g.us";
            let teks = `📢 *PENGINGAT PEMBAYARAN IPL CLUSTER ACACIA*\n\n`;
            const mentions = [];
            penunggak.forEach((w, index) => {
                teks += `${index + 1}. *${w.nama}* (${w.no_rumah}) - Rp ${w.total_tunggakan.toLocaleString('id-ID')}\n`;
                if (w.no_hp) mentions.push(`${w.no_hp}@s.whatsapp.net`);
            });
            await sock.sendMessage(targetJid, { text: teks, mentions: mentions });
        }
    }, { timezone: "Asia/Jakarta" });
}

connectToWhatsApp();
