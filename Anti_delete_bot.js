const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    getContentType,
    normalizeMessageContent,
    aesDecryptGCM,
    hmacSign,
    jidNormalizedUser,
    proto
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');

const botSentMessageIds = new Set();

// ==========================================
// CONFIGURATION & CREDENTIAL MANAGEMENT
// ==========================================
const ENV_PATH = path.join(__dirname, '.env');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const MEDIA_DIR = path.join(__dirname, 'media');
const AUTH_DIR = path.join(__dirname, 'auth_info');

// Native .env parser (zero-dependency, cross-platform)
function loadEnvFile() {
    try {
        if (fs.existsSync(ENV_PATH)) {
            const content = fs.readFileSync(ENV_PATH, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx !== -1) {
                    const key = trimmed.substring(0, eqIdx).trim();
                    let val = trimmed.substring(eqIdx + 1).trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1);
                    }
                    if (!process.env[key]) {
                        process.env[key] = val;
                    }
                }
            }
        }
    } catch (e) {
        console.error('[ENV] Failed loading .env file:', e.message);
    }
}

loadEnvFile();

function loadConfig() {
    let cfg = {
        admins: [process.env.ADMIN_NUMBER?.trim() || "923238522260"],
        telegram: {
            enabled: process.env.TELEGRAM_ENABLED !== 'false',
            botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
            channelId: process.env.TELEGRAM_CHANNEL_ID?.trim() || ""
        },
        settings: {
            resendDelayMs: parseInt(process.env.RESEND_DELAY_MS, 10) || 3000,
            cacheTtlMs: parseInt(process.env.CACHE_TTL_MS, 10) || 172800000,
            webPort: parseInt(process.env.PORT, 10) || 3000
        }
    };

    // Optional legacy fallback if .env does not specify credentials and config.json exists
    if (!process.env.TELEGRAM_BOT_TOKEN && fs.existsSync(CONFIG_PATH)) {
        try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            cfg = { ...cfg, ...parsed };
        } catch (err) {
            console.error('[CONFIG] Failed reading config.json:', err.message);
        }
    }

    return cfg;
}

const config = loadConfig();

function cleanMediaDir() {
    try {
        if (!fs.existsSync(MEDIA_DIR)) {
            fs.mkdirSync(MEDIA_DIR, { recursive: true });
            return;
        }
        const files = fs.readdirSync(MEDIA_DIR);
        for (const file of files) {
            const fullPath = path.join(MEDIA_DIR, file);
            try {
                if (fs.statSync(fullPath).isFile()) fs.unlinkSync(fullPath);
            } catch (e) {}
        }
    } catch (err) {
        console.error('[STORAGE] Error cleaning media directory:', err.message);
    }
}

function safeUnlink(filePath) {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}
}

cleanMediaDir();
safeUnlink(path.join(__dirname, 'test_vo.js'));

// In-memory forensics stores
const messageStore = new Map();
const activeDownloads = new Map();
const logger = P({ level: 'silent' });

let isConnected = false;

// Periodic cleanup of cache exceeding TTL
function purgeExpiredCache() {
    const now = Date.now();
    const ttl = config.settings.cacheTtlMs || 172800000;
    for (const [id, data] of messageStore) {
        if (now - data.timestamp > ttl) {
            safeUnlink(data.localPath);
            messageStore.delete(id);
            activeDownloads.delete(id);
        }
    }
}
setInterval(purgeExpiredCache, 120000);

// ==========================================
// TELEGRAM CLOUD ARCHIVE ENGINE (0 MB DISK)
// ==========================================
function isTelegramConfigured() {
    return Boolean(
        config.telegram &&
        config.telegram.enabled &&
        config.telegram.botToken &&
        config.telegram.channelId
    );
}

function uploadToTelegram(buffer, fileName, caption = '') {
    return new Promise((resolve) => {
        if (!isTelegramConfigured()) return resolve(null);

        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        const botToken = config.telegram.botToken.trim();
        const chatId = config.telegram.channelId.trim();

        const postDataHeader = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
            `${chatId}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="caption"\r\n\r\n` +
            `${caption.substring(0, 1000)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="document"; filename="${fileName}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
        );

        const postDataFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
        const totalLength = postDataHeader.length + buffer.length + postDataFooter.length;

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${botToken}/sendDocument`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': totalLength
            },
            timeout: 25000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok && json.result?.document?.file_id) {
                        resolve(json.result.document.file_id);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });

        req.write(postDataHeader);
        req.write(buffer);
        req.write(postDataFooter);
        req.end();
    });
}

