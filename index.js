const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const qrcode = require('qrcode');
const pino = require('pino');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TARGET_GROUP = process.env.GROUP_NAME;

let lastQR = null;

// Simple web server to show QR
http.createServer(async (req, res) => {
    if (lastQR) {
        const imgData = await qrcode.toDataURL(lastQR);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="text-align:center;font-family:sans-serif">
            <h2>Scan with WhatsApp</h2>
            <img src="${imgData}" />
            <p>Refresh page if QR expired</p>
        </body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif;text-align:center">✅ WhatsApp Connected!</h2>');
    }
}).listen(process.env.PORT || 3000);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            lastQR = qr;
            console.log('QR ready — open the app URL in your browser to scan');
        }
        if (connection === 'open') {
            lastQR = null;
            console.log('✅ Bot connected and watching the group!');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const message of messages) {
            try {
                // Skip if no message or if it's from me
                if (!message.message || message.key.fromMe) return;

                // Get group name
                const jid = message.key.remoteJid;
                if (!jid.endsWith('@g.us')) return; // only groups

                const groupMeta = await sock.groupMetadata(jid);
                const groupName = groupMeta.subject;

                console.log('Message from group:', groupName, '| target:', TARGET_GROUP);

                if (groupName !== TARGET_GROUP) return;

                // Check for PDF
                const msg = message.message;
                const docMsg = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage;

                if (!docMsg) return;
                if (!docMsg.mimetype?.includes('pdf')) return;

                console.log('📄 ECG PDF received — analyzing...');

                // Download the PDF
                const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                const buffer = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });

                const base64Data = buffer.toString('base64');

                const response = await anthropic.messages.create({
                    model: 'claude-opus-4-5',
                    max_tokens: 300,
                    messages: [{
                        role: 'user',
                        content: [
                            {
                                type: 'document',
                                source: {
                                    type: 'base64',
                                    media_type: 'application/pdf',
                                    data: base64Data
                                }
                            },
                            {
                                type: 'text',
                                text: `You are an ECG quality checker. Analyze this ECG recording for technical quality only (not clinical diagnosis).

If the ECG is good quality and readable, reply with exactly:
Correct

If the ECG has quality issues, reply with exactly:
Repeat
Issues found: [list the specific problems, e.g. lead detachment, poor contact, muscle noise, baseline wander, missing leads]
Action needed: [specific instructions for the technician, e.g. "Re-apply gel on chest leads V1-V4", "Ask patient to relax and breathe normally", "Check and re-attach lead aVL", "Clean skin before reapplying electrodes"]

Be concise and practical. Only mention what needs to be fixed.`
                            }
                        ]
                    }]
                });

                const reply = response.content[0].text.trim();
                console.log('✅ Replied:', reply);

                await sock.sendMessage(jid, { text: reply }, { quoted: message });

            } catch (err) {
                console.error('Err
