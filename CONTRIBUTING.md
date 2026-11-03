# Contributing to whatsapp-sentinel

Thank you for your interest in contributing to whatsapp-sentinel.

## Proprietary Software Notice
This project is licensed under a Proprietary Software License. Contributions submitted to this repository are subject to assignment or licensing terms under the sole ownership of Gohar Rehman.

## Security and Operational Guidelines
All contributors must strictly observe these operational boundaries:

1. **Session Credential Isolation**: Never commit or stage files from the `auth_info_baileys/` directory. Session files contain sensitive cryptographic authentication keys and must remain strictly machine-local.
2. **Zero Plaintext Secrets**: Telegram bot tokens, administrative phone numbers, and channel identifiers must be read exclusively from environment variables (`process.env`). Never hardcode fallback credentials.
3. **Rate Limiting Preservation**: Maintain operational delays (`RESEND_DELAY_MS`) and in-memory cache TTLs. Do not bypass timing safeguards that protect against WhatsApp anti-spam detection heuristics.
4. **Dependency Auditing**: Any new dependency must be thoroughly reviewed for security advisories and CVEs before introduction.

## Development Workflow
1. Fork and clone the repository:
   ```bash
   git clone https://github.com/<your-username>/whatsapp-sentinel.git
   cd whatsapp-sentinel
   ```
2. Create a focused branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Test locally with test session keys.
4. Open a Pull Request completing the mandatory security checklist in `.github/PULL_REQUEST_TEMPLATE.md`.