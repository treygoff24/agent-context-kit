# Documentation Audit — agent-context-kit

Date: 2026-04-01
Repo: `/Users/treygoff/Development/agent-context-kit`

## Scope

Audited source of truth:
- `src/index.ts`
- `src/types.ts`
- `src/sanitizer/tool-result-sanitizer.ts`
- `src/artifacts/store.ts`
- `src/guards/index.ts`
- `src/guards/char-estimator.ts`
- `src/guards/context-guard.ts`
- `src/guards/session-guard.ts`
- `src/guards/truncation.ts`
- `src/compaction/index.ts`
- `src/compaction/config.ts`
- `src/compaction/instructions.ts`
- `src/compaction/utils.ts`

Docs audited and fixed:
- `README.md`
- `AGENT-BUILD-GUIDE.md`

Verification run:
- `npx tsc --noEmit` ✅

## Summary

I re-checked the docs against the current `src/` tree and fixed source/doc mismatches, compile-bad import examples, and claims that were not supportable from the package source. The biggest pattern was docs attributing runtime compaction/retry behavior to helpers and config fields that the current library exports but does not itself orchestrate.

## Inaccuracies Found and Fixed

### README.md

1. **Unverifiable operational claims in the header**
   - Problem: the opening description claimed continuous 24/7 production operation, 1M-token contexts, and 6+ providers.
   - Source reality: none of that is provable from `src/`.
   - Fix: rewrote the header description to source-backed package capabilities only.

2. **Architecture diagram overstated built-in compaction behavior**
   - Problem: Layer 2 claimed the library itself triggers compaction, chunks history, runs adaptive timeouts, retries on failed audits, and falls back automatically.
   - Source reality: `src/guards/context-guard.ts` only truncates/clears and optionally throws `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE`; compaction orchestration is caller-owned.
   - Fix: rewrote Layer 2 to describe budget enforcement plus caller-owned compaction using exported helpers.

3. **"What It Achieves" included unsupported benchmark / provider / production claims**
   - Problem: claims like 40–60% reduction, zero crashes, sub-millisecond classification, provider compatibility, and 1M-token testing were not source-verifiable.
   - Source reality: the code exposes classification, artifacting, guards, and helpers; it does not prove those runtime outcomes.
   - Fix: replaced with source-backed capability bullets.

4. **`classifyToolResultRisk()` description claimed measured performance**
   - Problem: documented as “Sub-millisecond”.
   - Source reality: the function is pure and local, but the source does not establish a latency benchmark.
   - Fix: changed description to “Pure function; no external calls.”

5. **Context-guard budget description was imprecise**
   - Problem: README described single-result max as “50% of context window or 400K chars” and overflow as a simple 90% threshold.
   - Source reality: `installToolResultContextGuard()` computes:
     - `contextBudgetChars = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * 0.75` (with minimum handling in code)
     - `maxSingleToolResultChars = min(contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * 0.5, HARD_MAX_TOOL_RESULT_CHARS)`
     - `preemptiveOverflowChars = max(contextBudgetChars, contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * 0.9)`
   - Fix: replaced prose with the real formulas.

6. **Tool-result extraction behavior was overgeneralized**
   - Problem: README said extraction “handles both `string` and `TextBlock[]` formats” as a general statement.
   - Source reality: the async sanitizer accepts string content, but the synchronous session-guard extraction path reads text blocks.
   - Fix: clarified async vs. sync behavior.

7. **Layer 2 narrative implied built-in compaction orchestration**
   - Problem: README said the context guard “triggers compaction” and then described summary generation / validation as if all built in.
   - Source reality: the guard only enforces budget and can throw an overflow signal; the caller uses compaction helpers.
   - Fix: rewrote the section to separate guard behavior from caller-owned summarization.

8. **Design-philosophy text made unsupported absolute claims**
   - Problem: wording like “never drops an identifier” and “quality audit catches summaries…” implied stronger guarantees than the code alone provides.
   - Source reality: the library provides recovery hints/stubs and audit helpers; whether summaries are audited depends on caller usage.
   - Fix: softened wording to match exported behavior.

9. **Artifact-read paragraph described model-training behavior not present in source**
   - Problem: claimed the system “actively teaches models” and “trains the model”.
   - Source reality: the code returns explicit recovery hints for oversized artifact-backed reads.
   - Fix: rewrote to the actual recovery-hint behavior.

