# agent-context-kit

Production-grade context window management for AI agents. Extracted from a system that has been running 24/7 since January 2026, managing 1M-token context windows across 6+ LLM providers.

Zero dependencies beyond Node.js built-ins.

## The Problem

If you're building AI agents that use tools, you've hit this wall:

**Tool outputs explode.** A single `exec` call returns the entire build log (200K+ chars). A `browser` snapshot dumps the full DOM. A `read` on a large file loads everything. A `sessions_history` call pulls back an entire conversation transcript. Each of these can consume 20-50% of your context window in one shot.

**Naive truncation loses critical information.** Head-only truncation drops the error at the bottom of the build log. Tail-only truncation drops the command that was run. Character-limit truncation cuts in the middle of a JSON object, a stack trace, or a UUID that your agent needs to reference later.

**Context fills up silently.** Your agent works fine for 20 turns, then starts hallucinating or losing track of its task. The compaction step (if you have one) produces summaries that drop file paths, commit hashes, session IDs, and the specific thing the user asked for three turns ago.

**Poison-pill outputs crash compaction.** A single 200K-character tool result gets fed into your summarizer, which has its own context window. The summarizer chokes, times out, or produces garbage. Now your agent has no history at all.

**The failure mode cascade:**
1. Agent runs `exec` → gets 180K chars of build output
2. Context fills to 95% in one turn
3. Next tool call fails or agent starts dropping context
4. Compaction triggers but can't summarize the giant blob
5. Agent loses track of what it was doing, what files it changed, what the user asked

This library solves all of these.

## Architecture

Two layers, working together:

```
                         ┌─────────────────────────────────┐
                         │     Layer 1: Runtime Guards      │
                         │   (catches at generation time)   │
                         └──────────────┬──────────────────┘
                                        │
  Tool result arrives                   ▼
  ─────────────────►  ┌──────────────────────────────┐
                      │   classifyToolResultRisk()    │
                      │                              │
                      │  < 12K chars ──► safe         │  → pass through
                      │  12K-25K    ──► oversized     │  → inline truncate (head+tail)
                      │  25K-64K    ──► blob_like     │  → artifact + stub
                      │  > 64K      ──► giant         │  → artifact + stub
                      │  base64/high entropy ► blob   │  → artifact + stub
                      └──────────┬───────────────────┘
                                 │
                    needs artifact?
                     ┌───────────┴───────────┐
                     │                       │
                     ▼                       ▼
          ┌──────────────────┐    ┌─────────────────────┐
          │  Persist artifact │    │  Inline truncation   │
          │  (content-addr)  │    │  (head + tail)       │
          │                  │    └─────────────────────┘
          │  SHA-256 → ID    │
          │  Dedup on hash   │
          │  Atomic write    │
          │  Sharded dirs    │
          └────────┬─────────┘
                   │
                   ▼
          ┌──────────────────┐
          │  Generate stub   │    → replaces content in transcript
          │                  │
          │  • tool name     │    "Use `read` with offset/limit,
          │  • head preview  │     or `rg`, `head`, `tail` against
          │  • tail preview  │     /path/to/artifact.jsonl"
          │  • error hint    │
          │  • extracted URLs│
          │  • recovery hint │
          └──────────────────┘

                         ┌─────────────────────────────────┐
                         │   Layer 2: Compaction Hardening  │
                         │  (when context pressure is high) │
                         └──────────────┬──────────────────┘
                                        │
                                        ▼
          ┌──────────────────────────────────────────────────┐
          │  Context guard detects pressure                  │
          │  (estimateContextChars > budget)                 │
          │                                                  │
          │  1. Truncate oversized tool results in-place     │
          │  2. Clear stale tool results (oldest first)      │
          │  3. If still over → trigger compaction           │
          │                                                  │
          │  Compaction:                                     │
          │  • Chunk history into summarizer-sized pieces    │
          │  • Adaptive timeouts (90s → 120s → 300s cap)    │
          │  • Required sections enforced in output          │
          │  • Identifier preservation (strict policy)       │
          │  • Topic locality awareness                      │
          │  • Quality audit with retry on failure           │
          │  • Structured fallback if all retries fail       │
          └──────────────────────────────────────────────────┘
```

