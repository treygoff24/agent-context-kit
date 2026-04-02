# Audit Fragment — AGENT-BUILD-GUIDE.md (range 1-320)

Verified target file before editing:
- `/Users/treygoff/Development/agent-context-kit/AGENT-BUILD-GUIDE.md` exists
- `/Users/treygoff/Development/agent-context-kit/src/` exists

Source files audited against this guide range:
- `src/index.ts`
- `src/types.ts`
- `src/artifacts/store.ts`
- `src/guards/index.ts`
- `src/guards/context-guard.ts`
- `src/guards/session-guard.ts`
- `src/guards/truncation.ts`
- `src/guards/char-estimator.ts`
- `src/compaction/config.ts`
- `src/compaction/index.ts`
- `src/compaction/instructions.ts`
- `src/compaction/utils.ts`
- `src/sanitizer/tool-result-sanitizer.ts`

## Findings and fixes

1. **Lines 187-190**
   - **What was wrong:** The guide said the pre-LLM context guard throws `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE` when context still exceeds the threshold. In source, that throw happens in `installToolResultContextGuard()` after it calls `enforceToolResultContextBudgetInPlace()`. The direct in-place function does not itself throw.
   - **What I changed:** Reworded the description to say the additional throw behavior applies when using the installed wrapper via `installToolResultContextGuard()`.
   - **Source checked:** `src/guards/context-guard.ts`

2. **Lines 267-275**
   - **What was wrong:** The compaction import example omitted the actual text-extraction helper needed for the next snippet and included an unused type import.
   - **What I changed:** Replaced the unused type import with `extractMessageText`, which is the real exported helper from `src/compaction/utils.ts` via `src/compaction/index.ts`.
   - **Source checked:** `src/compaction/utils.ts`, `src/compaction/index.ts`, `src/index.ts`

3. **Lines 294-297**
   - **What was wrong:** The guide used `extractMessageTextContent(m)`, which does not exist in the audited `src/` tree.
   - **What I changed:** Replaced it with `extractMessageText(m)`, which is the real exported function on the `agent-context-kit/compaction` path.
   - **Source checked:** `src/compaction/utils.ts`, `src/compaction/index.ts`

4. **Lines 305-322**
   - **What was wrong:** The guide imported `estimateMessagesTokens` and `stripToolResultDetails` but did not use them, while the comment referenced `getMergeSummariesInstructions()` without importing it.
   - **What I changed:** Updated the import block to import `getMergeSummariesInstructions` instead, then added `const mergeInstructions = getMergeSummariesInstructions();` so the example matches the public API it mentions.
   - **Source checked:** `src/compaction/instructions.ts`, `src/compaction/index.ts`

## Result

Patched only `AGENT-BUILD-GUIDE.md` within the assigned section and wrote this audit fragment. No other repo files were modified.
