const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const qrcode = require('qrcode');
const pino = require('pino');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TARGET_GROUP = process.env.GROUP_NAME;
let lastQR = null;

http.createServer(async (req, res) => {
    if (lastQR) {
        const imgData = await qrcode.toDataURL(lastQR);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="text-align:center;font-family:sans-serif">
            <h2>Scan with WhatsApp</h2>
            <img src="${imgData}" />
            <p>Refresh if expired</p>
        </body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif;text-align:center">✅ WhatsApp Connected!</h2>');
    }
}).listen(process.env.PORT || 3000);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('/app/auth');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            lastQR = qr;
            console.log('QR ready — open the app URL to scan');
        }
        if (connection === 'open') {
            lastQR = null;
            console.log('✅ Bot connected!');
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                console.log('Reconnecting...');
                startBot();
            } else {
                console.log('Logged out. Please scan QR again.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                const jid = msg.key.remoteJid;
                if (!jid.endsWith('@g.us')) continue;

                const groupMeta = await sock.groupMetadata(jid);
                console.log('Message from group:', groupMeta.subject);

                if (groupMeta.subject !== TARGET_GROUP) continue;

                const docMsg = msg.message?.documentMessage ||
                               msg.message?.documentWithCaptionMessage?.message?.documentMessage;

                if (!docMsg) continue;
                if (!docMsg.mimetype?.includes('pdf')) continue;

                console.log('📄 ECG PDF received — analyzing...');

                const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                    reuploadRequest: sock.updateMediaMessage
                });

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
                                text: `You are an ECG quality checker. Analyze this ECG for technical quality only.

If good quality, reply exactly:
Correct

If poor quality, reply exactly:
Repeat
Issues: [list problems e.g. lead detachment, muscle noise, baseline wander]
Fix: [specific instructions e.g. "Re-apply gel on V1-V4", "Ask patient to lie still", "Re-attach left arm lead", "Clean skin and reapply electrodes"]

Be brief and practical.`
                            }
                        ]
                    }]
                });

                const reply = response.content[0].text.trim();
                console.log('✅ Replied:', reply);
await sock.sendMessage(jid, { text: reply });
            } catch (err) {
                console.error('Error:', err.message);
            }
        }
    });
}

startBot();
