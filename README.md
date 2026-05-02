# tribe-evolution

🧬 An agent ecosystem that evolves through natural selection in a shared filesystem.

A single Node.js supervisor process drives a population of LLM-backed agents. Every cycle, each agent picks an action via DeepSeek, the supervisor scores it, and the population is filtered by fitness. Surviving agents reproduce sexually (diploid genome with mutation); unfit agents are eliminated. Token rewards for bounties and proposals are funded by a system treasury — no minting from thin air.

## Quick start

```bash
npm install
cp .env.example .env       # edit DEEPSEEK_API_KEY at minimum
npm run seed               # initialize ./ecosystem with 10 agents
npm start                  # start the supervisor + API on http://localhost:3000
npm run web                # in a separate terminal: serve the dashboard on http://localhost:3001
```

Open http://localhost:3001/ and log in (default password `tribe-admin`, override with `DASHBOARD_AUTH_TOKEN`). The frontend talks to the API over CORS using a bearer token in the `x-auth-token` header.

For a debug-friendly 10s cycle loop, use `npm run dev`. For an end-to-end demo of the evolution engine without the supervisor (writes to `./ecosystem-demo`, cleans up after):

```bash
npx tsx src/demo.ts
```

To point the frontend at a non-default backend, use `?api=<url>` once: e.g. `http://localhost:3001/?api=http://my-host:3000` (the URL is remembered in `localStorage`).

## How it works

- **One supervisor process owns everything.** The Supervisor (`src/supervisor/index.ts`) loads agents from `ecosystem/agents/*.json`, runs cycles via the `Scheduler`, calls `decide()` for each agent in-process via `Promise.allSettled`, and runs `runCycle` from `life-cycle.ts` to evolve the population. There is no per-agent process — `src/agent/index.ts` is an alternative JSON-RPC subprocess shell that the supervisor doesn't currently spawn.
- **Frontend and backend run as separate processes.** The supervisor exposes a JSON + WebSocket API on port 3000 (`src/dashboard/server.ts` — no HTML serving). The dashboard HTML/JS lives in `web/` and is served by a small static file server (`src/web-server.ts`, `npm run web`). The two communicate over CORS using a bearer token (`x-auth-token`); session cookies were dropped when the frontend was split out.
- **State lives on disk, not in memory.** Everything under `ecosystem/` is the source of truth: agent JSON files, hash-chained event log, proposal JSONL, bounties JSON, treasury JSON.
- **Each cycle:** each agent's `decide()` picks an action; the supervisor scores it; `evaluateFitness` ranks the population; `eliminateStepped` removes the bottom by step thresholds; survivors age and (if below `MAX_AGENTS`) reproduce sexually with mutation. Agents die at age 50.
- **Sexual reproduction.** `DiploidGenome` carries dominant/recessive allele pairs. Reproduction does meiosis on each parent, recombines, then mutates at 15% per gene. Both genders must be present for sexual reproduction; otherwise the cycle falls back to asexual cloning.
- **Token economy.** LLM calls debit each agent's `tokenBalance`. Bounty rewards and auto-approved proposal payouts are funded by `Treasury` (`ecosystem/treasury.json`); on bounty failure the treasury is refunded. Losing bidders get 50% of their deposit back; failing past `maxRetries` reopens the bounty and burns 20% of the winner's deposit.
- **Bounty lifecycle.** `open → bidding → awarded → executing → submitted → publisher_review → supervisor_review → completed`. Either review tier can reject back to `executing`.
- **Verification sandbox.** `shell_test` verifications are disabled unless `BOUNTY_SHELL_SANDBOX_CMD` is configured (e.g., a `bwrap` argv prefix). Safe-by-default — safer than the previous `execSync(agentSuppliedCommand)` which was a straightforward RCE.

## Configuration

`.env.example` has every knob with defaults. The required key is `DEEPSEEK_API_KEY`. SMTP/POP3 are optional (proposal escalation/approval-by-email). `BRAVE_API_KEY` is optional (used by `agent/web-search.ts`). `BOUNTY_SHELL_SANDBOX_CMD` is optional and gates the `shell_test` verification path.

## Testing

```bash
npm test                                     # full vitest run
npx vitest run tests/unit/life-cycle.test.ts # single file
npx tsc --noEmit                             # type-check
```

There is **no build step** in normal use — `tsx` runs TypeScript directly.

## License

MIT