function downloadFromTelegram(fileId) {
    return new Promise((resolve) => {
        if (!isTelegramConfigured() || !fileId) return resolve(null);

        const botToken = config.telegram.botToken.trim();
        const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;

        https.get(getFileUrl, { timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.ok || !json.result?.file_path) return resolve(null);

                    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${json.result.file_path}`;
                    https.get(downloadUrl, { timeout: 30000 }, (dlRes) => {
                        const chunks = [];
                        dlRes.on('data', c => chunks.push(c));
                        dlRes.on('end', () => resolve(Buffer.concat(chunks)));
                        dlRes.on('error', () => resolve(null));
                    }).on('error', () => resolve(null));
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

function sendTextToTelegram(content) {
    if (!isTelegramConfigured() || !content) return Promise.resolve(null);
    return new Promise((resolve) => {
        const botToken = config.telegram.botToken.trim();
        const chatId = config.telegram.channelId.trim();
        const postData = JSON.stringify({
            chat_id: chatId,
            text: content.substring(0, 4000)
        });

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 10000
        };

        const req = https.request(options, (res) => {
            let d = '';
            res.on('data', chunk => { d += chunk; });
            res.on('end', () => resolve(null));
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });

        req.write(postData);
        req.end();
    });
}

// ==========================================
// LIGHTWEIGHT HEALTH SERVER (ZERO SECRETS LEAKED)
// ==========================================
const app = express();

app.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        cachedCount: messageStore.size
    });
});

const PORT = config.settings.webPort || process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[HTTP] Keep-alive service running on port ${PORT}`);
});

// ==========================================
// PARSERS & CRYPTOGRAPHIC HELPERS
// ==========================================
function normalizeNumber(jid) {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function isAdmin(jid) {
    const num = normalizeNumber(jid);
    return config.admins.some(admin => normalizeNumber(admin) === num);
}

function getTextMessage(msg) {
    if (!msg) return '';
    if (typeof msg === 'string') return msg;
    if (typeof msg.text === 'string') return msg.text;
    if (typeof msg.conversation === 'string') return msg.conversation;

    let m = msg.message || msg;
    if (typeof m === 'string') return m;
    if (typeof m.conversation === 'string') return m.conversation;
    if (typeof m.text === 'string') return m.text;

    // Check protocol edits and future-proof message wrappers
    if (m.protocolMessage?.editedMessage) {
        const txt = getTextMessage(m.protocolMessage.editedMessage);
        if (txt) return txt;
    }
    if (m.editedMessage) {
        const txt = getTextMessage(m.editedMessage);
        if (txt) return txt;
    }
    if (m.deviceSentMessage?.message) {
        const txt = getTextMessage(m.deviceSentMessage.message);
        if (txt) return txt;
    }
    if (m.ephemeralMessage?.message) {
        const txt = getTextMessage(m.ephemeralMessage.message);
        if (txt) return txt;
    }
    if (m.viewOnceMessage?.message) {
        const txt = getTextMessage(m.viewOnceMessage.message);
        if (txt) return txt;
    }
    if (m.viewOnceMessageV2?.message) {
        const txt = getTextMessage(m.viewOnceMessageV2.message);
        if (txt) return txt;
    }

    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;

    // Fallback inspection of fields
    const type = getContentType(m);
    if (type && m[type]) {
        const content = m[type];
        if (typeof content === 'string') return content;
        if (typeof content.text === 'string') return content.text;
        if (typeof content.caption === 'string') return content.caption;
        if (typeof content.conversation === 'string') return content.conversation;
        if (typeof content === 'object') {
            const nested = getTextMessage(content);
            if (nested) return nested;
        }
    }

    return '';
}

function findDeletedId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.protocolMessage && (obj.protocolMessage.type === 0 || obj.protocolMessage.type === 5)) {
        return obj.protocolMessage.key?.id;
    }
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const result = findDeletedId(obj[key]);
            if (result) return result;
        }
    }
    return null;
}