## What It Achieves

- **40-60% context usage reduction** through intelligent sanitization of tool outputs
- **Zero context-overflow crashes** in 2+ months of continuous 24/7 operation
- **Sub-millisecond classification** — no tokenizer dependency, uses character-based estimation with calibrated ratios (4 chars/token for text, 2 chars/token for tool results)
- **Compatible with 6+ LLM providers** — Anthropic, OpenAI, Google, xAI, DeepSeek, Mistral. Works with any provider that uses JSON message formats.
- **Handles 1M-token context windows** — tested with Gemini 3.1 Pro, Claude Opus 4.6 1M, GPT 5.4 1M
- **Content-addressed dedup** — identical tool outputs (common in retry loops) are stored once
- **Fail-open by default** — if artifact storage fails, falls back to inline truncation. Your agent never crashes because of this library.

## Installation

```bash
npm install agent-context-kit
```

Requires Node.js >= 18.0.0. Pure ESM package — no CommonJS export.

## Quick Start

```typescript
import {
  guardToolResultMessage,
  installToolResultContextGuard,
  buildCompactionInstructions,
  auditSummaryQuality,
} from "agent-context-kit";
```

### Minimal setup: guard a single tool result

```typescript
import { guardToolResultMessage } from "agent-context-kit";

const toolResultMessage = {
  role: "toolResult" as const,
  toolName: "exec",
  toolCallId: "call_abc123",
  content: [{ type: "text", text: someMassiveBuildOutput }],
};

const guarded = guardToolResultMessage(
  toolResultMessage,
  { toolCallId: "call_abc123", toolName: "exec" },
  {
    mode: "standard",
    artifactStore: {
      enabled: true,
      rootDir: "/path/to/your/state/dir",
      dir: "tool-artifacts",
    },
  },
);

// If the output was >25K chars, `guarded` now contains a stub with:
// - head/tail previews (1200 chars each)
// - artifact ID (SHA-256 hash)
// - path to the persisted artifact
// - recovery hint telling the model how to retrieve specific sections
```

## API Reference

### Tool Result Sanitizer

The core classification and sanitization engine.

```typescript
import {
  classifyToolResultRisk,
  sanitizeToolResultForPersistence,
  DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
} from "agent-context-kit";
```

#### `classifyToolResultRisk(content, toolName, config)`

Classifies a tool result into one of four risk categories. Sub-millisecond, no external calls.

```typescript
import {
  classifyToolResultRisk,
  DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
} from "agent-context-kit";

const classification = classifyToolResultRisk(
  toolOutputText,
  "exec",
  DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
);

// classification.category: "safe" | "oversized" | "blob_like" | "giant"
// classification.needsArtifact: boolean
// classification.needsTruncation: boolean
// classification.isBase64Like: boolean
// classification.isBlobLike: boolean
// classification.charCount: number
// classification.entropy: number
```

**Default thresholds:**

| Category | Threshold | Action |
|----------|-----------|--------|
| `safe` | < 12,000 chars | Pass through |
| `oversized` | 12,000 – 25,000 chars | Inline head+tail truncation |
| `blob_like` | 25,000 – 64,000 chars, or base64/high-entropy | Artifact + stub |
| `giant` | > 64,000 chars | Artifact + stub |

Per-tool overrides let you set `aggressive` mode for tools that produce reliably large outputs (halves the thresholds):

```typescript
const config = {
  ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
  tools: {
    browser: { mode: "aggressive" },
    sessions_history: { mode: "aggressive" },
  },
};
```

#### `sanitizeToolResultForPersistence(message, config, artifactContext)`

The async version of the full sanitization pipeline. Classifies, extracts structured facts, persists artifacts, and returns the replacement message.

```typescript
import {
  sanitizeToolResultForPersistence,
  DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
  persistToolResultArtifact,
  computeArtifactId,
} from "agent-context-kit";

const result = await sanitizeToolResultForPersistence(
  message,
  DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
  {
    artifactDir: "/path/to/state/tool-artifacts",
    persistArtifact: async ({ content, toolName, toolCallId, exitCode }) => {
      return persistToolResultArtifact({
        content,
        toolName,
        toolCallId,
        artifactDir: "/path/to/state/tool-artifacts",
        exitCode,
        failOpen: true,
      });
    },
  },
);

if (result.shouldReplace && result.replacementMessage) {
  // Use result.replacementMessage in your transcript
}
if (result.isDuplicate) {
  // Identical content was already stored — dedup'd automatically
}
```

