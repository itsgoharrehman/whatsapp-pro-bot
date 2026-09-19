# WhatsApp Pro Bot

Focused, high-reliability WhatsApp automation bot featuring real-time Anti-Delete recovery, Anti-Edit decryption, and Telegram Cloud archival for a zero-disk footprint.

## Core Features

1. **Anti-Delete Recovery Engine**:
   - Intercepts and recovers deleted messages (text, photos, videos, voice notes, stickers, documents).
   - In-flight media caching with immediate Telegram Cloud offloading.
   - Reposts recovered messages with sender and deleter mentions.

2. **Anti-Edit Decryption & Comparison**:
   - Supports both standard protocol edits and modern WhatsApp `SecretEncryptedMessage` edits.
   - Derives session HMAC keys and decrypts edit payloads via AES-GCM.
   - Tracks multi-step sequential edits and posts before-and-after text comparisons.

3. **Telegram Cloud Archival (0 MB Local Disk)**:
   - Permanently backs up deleted media, edit history, and chat logs directly to a private Telegram channel.
   - Zero local disk accumulation.

4. **Security & Configuration**:
   - Zero hardcoded credentials; fully driven by `.env` environment variables.
   - Session authentication state preserved via Baileys multi-file auth.
   - Lightweight keep-alive HTTP health probe on port 3000.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/itsgoharrehman/whatsapp-pro-bot.git
   cd whatsapp-pro-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   Copy `.env.example` to `.env` and configure your credentials:
   ```bash
   cp .env.example .env
   ```
   Edit `.env`:
   ```env
   ADMIN_NUMBER=923238522260
   TELEGRAM_ENABLED=true
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_CHANNEL_ID=your_channel_id
   PORT=3000
   ```

4. Start the bot:
   ```bash
   node Anti_delete_bot.js
   ```

## Commands

* `/status`: Displays system uptime, memory usage, Telegram connection state, and active cache count (authorized admin only).

## Architecture

* Runtime: Node.js (v18+)
* Protocol: `@whiskeysockets/baileys`
* Storage: Telegram Bot API (cloud document/message sink)
* Process Architecture: Single-process daemon with automatic reconnection handling