// Decrypt Modern WhatsApp SecretEncryptedMessage edits
function decryptSecretEncryptedEdit(secretEncMsg, originalStored, rawMsg = null) {
    try {
        const { encPayload, encIv, targetMessageKey } = secretEncMsg;
        const targetId = targetMessageKey?.id;
        if (!targetId || !encPayload || !encIv) return null;

        const rawOriginal = originalStored?.rawMsg || originalStored?.msg;
        const secret = rawOriginal?.message?.messageContextInfo?.messageSecret 
            || rawOriginal?.messageContextInfo?.messageSecret;

        if (!secret) {
            console.log(`[ANTI-EDIT] Target ${targetId} lacks messageSecret in cache.`);
            return null;
        }

        const candidateSenders = new Set();
        const addCandidate = (val) => {
            if (!val || typeof val !== 'string') return;
            candidateSenders.add(val);
            try {
                const norm = jidNormalizedUser(val);
                if (norm) candidateSenders.add(norm);
            } catch (e) {}
            if (val.includes(':')) {
                const stripped = val.split(':')[0] + (val.includes('@') ? '@' + val.split('@')[1] : '');
                candidateSenders.add(stripped);
            }
        };

        addCandidate(originalStored.sender);
        addCandidate(targetMessageKey.participant);
        addCandidate(rawMsg?.key?.participant);
        addCandidate(rawMsg?.key?.remoteJid);
        addCandidate(targetMessageKey.remoteJid);

        const toBinary = (txt) => Buffer.from(txt || '');
        const key = hmacSign(secret, new Uint8Array(32));

        for (const candidate of candidateSenders) {
            const senderBuf = toBinary(candidate);
            const sign = Buffer.concat([
                toBinary(targetId),
                senderBuf,
                senderBuf,
                toBinary('Message Edit'),
                new Uint8Array([1])
            ]);

            try {
                const decKey = hmacSign(sign, key);
                let decrypted = null;
                try {
                    decrypted = aesDecryptGCM(encPayload, decKey, encIv, Buffer.alloc(0));
                } catch (e) {}

                if (!decrypted) {
                    try {
                        decrypted = aesDecryptGCM(encPayload, decKey, encIv, toBinary(`${targetId}\u0000${candidate}`));
                    } catch (e) {}
                }

                if (decrypted) {
                    const msg = proto.Message.decode(decrypted);
                    if (msg) {
                        console.log(`[ANTI-EDIT] Successfully decrypted edit payload using candidate: ${candidate}`);
                        return msg;
                    }
                }
            } catch (e) {}
        }

        console.log(`[ANTI-EDIT] Decryption pending or signature mismatch for target: ${targetId}`);
        return null;
    } catch (err) {
        console.error('[ANTI-EDIT] Decryption error:', err.message);
        return null;
    }
}

// Recursive parser for standard protocol message edits
function findEditedMessage(obj, parentKeyId = null) {
    if (!obj || typeof obj !== 'object') return null;

    const currentKeyId = obj.key?.id || parentKeyId;

    if (obj.update?.message?.editedMessage) {
        return {
            targetId: currentKeyId,
            editedMessage: obj.update.message.editedMessage.message || obj.update.message.editedMessage
        };
    }

    if (obj.protocolMessage && (obj.protocolMessage.editedMessage || obj.protocolMessage.type === 14 || obj.protocolMessage.type === 'MESSAGE_EDIT')) {
        return {
            targetId: obj.protocolMessage.key?.id || currentKeyId,
            editedMessage: obj.protocolMessage.editedMessage?.message || obj.protocolMessage.editedMessage
        };
    }

    if (obj.editedMessage) {
        return {
            targetId: currentKeyId || obj.protocolMessage?.key?.id,
            editedMessage: obj.editedMessage.message || obj.editedMessage
        };
    }

    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                const result = findEditedMessage(obj[key], currentKeyId);
                if (result && result.targetId && result.editedMessage) return result;
            }
        }
    }
    return null;
}

