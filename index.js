const { Client, LocalAuth } = require('whatsapp-web.js');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const qrcode = require('qrcode');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TARGET_GROUP = process.env.GROUP_NAME;

let lastQR = null;

http.createServer(async (req, res) => {
    if (lastQR) {
        const imgData = await qrcode.toDataURL(lastQR);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="text-align:center">
            <h2>Scan with WhatsApp</h2>
            <img src="${imgData}" />
            <p>Refresh if expired</p>
        </body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>✅ WhatsApp already connected!</h2>');
    }
}).listen(process.env.PORT || 3000);

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', qr => {
    lastQR = qr;
    console.log('QR ready — open the app URL in your browser to scan');
});

client.on('ready', () => {
    lastQR = null;
    console.log('✅ Bot connected and watching the group!');
});

client.on('message', async (message) => {
    const chat = await message.getChat();
    if (!chat.isGroup || chat.name !== TARGET_GROUP) return;
    if (!message.hasMedia) return;

    const media = await message.downloadMedia();

    // Only handle PDFs
console.log('Media received, mimetype:', media.mimetype);
if (!media.mimetype.includes('pdf')) return;
    console.log('📄 ECG PDF received — analyzing...');

    try {
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
                            data: media.data
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
        await message.reply(reply);
        console.log(`✅ Replied: ${reply}`);

    } catch (err) {
        console.error('Error:', err.message);
    }
});

client.initialize();
