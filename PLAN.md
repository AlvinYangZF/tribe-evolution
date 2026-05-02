# Design Improvements Plan

Working branch: `claude/design-improvements-plan` (cut from `main` @ `53416a3`).

This plan is the output of the design review at the end of the prior session
plus a re-read of `main` after recent bounty/auth work landed. It groups the
findings into themed PRs sized for independent review and merge.

## Status legend

- ✅ landed on `main` since the original review
- ⚠️ regression introduced by recent commits
- 🆕 not in original review, found on re-read

## What changed since the original review

- ✅ `bid_bounty` is wired (`supervisor/index.ts:184-199`).
- ✅ `develop_skill` exists in the brain (`agent/brain.ts:73`) and the
  supervisor side acts on it (`supervisor/index.ts:202-222`).
- ✅ Bounty data reaches the agent prompt (`openBounties`, `topBountyReward`),
  though via two redundant `listBounties('open')` calls in the env literal.
- ⚠️ New bounty states (`submitted`/`publisher_review`/`supervisor_review`)
  were added but the flow has correctness bugs — see PR-2.
- ✅ Dashboard auth (token + cookie + rate limiting) added.

## Consolidated problem list

### A. Security & token-economy invariants

| ID | Where | Problem |
|----|-------|---------|
| A1 | `bounty-board.ts:288-294` | `shell_test` is unsandboxed `execSync` of agent-controlled strings → RCE |
| A2 | `supervisor/index.ts:521` | Email approval auth = substring match on `From:` header (spoofable) |
| A3 | `bounty-board.ts:222-235` + `:345-366` | Bounty escrow mints tokens (creator never debited) |
| A4 ⚠️ | `bounty-board.ts:333,341` | `publisherApprove`/`publisherReject` call `saveAll([bounty])` — overwrites entire `bounties.json` with a single-element array (data-loss) |
| A5 ⚠️ | `bounty-board.ts:26-35` + `supervisor/index.ts:443-477` | `processBountyExecutions` does submitResult → publisherApprove → completeBounty in one tick, but `VALID_TRANSITIONS.publisher_review = ['supervisor_review', 'executing']` — `completeBounty` requires transition from `supervisor_review`, so the path always throws |
| A6 ⚠️ | `supervisor/index.ts:213-216` | `develop_skill` writes to `agent.genome.skills` via a string-cast key, skipping `diploidGenome` entirely; new "skill" disappears at the next reproduction (meiosis reads diploid only) |
| A7 🆕 | `supervisor/index.ts:248` | Auto-approved proposals mint `tokenReward` from nothing — same shape of issue as A3 |

### B. Architectural duplication / dead code

| ID | Where | Problem |
|----|-------|---------|
| B1 | `src/agent/index.ts` vs `supervisor/index.ts` | JSON-RPC subprocess vs in-process `decide()` — two LLM call paths, two state shapes, two token-debit stories |
| B2 | `shared/types.ts:8-33` | Haploid `Genome` + `DiploidGenome` both stored on every agent and must be hand-synced |
| B3 | `agent/genome.ts:278-372` | Legacy `mutate`/`forceMutate`/`cloneGenome` exported but unused by the live cycle |

### C. Correctness landmines

