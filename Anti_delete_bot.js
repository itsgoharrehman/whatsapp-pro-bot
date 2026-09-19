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
    isJidUser,
    isLidUser,
    proto
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
let qrcode = null;
try {
    qrcode = require('qrcode-terminal');
} catch (e) {}

const botSentMessageIds = new Set();
const processedCommandIds = new Set();
let botStartTime = Date.now();
let botConnectTime = null;

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
let currentQR = null;
let isBotActive = true;
let currentSock = null;
let isTerminating = false;

const EXCLUDE_FILE = path.join(__dirname, 'excluded.json');
const LID_MAP_FILE = path.join(__dirname, 'lid_mappings.json');

const lidToPhoneMap = new Map();
const phoneToLidMap = new Map();

function normalizeNumber(jid) {
    if (!jid) return '';
    if (typeof jid !== 'string') jid = String(jid);
    let base = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (base.startsWith('0') && base.length === 11) {
        base = '92' + base.slice(1);
    }
    return base;
}

function loadLidMappings() {
    try {
        if (fs.existsSync(LID_MAP_FILE)) {
            const raw = fs.readFileSync(LID_MAP_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data && typeof data === 'object') {
                for (const [lid, phone] of Object.entries(data)) {
                    const cleanLid = normalizeNumber(lid);
                    const cleanPhone = normalizeNumber(phone);
                    if (cleanLid && cleanPhone) {
                        lidToPhoneMap.set(cleanLid, cleanPhone);
                        phoneToLidMap.set(cleanPhone, cleanLid);
                    }
                }
            }
        }
    } catch (e) {
        console.error('[LID-MAP] Failed loading lid_mappings.json:', e.message);
    }
}

function saveLidMappings() {
    try {
        const obj = {};
        for (const [lid, phone] of lidToPhoneMap) {
            obj[lid] = phone;
        }
        fs.writeFileSync(LID_MAP_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error('[LID-MAP] Failed saving lid_mappings.json:', e.message);
    }
}

loadLidMappings();

async function syncGroupMetadata(sock, groupJid) {
    if (!sock || !groupJid || !groupJid.endsWith('@g.us')) return;
    try {
        const meta = await sock.groupMetadata(groupJid);
        if (meta && Array.isArray(meta.participants)) {
            let changed = false;
            for (const p of meta.participants) {
                const phone = normalizeNumber(p.jid || (isJidUser(p.id) ? p.id : ''));
                const lid = normalizeNumber(p.lid || (isLidUser(p.id) ? p.id : ''));
                if (phone && lid && phone !== lid) {
                    if (lidToPhoneMap.get(lid) !== phone) {
                        lidToPhoneMap.set(lid, phone);
                        phoneToLidMap.set(phone, lid);
                        changed = true;
                    }
                }
            }
            if (changed) {
                saveLidMappings();
                console.log(`[LID-MAP] Synced ${meta.participants.length} identities from ${groupJid}`);
            }
        }
    } catch (e) {}
}

async function syncAllGroups(sock) {
    if (!sock) return;
    try {
        const groups = await sock.groupFetchAllParticipating();
        let changed = false;
        for (const [gid, meta] of Object.entries(groups)) {
            if (meta && Array.isArray(meta.participants)) {
                for (const p of meta.participants) {
                    const phone = normalizeNumber(p.jid || (isJidUser(p.id) ? p.id : ''));
                    const lid = normalizeNumber(p.lid || (isLidUser(p.id) ? p.id : ''));
                    if (phone && lid && phone !== lid) {
                        if (lidToPhoneMap.get(lid) !== phone) {
                            lidToPhoneMap.set(lid, phone);
                            phoneToLidMap.set(phone, lid);
                            changed = true;
                        }
                    }
                }
            }
        }
        if (changed) {
            saveLidMappings();
            console.log(`[LID-MAP] Mapped ${lidToPhoneMap.size} user identities (LID <-> Phone).`);
        }
    } catch (e) {
        console.log('[LID-MAP] Group sync status:', e.message);
    }
}

function isExcludedNumberMatch(numA, numB) {
    if (!numA || !numB) return false;
    const a = String(numA).replace(/[^0-9]/g, '');
    const b = String(numB).replace(/[^0-9]/g, '');
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 7 && b.length >= 7) {
        if (a.endsWith(b) || b.endsWith(a)) return true;
    }
    return false;
}