### Artifact Storage

Content-addressed, deduplicated, sharded file storage for oversized tool outputs.

```typescript
import {
  persistToolResultArtifact,
  readArtifact,
  computeArtifactId,
  resolveArtifactDir,
  checkQuota,
  pruneArtifacts,
} from "agent-context-kit";
```

#### Storage layout

Artifacts are stored as JSONL files in a sharded directory structure:

```
tool-artifacts/
  a1/
    b2/
      a1b2c3d4e5...full-sha256.jsonl   ← { metadata: {...}, content: "..." }
```

Each artifact file contains a JSON envelope with metadata and the full original content.

#### `persistToolResultArtifact(options)`

```typescript
const metadata = await persistToolResultArtifact({
  content: largeToolOutput,
  toolName: "exec",
  toolCallId: "call_xyz",
  artifactDir: resolveArtifactDir("/path/to/state"),
  exitCode: 0,
  failOpen: true, // default: true — returns null instead of throwing
});

if (metadata) {
  // metadata.id: SHA-256 hash (content-addressed)
  // metadata.path: absolute path to the artifact file
  // metadata.chars: character count
  // metadata.bytes: byte size
  // metadata.lineCount: line count
  // metadata.isDuplicate: true if content already existed
  // metadata.createdAt: timestamp
}
```

#### Quota management

```typescript
const quota = await checkQuota("/path/to/state/tool-artifacts");
// quota.totalBytes: total size of all artifacts
// quota.artifactCount: number of stored artifacts

// Prune artifacts older than 7 days
const removed = await pruneArtifacts("/path/to/state/tool-artifacts", {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  dryRun: false,
});
```

### Context Guard

Installs a `transformContext` hook on your agent that enforces context budget before each LLM call.

```typescript
import { installToolResultContextGuard } from "agent-context-kit";

// Your agent object needs a `transformContext` slot
const agent = {
  transformContext: undefined as
    | ((messages: AgentMessage[], signal: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>)
    | undefined,
};

const uninstall = installToolResultContextGuard({
  agent,
  contextWindowTokens: 200_000, // your model's context window
});

// Now agent.transformContext will:
// 1. Truncate any single tool result exceeding the per-result budget
// 2. If total context exceeds budget, compact stale tool results (oldest first)
// 3. Skip artifact-backed stubs (they're already compact)
// 4. Throw PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE if still over 90% after enforcement

// To remove the guard:
uninstall();
```

The guard computes budgets from your context window size:
- **Context budget:** 75% of context window (in estimated chars)
- **Single tool result max:** 50% of context window or 400K chars (whichever is smaller)
- **Preemptive overflow:** throws at 90% to trigger compaction before the provider rejects

### Session Guard

The synchronous, session-level guard that integrates into your message persistence pipeline.

```typescript
import { guardToolResultMessage } from "agent-context-kit";
import type { GuardHooks } from "agent-context-kit";

const hooks: GuardHooks = {
  beforePersist: (message) => {
    // Transform the message before sanitization (e.g., add metadata)
    return message;
  },
  afterPersist: (message, meta) => {
    // Transform after sanitization (e.g., log, emit metrics)
    console.log(`Processed ${meta.toolName} result`);
    return message;
  },
};

const guarded = guardToolResultMessage(
  incomingToolResult,
  { toolCallId: "call_123", toolName: "exec" },
  {
    mode: "standard",
    thresholds: {
      inlineSoftChars: 12_000,
      artifactChars: 25_000,
      giantChars: 64_000,
    },
    artifactStore: {
      enabled: true,
      rootDir: process.cwd(),
      dir: "tool-artifacts",
      failOpen: true,
    },
  },
  hooks,
);
```

`guardToolResultMessage` runs the full pipeline synchronously:
1. Creates a sanitizer transform from your config
2. Applies `beforePersist` hook
3. Classifies, persists artifact if needed, generates stub
4. Applies `afterPersist` hook
5. Enforces post-hook invariants (prevents hooks from re-inflating the message)

