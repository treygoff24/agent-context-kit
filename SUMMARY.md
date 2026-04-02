# Build Summary — agent-context-kit

## What Was Done

### 1. Source Layout Reviewed

**Files reviewed:** All 13 TypeScript source files currently present under `src/`.

Reviewed files:
- `src/index.ts`
- `src/types.ts`
- `src/sanitizer/tool-result-sanitizer.ts`
- `src/artifacts/store.ts`
- `src/guards/char-estimator.ts`
- `src/guards/context-guard.ts`
- `src/guards/index.ts`
- `src/guards/session-guard.ts`
- `src/guards/truncation.ts`
- `src/compaction/config.ts`
- `src/compaction/index.ts`
- `src/compaction/instructions.ts`
- `src/compaction/utils.ts`

### 2. Current Source Capabilities

**Types and public API:**
- `src/types.ts` defines the shared message, transcript, summarizer, runtime, and artifact envelope types.
- `src/index.ts` re-exports the package's public API across sanitizer, artifacts, guards, and compaction modules.
- `src/guards/index.ts` and `src/compaction/index.ts` provide sub-barrel exports.

**Artifact persistence:**
- `src/artifacts/store.ts` implements SHA-256-based artifact IDs, validation for relative artifact directories, atomic writes, metadata/body split storage, legacy `.jsonl` compatibility, duplicate detection, quota checks, pruning, and a disk-backed store backend.

**Tool-result sanitization and guardrails:**
- `src/sanitizer/tool-result-sanitizer.ts` classifies tool output risk (`safe`, `oversized`, `blob_like`, `giant`), extracts structured facts, detects artifact-backed read recovery cases, formats transcript stubs for persisted artifacts, and provides async sanitization helpers.
- `src/guards/char-estimator.ts` estimates message/context character counts with special handling for tool results and image blocks.
- `src/guards/truncation.ts` truncates oversized tool results with head/tail preservation and context-window-based sizing helpers.
- `src/guards/context-guard.ts` enforces tool-result context budgets, preserves artifact-backed stubs, and installs a transform hook that throws on preemptive overflow.
- `src/guards/session-guard.ts` composes sync sanitization, artifact persistence, and post-hook invariants for tool-result messages.

**Compaction utilities:**
- `src/compaction/config.ts` defines the package config surface, default config, config resolution, and phase checks.
- `src/compaction/instructions.ts` defines required summary sections, compaction instruction builders, topic-locality extraction/filtering, summary quality auditing, and a structured fallback summary.
- `src/compaction/utils.ts` provides token estimation, message text extraction, chunking, adaptive chunk sizing, oversized-summary checks, and history pruning by context share.

### 3. Current Configuration Shape

`src/compaction/instructions.ts` currently exposes a configurable `CompactionInstructionsConfig` with:
- `topicSignalCandidates`
- `offTopicMarkers`
- `globalStatusPatterns`
- `metadataLinePrefixes`
- `lowercaseTopicPhrases`

Current defaults in source:
- `topicSignalCandidates`: empty array
- `offTopicMarkers`: empty array
- `globalStatusPatterns`: generic regex defaults such as `current progress`, `open todos`, `project status`, and `daily digest`
- `metadataLinePrefixes`: empty array
- `lowercaseTopicPhrases`: empty array

`src/compaction/config.ts` currently uses these generic default paths/values:
- `entityIndexPath: "entity-index.json"`
- `psmDir: "agents"`
- `metricsPath: "context-engine-metrics.jsonl"`
- `relevanceLogPath: "relevance-log.jsonl"`

### 4. Verified File Counts

```text
src/index.ts                           176 lines
src/types.ts                           111 lines
src/sanitizer/tool-result-sanitizer.ts 709 lines
src/artifacts/store.ts                 478 lines
src/guards/char-estimator.ts           117 lines
src/guards/context-guard.ts            220 lines
src/guards/session-guard.ts            354 lines
src/guards/truncation.ts               136 lines
src/guards/index.ts                      4 lines
src/compaction/config.ts               213 lines
src/compaction/instructions.ts         452 lines
src/compaction/utils.ts                169 lines
src/compaction/index.ts                  3 lines
─────────────────────────────────────────────
Total src                             3,142 lines
```

## Decisions Made

1. **This summary is limited to what is verifiable from the current repository state.** Historical claims about what was removed or changed were omitted unless directly provable from the present source tree.
2. **The source tree currently contains 13 TypeScript files, not 10.** Both barrel files under `src/guards/index.ts` and `src/compaction/index.ts`, plus `src/index.ts`, are part of the audited source set.
3. **Current line counts were corrected to match the repository.** In particular, `src/artifacts/store.ts` is 478 lines, not 369.
4. **Current code is generic in the places reviewed.** The compaction instruction config and default config use generic arrays/patterns and generic relative paths as described above.

## Notes

Additional repository files such as `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `README.md`, and `AGENT-BUILD-GUIDE.md` exist, but this audit was scoped to `SUMMARY.md` versus the actual source code under `src/`.