| ID | Where | Problem |
|----|-------|---------|
| C1 | `life-cycle.ts:305` | `runCycle(agents, cycleNumber, maxAgents)` ignores `maxAgents`; `30` is hardcoded |
| C2 | `supervisor/index.ts:483` | `scanProposals` change-detection by count is wrong (count drops on auto-approve) |
| C3 | `supervisor/index.ts:360,439` | Cycle-boundary events logged with the wrong `EventType` (`token_allocated` for `cycle_start`, `task_completed` for `cycle_end`) |
| C4 | `tests/unit/life-cycle.test.ts:2` | Imports a non-existent `eliminate` symbol — file fails to load, `npm test` is red |
| C5 | `scheduler.ts:17` | `currentCycle` resets to 0 on restart → generation numbers reused |
| C6 | `supervisor/index.ts:19-22` | Module-level `agentLastProposal`/`pendingDigest` are lost on restart |
| C7 ⚠️ | `supervisor/index.ts` (multiple) | Pervasive `try { ... } catch(e){}` bare catches hide bugs like A4/A5/A6 |
| C8 🆕 | `life-cycle.ts:333-338` | `runCycle` increments age after `eliminateStepped` but never re-marks agents who cross age 50 as dead — a survivor can come back alive at age 50 |
| C9 🆕 | `tests/unit/bounty-board.test.ts` | 3 tests expect the pre-rename `verifying` status (replaced by `submitted` in two-tier review). Pre-existing on `main`. Belongs in PR-2 |
| C10 🆕 | `tests/unit/dashboard-server.test.ts` | 31 tests fail with 401 because the dashboard auth landed without test-side auth headers. Pre-existing on `main`. Belongs in PR-7 |
| C11 🆕 | `bounty-board.ts` ↔ `supervisor/index.ts` | `BountyBoard.deductAgentTokens`/`addAgentTokens` write directly to agent JSON, bypassing the supervisor's in-memory `this.agents` map. If a bounty action mutates an agent during a cycle, the supervisor's in-memory copy can overwrite it at end-of-cycle `saveAgent` time. Mitigated by `loadAgents()` at the start of every cycle. Belongs in a follow-up to PR-3 (token-mutation unification) |

### D. Performance / hygiene

| ID | Where | Problem |
|----|-------|---------|
| D1 | `event-log.ts:33-62` | `EventLog.append` re-reads the entire JSONL file every call |
| D2 | `shared/filesystem.ts:40-45` | `appendJSONL` is non-atomic; torn-line risk on crash |
| D3 | `bounty-board.ts:290` | `runVerification` uses `execSync` (blocks event loop) |
| D4 | `supervisor/index.ts:159-160` | Two `listBounties('open')` reads per agent per cycle for env metrics |
| D5 | `life-cycle.ts:90-101,326` | Magic numbers (elimination thresholds, reproduction caps) buried in code |
| D6 | `agent/brain.ts:179-216` | `parseDecision` hand-rolled, despite `zod` already being a dep |
| D7 | `config/index.ts:3` | Hardcoded `dotenv` path `/Users/zifengyang/...` — breaks on every other machine |

### E. Documentation drift

| ID | Where | Problem |
|----|-------|---------|
| E1 | `README.md` | Claims "persistent Node.js process per agent" and "30% elimination" — neither true |

## PR plan

### PR-1: tripwires (start here) — ✅ DONE

Pure, reversible fixes that surface the rest of the bugs.

- ✅ D7 — fix dotenv path (`config/index.ts:3` → `dotenv.config()`).
- ✅ C4 — fix `tests/unit/life-cycle.test.ts`: switch to `eliminateStepped` and rewrite the rate-based tests against the stepped semantics.
- ✅ C3 — add `cycle_start` and `cycle_end` to `EventType`; use them in `supervisor/index.ts:360,439`.
- ✅ C7 — replace bare `catch(e){}` blocks in `decideForAgent` and `processBountyExecutions` with `catch (err) { console.warn(...) }`.
- ✅ A4 — fix `bounty-board.ts:333,341` to mutate-in-place + `saveAll(bounties)`.
- ✅ C8 — fix `runCycle` so agents who hit age 50 after the post-cycle increment are marked dead (revealed by C4).

Result: 18/18 life-cycle tests pass. Pre-existing failures (C9, C10) deferred to PR-2 / PR-7.

### PR-2: bounty flow correctness — ✅ DONE

Fixes A5, A6, C9.

- ✅ Two-tier review confirmed by user. Added `supervisorApprove` (publisher_review → supervisor_review) and `supervisorReject` (publisher_review → executing) on `BountyBoard`. `publisherApprove` now uses `assertTransition` like the rest. `failVerification` accepts any of the three review states (submitted, publisher_review, supervisor_review) so a failure at any tier still routes through the retry/penalty logic.
- ✅ `processBountyExecutions` now walks the full path: submit → publisherApprove → supervisorApprove → runVerification → completeBounty (or failVerification on a failed test). Bounty completion is reachable for the first time since the two-tier states landed.
- ✅ `develop_skill` rewritten to bump one of the agent's existing `SkillName` values via `diploidGenome.skills` (random allele); the haploid `genome` is then re-expressed. Skill gain now survives reproduction.
- ✅ `bounty-board.test.ts` updated to walk through both review tiers; new test exercises both rejection paths.