// ==========================================
// FEATURE 1: ANTI-EDIT (COMPARISON ENGINE)
// ==========================================
async function handleEditedNotification(sock, jid, targetId, editedMessageObj, explicitNewText = null) {
    if (!targetId) return;

    console.log(`[ANTI-EDIT] Processing edit for target ID: ${targetId}`);

    const stored = messageStore.get(targetId);
    if (!stored) {
        console.log(`[ANTI-EDIT] Target ${targetId} not in cache (message sent prior to bot online or expired).`);
        return;
    }

    const originalText = stored.lastKnownText || getTextMessage(stored.msg);
    let newText = explicitNewText;

    if (!newText && editedMessageObj) {
        newText = getTextMessage(editedMessageObj.protocolMessage?.editedMessage)
            || getTextMessage(editedMessageObj.editedMessage)
            || getTextMessage(editedMessageObj.message)
            || getTextMessage(editedMessageObj);
    }

    console.log(`[ANTI-EDIT] Target: ${targetId} | Original: "${originalText}" | New: "${newText || '[Decryption Pending]'}"`);

    if (originalText) {
        const senderNumber = normalizeNumber(stored.sender);
        let notice = `[EDITED MESSAGE DETECTED]\n`;
        notice += `Sent By: @${senderNumber}\n`;
        notice += `Original: "${originalText}"\n`;
        if (newText && newText !== '[Decryption Pending]' && newText !== originalText) {
            notice += `Edited To: "${newText}"\n`;
        } else {
            notice += `Status: Message was edited by sender\n`;
        }
        notice += `Time: ${new Date().toLocaleTimeString()}`;

        const destJid = stored.originJid || jid;
        try {
            const sent = await sock.sendMessage(destJid, {
                text: notice,
                mentions: [stored.sender]
            });
            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
            console.log(`[ANTI-EDIT] Reposted edit comparison for ${senderNumber} in ${destJid}`);

            // Update stored text and lastKnownText so sequential edits compare against newest version
            if (newText && newText !== '[Decryption Pending]') {
                stored.lastKnownText = newText;
                stored.msg = { message: { conversation: newText } };
            }

            if (isTelegramConfigured()) {
                sendTextToTelegram(`[WA EDITED MESSAGE]\nUser: @${senderNumber}\nChat: ${destJid}\nOriginal: "${originalText}"\nEdited To: "${newText || '[Encrypted]'}"`);
            }
        } catch (e) {
            console.error('[ANTI-EDIT] Failed to send edit alert:', e.message);
        }
    }
}

// ==========================================
// FEATURE 2: ANTI-DELETE (RECOVERY ENGINE)
// ==========================================
async function downloadMediaMessageDirect(mediaMsg, type) {
    try {
        const stream = await downloadContentFromMessage(mediaMsg, type);
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    } catch (e) {
        return null;
    }
}

