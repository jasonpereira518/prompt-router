# Omni

A private, single-owner AI chat app backed by OmniRoute. The responsive web client shares server-side conversations across browsers; a future Mac client can reuse the same authenticated APIs.

The first web release includes streaming Markdown and code copying, Stop and separate retry attempts, conversation search/rename/delete/export, document and image attachments, routing presets and direct model selection, provider administration, themes, and available usage metadata. Paid API connections are ineligible until explicitly enabled globally. Gateway ranking and fallback operate only within the eligible model and connection set.

## Run locally

Use Node.js 24 and the pinned OmniRoute **3.8.51** gateway. Docker deployment is described in [operations](docs/operations.md).

```sh
npm ci
cp .env.example .env.local
npm run owner:password
```

Set `OWNER_EMAIL`, the generated `OWNER_PASSWORD_HASH`, `APP_ORIGIN=http://localhost:3000`, and a private `OMNI_GATEWAY_URL` in `.env.local`. Create a gateway API key with `manage` scope through its protected dashboard and set `OMNI_MANAGEMENT_KEY`. Never put gateway or provider keys into public environment variables.

```sh
npm run dev
```

Sign in at http://localhost:3000. In Settings → Providers, connect your providers and classify each connection's billing. Unknown connections are treated as paid. In Settings → Routing, choose up to ten models per preset. Unconfigured presets provide a setup action. The initial output cap is 2,048 tokens and can be adjusted per chat.

The application starts without configured gateway credentials so existing history remains accessible, but provider setup and generation require a compatible gateway. There is no registration or demo-account fallback.

## Verify

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests start a deterministic gateway fixture and use only disposable data and dummy credentials. The optional [real gateway compatibility test](docs/compatibility.md) uses the pinned gateway with a local provider fixture, without paid calls or real accounts. `npm audit` checks dependency advisories.

## Boundaries

This is a single-process, single-server deployment. SQLite, uploads, gateway configuration, and secrets require persistent storage and backups. [Architecture and API contracts](docs/architecture.md), [limits](docs/limits.md), and [operations and restoration](docs/operations.md) describe these requirements.

Third-party subscription authentication must be tested with your actual accounts before release. Catalog inclusion does not imply every authentication method works remotely. Local helpers and unsupported flows have external guidance. No OCR, offline chat, model comparisons, tools, agents, knowledge library, or guaranteed monetary cap are included. The Mac client is the next release, not part of this web implementation.