Result: 213/213 non-dashboard tests pass. C9 cleared.

### PR-3: token-economy invariants — ✅ DONE (partial)

User decided escrow is funded by a system treasury (not by debiting the creator).

- ✅ A3 — new `Treasury` class (`supervisor/treasury.ts`), JSON-backed at `ecosystem/treasury.json`. `BountyBoard.awardBid` now debits the treasury by `bounty.reward`; on exhausted retries, `failVerification` refunds the reservation. Initial balance is `1_000_000_000` (revisit via config in PR-7).
- ✅ A7 — auto-approved proposal rewards now debit the treasury too. If the treasury can't fund a proposal, the supervisor flips it to a rejection rather than minting silently.
- ✅ C1 — `runCycle` uses the `maxAgents` parameter for both the reproduction gate and the offspring-count cap.
- ✅ C2 — `scanProposals` walks all pending proposals and notifies on first sight via a `seenProposalIds: Set<string>` field. Hydrated at `Supervisor.start()` from the existing pending log so a restart doesn't re-spam.
- ⏭ Deferred to PR-3.5 (or PR-5): unify all token mutations through a single `Supervisor.adjustBalance(agentId, delta)`. Today, `BountyBoard.deductAgentTokens`/`addAgentTokens` bypass the supervisor's in-memory `this.agents` map; if a bounty action runs before `runLifeCycle`, the in-memory copy can stomp the on-disk update at `saveAgent` time. Mitigated in practice by `loadAgents()` at the start of every cycle, but it's a real coupling bug. (New tracker: **C11**.)

Result: 221/221 non-dashboard tests pass. Added 6 Treasury tests + 2 escrow flow tests.

### PR-4: agent path consolidation — ✅ DONE

User decided to keep both deployment shells (in-process supervisor and JSON-RPC subprocess). The work shifted from "delete the loser" to "stop the two paths from drifting".

- ✅ Extracted `proxyCall` into `src/shared/llm.ts`. Both the supervisor's `decideForAgent` and the subprocess's `callLLMLocal` now go through it, so timeout (30s), retry behavior, and `tokenUsage`/`cost` reporting stay in sync.
- ✅ Deleted `src/supervisor/llm-proxy.ts`. Updated imports in `supervisor/index.ts` and `tests/unit/llm-proxy.test.ts`.
- ✅ Replaced the hand-rolled `fetch` in `agent/index.ts:callLLMLocal` with `proxyCall`. Subprocess passes a stable agent label (`subprocess-${personaName}`) so telemetry can distinguish the two paths.
- ⏭ Out of scope for PR-4: making the subprocess load `AgentState` from disk via `AGENT_ID` env (today it always starts with a fresh random genome). Tracked separately if the subprocess deployment ever needs persistence.

Result: 221/221 non-dashboard tests pass. `agent/llm-proxy.ts` (the genome→prompt helper, distinct from the LLM client) is left in place.

### PR-5: genome model — ✅ DONE

Conservative scope: the active drift risk was eliminated in PR-2 (the only two mutation paths — reproduction and `develop_skill` — both keep the views in sync). PR-5 adds defense for off-path drift and removes the legacy haploid mutators that could be silently misused.

- ✅ B2 — `Supervisor.loadAgents()` now re-expresses `agent.genome` from `agent.diploidGenome` after JSON parse. Any on-disk drift (manual edits, third-party writers, replays from older code) is silently corrected. The diploid stays the source of truth; the haploid is treated as a derived snapshot.
- ✅ B3 — deleted `mutate`, `forceMutate`, `cloneGenome`, and `applyMutation` from `agent/genome.ts`. They were exported but unused by the live cycle, and a future contributor reaching for `mutate(genome)` would have hit a silent bug (mutation lost at the next reproduction). Test file `tests/unit/agent.genome.test.ts` updated to drop the matching describe blocks.
- ⏭ Not done: making `agent.genome` a real getter / dropping the field entirely. That requires changing every read site (brain, dashboard, logging, JSON serialization). Worth doing later but the cost/benefit isn't there now that drift is bounded.

