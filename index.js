const { Client, LocalAuth } = require('whatsapp-web.js');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const qrcode = require('qrcode');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TARGET_GROUP = process.env.GROUP_NAME;

let lastQR = null;

// Simple web server to show QR code in browser
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
        res.end('<h2>✅ WhatsApp already connected! No QR needed.</h2>');
    }
}).listen(process.env.PORT || 3000);

const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', qr => {
    lastQR = qr;
    console.log('QR ready — open the app URL in your browser to scan');
});

client.on('ready', () => {
    lastQR = null;
    console.log('✅ Bot connected and watching the group!');
});

client.on('message_create', async (message) => {
    const chat = await message.getChat();
    if (!chat.isGroup || chat.name !== TARGET_GROUP) return;
    if (!message.hasMedia) return;

    const media = await message.downloadMedia();
    if (!media.mimetype.startsWith('image/')) return;

    console.log('📷 ECG image received — analyzing...');

    try {
        const response = await anthropic.messages.create({
            model: 'claude-opus-4-5',
            max_tokens: 10,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: media.mimetype,
                            data: media.data
                        }
                    },
                    {
                        type: 'text',
                        text: 'This is an ECG graph. Is the recording good quality and complete enough to read? Reply with only one word: "Correct" if good quality, or "Repeat" if it needs to be retaken.'
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