### Compaction Instructions

Generate structured prompts for your summarizer model.

```typescript
import {
  buildCompactionInstructions,
  configureCompactionInstructions,
  auditSummaryQuality,
  extractOpaqueIdentifiers,
  extractLatestUserAsk,
  extractTopicLocalityContext,
  buildTopicLocalityInstructions,
  REQUIRED_SUMMARY_SECTIONS,
} from "agent-context-kit";
```

#### `buildCompactionInstructions(params)`

Generates the system prompt for your summarizer, including required section headings and identifier preservation rules.

```typescript
const instructions = buildCompactionInstructions({
  identifierPolicy: "strict",
  customInstructions: "This agent manages infrastructure deployments. Preserve all container IDs and port mappings.",
});

// Returns a prompt requiring these sections in order:
// ## Decisions
// ## Open TODOs
// ## Constraints/Rules
// ## Pending user asks
// ## Exact identifiers
//
// Plus: identifier preservation rules, custom focus instructions
```

#### `configureCompactionInstructions(config)`

Configure topic awareness for your domain. Call once at startup.

```typescript
configureCompactionInstructions({
  topicSignalCandidates: ["deployment", "CI pipeline", "staging environment"],
  offTopicMarkers: ["weekly standup", "team lunch"],
  lowercaseTopicPhrases: ["google sheets", "api gateway"],
});
```

#### `auditSummaryQuality(params)`

Validates that a compaction summary meets quality standards. Use this to decide whether to retry.

```typescript
const identifiers = extractOpaqueIdentifiers(conversationText);
const latestAsk = extractLatestUserAsk(messages);
const topicContext = extractTopicLocalityContext(messages);

const audit = auditSummaryQuality({
  summary: generatedSummary,
  identifiers,
  latestAsk,
  identifierPolicy: "strict",
  topicLocalityContext: topicContext,
});

if (!audit.ok) {
  console.log("Summary quality issues:", audit.reasons);
  // Possible reasons:
  // - "missing_section:## Open TODOs"
  // - "missing_identifiers:abc123,def456"
  // - "latest_user_ask_not_reflected"
  // - "thread_topic_not_reflected:deployment,staging"
  // - "off_topic_todo_contamination:weekly standup"
}
```

#### Topic locality

When compacting a conversation that has a clear thread topic, you can filter out global-status rollup messages and focus the summary on the actual work:

```typescript
import {
  extractTopicLocalityContext,
  buildTopicLocalityInstructions,
  filterMessagesForTopicLocality,
} from "agent-context-kit";

const topicContext = extractTopicLocalityContext(messages);

// Filter out global-status assistant messages that don't mention the topic
const { messages: filtered, filteredCount } = filterMessagesForTopicLocality({
  messages: rawMessages,
  context: topicContext,
});

// Generate topic-aware instructions for the summarizer
const topicInstructions = buildTopicLocalityInstructions(topicContext);
// "Topic / thread locality:
//  - Active thread: deployment-tracker | staging
//  - Current user ask: deploy the new API version to staging
//  - Anchor terms: deployment; staging environment; API v2
//  - Treat bootstrap/global-status chatter... as background..."
```

### History Pruning

Utilities for chunking and pruning message history before summarization.

```typescript
import {
  pruneHistoryForContextShare,
  chunkMessagesByMaxTokens,
  splitMessagesByTokenShare,
  estimateMessagesTokens,
  isOversizedForSummary,
} from "agent-context-kit";
```

#### `pruneHistoryForContextShare(params)`

Drop oldest messages to fit within a token budget, preserving recent context.

```typescript
const result = pruneHistoryForContextShare({
  messages: conversationHistory,
  maxContextTokens: 128_000,
  maxHistoryShare: 0.5, // use at most 50% of context for history
});

// result.messages: messages that fit within budget
// result.droppedMessages: count of messages dropped
// result.droppedTokens: tokens freed
// result.keptTokens: tokens remaining
// result.budgetTokens: the computed budget
```

#### `chunkMessagesByMaxTokens(messages, maxTokens)`

Split messages into chunks that fit within a token limit. Useful for feeding to a summarizer that has its own context window.

