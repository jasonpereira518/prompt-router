# Hosting and recovery

Deploy to an always-on Linux server with Docker Compose, persistent disk, and a DNS name pointing at that server. This does not depend on the owner's Mac. Expose only TCP 80/443 publicly; retain SSH access for administration. Do not use ephemeral/serverless disk or multiple app replicas.

## Initial deployment

```sh
cp .env.example .env
chmod 600 .env
mkdir -p data/app data/gateway backups
sudo chown -R 1000:1000 data/app backups
```

Generate the owner password hash with `npm run owner:password` on a trusted machine and put it in `.env`. Set the owner email, `OMNI_DOMAIN`, and independent random gateway initial password/JWT/API encryption secrets. Generate random values with `openssl rand -hex 32`; retain them in a password manager. Set `OMNI_DATA_DIR=/app/data` in `.env` for the container backup commands below. Compose overrides the app origin and gateway URL. Never commit `.env`.

```sh
docker compose up -d omniroute
ssh -L 20128:127.0.0.1:20128 your-server
```

Open http://localhost:20128 through the SSH tunnel, sign in with the gateway initial password, and create an API key with **manage** scope. Set `OMNI_MANAGEMENT_KEY` in the server `.env`, then:

```sh
docker compose up -d --build
```

Caddy provisions HTTPS at `https://OMNI_DOMAIN`. The gateway port is bound to server loopback only. Verify the actual rendered Compose configuration privately with `docker compose config --quiet` (avoid printing expanded secrets). Confirm the app sign-in, session isolation, provider setup, and two-browser history. Connect accounts and configure preset mappings inside Omni. Verify a real subscription route and a paid API route after explicit global enablement; account authorization and external provider compatibility are operator acceptance steps.

Advanced gateway administration remains available through the SSH tunnel. For local helpers, follow the app's external guide and the pinned gateway [remote-mode guidance](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/docs/guides/REMOTE-MODE.md). Helpers may require a protected tunnel to the hosted gateway. Do not publish its dashboard as a workaround.

## Backup

Keep encrypted, off-server backups of the app database/uploads, entire gateway data directory, and `.env` secrets. Gateway encryption/JWT secrets are required for usable restored credentials. Protect app backup files too: they contain private conversations and potentially transient OAuth tickets.

Stop both writers for a coherent snapshot. Choose a fresh backup name each time; the app backup command rejects a nonempty destination.

```sh
docker compose stop app omniroute
docker compose run --rm --no-deps app node scripts/backup.mjs create /app/backups/snapshot/app
sudo tar -czf backups/snapshot/gateway-and-secrets.tar.gz data/gateway .env
sudo chmod -R go-rwx backups/snapshot
docker compose up -d app omniroute
```

Encrypt the complete snapshot using your existing backup system and copy it off the server. The archive is not encrypted by `tar`; do not upload it unencrypted. Keep the original image digest and application revision with the snapshot. Schedule backup/retention with your server's backup service; the app does not run a background backup scheduler.

## Restore

On a spare server first, restore the same app revision and pinned gateway image. Preserve existing data before replacing it. Restore `.env` and `data/gateway` from the protected archive, verify secrets/domain, and create an **empty** app data directory owned by UID 1000. Copy the app snapshot to `backups/snapshot/app` and ensure UID 1000 can read it.

```sh
docker compose stop app omniroute
docker compose run --rm --no-deps app node scripts/backup.mjs restore /app/backups/snapshot/app
docker compose up -d omniroute app proxy
```

Restoration checks SQLite integrity, rewrites attachment paths for the target directory, and revokes app sessions/OAuth tickets. Sign in again; check a conversation, download an original attachment, inspect requested/reported route records, and test an existing provider connection. Reconnection may be required if a third-party token expired. App database plus attachment restoration is exercised by automated tests; the pinned gateway's persisted configuration is separately exercised with disposable credentials in compatibility testing. Always rehearse with your own encrypted backup before considering production recovery verified.

## Upgrades and diagnostics

Do not advance the gateway pin without running compatibility tests and the browser suite. Retain the old image and a complete snapshot before changing schemas. Inspect `docker compose ps` and service health locally. Never paste `.env`, gateway database contents, full configuration output, or raw provider responses into diagnostics. The app deliberately exposes only safe error messages. A gateway crash can leave expired inference-key records and temporary `omni-` combos; remove stale entries from the protected dashboard after confirming no response is active.
