# Audit fragment — guide-4b

Target file audited: `/Users/treygoff/Development/agent-context-kit/AGENT-BUILD-GUIDE.md`
Source tree audited: `/Users/treygoff/Development/agent-context-kit/src/`
Verified target file path before editing: yes

## Changes made

1. **Lines 1073-1080**
   - **What was wrong:** The guide said `makeToolResultStub` replaced giant tool output with a `~2,400 char stub`. In the source, the default preview budget is `headChars: 1_200` and `tailChars: 1_200` (`src/sanitizer/tool-result-sanitizer.ts`), but the final transcript stub also includes framing and metadata, so describing the whole stub as `~2,400 char` was too precise/misleading.
   - **What I changed:** Reworded this to say the stub is artifact-backed and, by default, contains 1,200 head chars + 1,200 tail chars **plus** framing/metadata.

2. **Lines 1093-1099**
   - **What was wrong:** The guide said `detectArtifactBackedReadRecovery()` ran "before classification." In both sanitizer paths, `classifyToolResultRisk(...)` runs first, then `detectArtifactBackedReadRecovery(...)` (`src/sanitizer/tool-result-sanitizer.ts`, `src/guards/session-guard.ts`).
   - **What I changed:** Updated the code sample/comment to reflect the real ordering: classification first, artifact-backed read detection second, before any artifact write.

3. **Lines 1135-1156**
   - **What was wrong:** The guide implied agent-context-kit itself automatically handled summary-quality retries and fallback. In the current source tree, the package exports `auditSummaryQuality()` and `buildStructuredFallbackSummary()`, and config fields like `qualityGuardEnabled` / `qualityGuardMaxRetries`, but there is no implemented retry orchestration loop in `src/` that wires those together.
   - **What I changed:** Reframed the section to accurately state that the library provides audit/fallback helpers and config knobs, while callers must implement the retry/fallback control flow.

4. **Lines 1162-1180**
   - **What was wrong:** The guide described a concrete built-in timeout escalation cascade using `timeoutMs`, `timeoutMsBase`, `timeoutMsCap`, and `maxStabilityRetryStages`. In the current source tree, those values exist in `src/compaction/config.ts`, but there is no implementation of the staged retry loop itself.
   - **What I changed:** Rewrote the section to say these are exposed configuration values only, clarified that callers must implement staged retries, and preserved the utility functions that do exist (`pruneHistoryForContextShare`, `chunkMessagesByMaxTokens`, `getMergeSummariesInstructions`, `buildStructuredFallbackSummary`).

## Source files read for this audit

- `src/compaction/instructions.ts`
- `src/compaction/config.ts`
- `src/compaction/utils.ts`
- `src/sanitizer/tool-result-sanitizer.ts`
- `src/guards/context-guard.ts`
- `src/guards/session-guard.ts`
- `src/artifacts/store.ts`