```typescript
const chunks = chunkMessagesByMaxTokens(messages, 30_000);
// Each chunk fits within 30K tokens (with 1.2x safety margin)
// Oversized single messages get their own chunk
```

### Truncation Utilities

Lower-level truncation functions for direct use.

```typescript
import {
  truncateToolResultText,
  truncateOversizedToolResultsInMessages,
  calculateMaxToolResultChars,
  isOversizedToolResult,
  HARD_MAX_TOOL_RESULT_CHARS, // 400,000 chars
} from "agent-context-kit";
```

#### `truncateToolResultText(text, maxChars, options)`

Intelligent truncation that preserves head and tail when the tail contains important content (errors, summaries, closing braces):

```typescript
const truncated = truncateToolResultText(buildOutput, 50_000, {
  errorTailBias: true, // allocate 50% to tail (vs 30% default)
  minKeepChars: 2_000,
});
// Keeps head, keeps the error at the tail, omits the middle
```

#### `truncateOversizedToolResultsInMessages(messages, contextWindowTokens)`

Batch-truncate all oversized tool results in a message array:

```typescript
const { messages: truncated, truncatedCount } =
  truncateOversizedToolResultsInMessages(messages, 200_000);
```

### Character Estimation

Fast token estimation without a tokenizer dependency.

```typescript
import {
  estimateContextChars,
  estimateMessageCharsCached,
  createMessageCharEstimateCache,
  CHARS_PER_TOKEN_ESTIMATE,           // 4 chars ≈ 1 token (general text)
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE, // 2 chars ≈ 1 token (tool results are denser)
} from "agent-context-kit";

const cache = createMessageCharEstimateCache();
const totalChars = estimateContextChars(messages, cache);
const approximateTokens = totalChars / CHARS_PER_TOKEN_ESTIMATE;
```

The cache uses `WeakMap<AgentMessage, number>` so entries are garbage-collected when messages leave scope.

### Configuration

```typescript
import { resolveConfig, DEFAULT_CONFIG, isPhaseEnabled } from "agent-context-kit";
import type { ContextKitConfig } from "agent-context-kit";

// resolveConfig merges your overrides with defaults, type-safe
const config = resolveConfig({
  compaction: {
    recentTurnsPreserve: 5,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 2,
    identifierPolicy: "strict",
    timeoutMs: 90_000,
    timeoutMsBase: 120_000,
    timeoutMsCap: 300_000,
    maxStabilityRetryStages: 3,
  },
  summarizer: {
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    reasoningEffort: "medium",
  },
});

if (isPhaseEnabled(config, "smartCompaction")) {
  // ...
}
```

### Subpath Exports

For tree-shaking or importing only what you need:

```typescript
import { classifyToolResultRisk } from "agent-context-kit/sanitizer";
import { persistToolResultArtifact } from "agent-context-kit/artifacts";
import { installToolResultContextGuard } from "agent-context-kit/guards";
import { buildCompactionInstructions } from "agent-context-kit/compaction";
```

## How It Works

### Layer 1: Runtime Tool-Output Guards

When a tool result arrives, the system runs this pipeline synchronously (no async, no network calls for classification):

1. **Extract text** from the message content (handles both `string` and `TextBlock[]` formats).
2. **Check for artifact-backed reads** — if the tool is `read` and the path points inside the artifact directory, the system either allows chunked reads through or replaces the content with a recovery hint telling the model to use `offset`/`limit`.
3. **Classify risk** using character count, Shannon entropy, base64 detection, and line-length heuristics. No tokenizer needed.
4. **For safe results** (< 12K chars): pass through unchanged.
5. **For oversized results** (12K–25K chars): inline truncation preserving head and tail with a recovery hint.
6. **For blob-like or giant results** (> 25K chars, or detected as base64/binary-like): persist to content-addressed artifact storage, generate a stub with structured metadata.
7. **The stub** replaces the original content in the transcript. It contains: tool name, status, size metrics, head preview (1200 chars), tail preview (1200 chars), error details if applicable, extracted URLs and file paths, and a recovery hint.

The artifact ID is the SHA-256 of the content, so identical outputs (common during retry loops) are stored exactly once.

### Layer 2: Compaction Engine Hardening