Result: 215/215 non-dashboard tests pass (was 221; the -6 are the deleted legacy-mutator tests).

### PR-6: security hardening — ✅ DONE (A1 only; A2 deferred for user input)

User decided to sandbox `shell_test` rather than drop it.

- ✅ A1 — `shell_test` is now disabled unless `BOUNTY_SHELL_SANDBOX_CMD` is set (safe-by-default). When set, the value is whitespace-split into argv prefix and prepended to `['sh', '-c', test.command]`, then exec'd via `execFileSync` (no shell interpretation of the sandbox prefix itself). Recommended values for production are documented in `.env.example` (`bwrap --ro-bind / / --tmpfs /tmp --unshare-net ...`). The pre-existing `execSync(test.command)` was a straightforward RCE — anyone (including agents) posting a bounty could have shell access to the host.
- ✅ Tests: existing shell_test test updated to set `BOUNTY_SHELL_SANDBOX_CMD=env` (universal no-op passthrough). New test asserts safe-by-default — shell_test fails without the sandbox env var.
- ⏭ A2 (email approval auth) — **still waiting for user input**. The email-reply path uses substring-match on the `From:` header, which is trivially spoofable. Two options:
  - **HMAC**: include a signed token in the proposal email body, verify on parse.
  - **Retire email**: rely on the dashboard's auth (which landed recently) for human-in-the-loop approval.

### PR-7: performance & polish — partial

Done in this branch:
- ✅ D1 — `EventLog` now caches `{ hash, count }` of the chain tail. Hydrated lazily, updated in place on every append. `append()` is now O(1) instead of O(N) (was re-reading the entire JSONL file every call).
- ✅ C6 — `agentLastProposal` and `pendingDigest` moved off module scope onto `Supervisor` instance fields. Threaded through `decideForAgent` as parameters. (Persistence to disk deferred — current behavior is "in-memory, resets on restart" with the trade-off that a chatty agent could double-propose right after a restart.)
- ✅ E1 — README rewritten to match the live architecture (single supervisor process, treasury, two-tier bounty review, sandboxed shell_test).

Deferred to a follow-up:
- ⏭ D2 — atomic `appendJSONL` (low frequency, low risk).
- ⏭ D3 — async `execFile` in verification (negligible perf gain at current cycle frequency).
- ⏭ D4 — cache `listBounties('open')` once per cycle.
- ⏭ D5 — extract elimination/reproduction constants to a config table.
- ⏭ D6 — replace `parseDecision` ad-hoc validation with a Zod schema.
- ⏭ C5 — persist `scheduler.currentCycle` to disk.
- ⏭ C10 — fix `tests/unit/dashboard-server.test.ts` (31 failures from auth-without-test-headers); requires walking through the auth scheme and adding token headers everywhere.

## Sequencing

```
PR-1 (tripwires) ─┬─> PR-2 (bounty flow) ──> PR-3 (token economy) ──┐
                  ├─> PR-4 (agent path)   ──> PR-5 (genome model) ──┼─> PR-7 (polish)
                  └─> PR-6 (security)                               ─┘
```

PR-1 first. Then PR-2/PR-4/PR-6 can run in parallel — they touch disjoint files.
PR-3 before PR-5. PR-7 last (cheap to rebase).

## Open questions for the user

1. **Bounty review tiers** (PR-2): single review stage, or two-tier publisher+supervisor?
2. **Bounty creator solvency** (PR-3): does the creator pay on award, or is escrow funded by a system treasury?
3. **Agent subprocess** (PR-4): keep, delete, or defer?
4. **`shell_test`** (PR-6): delete, allowlist, or sandbox?
5. **Auto-approved proposal rewards** (PR-3, A7): minted from nothing today — same fix as A3 or different policy?
6. **PR cadence**: one PR per cluster, or stack commits on this branch and one big PR at the end?