function resolveAllIdentifiers(target) {
    if (!target) return [];
    if (typeof target !== 'string') target = String(target);
    const clean = normalizeNumber(target);
    if (!clean) return [];

    const candidates = new Set([clean]);

    const phone = lidToPhoneMap.get(clean);
    if (phone) {
        candidates.add(phone);
        const np = normalizeNumber(phone);
        if (np) candidates.add(np);
    }

    const lid = phoneToLidMap.get(clean);
    if (lid) {
        candidates.add(lid);
        const nl = normalizeNumber(lid);
        if (nl) candidates.add(nl);
    }

    return Array.from(candidates);
}

function loadExcludedNumbers() {
    try {
        if (fs.existsSync(EXCLUDE_FILE)) {
            const raw = fs.readFileSync(EXCLUDE_FILE, 'utf-8');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                return new Set(arr.map(n => normalizeNumber(n)).filter(Boolean));
            }
        }
    } catch (e) {
        console.error('[EXCLUSION] Failed loading excluded.json:', e.message);
    }
    return new Set();
}

const excludedNumbers = loadExcludedNumbers();

function saveExcludedNumbers() {
    try {
        fs.writeFileSync(EXCLUDE_FILE, JSON.stringify(Array.from(excludedNumbers), null, 2));
    } catch (e) {
        console.error('[EXCLUSION] Failed saving excluded.json:', e.message);
    }
}

function isExcluded(target) {
    if (!target) return false;
    const candidates = resolveAllIdentifiers(target);
    for (const cand of candidates) {
        for (const num of excludedNumbers) {
            const exCandidates = resolveAllIdentifiers(num);
            for (const exCand of exCandidates) {
                if (isExcludedNumberMatch(cand, exCand)) return true;
            }
        }
    }
    return false;
}

async function terminateSession() {
    if (isTerminating) return { success: false, message: 'Termination already in progress' };
    isTerminating = true;
    console.log('[AUTH] Terminate session requested via web interface');
    isConnected = false;
    currentQR = null;

    try {
        if (currentSock) {
            try {
                await currentSock.logout();
            } catch (e) {
                console.log('[AUTH] Sock logout:', e.message);
            }
            try {
                currentSock.end();
            } catch (e) {}
            currentSock = null;
        }

        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log('[AUTH] auth_info directory purged successfully');
        }
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch (err) {
        console.error('[AUTH] Session termination error:', err.message);
    } finally {
        isTerminating = false;
    }

    setTimeout(() => {
        console.log('[AUTH] Relaunching bot for fresh pairing sequence...');
        startBot();
    }, 1500);

    return { success: true, message: 'Session terminated and credentials cleared' };
}

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
app.use(express.json());

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

app.get('/api/status', (req, res) => {
    const uptimeSec = Math.floor(process.uptime());
    const ramMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    res.json({
        status: isConnected ? 'online' : (currentQR ? 'pairing' : 'initializing'),
        isConnected,
        hasQR: Boolean(currentQR),
        uptime: formatUptime(uptimeSec),
        uptimeSeconds: uptimeSec,
        ramMb,
        cachedCount: messageStore.size,
        excludedCount: excludedNumbers.size,
        isBotActive
    });
});

app.post('/api/terminate-session', async (req, res) => {
    const result = await terminateSession();
    res.json(result);
});