When context pressure builds, the context guard triggers compaction:

1. **Budget calculation**: The guard computes a context budget (75% of the model's context window) and a per-tool-result budget (50% of context or 400K chars max).
2. **In-place truncation**: Scans tool results from newest to oldest, truncating any that exceed the per-result budget. Artifact-backed stubs are skipped (they're already compact).
3. **Stale clearing**: If still over budget, replaces the oldest non-stub tool results with `[Old tool result content cleared]`, prioritized by a compaction score that preserves error outputs and recent results.
4. **Compaction trigger**: If the context exceeds 90% after enforcement, throws `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE` so your framework can trigger summarization.
5. **Summary generation**: Your summarizer receives `buildCompactionInstructions()` as a system prompt, requiring five sections (Decisions, Open TODOs, Constraints/Rules, Pending user asks, Exact identifiers).
6. **Quality audit**: `auditSummaryQuality()` checks the summary for required sections, identifier preservation, topic coverage, and user-ask reflection. Failed audits trigger retries.
7. **Adaptive timeouts**: Start at 90s, escalate to 120s, cap at 300s. Each retry stage gets more time.
8. **Structured fallback**: If all retries fail, `buildStructuredFallbackSummary()` produces a minimal valid summary rather than losing everything.

### The Stub Format

When a tool result is replaced, the stub looks like this in the transcript:

```
[Tool result: exec]
Status: ERROR (exit code 1)
Size: 184293 chars, 4521 lines, 184293 bytes
Type: Structured JSON [preview only - full content stored in artifact]
Artifact: a1b2c3d4...
Path: /state/tool-artifacts/a1/b2/a1b2c3d4....jsonl

--- Preview (head) ---
$ npm run build
> tsc --noEmit && ...

--- Preview (tail) ---
error TS2345: Argument of type 'string' is not assignable to parameter...

⚠️ Error: Argument of type 'string' is not assignable

URLs (2): https://github.com/..., https://docs.example.com/...
Paths: src/index.ts, tsconfig.json

💡 Recovery: Use targeted retrieval only. Use `read` with offset/limit,
or `head`, `tail`, `rg` against /state/tool-artifacts/a1/b2/a1b2c3d4....jsonl
(artifact a1b2c3d4...). Do not request the full artifact or re-dump it into
the transcript; search/page small sections first to avoid re-artifacting loops.
```

Models learn quickly that the recovery hint tells them exactly how to get the information they need. Instead of requesting the full content, they issue targeted reads.

## Design Philosophy

**Correctness over speed.** The system never drops an identifier, a file path, a URL, or an error message without preserving a recovery path. Stubs always contain enough preview to understand what the content was, and a path to get more. The quality audit catches summaries that lose track of what the user asked.

**Transparency over optimization.** Every stub is human-readable. You can grep your transcript for `[Tool result:` and see exactly which outputs were sanitized, how big they were, and where the originals live. There's no opaque compression, no magic tokens, no hidden state.

**Universal JSON over binary formats.** The artifact envelope is `{ metadata: {...}, content: "..." }` — plain JSON. The message types use standard content block arrays that work with Anthropic, OpenAI, Google, and every other provider. No provider-specific serialization.

**Fresh reads over cached stale data.** The system actively teaches models to use targeted retrieval. When a model tries to read an artifact file without chunking parameters, the guard intercepts and returns a hint: "Use `read` with offset/limit." This trains the model to page through large content instead of dumping it all into context.

**Fail-open by default.** If the artifact directory doesn't exist, if the disk is full, if the hash somehow collides — the system falls back to inline truncation. `failOpen: true` is the default on every persistence call. Your agent keeps working; it just has less context.

## Integration Guide

See [AGENT-BUILD-GUIDE.md](./AGENT-BUILD-GUIDE.md) for detailed integration instructions, including:

- How to wire the session guard into your agent's message pipeline
- How to configure the context guard for different model context windows
- How to set up the compaction loop with your summarizer
- How to handle the preemptive overflow signal

## Credits

Extracted from the [OpenClaw](https://openclaw.com) agent framework, where it has been managing context windows for persistent AI agents in production since January 2026.

<!-- TODO: Link to blog post about the extraction -->

## License

MIT
