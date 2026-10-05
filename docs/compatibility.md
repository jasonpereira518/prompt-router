# OmniRoute compatibility

The web adapter targets **3.8.51**, tag commit `c1e30b7676975feb298b49eff6ff58923c04b89e`, image digest `sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218`. Upstream API schemas and implementation were inspected at this version. The app fails closed when the gateway health version differs.

The registry, connection inventory, provider nodes (paginated at the verified 200-row maximum), live model metadata, explicit combo creation, restricted keys, key configuration, and streamed inference are tested against the actual pinned container. A local OpenAI-compatible fixture verifies the serving model without contacting paid providers. Real fixture tests also exercise image metadata, vision-only candidate selection, rejection of a text target outside the restricted attempt key, and cancellation propagating to the upstream fixture. Unit tests cover paid/subscription filtering, vision-only candidate sets, request-level key/connection restrictions, stream fragmentation/truncation, crash recovery, and file processing. Browser tests cover sign-in, cross-browser history, private exports, unsafe Markdown, cancellation/retry, and attachment error recovery.

## Run the real compatibility test

The following credentials are disposable **test-only values**. Use a fresh container without host data mounts or real accounts. The fixture listens on port 20139; the gateway listens on 20138. The default `host.docker.internal` works on Docker Desktop; on Linux add the host-gateway mapping shown here.

```sh
docker run --rm -d --name omni-gateway-compat \
  --add-host=host.docker.internal:host-gateway \
  -p 127.0.0.1:20138:20128 \
  -e INITIAL_PASSWORD=compat-test-password \
  -e JWT_SECRET=compat-jwt-test-only-0123456789abcdef \
  -e API_KEY_SECRET=compat-encryption-test-only-0123456789abcdef \
  diegosouzapw/omniroute:3.8.51@sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218
```

Wait for the gateway to respond, then:

```sh
npm run test:compat
docker stop omni-gateway-compat
```

The test creates and cleans its own management key, custom provider/node, temporary combos, and restricted inference keys. It does not authorize third-party subscriptions. Running it against a gateway holding real accounts is unsupported.

## Authentication coverage and limitations

API-key connection create/update/test/enable/delete and the gateway's OAuth endpoint shapes are supported by the adapter. The in-app device-flow allowlist is GitHub, Qwen, CodeBuddy, and CodeBuddy CN; the browser flow is Claude with callback URL exchange and server-side state verification. Other flows expose guided external setup because remote redirects, local helpers, provider restrictions, or unsupported endpoint behavior require separate validation. API schema verification does not establish successful live authorization with every provider. Real account tests are still required before web release acceptance.

The catalog lists all registry providers plus custom provider nodes. Only active, persisted connections with verified live chat-model metadata are eligible. Synthetic/no-auth provider entries without a persisted connection are catalog-only. Missing context metadata blocks inference; positive vision metadata is required. This conservative policy may exclude usable routes until the gateway provides the required metadata.

[API reference at the pin](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/docs/reference/API_REFERENCE.md) · [remote guidance at the pin](https://github.com/diegosouzapw/OmniRoute/blob/v3.8.51/docs/guides/REMOTE-MODE.md)

## Recovery and production packaging

```sh
node tests/compat/restore.mjs
docker build -t omni-web-verification .
node tests/compat/runtime.mjs
```

The recovery rehearsal creates its own two disposable gateway containers, copies their stopped data, and verifies the persisted management key and encrypted provider credentials against a local HTTP fixture. It needs ports 20140–20142 and Docker. The production smoke test uses port 3018 and verifies owner access, Secure sessions, SQLite, and private PDF upload/download in the standalone app image. Both scripts clean up their own containers and use no real credentials.
