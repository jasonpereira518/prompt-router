# Web architecture and API

Next.js 16, React, TypeScript, Node.js 24, and SQLite form a single-owner application. One Node process owns the SQLite WAL database and active generation controllers. Do not run multiple app workers or replicas against this database. The app persists shared conversations and original uploads; OmniRoute owns provider credentials, inference ranking, and fallback. The gateway is pinned to 3.8.51 and catalog discovery rejects a different version.

`lib/gateway.ts` contains the inference and provider-management adapters. It translates the provider registry, active connection inventory, and live model catalog into allowlisted browser DTOs. Each response creates an explicit gateway combo and a short-lived, restricted inference key. Both restrict model and connection eligibility, including every fallback. Automatic combos use the gateway's Balanced defaults, `quality-first`, `ship-fast`, or `cost-saver` mode packs; direct selection uses a one-model priority combo. Compression, hedging, exploration, logging, and cache reuse are disabled for these attempts. The app never ranks models, compares responses, or regenerates automatically.

A server-only management key mediates provider operations. Gateway inference and dashboard endpoints are not public. Third-party tokens and code verifiers never enter browser storage. Browser/device authorization URLs and codes are intentionally displayed to the signed-in owner. API-key fields are submitted once, then cleared. Catalog responses omit key/token fields, and exports contain conversation data rather than settings or connection credentials.

Owner email plus a salted scrypt password hash provides sign-in with no registration. Opaque, hashed server-side sessions last seven days. Production cookies are Secure, HttpOnly, and SameSite=Strict. Every mutation, including login, requires the configured exact Origin. Login failures are rate limited. HTTPS is terminated by Caddy. Safe Markdown excludes raw HTML; content and attachment routes return no-store headers. A compromised server can access data and credentials: this is server-side privacy, not end-to-end encryption.

SQLite stores conversations, messages, generation attempts, attachment processing results, settings, sessions, and short-lived OAuth tickets. Generation status transitions from pending to completed/stopped/failed/interrupted. A unique partial index prevents overlapping responses within a conversation. On startup, pending attempts become interrupted. Preflight failures do not create attempts. Requested route, reported model/provider/fallback, exclusions, and available usage remain separate fields. Settings changes are blocked while a generation is active; in-flight eligibility is a snapshot, so use Stop before disabling a connection used by an active response.

## Authenticated API

All routes except session status/sign-in require the owner cookie. Mutations require `Origin: APP_ORIGIN`. Errors use `{error, code}` and never include raw upstream error bodies. The JSON request limit is 512,000 bytes.

| Endpoint                                        | Method               | Contract                                                                                             |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `/api/session`                                  | GET / POST / DELETE  | Authentication/configuration status; sign in `{email,password}`; revoke current session              |
| `/api/conversations?search=…`                   | GET / POST           | Search titles/message text; create conversation                                                      |
| `/api/conversations/:id`                        | GET / PATCH / DELETE | Detail; change `{title?,route?,outputCap?}`; delete idle chat and files                              |
| `/api/conversations/:id/export?format=json\|md` | GET                  | Owner-only conversation export; JSON includes attempt metadata                                       |
| `/api/conversations/:id/attachments`            | POST                 | Multipart `file`; returns ID, processing result/error                                                |
| `/api/attachments/:id`                          | GET                  | Private original download                                                                            |
| `/api/chat`                                     | POST                 | `{conversationId,content,attachmentIds,retryId?,excludeMessageIds?}`; SSE `attempt`, `delta`, `done` |
| `/api/generations/:id/stop`                     | POST                 | Stop active generation                                                                               |
| `/api/catalog`                                  | GET                  | Pinned provider registry, masked connection inventory, live models                                   |
| `/api/settings`                                 | GET / PUT            | `{paidEnabled,outputCap,routes,billing,theme}`                                                       |
| `/api/providers`                                | POST                 | Verified key connection `{provider,name,apiKey}`                                                     |
| `/api/providers/:id`                            | PATCH / DELETE       | `{isActive?,name?,apiKey?}`; remove connection                                                       |
| `/api/providers/:id/test`                       | POST                 | Safe connection test result                                                                          |
| `/api/providers/:provider/oauth`                | POST                 | Begin supported device/browser authorization                                                         |
| `/api/oauth/:ticket`                            | POST                 | Poll device flow or exchange `{callback}` with server-held state                                     |

The later Mac client should use these contracts, store its session in Keychain, and support file selection. It must use the hosted backend; local gateway management and offline chat are outside scope.
