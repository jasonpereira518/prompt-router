# Repository workflow

Default integration branch: `main`. One objective and one PR per coding chat. Preserve all user changes. Fetch origin and implement only in a dedicated sibling worktree on a unique `codex/<task>` branch based on latest `origin/main`; never edit or commit on main. Reuse a clean task worktree when already attached. Ask if isolation is ambiguous.

Before requesting approval, run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`. Install with `npm ci` on Node.js 24; browser setup uses `npx playwright install chromium`. The optional real-gateway test is `npm run test:compat` after disposable-container setup in docs/compatibility.md. Review the diff for secrets, generated artifacts, and unrelated changes.

Ask the user before every implementation commit or push. After approval, commit, push the codex branch without force, and open a ready-for-review PR against main with `gh`. Never merge until explicitly asked. On a merge instruction, pass required CI/reviews, squash-merge, verify the merge, and remove only this task's clean worktree and branch.

Architecture: one Node.js process, SQLite WAL plus private attachment files, hosted gateway pinned to 3.8.51. Credentials stay server-side; paid eligibility is opt-in. Keep gateway behavior behind lib/gateway.ts; do not add client-side ranking or fallback. Mac client is later. Never use real secrets in tests or make irreversible production changes without explicit authorization.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
