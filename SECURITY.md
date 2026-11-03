# Security Policy

## Supported Versions

| Version | Supported | Description |
| :--- | :--- | :--- |
| `2.0.x` | Yes | Current stable release branch (`main`) |
| `< 2.0.0` | No | Legacy prototypes |

## Security and Credential Safeguards

whatsapp-pro-bot operates with access to real-time messaging protocols and cloud archival channels. Strict security controls are enforced:
* **Session Credentials**: Baileys session credentials contain active cryptographic keys and tokens. The authentication directory must remain strictly local and isolated with restricted file permissions (`chmod 700`).
* **Telegram Bot Tokens**: Telegram bot tokens grant write access to archival channels. Tokens must be injected via environment variables and never logged or serialized.
* **Rate Limiting**: Automated repost mechanisms must respect rate limits to prevent trigger heuristics on the WhatsApp network.

## Reporting a Vulnerability

If you discover a security flaw, credential exposure, or protocol vulnerability, report it privately:

* **Security Contact**: Gohar Rehman
* **Email**: `goharrehmanfsd260@gmail.com`
* **Response SLA**: Initial acknowledgement within 48 hours; resolution timeline provided within 7 days.

Please do not open public GitHub issues or discussions regarding undisclosed vulnerabilities.