async function resendDeletedMessage(sock, stored, deletedBy) {
    const { msg, rawMsg, sender, originJid, messageType, isPrivateChat } = stored;
    const messageId = rawMsg?.key?.id;
    const senderNumber = normalizeNumber(sender);
    const deleterNumber = normalizeNumber(deletedBy);
    const mentionedJids = [...new Set([sender, deletedBy])];

    let header = `[ANTI-DELETE ALERT]\n`;
    header += `Sent By: @${senderNumber}\n`;
    header += `Deleted By: @${deleterNumber}\n`;
    header += `Type: ${messageType ? messageType.replace('Message', '') : 'Text'}\n`;
    header += `Time: ${new Date().toLocaleTimeString()}\n`;
    header += `------------------------\n`;

    const targetJid = isPrivateChat
        ? (normalizeNumber(config.admins[0]) + '@s.whatsapp.net')
        : originJid;

    let resolvedBuffer = null;

    // 1. Check in-flight download lock
    if (activeDownloads.has(messageId)) {
        try {
            resolvedBuffer = await activeDownloads.get(messageId);
        } catch (e) {}
    }

    // 2. Fetch from Telegram Cloud if archived
    if (!resolvedBuffer && stored.telegramFileId) {
        try {
            resolvedBuffer = await downloadFromTelegram(stored.telegramFileId);
        } catch (e) {}
    }

    // 3. Fallback to direct stream download if raw media payload exists
    if (!resolvedBuffer && msg?.message) {
        const inner = msg.message[messageType];
        if (inner && inner.mediaKey) {
            const streamType = messageType.replace('Message', '').toLowerCase();
            resolvedBuffer = await downloadMediaMessageDirect(inner, streamType);
        }
    }

    try {
        let sent = null;
        if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
            const text = getTextMessage(msg) || '[Empty message]';
            sent = await sock.sendMessage(targetJid, {
                text: `${header}Message: "${text}"`,
                mentions: mentionedJids
            });
        } else if (messageType === 'imageMessage' && resolvedBuffer) {
            const caption = msg.message?.imageMessage?.caption;
            sent = await sock.sendMessage(targetJid, {
                image: resolvedBuffer,
                caption: `${header}${caption ? `Caption: "${caption}"` : ''}`,
                mentions: mentionedJids
            });
        } else if (messageType === 'videoMessage' && resolvedBuffer) {
            const caption = msg.message?.videoMessage?.caption;
            sent = await sock.sendMessage(targetJid, {
                video: resolvedBuffer,
                caption: `${header}${caption ? `Caption: "${caption}"` : ''}`,
                mentions: mentionedJids
            });
        } else if (messageType === 'audioMessage' && resolvedBuffer) {
            const noteSent = await sock.sendMessage(targetJid, {
                text: `${header}[Voice / Audio Message Below]`,
                mentions: mentionedJids
            });
            if (noteSent?.key?.id) botSentMessageIds.add(noteSent.key.id);

            sent = await sock.sendMessage(targetJid, {
                audio: resolvedBuffer,
                mimetype: msg.message?.audioMessage?.mimetype || 'audio/mpeg',
                ptt: msg.message?.audioMessage?.ptt || false
            });
        } else if (messageType === 'documentMessage' && resolvedBuffer) {
            sent = await sock.sendMessage(targetJid, {
                document: resolvedBuffer,
                fileName: msg.message?.documentMessage?.fileName || 'document',
                caption: header,
                mentions: mentionedJids
            });
        } else if (messageType === 'stickerMessage' && resolvedBuffer) {
            const noteSent = await sock.sendMessage(targetJid, {
                text: `${header}[Sticker Below]`,
                mentions: mentionedJids
            });
            if (noteSent?.key?.id) botSentMessageIds.add(noteSent.key.id);

            sent = await sock.sendMessage(targetJid, { sticker: resolvedBuffer });
        } else {
            const fallbackText = getTextMessage(msg) || `[Unrecoverable ${messageType}]`;
            sent = await sock.sendMessage(targetJid, {
                text: `${header}Content: "${fallbackText}"`,
                mentions: mentionedJids
            });
        }
        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
        console.log(`[ANTI-DELETE] Recovered message from ${senderNumber} resent to ${targetJid}`);
    } catch (err) {
        console.error('[ANTI-DELETE] Resend error:', err.message);
    } finally {
        activeDownloads.delete(messageId);
    }
}

