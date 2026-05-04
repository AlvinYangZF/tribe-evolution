# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                # install deps
npm run seed               # initialize 10-agent population in ECOSYSTEM_DIR (./ecosystem by default)
npm start                  # run supervisor with the configured cycle interval (default 4h)
npm run dev                # same as start, but forces 10s cycles for debugging
npx tsx src/demo.ts        # standalone end-to-end demo of the evolution engine (uses ./ecosystem-demo, cleans up after)

npm test                   # vitest run (all tests in tests/**/*.test.ts)
npm run test:watch         # vitest watch mode
npx vitest run tests/unit/life-cycle.test.ts          # single file
npx vitest run -t "evaluateFitness penalises old agents" # single test by name
```

There is **no build step** in normal use — `tsx` runs TypeScript directly. `tsconfig.json` writes to `dist/` but no script invokes `tsc`; treat `npx tsc --noEmit` as the type-check command.

## Configuration

Copy `.env.example` to `.env`. **Bug to be aware of:** `src/config/index.ts` currently hardcodes `dotenv.config({ path: '/Users/zifengyang/tribe-evolution/.env' })`. On any other machine you must either edit that path, set env vars another way, or fix the loader to use a relative path before `loadConfig()` will see your `.env`.

Required external services:
- `DEEPSEEK_API_KEY` — agent decisions call `https://api.deepseek.com/chat/completions` (model `deepseek-chat`).
- `BRAVE_API_KEY` — optional, used by `agent/web-search.ts`.
- SMTP (`EMAIL_USER`/`EMAIL_PASS`) and POP3 are optional; the Supervisor escalates proposals via email and reads approve/reject replies. `EMAIL_PASS` is auto-base64-decoded if it looks like base64 (`maybeDecodeBase64` in `config/index.ts`).

## Architecture

### Process model

Single Node process. The `Supervisor` (`src/supervisor/index.ts`) owns everything: it loads agents from `ecosystem/agents/*.json`, runs cycles via `Scheduler`, calls `decide()` for each agent **in-process** via `Promise.allSettled`, then runs `runCycle` from `life-cycle.ts` to evolve the population.

Important: `src/agent/index.ts` is a **separate JSON-RPC stdin/stdout agent subprocess** (`ping`, `get_genome`, `think_cycle`, `create_proposal`, …). The Supervisor does **not** currently spawn it — it calls `decide()` directly. Treat `agent/index.ts` as an alternative deployment shell, not the live code path. Don't refactor one assuming the other is dead.

### State lives on disk, not in memory

There is no database. The `ecosystem/` directory is the source of truth and the dashboard reads it independently:

```
ecosystem/
  agents/<id>.json         # AgentState — tokenBalance, fitness, diploidGenome, alive, …
  event-log/events.jsonl   # hash-chained append-only log (see EventLog.verify())
  proposals/log.jsonl      # JSONL, rewritten in place when status changes
  bounties/bounties.json   # single JSON array
  reputation/log.jsonl
  resources/resources.json
  config.json              # mirror of runtime config for the dashboard
  email-state.json         # processed POP3 UIDs
```

All writes go through `shared/filesystem.ts`:
- `safeWriteJSON` writes to `.tmp-<rand>-<name>` then `rename` — never write JSON directly.
- `appendJSONL` for event/proposal logs.
- `EventLog.append` computes `prevHash`/`hash` (SHA-256 over the entry) and `verify()` walks the chain — preserve that contract when adding event types.

### Evolution cycle (`supervisor/life-cycle.ts:runCycle`)

Each cycle:
1. `evaluateFitness`: `fitness = contributionScore*0.5 + age*2 + reputation*10`, with `-(age-29)*5` after age 30, hard death at age 50, `+20` while `protectionRounds > 0`.
2. `eliminateStepped`: graduated by population size — `<20`: 0, `20-29`: 2, `30-39`: 5, `40-49`: 10, `50-59`: 20, `60-69`: 40, `≥70`: 60. **Protection is ignored once the population reaches 30.**
3. `reproduce` (only when survivors `< 30`): sexual reproduction via `genome.ts:sexualReproduce` (meiosis on each parent → recombine → `mutateDiploid` at rate 0.15). Falls back to asexual cloning if both genders are not present.
4. Increment age and decrement `protectionRounds` for survivors; tag offspring with the cycle number as their `generation`.

### Diploid genome

`shared/types.ts` defines both `Genome` (haploid, legacy) and `DiploidGenome` (gene pairs with dominant/recessive alleles). `AgentState.diploidGenome` is the real genetic state; `AgentState.genome` is the **expressed** snapshot kept for backward compatibility. When mutating an agent, mutate the diploid form and re-express via `expressGenome` + `expressedToGenome` — see `main.ts:seed` and `demo.ts:createAgent` for the canonical pattern.

### Agent decision flow (`agent/brain.ts`)