10. **Credits repeated unverified production-history claims**
   - Problem: README said the extracted code had been managing production agents since January 2026.
   - Source reality: not source-verifiable.
   - Fix: reduced the credit line to the extraction fact only.

### AGENT-BUILD-GUIDE.md

1. **Intro overstated built-in functionality**
   - Problem: the guide said the library “produces structured summaries when compaction is needed”.
   - Source reality: the package provides config/instruction/audit/pruning helpers, not a full summarization loop.
   - Fix: rewrote the intro to distinguish built-in helpers from caller-owned summarization.

2. **Component boundary for `compaction/` was too strong**
   - Problem: described as “Structured summary generation when context is full”.
   - Source reality: `src/compaction/*` exports config, instructions, audit, and utility helpers.
   - Fix: changed the boundary description accordingly.

3. **LangChain snippet had wrong / incomplete imports**
   - Problem: it used `enforceToolResultContextBudgetInPlace()` without importing it, and imported unused symbols (`installToolResultContextGuard`, `ContextGuardAgent`, `ToolMessage`).
   - Source reality: `enforceToolResultContextBudgetInPlace` is exported from `agent-context-kit/guards`; the unused imports were unnecessary.
   - Fix: corrected the import block.

4. **OpenClaw snippet omitted real types it used**
   - Problem: the snippet referenced `AgentMessage` and `ToolResultPersistMeta` without importing them.
   - Source reality: `AgentMessage` is exported from the root; `ToolResultPersistMeta` is exported from `agent-context-kit/guards`.
   - Fix: added the missing imports.

5. **`CompactionConfig` section attributed runtime behavior to config-only fields**
   - Problem: the table described retries, timeouts, preview budgets, and compaction-time thresholds as if the current package executed that logic.
   - Source reality: `src/compaction/config.ts` defines defaults and `resolveConfig()`, but most fields are not consumed elsewhere in `src/`.
   - Fix: rewrote the section to describe them as exported defaults for caller-owned orchestration.

6. **`summarySectionBudgets` descriptions also implied built-in behavior**
   - Problem: they were documented as active runtime limits.
   - Source reality: they are config defaults only in the current tree.
   - Fix: changed them to caller-side budget defaults.

7. **`ContextKitPhases` prose implied meaningful built-in phase gating**
   - Problem: the guide presented these flags like active subsystem switches.
   - Source reality: they are resolved in config and queryable through `isPhaseEnabled()`, but no additional runtime logic in `src/` consumes them.
   - Fix: clarified that boundary.

8. **Budget-calculation formulas were simplified past the actual implementation**
   - Problem: guide listed direct formulas and omitted the `max(1024, ...)`, `floor(...)`, and `max(contextBudgetChars, ...)` behavior.
   - Source reality: `src/guards/context-guard.ts` uses those exact guards/formulas.
   - Fix: replaced the formulas with the actual implementation shape.

9. **Metrics table included invented target ranges**
   - Problem: rows like “Once every 20–50 turns”, “Should hover 50–80%”, “>80%”, and “<5%” were not source-backed.
   - Source reality: the package exports no such benchmarks or recommendations.
   - Fix: rewrote the third column as qualitative interpretation guidance instead of fabricated targets.

10. **Appendix A used a nonexistent compaction deep export name**
   - Problem: documented `extractMessageTextFromEntry` from `agent-context-kit/compaction`.
   - Source reality: the compaction subpath exports `extractMessageText`; only the root barrel aliases it as `extractMessageTextFromEntry`.
   - Fix: changed the deep-import reference to `extractMessageText`.

11. **Appendix B overclaimed string-content support across all guards**
   - Problem: said string `content` is accepted by “the guards and sanitizer helpers” broadly.
   - Source reality: async sanitizer + char-estimation helpers handle string content, but synchronous session-guard sanitization extracts from text blocks.
   - Fix: clarified which helpers accept string content and how `details` is handled.

12. **Appendix C overstated fail-open guarantees and fallback behavior**
   - Problem: claimed the whole system is fail-open, that structured fallback is automatically used on compaction failure, and that the overflow signal is the only intentional throw.
   - Source reality: multiple APIs can throw when `failOpen` is disabled or inputs/config are invalid; structured fallback is caller-owned.
   - Fix: rewrote the design-principle note to match actual throw/fallback boundaries.

## Result

- `README.md` corrected
- `AGENT-BUILD-GUIDE.md` corrected
- `npx tsc --noEmit` passed