// ==========================================
// BOT ENGINE & CORE EVENT DISPATCHER
// ==========================================
async function startBot() {
    console.log('\n==========================================');
    console.log('   WHATSAPP PRO BOT (FOCUSED DUAL-CORE)   ');
    console.log('   1. Anti-Delete                         ');
    console.log('   2. Anti-Edit                           ');
    console.log('==========================================\n');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        auth: state,
        logger: logger,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        retryRequestDelayMs: 2000,
        syncFullHistory: false,
        getMessage: async (key) => {
            const stored = messageStore.get(key.id);
            return stored?.msg?.message || undefined;
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            console.log('[AUTH] Connecting to WhatsApp...');
        }

        if (connection === 'open') {
            isConnected = true;
            console.log('\n[CONNECTED] WhatsApp Pro Bot is online.');
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode
                : null;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log('[AUTH] Connection dropped. Reconnecting in 3s...');
                setTimeout(() => startBot(), 3000);
            } else {
                console.log('[AUTH] Logged out. Session expired.');
                process.exit(1);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Messages Upsert Listener
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const rawMsg of messages) {
            if (!rawMsg?.key || !rawMsg.key.remoteJid) continue;

            const jid = rawMsg.key.remoteJid;
            if (jid === 'status@broadcast') continue;

            // Prevent reacting to bot's own alerts
            if (botSentMessageIds.has(rawMsg.key.id)) continue;

            const textContent = getTextMessage(rawMsg);
            if (textContent && (
                textContent.startsWith('[ANTI-DELETE ALERT]') ||
                textContent.startsWith('[EDITED MESSAGE DETECTED]') ||
                textContent.startsWith('=== BOT SYSTEM STATUS')
            )) {
                continue;
            }

            const isGroup = jid.endsWith('@g.us');
            const isPrivate = !isGroup;
            const sender = rawMsg.key.fromMe
                ? (sock.user?.id || rawMsg.key.participant || jid)
                : (rawMsg.key.participant || rawMsg.key.remoteJid || jid);
            const senderNumber = normalizeNumber(sender);
            const messageId = rawMsg.key.id;

            console.log(`[INBOUND] Type: ${type} | ID: ${messageId} | Sender: ${senderNumber} | Chat: ${jid}`);

            // 1. Admin Command Handling (/status only)
            if (textContent && textContent.trim().startsWith('/')) {
                const cmd = textContent.trim().split(/\s+/)[0].toLowerCase();
                if (cmd === '/status' && isAdmin(sender)) {
                    const uptime = Math.floor(process.uptime());
                    const h = Math.floor(uptime / 3600);
                    const m = Math.floor((uptime % 3600) / 60);
                    const s = uptime % 60;
                    const ram = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

                    let statusText = `=== BOT SYSTEM STATUS ===\n`;
                    statusText += `Uptime: ${h}h ${m}m ${s}s\n`;
                    statusText += `RAM: ${ram} MB\n`;
                    statusText += `Telegram Cloud: ${isTelegramConfigured() ? 'ACTIVE' : 'OFFLINE'}\n`;
                    statusText += `Cached Messages: ${messageStore.size}\n`;
                    statusText += `=========================`;

                    const replyJid = rawMsg.key.fromMe ? (rawMsg.key.remoteJid || jid) : jid;
                    const sentStatus = await sock.sendMessage(replyJid, { text: statusText });
                    if (sentStatus?.key?.id) botSentMessageIds.add(sentStatus.key.id);
                    continue;
                }
            }

            // 2. Anti-Edit Check: SecretEncryptedMessage (Modern WhatsApp Edits)
            const secretEnc = rawMsg.message?.secretEncryptedMessage;
            if (secretEnc && secretEnc.targetMessageKey?.id) {
                const targetId = secretEnc.targetMessageKey.id;
                console.log(`[ANTI-EDIT] Detected SecretEncrypted edit targeting ID: ${targetId}`);

                const stored = messageStore.get(targetId);
                if (stored) {
                    let newText = null;
                    const decoded = decryptSecretEncryptedEdit(secretEnc, stored, rawMsg);
                    if (decoded) {
                        newText = getTextMessage(decoded.protocolMessage?.editedMessage)
                            || getTextMessage(decoded.editedMessage)
                            || getTextMessage({ message: decoded })
                            || getTextMessage(decoded);
                    }
                    await handleEditedNotification(sock, jid, targetId, decoded || secretEnc, newText);
                } else {
                    console.log(`[ANTI-EDIT] Target ${targetId} not in cache.`);
                }
                continue;
            }

            // 4. Anti-Edit Check: Protocol Message Edits
            const editInUpsert = findEditedMessage(rawMsg);
            if (editInUpsert && editInUpsert.targetId) {
                await handleEditedNotification(sock, jid, editInUpsert.targetId, editInUpsert.editedMessage);
                continue;
            }

            // 5. Anti-Delete Check: Revocation in Upsert
            const deletedIdInUpsert = findDeletedId(rawMsg);
            if (deletedIdInUpsert) {
                const stored = messageStore.get(deletedIdInUpsert);
                if (stored && !stored.resent) {
                    stored.resent = true;
                    const deletedBy = rawMsg.key.participant || stored.sender;
                    setTimeout(async () => {
                        await resendDeletedMessage(sock, stored, deletedBy);
                    }, config.settings.resendDelayMs);
                }
                continue;
            }

            // 6. Cache Regular Message for Forensics
            const messageType = getContentType(rawMsg.message);
            if (!messageType || messageType === 'protocolMessage') continue;

            // In-flight media download & Telegram archival
            const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
            if (mediaTypes.includes(messageType)) {
                const inner = rawMsg.message[messageType];
                if (inner && inner.mediaKey) {
                    const streamType = messageType.replace('Message', '').toLowerCase();
                    const dlPromise = downloadMediaMessageDirect(inner, streamType).then(async (buf) => {
                        if (buf) {
                            const ext = streamType === 'image' ? 'jpg' : (streamType === 'video' ? 'mp4' : 'mp3');
                            const fileId = await uploadToTelegram(buf, `del_${messageId}.${ext}`, `WA_${messageId}`);
                            const existing = messageStore.get(messageId);
                            if (existing) existing.telegramFileId = fileId;
                        }
                        return buf;
                    });
                    activeDownloads.set(messageId, dlPromise);
                }
            }

            messageStore.set(messageId, {
                msg: rawMsg,
                rawMsg: rawMsg,
                sender,
                originJid: jid,
                messageType,
                telegramFileId: null,
                timestamp: Date.now(),
                isPrivateChat: isPrivate,
                resent: false
            });

            console.log(`[CACHE] Stored ${messageType.replace('Message', '')} (${messageId}) from ${senderNumber} in ${jid}`);

            // Archive plain text to Telegram Cloud
            if (textContent && isTelegramConfigured()) {
                sendTextToTelegram(`[WA ${isGroup ? 'GROUP' : 'DM'}] From: @${senderNumber}\nMsg: ${textContent}`).catch(() => {});
            }
        }
    });

    // Messages Update Listener (Anti-Delete & Anti-Edit updates)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            // Check for message revocation
            const deletedId = findDeletedId(update);
            if (deletedId) {
                const stored = messageStore.get(deletedId);
                if (stored && !stored.resent) {
                    stored.resent = true;
                    const deletedBy = update.key?.participant || stored.sender;
                    console.log(`[ANTI-DELETE] Detected deletion for msg ID: ${deletedId}`);
                    setTimeout(async () => {
                        await resendDeletedMessage(sock, stored, deletedBy);
                    }, config.settings.resendDelayMs);
                    continue;
                }
            }

            // Check for SecretEncryptedMessage in update
            const secretEncInUpdate = update.update?.message?.secretEncryptedMessage 
                || update.message?.secretEncryptedMessage;
            if (secretEncInUpdate && secretEncInUpdate.targetMessageKey?.id) {
                const targetId = secretEncInUpdate.targetMessageKey.id;
                console.log(`[ANTI-EDIT] Detected SecretEncrypted edit in update targeting ID: ${targetId}`);
                const stored = messageStore.get(targetId);
                if (stored) {
                    let newText = null;
                    const decoded = decryptSecretEncryptedEdit(secretEncInUpdate, stored, update);
                    if (decoded) {
                        newText = getTextMessage(decoded.protocolMessage?.editedMessage)
                            || getTextMessage(decoded.editedMessage)
                            || getTextMessage({ message: decoded })
                            || getTextMessage(decoded);
                    }
                    await handleEditedNotification(sock, update.key?.remoteJid, targetId, decoded || secretEncInUpdate, newText);
                }
                continue;
            }

            // Check for standard Baileys edit updates
            const editData = findEditedMessage(update);
            if (editData && editData.targetId) {
                await handleEditedNotification(sock, update.key?.remoteJid, editData.targetId, editData.editedMessage);
            }
        }
    });
}

process.on('SIGINT', () => {
    cleanMediaDir();
    process.exit(0);
});
process.on('SIGTERM', () => {
    cleanMediaDir();
    process.exit(0);
});
process.on('uncaughtException', (err) => console.error('[FATAL EXCEPTION]', err.message));
process.on('unhandledRejection', (err) => console.error('[FATAL REJECTION]', err));

startBot();