`decide(genome, state, env, callLLM)` builds a system prompt from the genome via `compileAgentPrompt`, asks the LLM for JSON, and runs it through `parseDecision`. **`parseDecision` falls back to `{action: 'idle'}` on any malformed response** — never throw out of `decide`. Valid actions are listed in `ALL_DECISION_ACTIONS`; if you add one, update both that array and `ACTION_DESCRIPTIONS`, and add a score in `Supervisor.decideForAgent` (the contribution score for the cycle is set by which action was chosen).

### Token accounting

`supervisor/llm-proxy.ts:proxyCall` returns `tokenUsage` but does **not** debit the agent. The Supervisor reads `resp.tokenUsage.total` and subtracts from `agent.tokenBalance`, then persists via `saveAgent`. If you call the LLM from elsewhere, you must replicate this pattern or balances will drift from disk.

### Proposals & email loop

When an agent picks `propose`, the Supervisor creates a `Proposal`, runs `evaluateProposal` (heuristic: too short/long/sensitive → reject/escalate; high-rep + high-fitness → auto-approve; high cost → escalate to user via SMTP). Approved-by-Supervisor proposals are batched into a digest email every 3 cycles. Every cycle, `checkEmailReplies` polls POP3, calls `classifyReply` (looks for `approve`/`reject`/`同意`/`批准`/`拒绝` plus a UUID), and resolves the matching proposal. **Replies without a UUID are intentionally ignored** — don't change that without updating `extractProposalId`.

### Bounty state machine (`supervisor/bounty-board.ts`)

`open → bidding → awarded → executing → submitted → publisher_review → supervisor_review → completed`. Either review tier can reject back to `executing`. Transitions are guarded by `VALID_TRANSITIONS` — call `assertTransition` when adding new edges. Verification runs `shell_test`/`file_check`/`api_check`/`llm_review` (the last is a no-op stub). Losing bidders are refunded 50% of deposit; failing past `maxRetries` (default 3) reopens the bounty and burns 20% of the winner's deposit.

Bounty rewards are funded by the system `Treasury` (`supervisor/treasury.ts`, persisted at `ecosystem/treasury.json`). `awardBid` debits the treasury by `bounty.reward`; `completeBounty` credits the winner; `failVerification` (exhausted) refunds the treasury. The same treasury funds auto-approved proposal rewards. **No path mints tokens from thin air** — if you add a new payout, route it through the treasury.

`shell_test` is **disabled unless `BOUNTY_SHELL_SANDBOX_CMD` is set** (safe-by-default). When set, the value is whitespace-split into argv prefix and prepended to `['sh', '-c', test.command]`. Recommended on Linux: `bwrap --ro-bind / / --tmpfs /tmp --unshare-net --unshare-pid --die-with-parent --`. Tests use `env` as a passthrough.

### Dashboard (split frontend / backend)

The dashboard is two processes:

- **API/WebSocket server** — `src/dashboard/server.ts`, started lazily by the Supervisor (`port` from `DASHBOARD_PORT`, default 3000). JSON endpoints under `/api/*`, WebSocket at `/ws`, plus the public `/auth-check` POST. **No HTML serving** — the only non-API route is the 404 fallback. Auth is bearer-token via the `x-auth-token` header (cookie path was removed during the split). CORS headers (`*` origin, allowed headers include `x-auth-token`) are set on every response, including 401, so the browser can read the status.
- **Static frontend server** — `src/web-server.ts` (`npm run web`, default port 3001). Serves `web/index.html`, `web/login.html` (and any future assets). Pure file server — no API logic.

The frontend resolves the backend URL at runtime via `window.TRIBE_CONFIG.apiUrl`, populated from (in priority): `?api=<url>` query param, `localStorage.tribe_api_url`, or the default `http://localhost:3000`. The validated password is echoed back from `/auth-check` and stored in `sessionStorage.tribe_token`; `index.html`'s `authFetch` sends it on every request. On 401, `authFetch` clears the token and redirects to `login.html`.

The API server still re-reads `ecosystem/agents/*.json` directly — it does not share memory with the Supervisor.

## Conventions

- **ESM with `.js` import suffix.** TypeScript files import from `'./foo.js'` even though the source is `foo.ts` — required by `"module": "ESNext"` + `"moduleResolution": "bundler"`. New files must follow this.
- **Strict TS** is on. Don't add `any` casually; the codebase prefers `unknown` + narrowing for caught errors (`err instanceof Error ? err.message : String(err)`).
- **No comment churn**: existing modules use brief block comments at the top of public functions. Match that style; don't narrate logic line-by-line.
- **Don't add a database, ORM, or bundler.** Persistence is intentionally JSON-on-disk so the dashboard, the supervisor, and tests can all touch the same state.
- **Reproduction needs both genders** — if you add agents programmatically, set `diploidGenome.gender` or call `createRandomDiploidGenome(gender)`; otherwise `canReproduce` will exclude them and the population collapses to asexual cloning.
- **Vitest globals are on** (`globals: true` in `vitest.config.ts`); `describe`/`it`/`expect` are still imported explicitly throughout the existing tests — keep that convention.