app.get('/', (req, res) => {
    const uptimeSec = Math.floor(process.uptime());
    const ramMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const uptimeFormatted = formatUptime(uptimeSec);
    const isStateConnected = isConnected;
    const hasStateQR = Boolean(currentQR);

    let statusBadgeHtml = '';
    let contentHtml = '';
    let actionsHtml = '';

    if (isStateConnected) {
        statusBadgeHtml = `<div class="status-badge status-online">Status: Online</div>`;
        contentHtml = `
            <div>
                <h2 class="section-title">Surveillance Active</h2>
                <p class="section-desc">WhatsApp socket connection established. Inbound deleted messages and edited messages are intercepted and reposted in real-time.</p>
            </div>
            <div class="telemetry-grid">
                <div class="telemetry-box">
                    <span class="telemetry-label">Engine</span>
                    <span class="telemetry-value">${isBotActive ? 'ACTIVE' : 'PAUSED'}</span>
                </div>
                <div class="telemetry-box">
                    <span class="telemetry-label">Uptime</span>
                    <span class="telemetry-value" id="valUptime">${uptimeFormatted}</span>
                </div>
                <div class="telemetry-box">
                    <span class="telemetry-label">Memory</span>
                    <span class="telemetry-value" id="valRam">${ramMb} MB</span>
                </div>
                <div class="telemetry-box">
                    <span class="telemetry-label">Cached</span>
                    <span class="telemetry-value" id="valCache">${messageStore.size} msgs</span>
                </div>
            </div>
        `;
        actionsHtml = `
            <div class="actions-bar">
                <span class="action-note">Terminating the session logs out the bot and erases local authentication keys.</span>
                <button type="button" id="terminateBtn" class="btn btn-danger" onclick="executeSessionTermination()">Terminate Session</button>
            </div>
        `;
    } else if (hasStateQR) {
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(currentQR)}`;
        statusBadgeHtml = `<div class="status-badge status-pairing">Status: Pairing Required</div>`;
        contentHtml = `
            <div>
                <h2 class="section-title">Link WhatsApp Device</h2>
                <p class="section-desc">Point your primary WhatsApp camera at the QR code below to connect the bot.</p>
            </div>
            <div class="qr-wrapper">
                <div class="qr-box">
                    <img src="${qrImageUrl}" alt="WhatsApp Pairing QR Code" class="qr-img" />
                </div>
                <ol class="instructions-list">
                    <li>Open WhatsApp on your mobile phone</li>
                    <li>Navigate to Settings &gt; Linked Devices</li>
                    <li>Tap Link a Device and scan the QR code above</li>
                </ol>
            </div>
        `;
        actionsHtml = `
            <div class="actions-bar">
                <span class="action-note">If pairing stalls, you can clear stale keys and generate a clean pairing code.</span>
                <button type="button" id="resetBtn" class="btn btn-secondary" onclick="executeSessionTermination()">Reset Pairing Keys</button>
            </div>
        `;
    } else {
        statusBadgeHtml = `<div class="status-badge status-initializing">Status: Initializing</div>`;
        contentHtml = `
            <div>
                <h2 class="section-title">Initializing Protocol Engine</h2>
                <p class="section-desc">Allocating multi-file cryptographic state and generating handshake keys. This view will update automatically.</p>
            </div>
            <div class="init-box">
                <span class="init-label">Connecting to WhatsApp gateway...</span>
            </div>
        `;
        actionsHtml = `
            <div class="actions-bar">
                <span class="action-note">You can force a clean restart if the engine takes longer than 30 seconds.</span>
                <button type="button" id="resetBtn" class="btn btn-secondary" onclick="executeSessionTermination()">Force Restart</button>
            </div>
        `;
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
    <title>WhatsApp Pro Bot</title>
    <style>
        :root {
            --bg-page: #0b0f17;
            --bg-card: #131b28;
            --bg-subtle: #1c2637;
            --border: #28374d;
            --border-subtle: #1e2a3c;
            --text-main: #f3f6fa;
            --text-muted: #9baac1;
            --text-dim: #65758d;
            --accent-green: #10b981;
            --accent-amber: #f59e0b;
            --accent-blue: #60a5fa;
            --accent-red: #dc2626;
            --accent-red-hover: #b91c1c;
            --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            background-color: var(--bg-page);
            color: var(--text-main);
            font-family: var(--font-sans);
            line-height: 1.5;
            padding: 16px;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
        }
        .container {
            width: 100%;
            max-width: 680px;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        @media (min-width: 640px) {
            body {
                padding: 32px 20px;
            }
            .container {
                gap: 20px;
            }
        }
        .header {
            display: flex;
            flex-direction: column;
            gap: 10px;
            border-bottom: 1px solid var(--border-subtle);
            padding-bottom: 16px;
        }
        @media (min-width: 480px) {
            .header {
                flex-direction: row;
                justify-content: space-between;
                align-items: center;
            }
        }
        .header-title-group {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .title {
            font-size: 1.25rem;
            font-weight: 700;
            letter-spacing: -0.02em;
            color: #ffffff;
        }
        @media (min-width: 640px) {
            .title {
                font-size: 1.5rem;
            }
        }
        .subtitle {
            font-size: 0.8125rem;
            color: var(--text-muted);
            font-family: var(--font-mono);
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            font-family: var(--font-mono);
            font-size: 0.75rem;
            font-weight: 600;
            padding: 5px 12px;
            border-radius: 4px;
            width: fit-content;
            letter-spacing: 0.04em;
        }
        .status-online {
            background-color: rgba(16, 185, 129, 0.12);
            color: #34d399;
            border: 1px solid rgba(16, 185, 129, 0.4);
        }
        .status-pairing {
            background-color: rgba(245, 158, 11, 0.12);
            color: #fbbf24;
            border: 1px solid rgba(245, 158, 11, 0.4);
        }
        .status-initializing {
            background-color: rgba(96, 165, 250, 0.12);
            color: #93c5fd;
            border: 1px solid rgba(96, 165, 250, 0.4);
        }
        .card {
            background-color: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        @media (min-width: 640px) {
            .card {
                padding: 24px;
            }
        }
        .section-title {
            font-size: 1.0625rem;
            font-weight: 600;
            color: #ffffff;
            margin-bottom: 4px;
        }
        .section-desc {
            font-size: 0.875rem;
            color: var(--text-muted);
            line-height: 1.5;
        }
        .telemetry-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
        }
        @media (min-width: 600px) {
            .telemetry-grid {
                grid-template-columns: repeat(4, 1fr);
            }
        }
        .telemetry-box {
            background-color: var(--bg-subtle);
            border: 1px solid var(--border-subtle);
            border-radius: 6px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .telemetry-label {
            font-size: 0.6875rem;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--text-dim);
            font-family: var(--font-mono);
        }
        .telemetry-value {
            font-size: 1.0625rem;
            font-weight: 600;
            color: #ffffff;
            font-family: var(--font-mono);
            word-break: break-all;
        }
        .qr-wrapper {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
            text-align: center;
        }
        .qr-box {
            background-color: #ffffff;
            border-radius: 8px;
            padding: 12px;
            display: inline-block;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            max-width: 100%;
        }
        .qr-img {
            display: block;
            width: 240px;
            height: 240px;
            max-width: 100%;
            object-fit: contain;
        }
        @media (min-width: 480px) {
            .qr-img {
                width: 280px;
                height: 280px;
            }
        }
        .instructions-list {
            text-align: left;
            background-color: var(--bg-subtle);
            border: 1px solid var(--border-subtle);
            border-radius: 6px;
            padding: 14px 18px 14px 34px;
            font-size: 0.8125rem;
            color: var(--text-muted);
            width: 100%;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .instructions-list li {
            padding-left: 4px;
        }
        .init-box {
            background-color: var(--bg-subtle);
            border: 1px solid var(--border-subtle);
            border-radius: 6px;
            padding: 24px;
            text-align: center;
        }
        .init-label {
            font-family: var(--font-mono);
            font-size: 0.875rem;
            color: var(--text-muted);
        }
        .actions-bar {
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding-top: 14px;
            border-top: 1px solid var(--border-subtle);
        }
        @media (min-width: 520px) {
            .actions-bar {
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
            }
        }
        .action-note {
            font-size: 0.75rem;
            color: var(--text-dim);
            line-height: 1.4;
        }
        @media (min-width: 520px) {
            .action-note {
                max-width: 380px;
            }
        }
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-family: var(--font-sans);
            font-size: 0.875rem;
            font-weight: 600;
            padding: 10px 18px;
            min-height: 42px;
            border-radius: 6px;
            cursor: pointer;
            text-decoration: none;
            border: 1px solid transparent;
            white-space: nowrap;
            width: 100%;
            transition: background-color 0.15s ease, border-color 0.15s ease;
        }
        @media (min-width: 520px) {
            .btn {
                width: auto;
            }
        }
        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .btn-danger {
            background-color: var(--accent-red);
            color: #ffffff;
            border-color: #b91c1c;
        }
        .btn-danger:hover:not(:disabled) {
            background-color: var(--accent-red-hover);
        }
        .btn-secondary {
            background-color: var(--bg-subtle);
            color: var(--text-main);
            border-color: var(--border);
        }
        .btn-secondary:hover:not(:disabled) {
            background-color: #26344a;
            border-color: #3b4d6a;
        }
        .footer {
            text-align: center;
            font-size: 0.75rem;
            color: var(--text-dim);
            font-family: var(--font-mono);
        }
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <div class="header-title-group">
                <h1 class="title">WhatsApp Pro Bot</h1>
                <div class="subtitle">Anti-Delete &amp; Anti-Edit System</div>
            </div>
            ${statusBadgeHtml}
        </header>

        <main class="card">
            ${contentHtml}
            ${actionsHtml}
        </main>

        <footer class="footer">
            Endpoint: Port ${PORT} | Mode: Dedicated
        </footer>
    </div>

    <script>
        const initialStatus = "${isStateConnected ? 'online' : (hasStateQR ? 'pairing' : 'initializing')}";
        let isProcessing = false;

        async function executeSessionTermination() {
            if (isProcessing) return;
            const confirmed = window.confirm("Are you sure you want to terminate the WhatsApp session? All stored authentication keys will be cleared and a new QR code will be generated.");
            if (!confirmed) return;

            isProcessing = true;
            const btn = document.getElementById('terminateBtn') || document.getElementById('resetBtn');
            if (btn) {
                btn.disabled = true;
                btn.textContent = "Terminating...";
            }

            try {
                const response = await fetch('/api/terminate-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                const data = await response.json();
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            } catch (err) {
                alert("Termination request error: " + err.message);
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "Terminate Session";
                }
                isProcessing = false;
            }
        }

        setInterval(async () => {
            if (isProcessing) return;
            try {
                const res = await fetch('/api/status');
                if (!res.ok) return;
                const data = await res.json();
                if (data.status !== initialStatus) {
                    window.location.reload();
                } else if (data.status === 'online') {
                    const elUptime = document.getElementById('valUptime');
                    const elRam = document.getElementById('valRam');
                    const elCache = document.getElementById('valCache');
                    if (elUptime) elUptime.textContent = data.uptime;
                    if (elRam) elRam.textContent = data.ramMb + ' MB';
                    if (elCache) elCache.textContent = data.cachedCount + ' msgs';
                }
            } catch (e) {}
        }, 5000);
    </script>
</body>
</html>`);
});

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
function isAdmin(jid) {
    const candidates = resolveAllIdentifiers(jid);
    for (const cand of candidates) {
        if (config.admins.some(admin => isExcludedNumberMatch(normalizeNumber(admin), cand))) {
            return true;
        }
    }
    return false;
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

    if (isExcluded(stored.sender) || isExcluded(stored.originJid) || isExcluded(jid)) {
        console.log(`[EXCLUSION] Suppressed edit notification for excluded target ID: ${targetId}`);
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
    if (!stored) return;
    if (isExcluded(stored.sender) || isExcluded(stored.originJid) || isExcluded(deletedBy)) {
        console.log(`[EXCLUSION] Suppressed resending deleted message from excluded contact.`);
        return;
    }
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

    botStartTime = Date.now();
    if (process.env.CLEAR_AUTH_ON_BOOT === 'true' || process.env.RESET_AUTH === 'true') {
        try {
            if (fs.existsSync(AUTH_DIR)) {
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                console.log('[AUTH] Purged auth_info directory on boot as requested.');
            }
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch (e) {
            console.error('[AUTH] Failed clearing auth_info on boot:', e.message);
        }
    }
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
    currentSock = sock;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('\n==========================================');
            console.log('   SCAN THIS QR CODE IN WHATSAPP');
            console.log('   (Settings > Linked Devices > Link a Device)');
            console.log('==========================================');
            if (qrcode) {
                try {
                    qrcode.generate(qr, { small: true });
                } catch (e) {}
            }
            console.log('[AUTH] QR Code is also viewable in browser at http://localhost:' + PORT + '/\n');
        }

        if (connection === 'connecting') {
            console.log('[AUTH] Connecting to WhatsApp...');
        }

        if (connection === 'open') {
            isConnected = true;
            botConnectTime = Date.now();
            currentQR = null;
            console.log('\n[CONNECTED] WhatsApp Pro Bot is online.');
            syncAllGroups(sock).catch(() => {});
        }

        if (connection === 'close') {
            isConnected = false;
            currentSock = null;

            if (isTerminating) {
                console.log('[AUTH] Connection closed during requested session termination.');
                return;
            }

            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode
                : null;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log('[AUTH] Connection dropped. Reconnecting in 3s...');
                setTimeout(() => startBot(), 3000);
            } else {
                console.log('[AUTH] Session logged out. Purging credentials for fresh pairing...');
                try {
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    fs.mkdirSync(AUTH_DIR, { recursive: true });
                } catch (e) {}
                setTimeout(() => startBot(), 3000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('group-participants.update', async ({ id }) => {
        syncGroupMetadata(sock, id).catch(() => {});
    });

    sock.ev.on('groups.update', async (groups) => {
        for (const g of groups) {
            if (g.id) syncGroupMetadata(sock, g.id).catch(() => {});
        }
    });

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

            if (isGroup && sender && !lidToPhoneMap.has(senderNumber)) {
                syncGroupMetadata(sock, jid).catch(() => {});
            }

            console.log(`[INBOUND] Type: ${type} | ID: ${messageId} | Sender: ${senderNumber} | Chat: ${jid}`);

            // 1. Admin Command Handling
            if (textContent && textContent.trim().startsWith('/')) {
                const parts = textContent.trim().split(/\s+/);
                const cmd = parts[0].toLowerCase();
                const args = parts.slice(1);
                const replyJid = rawMsg.key.fromMe ? (rawMsg.key.remoteJid || jid) : jid;

                // Completely ignore any offline sync or non-live event
                if (type !== 'notify') continue;
                if (!isConnected || !botConnectTime) continue;

                const msgTime = rawMsg.messageTimestamp ? (Number(rawMsg.messageTimestamp) * 1000) : 0;
                // Discard messages sent prior to connection or older than 15 seconds
                if (msgTime < botConnectTime || (Date.now() - msgTime) > 15000) {
                    console.log(`[COMMAND] Ignored stale/buffered command ${cmd}`);
                    continue;
                }

                if (isAdmin(sender)) {
                    if (processedCommandIds.has(messageId)) {
                        console.log(`[COMMAND] Ignored duplicate event for command ${cmd} (${messageId})`);
                        continue;
                    }
                    processedCommandIds.add(messageId);
                    if (cmd === '/status') {
                        const uptime = Math.floor(process.uptime());
                        const h = Math.floor(uptime / 3600);
                        const m = Math.floor((uptime % 3600) / 60);
                        const s = uptime % 60;
                        const ram = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

                        let statusText = `=== BOT SYSTEM STATUS ===\n`;
                        statusText += `Surveillance: ${isBotActive ? 'ACTIVE' : 'PAUSED'}\n`;
                        statusText += `Uptime: ${h}h ${m}m ${s}s\n`;
                        statusText += `RAM: ${ram} MB\n`;
                        statusText += `Telegram Cloud: ${isTelegramConfigured() ? 'ACTIVE' : 'OFFLINE'}\n`;
                        statusText += `Cached Messages: ${messageStore.size}\n`;
                        statusText += `Resend Delay: ${Math.round(config.settings.resendDelayMs / 1000)}s\n`;
                        statusText += `Excluded Numbers: ${excludedNumbers.size}\n`;
                        statusText += `=========================`;

                        const sent = await sock.sendMessage(replyJid, { text: statusText });
                        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        continue;
                    }

                    if (cmd === '/help') {
                        let helpText = `=== BOT COMMANDS ===\n\n`;
                        helpText += `/status - System status\n`;
                        helpText += `/on - Enable surveillance\n`;
                        helpText += `/off - Pause surveillance\n`;
                        helpText += `/delay <seconds> - Set resend delay\n`;
                        helpText += `/exclude <number> - Exclude phone number\n`;
                        helpText += `/unexclude <number> - Remove from exclusion\n`;
                        helpText += `/list - View excluded numbers\n`;
                        helpText += `/clear - Flush cache and storage\n`;
                        helpText += `/help - Display commands\n\n`;
                        helpText += `====================`;

                        const sent = await sock.sendMessage(replyJid, { text: helpText });
                        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        continue;
                    }

                    if (cmd === '/on') {
                        isBotActive = true;
                        const sent = await sock.sendMessage(replyJid, { text: '[STATUS] Surveillance activated.' });
                        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        continue;
                    }

                    if (cmd === '/off') {
                        isBotActive = false;
                        const sent = await sock.sendMessage(replyJid, { text: '[STATUS] Surveillance paused.' });
                        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        continue;
                    }

                    if (cmd === '/delay') {
                        const sec = parseInt(args[0], 10);
                        if (!isNaN(sec) && sec >= 0 && sec <= 300) {
                            config.settings.resendDelayMs = sec * 1000;
                            const sent = await sock.sendMessage(replyJid, { text: `[CONFIG] Resend delay set to ${sec}s.` });
                            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        } else {
                            const sent = await sock.sendMessage(replyJid, { text: '[USAGE] /delay <seconds>' });
                            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        }
                        continue;
                    }

                    if (cmd === '/exclude') {
                        let targetRaw = args[0] || '';
                        if (targetRaw.toLowerCase() === 'add' && args[1]) targetRaw = args[1];

                        const contextInfo = rawMsg.message?.extendedTextMessage?.contextInfo;
                        const mentioned = contextInfo?.mentionedJid;
                        if (Array.isArray(mentioned) && mentioned.length > 0) {
                            targetRaw = mentioned[0];
                        } else if (!targetRaw && contextInfo?.participant) {
                            targetRaw = contextInfo.participant;
                        }

                        if (targetRaw.toLowerCase() === 'list' || !targetRaw) {
                            if (excludedNumbers.size === 0) {
                                const sent = await sock.sendMessage(replyJid, { text: '[EXCLUSION] No numbers currently excluded.' });
                                if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                            } else {
                                const list = Array.from(excludedNumbers).map((n, i) => {
                                    const linked = lidToPhoneMap.get(n) || phoneToLidMap.get(n);
                                    return `${i + 1}. +${n}${linked ? ` (linked: +${linked})` : ''}`;
                                }).join('\n');
                                const sent = await sock.sendMessage(replyJid, { text: `=== EXCLUDED NUMBERS ===\n${list}\n========================` });
                                if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                            }
                            continue;
                        }

                        const target = normalizeNumber(targetRaw);
                        if (target) {
                            excludedNumbers.add(target);
                            const linked = lidToPhoneMap.get(target) || phoneToLidMap.get(target);
                            if (linked) excludedNumbers.add(linked);
                            saveExcludedNumbers();
                            const sent = await sock.sendMessage(replyJid, { text: `[EXCLUSION] Excluded +${target}. All messages from this contact will be ignored.` });
                            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        } else {
                            const sent = await sock.sendMessage(replyJid, { text: '[USAGE] /exclude <number or @mention>' });
                            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        }
                        continue;
                    }

                    if (cmd === '/unexclude') {
                        let targetRaw = args[0] || '';
                        if (targetRaw.toLowerCase() === 'remove' && args[1]) targetRaw = args[1];

                        const contextInfo = rawMsg.message?.extendedTextMessage?.contextInfo;
                        const mentioned = contextInfo?.mentionedJid;
                        if (Array.isArray(mentioned) && mentioned.length > 0) {
                            targetRaw = mentioned[0];
                        } else if (!targetRaw && contextInfo?.participant) {
                            targetRaw = contextInfo.participant;
                        }

                        const target = normalizeNumber(targetRaw);
                        if (target) {
                            let removed = false;
                            const candidates = resolveAllIdentifiers(target);
                            for (const n of Array.from(excludedNumbers)) {
                                for (const cand of candidates) {
                                    if (isExcludedNumberMatch(n, cand)) {
                                        excludedNumbers.delete(n);
                                        removed = true;
                                    }
                                }
                            }
                            saveExcludedNumbers();
                            const sent = await sock.sendMessage(replyJid, {
                                text: removed ? `[EXCLUSION] Removed +${target} from exclusion list.` : `[EXCLUSION] +${target} was not in exclusion list.`
                            });
                            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        } else {
                            const sent = await sock.sendMessage(replyJid, { text: '[USAGE] /unexclude <number or @mention>' });
                            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        }
                        continue;
                    }

                    if (cmd === '/list') {
                        if (excludedNumbers.size === 0) {
                            const sent = await sock.sendMessage(replyJid, { text: '[EXCLUSION] No numbers currently excluded.' });
                            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        } else {
                            const list = Array.from(excludedNumbers).map((n, i) => `${i + 1}. +${n}`).join('\n');
                            const sent = await sock.sendMessage(replyJid, { text: `=== EXCLUDED NUMBERS ===\n${list}\n========================` });
                            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        }
                        continue;
                    }

                    if (cmd === '/clear') {
                        cleanMediaDir();
                        messageStore.clear();
                        const sent = await sock.sendMessage(replyJid, { text: '[CLEANUP] In-memory cache and temporary media cleared.' });
                        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                        continue;
                    }
                }
            }

            // Skip forensic processing if bot is paused or sender/chat is excluded
            if (!isBotActive) continue;
            if (isExcluded(sender) || isExcluded(senderNumber) || isExcluded(jid)) continue;


            // 2. Anti-Edit Check: SecretEncryptedMessage (Modern WhatsApp Edits)
            const secretEnc = rawMsg.message?.secretEncryptedMessage;
            if (secretEnc && secretEnc.targetMessageKey?.id) {
                const targetId = secretEnc.targetMessageKey.id;
                const stored = messageStore.get(targetId);
                if (stored) {
                    if (isExcluded(stored.sender) || isExcluded(stored.originJid) || isExcluded(jid)) continue;
                    let newText = null;
                    const decoded = decryptSecretEncryptedEdit(secretEnc, stored, rawMsg);
                    if (decoded) {
                        newText = getTextMessage(decoded.protocolMessage?.editedMessage)
                            || getTextMessage(decoded.editedMessage)
                            || getTextMessage({ message: decoded })
                            || getTextMessage(decoded);
                    }
                    await handleEditedNotification(sock, jid, targetId, decoded || secretEnc, newText);
                }
                continue;
            }

            // 4. Anti-Edit Check: Protocol Message Edits
            const editInUpsert = findEditedMessage(rawMsg);
            if (editInUpsert && editInUpsert.targetId) {
                const stored = messageStore.get(editInUpsert.targetId);
                if (stored && (isExcluded(stored.sender) || isExcluded(stored.originJid) || isExcluded(jid))) continue;
                await handleEditedNotification(sock, jid, editInUpsert.targetId, editInUpsert.editedMessage);
                continue;
            }

            // 5. Anti-Delete Check: Revocation in Upsert
            const deletedIdInUpsert = findDeletedId(rawMsg);
            if (deletedIdInUpsert) {
                const stored = messageStore.get(deletedIdInUpsert);
                if (stored && !stored.resent) {
                    if (isExcluded(stored.sender) || isExcluded(stored.originJid) || isExcluded(rawMsg.key.participant) || isExcluded(rawMsg.key.remoteJid)) {
                        console.log(`[EXCLUSION] Revocation for ${deletedIdInUpsert} ignored because contact is excluded.`);
                        continue;
                    }
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
        if (!isBotActive) return;

        for (const update of updates) {
            // Check for message revocation
            const deletedId = findDeletedId(update);
            if (deletedId) {
                const stored = messageStore.get(deletedId);
                if (stored && !stored.resent) {
                    if (isExcluded(stored.sender) || isExcluded(stored.originJid) || isExcluded(update.key?.participant) || isExcluded(update.key?.remoteJid)) {
                        console.log(`[EXCLUSION] Revocation update for ${deletedId} ignored because contact is excluded.`);
                        continue;
                    }
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
                const stored = messageStore.get(targetId);
                if (stored) {
                    if (isExcluded(stored.sender) || isExcluded(stored.originJid) || isExcluded(update.key?.remoteJid)) continue;
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
                const stored = messageStore.get(editData.targetId);
                if (stored && (isExcluded(stored.sender) || isExcluded(stored.originJid) || isExcluded(update.key?.remoteJid))) continue;
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
