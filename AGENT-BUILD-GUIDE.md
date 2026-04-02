# Agent Build Guide

## How to integrate `agent-context-kit` into any AI agent runtime

This document is an integration manual for `agent-context-kit`, extracted from [OpenClaw](https://github.com/openclaw/openclaw). It is written for AI engineers and AI agents wiring the package into their own runtimes.

**What this library does:** Sanitizes oversized tool outputs, stores large results in content-addressed artifacts, enforces context budgets, and provides compaction helpers such as prompt builders, topic-locality helpers, quality auditing, and history-pruning utilities.

**What this library does NOT do:** It does not call LLMs directly and it does not implement a full summarization/retry loop for you. The compaction subsystem provides *instructions*, *audit helpers*, and *utility functions* for a summarizer that you supply.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Integration Points](#2-integration-points)
3. [Step-by-Step Adaptation Instructions](#3-step-by-step-adaptation-instructions)
4. [Configuration Reference](#4-configuration-reference)
5. [The Compaction Prompt](#5-the-compaction-prompt)
6. [Failure Modes and Debugging](#6-failure-modes-and-debugging)
7. [Tuning Guide](#7-tuning-guide)
8. [Testing Strategy](#8-testing-strategy)

---

## 1. Architecture Overview

### Component Boundaries

```
agent-context-kit
├── sanitizer/          # Classifies and replaces oversized tool results
│   └── tool-result-sanitizer.ts
├── artifacts/          # Content-addressed disk storage for replaced outputs
│   └── store.ts
├── guards/             # Runtime enforcement at two lifecycle points
│   ├── session-guard.ts    # Post-tool-execution (synchronous)
│   ├── context-guard.ts    # Pre-LLM-call (context budget enforcement)
│   ├── truncation.ts       # Low-level text truncation utilities
│   └── char-estimator.ts   # Token/char estimation with caching
└── compaction/         # Config, prompt, audit, and pruning helpers for caller-owned compaction
    ├── config.ts           # Configuration types and resolution
    ├── instructions.ts     # Prompt generation, quality auditing, topic locality
    └── utils.ts            # Chunking, token estimation, history pruning
```

### Data Flow Diagram

```
                    ┌─────────────────────────────────────────────────┐
                    │                AGENT LOOP                       │
                    │                                                 │
                    │  ┌──────────┐    ┌──────────┐    ┌──────────┐  │
                    │  │  User    │───▶│   LLM    │───▶│  Tool    │  │
                    │  │ Message  │    │  Call     │    │ Execute  │  │
                    │  └──────────┘    └──────────┘    └────┬─────┘  │
                    │       ▲               ▲               │        │
                    │       │               │               ▼        │
                    │       │          ┌────┴────┐   ┌──────────┐   │
                    │       │          │ Context │   │ Session  │   │
                    │       │          │ Guard   │   │ Guard    │   │
                    │       │          │ (pre-   │   │ (post-   │   │
                    │       │          │  LLM)   │   │  tool)   │   │
                    │       │          └────┬────┘   └────┬─────┘   │
                    │       │               │             │          │
                    │       │               │             ▼          │
                    │       │               │      ┌──────────┐     │
                    │       │               │      │Sanitizer │     │
                    │       │               │      │ classify │     │
                    │       │               │      │ + stub   │     │
                    │       │               │      └────┬─────┘     │
                    │       │               │           │            │
                    │       │               │           ▼            │
                    │       │               │    ┌────────────┐     │
                    │       │               │    │ Artifact   │     │
                    │       │               │    │ Store      │     │
                    │       │               │    │ (disk,     │     │
                    │       │               │    │  SHA-256)  │     │
                    │       │               │    └────────────┘     │
                    │       │               │                       │
                    │  ┌────┴───────────────┴──┐                    │
                    │  │    Compaction          │                    │
                    │  │  (when context full)   │                    │
                    │  │  instructions.ts       │                    │
                    │  │  → your summarizer     │                    │
                    │  │  → quality audit       │                    │
                    │  └───────────────────────┘                    │
                    └─────────────────────────────────────────────────┘
```

### Independence vs. Coupling

| Component | Dependencies | Can use standalone? |
|-----------|-------------|-------------------|
| **Sanitizer** (`sanitizer/`) | Artifact Store (for persistence) | Yes, with inline truncation fallback if no artifact store |
| **Artifact Store** (`artifacts/`) | None (pure disk I/O) | Yes, fully independent |
| **Session Guard** (`guards/session-guard.ts`) | Sanitizer + Artifact Store | Yes — the main integration entry point for post-tool processing |
| **Context Guard** (`guards/context-guard.ts`) | Char Estimator, Truncation | Yes, fully independent of Sanitizer/Artifacts |
| **Truncation** (`guards/truncation.ts`) | None | Yes, pure functions |
| **Char Estimator** (`guards/char-estimator.ts`) | None | Yes, pure functions with caching |
| **Compaction Config** (`compaction/config.ts`) | None | Yes, pure config resolution |
| **Compaction Instructions** (`compaction/instructions.ts`) | Compaction Utils | Yes — generates prompts, does not call LLMs |
| **Compaction Utils** (`compaction/utils.ts`) | None | Yes, pure chunking/estimation |

**Key insight:** The Sanitizer and Context Guard are independent subsystems. The Sanitizer processes individual tool results (post-tool). The Context Guard processes the full message array (pre-LLM). They share no state. The Compaction subsystem is also independent — it generates instructions for YOUR summarizer to execute.

---

## 2. Integration Points

### 2.1 Post-Tool-Execution Hook (Session Guard)

**When:** After each tool call returns, before the result enters the transcript.

**What it does:**
1. Classifies the tool result by risk (`safe`, `oversized`, `blob_like`, `giant`)
2. If oversized: truncates inline (head/tail preview)
3. If blob-like or giant: persists full content to artifact store, replaces with stub
4. Detects artifact-backed read loops and returns recovery instructions
5. Enforces post-hook invariants (caps details payload, preserves stub markers)

**Entry point:**

```typescript
import {
  guardToolResultMessage,
  createSyncSanitizerTransform,
  type ToolResultHandlingConfigInput,
  type ToolResultPersistMeta,
  type GuardHooks,
} from "agent-context-kit/guards";

// Option A: One-shot guard (simplest)
const guardedMessage = guardToolResultMessage(
  toolResultMessage,    // AgentMessage with role "toolResult"
  { toolCallId: "call_123", toolName: "exec" },
  toolResultHandlingConfig,
  hooks  // optional { beforePersist, afterPersist }
);

// Option B: Reusable transform (better for loops — resolves artifact dir once)
const transform = createSyncSanitizerTransform(toolResultHandlingConfig);
const guardedMessage = transform(toolResultMessage, { toolCallId: "call_123", toolName: "exec" });
```

**The `ToolResultHandlingConfigInput`:**

```typescript
const config: ToolResultHandlingConfigInput = {
  mode: "standard",               // "off" | "standard" | "aggressive"
  thresholds: {
    inlineSoftChars: 12_000,      // Above this: truncate inline
    artifactChars: 25_000,        // Above this: persist to artifact
    giantChars: 64_000,           // Above this: always artifact, no questions
    blobLineChars: 800,           // Lines longer than this: blob detection
    emergencySyncCeilingChars: 400_000,  // Hard ceiling, always artifact
  },
  preview: {
    headChars: 1_200,
    tailChars: 1_200,
    errorTailBias: true,          // Errors get 2x tail preview
    structuredSummaryPreferred: true,
  },
  detection: {
    base64RatioThreshold: 0.9,
    highEntropyThreshold: 4.2,
    enableBlobDetection: true,
    enableHashDedup: true,
  },
  tools: {
    exec: { mode: "aggressive" },   // Per-tool overrides
    browser: { mode: "balanced" },
  },
  artifactStore: {
    enabled: true,
    dir: "tool-artifacts",          // Relative to rootDir
    rootDir: "/path/to/state/dir",  // Absolute base path
    failOpen: true,                 // Gracefully degrade if storage fails
  },
};
```

### 2.2 Pre-LLM-Call Hook (Context Guard)

**When:** Before sending messages to the model. Enforces the total context budget.

**What it does:**
1. Truncates any individual tool result that exceeds the single-result budget
2. If total context still exceeds budget: progressively clears stale tool results (lowest priority first)
3. If you install the wrapper via `installToolResultContextGuard()`, it additionally throws `Error` with `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE` when post-enforcement context still exceeds the preemptive overflow threshold

**Entry point:**

```typescript
import {
  installToolResultContextGuard,
  enforceToolResultContextBudgetInPlace,
  type ContextGuardAgent,
} from "agent-context-kit/guards";

// Option A: Install on an agent object (monkey-patches transformContext)
const agent: ContextGuardAgent = {
  transformContext: existingTransform,  // optional — will be chained
};
const uninstall = installToolResultContextGuard({
  agent,
  contextWindowTokens: 200_000,  // Your model's context window
});
// Now agent.transformContext enforces budgets
// Call uninstall() to remove the guard

// Option B: Direct enforcement on a message array (mutates in-place)
enforceToolResultContextBudgetInPlace({
  messages,                               // AgentMessage[]
  contextBudgetChars: 600_000,           // 200K tokens × 4 chars/token × 0.75 headroom
  maxSingleToolResultChars: 200_000,     // max chars for any single tool result
});
```

**Budget calculation internals:**
- `contextBudgetChars = max(1024, floor(contextWindowTokens × CHARS_PER_TOKEN_ESTIMATE × 0.75))`
- `maxSingleToolResultChars = max(1024, min(floor(contextWindowTokens × TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE × 0.5), HARD_MAX_TOOL_RESULT_CHARS))`
- `preemptiveOverflowChars = max(contextBudgetChars, floor(contextWindowTokens × CHARS_PER_TOKEN_ESTIMATE × 0.9))`

**Compaction priority (lowest = cleared first):**

| Priority | Description |
|----------|-------------|
| 0 | Already-cleared placeholders |
| 1 | Already-compacted placeholders |
| 2 | Already-truncated notices |
| 3 | Truncation-notice content |
| 5 | Regular tool results (default) |
| 7 | Results with error keywords in tail |
| 8 | Results with summary/result keywords in tail |
| 9 | Error results (`isError: true`) |
| 10 | Artifact-backed stubs (NEVER cleared — already minimal) |

### 2.3 Compaction Trigger

**When:** Context pressure exceeds your threshold. This is YOUR responsibility to detect and trigger.

**How to detect context pressure:**

```typescript
import {
  estimateContextChars,
  createMessageCharEstimateCache,
  CHARS_PER_TOKEN_ESTIMATE,
} from "agent-context-kit/guards";

const cache = createMessageCharEstimateCache();
const currentChars = estimateContextChars(messages, cache);
const budgetChars = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * 0.75;
const pressure = currentChars / budgetChars;  // 0.0 to 1.0+

if (pressure > 0.8) {
  // Time to compact
}
```

### 2.4 Compaction Execution

**Step 1: Build the compaction prompt**

```typescript
import {
  buildCompactionInstructions,
  buildTopicLocalityInstructions,
  extractTopicLocalityContext,
  extractOpaqueIdentifiers,
  extractLatestUserAsk,
  extractMessageText,
  configureCompactionInstructions,
} from "agent-context-kit/compaction";

// Optional: configure domain-specific signals (call once at startup)
configureCompactionInstructions({
  topicSignalCandidates: ["deployment", "migration", "API refactor"],
  offTopicMarkers: ["weekly standup", "sprint planning"],
  globalStatusPatterns: [/current progress/i, /status update/i],
});

// Build the system prompt for your summarizer
const instructions = buildCompactionInstructions({
  identifierPolicy: "strict",  // or "off"
  customInstructions: "Emphasize file paths and error states.",
});

// Extract topic context for locality-aware compaction
const topicContext = extractTopicLocalityContext(messages);
const localityBlock = buildTopicLocalityInstructions(topicContext);

// Extract identifiers that MUST be preserved in the summary
const fullText = messages.map((m) => extractMessageText(m)).join("\n");
const identifiers = extractOpaqueIdentifiers(fullText);
const latestAsk = extractLatestUserAsk(messages);

// Combine into your summarizer's system prompt
const systemPrompt = [instructions, localityBlock].filter(Boolean).join("\n\n");
```

**Step 2: Prepare messages for summarization**

```typescript
import {
  pruneHistoryForContextShare,
  chunkMessagesByMaxTokens,
  getMergeSummariesInstructions,
} from "agent-context-kit/compaction";

// Prune history to fit within the summarizer's context window
const { messages: prunedMessages, droppedTokens } = pruneHistoryForContextShare({
  messages: historyMessages,
  maxContextTokens: summarizerContextWindow,
  maxHistoryShare: 0.5,
});

// If still too large, chunk and summarize in parts
const chunks = chunkMessagesByMaxTokens(prunedMessages, summarizerContextWindow * 0.4);
const mergeInstructions = getMergeSummariesInstructions();
// Summarize each chunk, then merge using mergeInstructions
```

**Step 3: Audit summary quality**

```typescript
import {
  auditSummaryQuality,
  buildStructuredFallbackSummary,
  hasRequiredSummarySections,
} from "agent-context-kit/compaction";

const audit = auditSummaryQuality({
  summary: generatedSummary,
  identifiers,
  latestAsk,
  identifierPolicy: "strict",
  topicLocalityContext: topicContext,
});

if (!audit.ok) {
  // Retry with feedback: audit.reasons tells you what failed
  // e.g., ["missing_section:## Open TODOs", "missing_identifiers:abc123"]
  // If retries exhausted:
  const fallback = buildStructuredFallbackSummary(previousSummary);
}
```

### 2.5 Artifact Lifecycle

**Creation:** Artifacts are created by the sanitizer when a tool result is too large for inline retention (`artifactChars` / giant-result thresholds) or is detected as blob-/artifact-worthy content (for example base64-like, high-entropy, or very long-line payloads). The artifact ID is the SHA-256 hash of the content.

**Storage format:** artifacts are sharded under `{artifactDir}/{shard1}/{shard2}/` using the content hash as the filename stem. Current builds store the body and metadata separately as `{id}.body` and `{id}.meta.json`. The library also still reads legacy `{id}.jsonl` envelopes for backward compatibility.

**Deduplication:** If the same content is persisted twice, the second call returns the existing metadata with `isDuplicate: true`. No disk write occurs.

**Reading:**

```typescript
import {
  readArtifact,
  readArtifactMetadata,
  checkArtifactExists,
  artifactPathFor,
} from "agent-context-kit/artifacts";

const envelope = await readArtifact(artifactId, artifactDir);
// envelope = { metadata: ArtifactMetadata, content: string } | null
```

**Pruning:**

```typescript
import { pruneArtifacts, checkQuota } from "agent-context-kit/artifacts";

const quota = await checkQuota(artifactDir);
// { totalBytes: number, artifactCount: number }

const removed = await pruneArtifacts(artifactDir, {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,  // 7 days
  dryRun: false,
});
```

---

## 3. Step-by-Step Adaptation Instructions

### 3.1 Custom Agent Loop (Base Case)

This is the most common integration pattern — a `while` loop that alternates between LLM calls and tool execution.

```typescript
import {
  createSyncSanitizerTransform,
  enforceToolResultContextBudgetInPlace,
  estimateContextChars,
  createMessageCharEstimateCache,
  CHARS_PER_TOKEN_ESTIMATE,
  type ToolResultHandlingConfigInput,
  type AgentMessage,
} from "agent-context-kit";

// === SETUP (once) ===

const CONTEXT_WINDOW_TOKENS = 200_000;

const sanitizerConfig: ToolResultHandlingConfigInput = {
  mode: "standard",
  artifactStore: {
    enabled: true,
    dir: "tool-artifacts",
    rootDir: "/path/to/agent/state",
    failOpen: true,
  },
};

const sanitize = createSyncSanitizerTransform(sanitizerConfig);

// === AGENT LOOP ===

const messages: AgentMessage[] = [];

while (true) {
  // 1. ENFORCE CONTEXT BUDGET (pre-LLM)
  enforceToolResultContextBudgetInPlace({
    messages,
    contextBudgetChars: CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE * 0.75,
    maxSingleToolResultChars: Math.min(
      CONTEXT_WINDOW_TOKENS * 2 * 0.5,
      400_000
    ),
  });

  // 2. CHECK IF COMPACTION NEEDED
  const cache = createMessageCharEstimateCache();
  const currentChars = estimateContextChars(messages, cache);
  const budgetChars = CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE * 0.75;
  if (currentChars / budgetChars > 0.8) {
    // Run compaction (see Section 2.4)
    const summary = await runCompaction(messages);
    const recentTurnsPreserve = 3; // matches the library's default compaction config
    // Replace history with summary + recent turns
    messages.splice(0, messages.length - recentTurnsPreserve, {
      type: "compaction",
      id: crypto.randomUUID(),
      summary,
    } as any);
  }

  // 3. SEND TO LLM
  const response = await callLLM(messages);
  messages.push(response.assistantMessage);

  // 4. PROCESS TOOL CALLS
  if (!response.toolCalls?.length) break;  // No tools = done

  for (const toolCall of response.toolCalls) {
    const rawResult = await executeTool(toolCall);

    // 5. SANITIZE TOOL RESULT ← agent-context-kit hooks here
    const sanitized = sanitize(rawResult, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    messages.push(sanitized);
  }
}
```

### 3.2 LangChain / LangGraph

LangChain tools return results through the tool execution pipeline. Hook into the output processing:

```typescript
import {
  createSyncSanitizerTransform,
  enforceToolResultContextBudgetInPlace,
} from "agent-context-kit/guards";
import type { ToolResultHandlingConfigInput } from "agent-context-kit/guards";
import { RunnableLambda } from "@langchain/core/runnables";

// === Tool Output Wrapper ===

const sanitizerConfig: ToolResultHandlingConfigInput = {
  mode: "standard",
  artifactStore: {
    enabled: true,
    dir: "tool-artifacts",
    rootDir: "./agent-state",
    failOpen: true,
  },
};

const sanitize = createSyncSanitizerTransform(sanitizerConfig);

// Wrap any LangChain tool to sanitize its output
function wrapToolWithSanitizer<T extends { name: string }>(tool: T): T {
  const original = (tool as any).invoke.bind(tool);
  (tool as any).invoke = async (input: any, config?: any) => {
    const result = await original(input, config);

    // Convert the LangChain tool result into an AgentMessage for sanitization
    const agentMsg = {
      role: "toolResult" as const,
      toolName: (tool as any).name,
      toolCallId: config?.toolCallId,
      content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }],
    };

    const sanitized = sanitize(agentMsg, {
      toolName: (tool as any).name,
      toolCallId: config?.toolCallId,
    });

    // Extract text back for LangChain
    const content = sanitized.content;
    if (Array.isArray(content)) {
      const textBlock = content.find((b: any) => b.type === "text");
      return (textBlock as any)?.text ?? result;
    }
    return result;
  };
  return tool;
}

// === Context Guard as a Runnable ===

// For LangGraph: add a context-guard node that runs before the LLM node
const contextGuardNode = new RunnableLambda({
  func: (state: { messages: any[] }) => {
    // Convert LangChain messages to AgentMessage format for the guard
    const agentMessages = state.messages.map(langChainToAgentMessage);

    enforceToolResultContextBudgetInPlace({
      messages: agentMessages,
      contextBudgetChars: 200_000 * 4 * 0.75,
      maxSingleToolResultChars: 200_000,
    });

    // Convert back to LangChain format
    return { messages: agentMessages.map(agentToLangChainMessage) };
  },
});
```

### 3.3 AutoGen / AG2

AutoGen uses a message transformation pipeline. Register agent-context-kit as a transform:

```typescript
import { createSyncSanitizerTransform } from "agent-context-kit/guards";
import { enforceToolResultContextBudgetInPlace } from "agent-context-kit/guards";

const sanitize = createSyncSanitizerTransform({
  mode: "standard",
  artifactStore: {
    enabled: true,
    dir: "tool-artifacts",
    rootDir: "./autogen-state",
    failOpen: true,
  },
});

// AutoGen message transform hook
class ContextKitTransform {
  /**
   * Post-tool transform: sanitize tool results before they enter the
   * conversation history.
   */
  transformToolResult(message: Record<string, any>): Record<string, any> {
    if (message.role !== "tool") return message;

    const agentMsg = {
      role: "toolResult" as const,
      toolName: message.name ?? "unknown",
      toolCallId: message.tool_call_id,
      content: [{ type: "text" as const, text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }],
    };

    const sanitized = sanitize(agentMsg, {
      toolName: message.name ?? "unknown",
      toolCallId: message.tool_call_id,
    });

    const text = Array.isArray(sanitized.content)
      ? (sanitized.content.find((b: any) => b.type === "text") as any)?.text
      : sanitized.content;

    return { ...message, content: text ?? message.content };
  }

  /**
   * Pre-LLM transform: enforce context budget on the full conversation.
   */
  transformConversation(messages: Record<string, any>[]): Record<string, any>[] {
    const agentMessages = messages.map(autogenToAgentMessage);
    enforceToolResultContextBudgetInPlace({
      messages: agentMessages,
      contextBudgetChars: 200_000 * 4 * 0.75,
      maxSingleToolResultChars: 200_000,
    });
    return agentMessages.map(agentToAutogenMessage);
  }
}

// Register with AutoGen agent
// agent.register_hook("process_message_before_send", transform.transformConversation)
```

### 3.4 CrewAI

CrewAI tools have an `_run` method. Wrap the tool output:

```typescript
import { createSyncSanitizerTransform } from "agent-context-kit/guards";

const sanitize = createSyncSanitizerTransform({
  mode: "standard",
  artifactStore: {
    enabled: true,
    dir: "tool-artifacts",
    rootDir: "./crewai-state",
    failOpen: true,
  },
});

// CrewAI tool wrapper
function withContextKit(tool: any): any {
  const originalRun = tool._run.bind(tool);

  tool._run = async (...args: any[]) => {
    const result = await originalRun(...args);
    const resultText = typeof result === "string" ? result : JSON.stringify(result);

    const agentMsg = {
      role: "toolResult" as const,
      toolName: tool.name,
      content: [{ type: "text" as const, text: resultText }],
    };

    const sanitized = sanitize(agentMsg, { toolName: tool.name });

    const text = Array.isArray(sanitized.content)
      ? (sanitized.content.find((b: any) => b.type === "text") as any)?.text
      : sanitized.content;

    return text ?? resultText;
  };

  return tool;
}

// Usage:
// const tool = withContextKit(new MyCrewAITool());
```

### 3.5 OpenClaw (Native Integration)

OpenClaw is the framework this library was extracted from. The integration is the most complete:

```typescript
import type { AgentMessage } from "agent-context-kit";
import {
  createSyncSanitizerTransform,
  enforcePostHookInvariants,
  installToolResultContextGuard,
  type GuardHooks,
  type ToolResultPersistMeta,
} from "agent-context-kit/guards";
import {
  buildCompactionInstructions,
  extractTopicLocalityContext,
  buildTopicLocalityInstructions,
  auditSummaryQuality,
  configureCompactionInstructions,
} from "agent-context-kit/compaction";
import { resolveConfig } from "agent-context-kit/compaction";

// === transformContext hook (pre-LLM) ===
// installToolResultContextGuard wraps the agent's transformContext
const uninstall = installToolResultContextGuard({
  agent: agentInstance,
  contextWindowTokens: modelContextWindow,
});

// === afterPersist hook (post-tool) ===
// The session guard runs synchronously in the persistence layer
const transform = createSyncSanitizerTransform(toolResultConfig);

const hooks: GuardHooks = {
  beforePersist: (message) => {
    // Any pre-processing before the sanitizer sees the message
    return message;
  },
  afterPersist: (message, meta) => {
    // Any post-processing after sanitization
    // e.g., logging, metrics, custom annotations
    return message;
  },
};

// In the session persistence path:
function onToolResultPersist(message: AgentMessage, meta: ToolResultPersistMeta): AgentMessage {
  const prepared = hooks.beforePersist ? hooks.beforePersist(message) : message;
  const sanitized = transform(prepared, meta);
  const postHook = hooks.afterPersist ? hooks.afterPersist(sanitized, meta) : sanitized;
  return enforcePostHookInvariants(postHook, sanitized, toolResultConfig);
}
```

---

## 4. Configuration Reference

### 4.1 `ToolResultSanitizerConfig`

The core sanitizer configuration. Controls when and how tool results are classified, truncated, or artifact-stored.

```typescript
type ToolResultSanitizerConfig = {
  mode: "off" | "standard" | "aggressive";
  thresholds: { ... };
  preview: { ... };
  detection: { ... };
  staleClearing: { ... };
  tools: Record<string, { mode?: ToolResultHandlingToolMode }>;
};
```

#### `mode`

| Value | Behavior |
|-------|----------|
| `"off"` | Sanitizer is completely disabled. All tool results pass through unchanged. |
| `"standard"` | Default. Applies thresholds as configured. |
| `"aggressive"` | Accepted at the top level by the config types, but the current implementation treats it the same as `"standard"`. Only per-tool `"aggressive"` mode actually halves thresholds. |

#### `thresholds`

| Parameter | Default | What it does | Too high | Too low |
|-----------|---------|-------------|----------|---------|
| `inlineSoftChars` | `12,000` | Above this: content is truncated inline (head+tail preview). Below this: content passes through untouched. | Lets large tool results consume context budget. 20K+ results crowd out conversation history. | Truncates useful small outputs. Below 4K, many `read` results get clipped unnecessarily. |
| `artifactChars` | `25,000` | Above this: content is persisted to artifact store and replaced with a stub. | Keeps very large outputs in the transcript. Compaction has more work to do. | Creates too many artifacts for moderate content. Disk usage grows; stubs add overhead. |
| `giantChars` | `64,000` | Above this: always artifact, regardless of blob detection or tool mode. | Allows genuinely huge outputs inline. Risk of single result blowing context. | Artifacts small outputs that could be useful inline. |
| `blobLineChars` | `800` | Lines longer than this trigger blob detection. Catches minified JS, base64, binary data. | Misses blob content with shorter lines. | False positives on legitimate long lines (URLs, paths). |
| `emergencySyncCeilingChars` | `400,000` | Hard ceiling. Content above this is ALWAYS artifacted regardless of any other setting. This is a safety valve. | No practical scenario where you'd want this higher. | Below 200K risks artifacting large-but-useful outputs unnecessarily. |

**For `"aggressive"` per-tool mode:** `inlineSoftChars` and `artifactChars` are halved for that tool.

#### `preview`

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `headChars` | `1,200` | Characters shown from the beginning of truncated/artifacted content. |
| `tailChars` | `1,200` | Characters shown from the end. For errors with `errorTailBias`, this doubles to `min(tailChars * 2, 4000)`. |
| `errorTailBias` | `true` | When the tool result is an error, allocate more preview space to the tail (where stack traces and error messages live). |
| `structuredSummaryPreferred` | `true` | When content is structured (JSON/XML/YAML/table), note the structure type in the stub for context. |

#### `detection`

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `base64RatioThreshold` | `0.9` | If ≥90% of characters are base64-alphabet characters, classify as base64-like. |
| `highEntropyThreshold` | `4.2` | Shannon entropy above this marks content as high-entropy (binary, compressed, encoded data). English text is typically 3.5-4.0. |
| `enableBlobDetection` | `true` | Enable line-length-based blob detection. |
| `enableHashDedup` | `true` | Present in the config type, but currently not consulted by the implementation. Artifact dedup still happens because artifact IDs are content hashes. |

#### `staleClearing`

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `enabled` | `true` | Present in the config type, but the current guards do not read this flag yet; stale-result clearing is currently hard-coded in the context guard. |
| `placeholder` | `"[Old tool result content cleared]"` | Present in the config type, but the current guards do not read this value yet; the placeholder text is currently hard-coded. |

#### `tools` (per-tool overrides)

```typescript
tools: {
  exec: { mode: "aggressive" },    // Halves thresholds for exec
  browser: { mode: "balanced" },    // Default behavior
  read: { mode: "off" },            // Never sanitize read results
}
```

| Tool Mode | Behavior |
|-----------|----------|
| `"off"` | Skip sanitization entirely for this tool. |
| `"balanced"` | Use standard thresholds (same as omitting the override). |
| `"aggressive"` | Halve `inlineSoftChars` and `artifactChars` for this tool. |

### 4.2 `CompactionConfig`

`CompactionConfig` is a resolved config shape exported by `src/compaction/config.ts`. In the current source tree, these values are surfaced by `DEFAULT_CONFIG` / `resolveConfig()`, but this package does not itself run a full compaction loop or consume most of these fields outside config resolution. Treat them as defaults for your caller-owned compaction pipeline.

```typescript
interface CompactionConfig {
  recentTurnsPreserve: number;
  qualityGuardEnabled: boolean;
  qualityGuardMaxRetries: number;
  maxHistoryShare: number;
  identifierPolicy: "strict" | "off";
  timeoutMs: number;
  timeoutMsBase: number;
  timeoutMsCap: number;
  oversizedToolResultChars: number;
  giantToolResultChars: number;
  previewHeadChars: number;
  previewTailChars: number;
  maxStabilityRetryStages: number;
  summarySectionBudgets: SummarySectionBudgets;
}
```

| Parameter | Default | What it does | Too high | Too low |
|-----------|---------|-------------|----------|---------|
| `recentTurnsPreserve` | `3` | Default value exposed for callers that want to keep the most recent turns verbatim during their own compaction flow. | Keeps more raw history than your app needs. | Leaves less recent verbatim context in your app's summary handoff. |
| `qualityGuardEnabled` | `true` | Default knob a caller can use to decide whether to run `auditSummaryQuality()` after summary generation. | Your app spends more time validating summaries. | Your app may skip a useful validation step. |
| `qualityGuardMaxRetries` | `1` | Default retry budget for caller-owned summary regeneration. This package does not execute the retry loop itself. | Your app may spend extra LLM calls on retries. | Your app may accept a poor summary sooner. |
| `maxHistoryShare` | `0.5` | Default history-budget share a caller can pair with `pruneHistoryForContextShare()`. | Your caller may pass too much history to the summarizer. | Your caller may prune too aggressively. |
| `identifierPolicy` | `"strict"` | Default policy value for `buildCompactionInstructions()` / `auditSummaryQuality()`. | N/A | `"off"` disables identifier-preservation checks. |
| `timeoutMs` | `90,000` | Default timeout value available to caller-owned compaction orchestration. | Your app may wait longer on a slow summarizer call. | Your app may time out earlier. |
| `timeoutMsBase` | `120,000` | Default follow-on timeout value available to callers that implement staged retries. | Same as above. | Same as above. |
| `timeoutMsCap` | `300,000` | Default upper timeout bound available to callers that implement staged retries. | Same as above. | Same as above. |
| `oversizedToolResultChars` | `16,000` | Exported default for caller-defined compaction-time tool-result handling. The current `src/` helpers do not read this value directly. | Your app may keep too much oversized content. | Your app may shrink compaction input more aggressively. |
| `giantToolResultChars` | `64,000` | Exported default for caller-defined giant-result handling during compaction. | Same as above. | Same as above. |
| `previewHeadChars` | `400` | Exported preview-budget default for caller-owned compaction summaries/snippets. | Longer previews consume more prompt budget. | Shorter previews may omit context. |
| `previewTailChars` | `400` | Exported tail-preview default for caller-owned compaction summaries/snippets. | Longer previews consume more prompt budget. | Shorter previews may omit important endings. |
| `maxStabilityRetryStages` | `3` | Exported retry-stage default for callers that implement their own stability/timeout escalation. | More caller-side retry stages. | Fewer caller-side retry stages. |

#### `summarySectionBudgets`

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `diagnosticEvidenceChars` | `2,500` | Exported default budget a caller can use when formatting diagnostic evidence in its own compaction output. |
| `toolFailuresChars` | `1,800` | Exported default budget a caller can use for tool-failure detail in its own compaction output. |
| `entityPreservedMessagesChars` | `2,200` | Exported default budget a caller can use for entity-preserved message context. |
| `recentTurnsPreservedChars` | `2,200` | Exported default budget a caller can use for its recent-turns preservation block. |

### 4.3 `CompactionInstructionsConfig`

Controls domain-specific signals for topic locality and quality auditing. Set once at startup via `configureCompactionInstructions()`.

```typescript
interface CompactionInstructionsConfig {
  topicSignalCandidates?: string[];
  offTopicMarkers?: string[];
  globalStatusPatterns?: RegExp[];
  metadataLinePrefixes?: string[];
  lowercaseTopicPhrases?: string[];
}
```

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `topicSignalCandidates` | `[]` | Phrases indicating the current topic. Used in quality audit to verify the summary reflects the thread. |
| `offTopicMarkers` | `[]` | Phrases indicating off-topic contamination. If found in summary, audit fails with `off_topic_todo_contamination`. |
| `globalStatusPatterns` | `[/current progress/i, /open todos?/i, ...]` | Regex patterns matching global-status rollup messages. These are deprioritized during topic-local compaction. |
| `metadataLinePrefixes` | `[]` | Accepted and stored by `configureCompactionInstructions()`, but not currently consulted by `extractRequestSnippet()` / `isMetadataLine()`. |
| `lowercaseTopicPhrases` | `[]` | Lowercase phrases to extract from user messages as topic anchors (e.g., `"google sheets"`, `"api migration"`). |

### 4.4 `ContextKitConfig`

The full configuration object. Used by the `resolveConfig()` function. Covers all subsystems.

```typescript
interface ContextKitConfig {
  phases: ContextKitPhases;           // Feature flags for subsystem phases
  compaction: CompactionConfig;       // Compaction config (see 4.2)
  summarizer?: CompactionSummarizerConfig;  // Summarizer model config
  entityIndexPath: string;            // Default: "entity-index.json"
  psmDir: string;                     // Default: "agents"
  metricsPath: string;                // Default: "context-engine-metrics.jsonl"
  relevanceLogPath: string;           // Default: "relevance-log.jsonl"
  salvageThreshold: number;           // Default: 0.75
  compactionRecoveryBudget: number;   // Default: 5000
  subagentContextBudget: number;      // Default: 3000
  nudgeTurnThreshold: number;         // Default: 10
  nudgeToolThreshold: number;         // Default: 15
  maxActiveEntities: number;          // Default: 200
  entityDecayRate: number;            // Default: 0.9
  entityEvictionThreshold: number;    // Default: 0.05
}
```

**`ContextKitPhases`** — Feature-flag values surfaced by `DEFAULT_CONFIG`. Most default to `false`. Core phase flags (`corePort`, `smartCompaction`, `dynamicAssembly`, `sessionSearch`, `subagentIntelligence`, `turnLearning`) default to `true`. In the current `src/` tree, these flags are resolved and queryable via `isPhaseEnabled()`, but they are not consumed by additional runtime logic here.

```typescript
resolveConfig();           // Returns DEFAULT_CONFIG with deep-cloned objects
resolveConfig({ compaction: { recentTurnsPreserve: 5 } });  // Merges overrides
isPhaseEnabled(config, "smartCompaction");  // true
```

### 4.5 `ToolResultHandlingConfigInput`

The session guard's config input. Superset of the sanitizer config with artifact store settings.

```typescript
type ToolResultHandlingConfigInput = {
  mode?: string;                             // "off" | "standard" | "aggressive"
  thresholds?: Record<string, number>;       // Partial override of sanitizer thresholds
  preview?: Record<string, unknown>;         // Partial override of preview settings
  detection?: Record<string, unknown>;       // Partial override of detection settings
  staleClearing?: Record<string, unknown>;   // Partial override of stale clearing
  tools?: Record<string, { mode?: ToolResultHandlingToolMode }>;
  artifactStore?: {
    enabled?: boolean;   // Default: true unless explicitly set to false
    dir?: string;        // Default: "tool-artifacts"
    failOpen?: boolean;  // Default: true
    rootDir?: string;    // Default: process.cwd()
  };
};
```

**Gotcha:** `rootDir` defaults to `process.cwd()`. In containerized environments or when the working directory changes, artifacts end up in unexpected locations. Always set `rootDir` explicitly.

---

## 5. The Compaction Prompt

### 5.1 Required Summary Sections

Every compaction summary MUST contain these five sections in order:

```markdown
## Decisions
What was decided and why. Concrete outcomes, not process.

## Open TODOs
Unfinished work, pending actions, things that need follow-up.
Include batch progress ("5/17 items migrated").

## Constraints/Rules
Rules, policies, or constraints that were established and must persist.
Things the agent must NOT do. Configuration that was set.

## Pending user asks
The last thing the user asked for, and what was being done about it.
This section prevents the model from "forgetting" the current task
after compaction.

## Exact identifiers
UUIDs, file paths, API keys, URLs, hostnames, ports, commit SHAs,
branch names — anything opaque that cannot be reconstructed from context.
```

### 5.2 Why Each Section Exists

| Section | Failure mode it prevents |
|---------|------------------------|
| **Decisions** | Model re-asks questions that were already decided, or reverses previous choices. |
| **Open TODOs** | Model declares work "complete" when items remain. Batch progress counters get lost. |
| **Constraints/Rules** | Model violates rules that were established earlier in the session ("don't use sudo", "always use branch X"). |
| **Pending user asks** | After compaction, the model forgets what the user just asked and starts from scratch. This is the most common compaction failure. |
| **Exact identifiers** | Model hallucinates UUIDs, invents file paths, or uses the wrong API key. The original identifiers are in the compacted history and no longer in context. |

### 5.3 Customizing for Different Agent Types

**Coding agents:**

```typescript
configureCompactionInstructions({
  topicSignalCandidates: ["build", "test", "deploy", "refactor", "migration"],
  offTopicMarkers: ["meeting notes", "weekly review"],
  lowercaseTopicPhrases: ["typescript", "react", "database"],
});

const instructions = buildCompactionInstructions({
  identifierPolicy: "strict",
  customInstructions:
    "Emphasize: file paths, function names, error messages, test results, " +
    "git branch names, and build commands. Preserve exact error output " +
    "including line numbers and stack traces in the Constraints section.",
});
```

**Research agents:**

```typescript
configureCompactionInstructions({
  topicSignalCandidates: ["analysis", "findings", "methodology", "source"],
  offTopicMarkers: ["admin", "scheduling"],
  lowercaseTopicPhrases: ["study", "paper", "dataset"],
});

const instructions = buildCompactionInstructions({
  identifierPolicy: "strict",
  customInstructions:
    "Emphasize: source URLs, paper titles, author names, key statistics, " +
    "methodology details, and findings with citations. Preserve exact " +
    "quotes and numerical results.",
});
```

**Conversational agents:**

```typescript
configureCompactionInstructions({
  topicSignalCandidates: ["preference", "schedule", "reminder"],
  offTopicMarkers: [],
  lowercaseTopicPhrases: [],
});

const instructions = buildCompactionInstructions({
  identifierPolicy: "off",  // Less critical for conversation
  customInstructions:
    "Emphasize: user preferences, emotional context, relationship history, " +
    "names of people/pets/places mentioned, scheduled events, and any " +
    "promises or commitments made.",
});
```

### 5.4 Topic Locality

**The problem:** In long sessions, summaries get contaminated with "global status" content — project-wide progress dumps, daily digest info, infrastructure chatter — that drowns out the current thread's actual topic.

**How it works:**

1. `extractTopicLocalityContext(messages)` analyzes recent user messages to extract:
   - The latest user ask (the current request)
   - Thread/group/conversation labels from metadata
   - Salient anchor phrases (proper nouns, capitalized phrases)
   - Opaque identifiers from the conversation

2. `filterMessagesForTopicLocality()` removes assistant messages that are global-status rollups and don't mention any anchor terms.

3. `buildTopicLocalityInstructions()` generates a locality block for the summarizer prompt that says "focus on X, treat Y as background."

**Example output:**

```
Topic / thread locality:
- Active thread: deployment-pipeline | #ops-channel
- Current user ask: Fix the failing Docker build for the API service
- Anchor terms: Docker; API service; deployment-pipeline; nginx config
- Treat bootstrap/global-status chatter, active-thread inventories, and
  unrelated project-wide progress rollups as background unless they directly
  answer the current ask.
- Prefer the current thread's concrete work over older session status or
  infrastructure chatter.
```

### 5.5 Identifier Preservation

**Why it matters:** After compaction, the original conversation history is gone. If the summary doesn't preserve exact identifiers, the model will hallucinate them. A UUID like `a3f8c2d1-...` cannot be reconstructed; if it's dropped from the summary, the model will invent a new one.

**How it works:**

1. `extractOpaqueIdentifiers(text)` scans conversation text for patterns:
   - Hex strings ≥8 chars (UUIDs, commit SHAs, artifact IDs)
   - URLs
   - File paths (absolute or relative with slashes)
   - Host:port pairs
   - Large numeric IDs

2. `auditSummaryQuality()` checks that extracted identifiers appear verbatim in the summary. If they don't: `reasons: ["missing_identifiers:a3f8c2d1,/path/to/file"]`.

3. On retry, the audit feedback tells the summarizer exactly which identifiers were dropped.

**The `isTransportOrMetadataIdentifier` filter:** Some identifiers are "transport" — URLs, file paths, host:port pairs, numeric IDs. These are filtered from topic anchors (to avoid polluting locality signals) but still checked for preservation in summaries.

---

## 6. Failure Modes and Debugging

### 6.1 The 200K Tool Output That Crashed Compaction

**Scenario:** A single `exec` tool call returns 200K characters (e.g., `npm ls --all`, a full database dump, or a log file `cat`). Without the sanitizer, this enters the transcript verbatim. When compaction triggers, it tries to summarize a message array containing this 200K blob, exceeding the summarizer's own context window.

**How agent-context-kit prevents this:**

```
Tool returns 200K chars
  → classifyToolResultRisk: category = "giant" (exceeds giantChars: 64,000)
  → persistToolResultArtifactSync: stores full content on disk
  → makeToolResultStub: replaces it with an artifact-backed stub
     (by default, 1,200 chars of head preview + 1,200 chars of tail preview,
      plus stub framing/metadata)
  → Transcript contains only the stub
```

The stub is ~50x smaller than the original. Compaction never sees the full output.

**If the sanitizer is disabled:** The context guard (`enforceToolResultContextBudgetInPlace`) is the second line of defense. It truncates any single tool result exceeding `maxSingleToolResultChars`, then progressively clears stale results if total context exceeds budget.

### 6.2 The Re-Artifacting Loop

**Scenario:** The model sees an artifact stub that says "use `read` with offset/limit to access the full content." Instead of using offset/limit, it calls `read` on the artifact path with no pagination. The `read` returns the full 200K artifact content. The sanitizer sees another 200K result from the `read` tool and artifacts it again. The model sees another stub, calls `read` again...

**How agent-context-kit prevents this:**

```typescript
// In the sanitizer, after classification and before any artifact write:
const classification = classifyToolResultRisk(textContent, toolName, config);
const artifactBackedRead = detectArtifactBackedReadRecovery(
  message, toolName, artifactDir
);
// Returns non-null if the read targets a path under artifactDir
```

Three outcomes:

1. **No chunking parameters (offset/limit):** Returns recovery instructions instead of the read result:
   ```
   [Artifact-backed read requires chunked recovery]
   Path: /state/tool-artifacts/a3/f8/a3f8c2d1....body
   This read targeted a persisted tool-output artifact.
   Use `read` with offset/limit, or `head`, `tail`, `rg`...
   ```

2. **Has chunking parameters but still oversized:** Truncates with head/tail preview (it's a paginated read that returned a large page).

3. **Has chunking parameters and is safe-sized:** Passes through untouched.

### 6.3 Models Ignoring Recovery Hints

**Scenario:** The model reads the recovery instructions ("use offset/limit") and ignores them. It calls `read` on the artifact path again with no parameters. Or it calls a different tool to `cat` the file.

**How agent-context-kit handles this:** Resilience through layered defense:

1. **Sanitizer catches the re-read** (as described above).
2. **Context guard's `compactExistingToolResultsInPlace`** progressively clears stale tool results when context pressure rises. Older, lower-priority tool results (including repeated failed reads) are replaced with `[Old tool result content cleared]`.
3. **The stub itself is immune** — artifact-backed stubs have compaction priority 10 (highest) and are never cleared by the context guard.

The system converges: even if the model loops, the context doesn't grow. Each failed attempt generates a small recovery message that gets cleared if context pressure builds.

### 6.4 Summary Quality Degradation

**Scenario:** The summarizer (your LLM) produces a compaction summary that:
- Drops identifiers ("the UUID" instead of the actual UUID)
- Misses the current topic (summarizes old infrastructure chat instead of the current task)
- Gets contaminated with off-topic TODOs from a global status dump in the history

**What agent-context-kit provides:**

```typescript
const audit = auditSummaryQuality({
  summary: generatedSummary,
  identifiers: ["a3f8c2d1-9b7e-4f2a-8c3d-1e5f6a7b8c9d", "/src/api/handler.ts"],
  latestAsk: "Fix the Docker build",
  identifierPolicy: "strict",
  topicLocalityContext: topicContext,
});

// audit.ok = false
// audit.reasons = [
//   "missing_identifiers:a3f8c2d1-9b7e-4f2a-8c3d-1e5f6a7b8c9d",
//   "thread_topic_not_reflected:docker,build",
//   "off_topic_todo_contamination:weekly standup"
// ]
```

The library exports `auditSummaryQuality()` and `buildStructuredFallbackSummary()`, and `resolveConfig()` exposes knobs like `qualityGuardEnabled` / `qualityGuardMaxRetries`. But in the current `src/` tree, the retry loop itself is not implemented here — callers must wire `audit.reasons` back into their summarizer and decide when to fall back.

If you choose to fall back, `buildStructuredFallbackSummary(previousSummary)` returns a minimal valid summary with all required sections. If a previous summary exists and has valid sections, it's reused as-is.

### 6.5 Compaction Timeout Cascade

**Scenario:** The context is 500K+ characters. The summarizer needs to process a large input. First attempt times out at `timeoutMs` (90s). Retry at `timeoutMsBase` (120s). Still too slow.

**What agent-context-kit provides today:**

The config surface exposes the timeout/retry values:

```
timeoutMs = 90,000ms
timeoutMsBase = 120,000ms
timeoutMsCap = 300,000ms
maxStabilityRetryStages = 3
```

However, in the current `src/` tree these are configuration values only; this package does not implement the timeout escalation loop itself. If you want staged retries, you need to build that control flow in your caller and choose how to use `timeoutMs`, `timeoutMsBase`, `timeoutMsCap`, and `maxStabilityRetryStages`.

**Complementary strategies available as utilities:**
- `pruneHistoryForContextShare()` drops oldest chunks to fit within `maxHistoryShare`
- `chunkMessagesByMaxTokens()` splits messages into token-bounded chunks, which a caller can summarize independently and then merge with `getMergeSummariesInstructions()`
- `buildStructuredFallbackSummary()` can be used by the caller if retries/timeouts are exhausted

**Debugging tip:** If compaction consistently times out, your `maxHistoryShare` may be too high (keeping too much history), or your summarizer model may be too slow for the input size. Reduce `maxHistoryShare` to 0.3-0.4, or use a faster summarizer model.

---

## 7. Tuning Guide

### 7.1 By Context Window Size

#### Small Context Windows (8K-32K tokens)

Context is scarce. Aggressive sanitization, aggressive compaction.

```typescript
const sanitizerConfig: ToolResultHandlingConfigInput = {
  mode: "standard",
  thresholds: {
    inlineSoftChars: 4_000,
    artifactChars: 8_000,
    giantChars: 20_000,
    blobLineChars: 500,
    emergencySyncCeilingChars: 100_000,
  },
  preview: {
    headChars: 600,
    tailChars: 600,
    errorTailBias: true,
    structuredSummaryPreferred: true,
  },
  tools: {
    exec: { mode: "aggressive" },
    browser: { mode: "aggressive" },
    process: { mode: "aggressive" },
  },
  artifactStore: {
    enabled: true,
    dir: "tool-artifacts",
    rootDir: "/path/to/state",
    failOpen: true,
  },
};

const compactionConfig = resolveConfig({
  compaction: {
    recentTurnsPreserve: 2,
    maxHistoryShare: 0.3,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
    summarySectionBudgets: {
      diagnosticEvidenceChars: 1_000,
      toolFailuresChars: 800,
      entityPreservedMessagesChars: 1_000,
      recentTurnsPreservedChars: 1_000,
    },
  },
});
```

**Trigger compaction at 60-70% pressure** (not 80% — small windows have less margin).

#### Medium Context Windows (128K tokens)

Default configuration works well. Adjust based on agent type.

```typescript
const sanitizerConfig: ToolResultHandlingConfigInput = {
  mode: "standard",
  // Defaults are calibrated for ~128K
  artifactStore: {
    enabled: true,
    dir: "tool-artifacts",
    rootDir: "/path/to/state",
    failOpen: true,
  },
};

const compactionConfig = resolveConfig();  // All defaults
```

**Trigger compaction at 75-80% pressure.**

#### Large Context Windows (200K-1M tokens)

Context is abundant. Be more generous with inline content; compact less often.

```typescript
const sanitizerConfig: ToolResultHandlingConfigInput = {
  mode: "standard",
  thresholds: {
    inlineSoftChars: 25_000,
    artifactChars: 50_000,
    giantChars: 128_000,
    blobLineChars: 1_200,
    emergencySyncCeilingChars: 400_000,
  },
  preview: {
    headChars: 2_400,
    tailChars: 2_400,
    errorTailBias: true,
    structuredSummaryPreferred: true,
  },
  artifactStore: {
    enabled: true,
    dir: "tool-artifacts",
    rootDir: "/path/to/state",
    failOpen: true,
  },
};

const compactionConfig = resolveConfig({
  compaction: {
    recentTurnsPreserve: 5,
    maxHistoryShare: 0.6,
    summarySectionBudgets: {
      diagnosticEvidenceChars: 5_000,
      toolFailuresChars: 3_000,
      entityPreservedMessagesChars: 4_000,
      recentTurnsPreservedChars: 4_000,
    },
  },
});
```

**Source-backed guardrails:** the context guard reserves input headroom at `0.75` of the estimated context budget and throws a preemptive overflow error at `0.9` of the estimated full context (`src/guards/context-guard.ts`). This package does not define a built-in “trigger compaction at 80–85%” threshold in code, so treat any compaction trigger point in your app as an application-level policy choice.

### 7.2 By Agent Type

#### Coding Agents

Code tool outputs are highly structured and information-dense. Errors are critical.

```typescript
const sanitizerConfig: ToolResultHandlingConfigInput = {
  mode: "standard",
  thresholds: {
    blobLineChars: 1_200,  // Code has longer lines than prose
  },
  preview: {
    headChars: 1_500,
    tailChars: 2_000,      // Errors cluster at the end
    errorTailBias: true,
  },
  tools: {
    exec: { mode: "aggressive" },    // Build outputs can be huge
    process: { mode: "aggressive" },  // Background process logs
    read: { mode: "balanced" },       // File reads are usually valuable
    browser: { mode: "aggressive" },  // DOM snapshots are large
  },
};

configureCompactionInstructions({
  topicSignalCandidates: ["build", "test", "deploy", "refactor", "debug"],
  offTopicMarkers: [],
  lowercaseTopicPhrases: ["typescript", "python", "rust", "dockerfile"],
});
```

#### Research Agents

Search results are valuable inline. Web content is often large.

```typescript
const sanitizerConfig: ToolResultHandlingConfigInput = {
  mode: "standard",
  thresholds: {
    inlineSoftChars: 20_000,  // Search results are valuable inline
  },
  preview: {
    headChars: 2_000,         // Generous previews for research
    tailChars: 1_500,
    errorTailBias: false,     // Errors are less critical
  },
  tools: {
    web_search: { mode: "balanced" },
    web_fetch: { mode: "aggressive" },  // Full page content can be huge
  },
};
```

#### Conversational Agents

Context is precious — mostly text, few tool results. Compact aggressively.

```typescript
const sanitizerConfig: ToolResultHandlingConfigInput = {
  mode: "standard",
  thresholds: {
    inlineSoftChars: 8_000,
    artifactChars: 16_000,
  },
};

const compactionConfig = resolveConfig({
  compaction: {
    recentTurnsPreserve: 4,   // More turns matter in conversation
    maxHistoryShare: 0.4,
    identifierPolicy: "off",  // Fewer opaque identifiers in conversation
  },
});
```

---

## 8. Testing Strategy

### 8.1 Sanitizer Classification Tests

Verify the sanitizer correctly classifies outputs by risk category:

```typescript
import {
  classifyToolResultRisk,
  DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
  type ToolResultClassification,
} from "agent-context-kit/sanitizer";

describe("classifyToolResultRisk", () => {
  const config = DEFAULT_TOOL_RESULT_SANITIZER_CONFIG;

  it("classifies short output as safe", () => {
    const result = classifyToolResultRisk("hello world", "exec", config);
    expect(result.category).toBe("safe");
    expect(result.needsArtifact).toBe(false);
    expect(result.needsTruncation).toBe(false);
  });

  it("classifies oversized output for truncation", () => {
    const content = "x".repeat(15_000);  // > inlineSoftChars (12,000)
    const result = classifyToolResultRisk(content, "exec", config);
    expect(result.category).toBe("oversized");
    expect(result.needsTruncation).toBe(true);
    expect(result.needsArtifact).toBe(false);
  });

  it("classifies large output for artifact storage", () => {
    const content = "x".repeat(30_000);  // > artifactChars (25,000)
    const result = classifyToolResultRisk(content, "exec", config);
    expect(result.category).toBe("blob_like");
    expect(result.needsArtifact).toBe(true);
  });

  it("classifies giant output", () => {
    const content = "x".repeat(70_000);  // > giantChars (64,000)
    const result = classifyToolResultRisk(content, "exec", config);
    expect(result.category).toBe("giant");
    expect(result.needsArtifact).toBe(true);
  });

  it("detects base64-like content", () => {
    const content = "A".repeat(1_000);  // All base64-alphabet chars
    const result = classifyToolResultRisk(content, "exec", config);
    expect(result.isBase64Like).toBe(true);
  });

  it("applies aggressive per-tool mode", () => {
    const aggressiveConfig = {
      ...config,
      tools: { exec: { mode: "aggressive" as const } },
    };
    const content = "x".repeat(7_000);  // > inlineSoftChars/2 (6,000)
    const result = classifyToolResultRisk(content, "exec", aggressiveConfig);
    expect(result.category).toBe("oversized");
  });
});
```

### 8.2 Artifact Persistence and Deduplication Tests

```typescript
import {
  persistToolResultArtifactSync,
  readArtifactSync,
  checkArtifactExistsSync,
  computeArtifactId,
  resolveArtifactDir,
} from "agent-context-kit/artifacts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("artifact store", () => {
  let artifactDir: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-test-"));
    artifactDir = resolveArtifactDir(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  });

  it("persists and reads an artifact", () => {
    const content = "x".repeat(50_000);
    const meta = persistToolResultArtifactSync({
      content,
      toolName: "exec",
      artifactDir,
    });

    expect(meta).not.toBeNull();
    expect(meta!.isDuplicate).toBe(false);
    expect(meta!.chars).toBe(50_000);

    expect(checkArtifactExistsSync(meta!.id, artifactDir)).toBe(true);

    const envelope = readArtifactSync(meta!.id, artifactDir);
    expect(envelope).not.toBeNull();
    expect(envelope!.content).toBe(content);
    expect(envelope!.metadata.id).toBe(meta!.id);
  });

  it("deduplicates identical content", () => {
    const content = "same content";
    const meta1 = persistToolResultArtifactSync({ content, toolName: "exec", artifactDir });
    const meta2 = persistToolResultArtifactSync({ content, toolName: "read", artifactDir });

    expect(meta1!.id).toBe(meta2!.id);
    expect(meta1!.isDuplicate).toBe(false);
    expect(meta2!.isDuplicate).toBe(true);
  });

  it("uses content-addressed SHA-256 IDs", () => {
    const content = "test content";
    const expectedId = computeArtifactId(content);
    const meta = persistToolResultArtifactSync({ content, toolName: "exec", artifactDir });
    expect(meta!.id).toBe(expectedId);
  });
});
```

### 8.3 Compaction Quality Tests

```typescript
import {
  hasRequiredSummarySections,
  auditSummaryQuality,
  buildStructuredFallbackSummary,
  REQUIRED_SUMMARY_SECTIONS,
} from "agent-context-kit/compaction";

describe("compaction quality", () => {
  const validSummary = [
    "## Decisions",
    "Used PostgreSQL for the database.",
    "",
    "## Open TODOs",
    "- Migrate user table (3/10 done)",
    "",
    "## Constraints/Rules",
    "- Always use parameterized queries",
    "",
    "## Pending user asks",
    "Fix the login endpoint returning 500.",
    "",
    "## Exact identifiers",
    "- UUID: a3f8c2d1-9b7e-4f2a-8c3d-1e5f6a7b8c9d",
    "- File: /src/api/auth.ts",
  ].join("\n");

  it("validates required sections", () => {
    expect(hasRequiredSummarySections(validSummary)).toBe(true);
  });

  it("rejects summary missing sections", () => {
    const incomplete = "## Decisions\nSome decision.";
    expect(hasRequiredSummarySections(incomplete)).toBe(false);
  });

  it("audits identifier preservation", () => {
    const audit = auditSummaryQuality({
      summary: validSummary,
      identifiers: ["a3f8c2d1-9b7e-4f2a-8c3d-1e5f6a7b8c9d"],
      latestAsk: "Fix the login endpoint",
      identifierPolicy: "strict",
    });
    expect(audit.ok).toBe(true);
  });

  it("flags missing identifiers", () => {
    const audit = auditSummaryQuality({
      summary: validSummary,
      identifiers: ["missing-uuid-12345678"],
      latestAsk: "Fix the login endpoint",
      identifierPolicy: "strict",
    });
    expect(audit.ok).toBe(false);
    expect(audit.reasons).toContain(expect.stringContaining("missing_identifiers"));
  });

  it("builds valid fallback summary", () => {
    const fallback = buildStructuredFallbackSummary();
    expect(hasRequiredSummarySections(fallback)).toBe(true);
  });
});
```

### 8.4 Integration Test: Full Agent Loop Simulation

```typescript
import {
  createSyncSanitizerTransform,
  enforceToolResultContextBudgetInPlace,
  estimateContextChars,
  createMessageCharEstimateCache,
  CHARS_PER_TOKEN_ESTIMATE,
  ARTIFACT_STUB_MARKER,
  type AgentMessage,
  type ToolResultHandlingConfigInput,
} from "agent-context-kit";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("integration: full agent loop", () => {
  let stateDir: string;
  let config: ToolResultHandlingConfigInput;
  let sanitize: ReturnType<typeof createSyncSanitizerTransform>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-integration-"));
    config = {
      mode: "standard",
      artifactStore: { enabled: true, dir: "tool-artifacts", rootDir: stateDir, failOpen: true },
    };
    sanitize = createSyncSanitizerTransform(config);
  });

  it("handles a session with mixed tool outputs", () => {
    const messages: AgentMessage[] = [];
    const CONTEXT_WINDOW = 128_000;

    // Simulate 20 tool calls with varying sizes
    for (let i = 0; i < 20; i++) {
      // User message
      messages.push({
        role: "user",
        content: [{ type: "text", text: `Run command ${i}` }],
      });

      // Assistant message
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `Running command ${i}...` }],
      });

      // Tool result (varying sizes)
      const size = i % 3 === 0 ? 50_000 : i % 3 === 1 ? 15_000 : 5_000;
      const rawResult: AgentMessage = {
        role: "toolResult",
        toolName: "exec",
        toolCallId: `call_${i}`,
        content: [{ type: "text", text: "x".repeat(size) }],
      };

      const sanitized = sanitize(rawResult, {
        toolCallId: `call_${i}`,
        toolName: "exec",
      });
      messages.push(sanitized);
    }

    // Enforce context budget
    enforceToolResultContextBudgetInPlace({
      messages,
      contextBudgetChars: CONTEXT_WINDOW * CHARS_PER_TOKEN_ESTIMATE * 0.75,
      maxSingleToolResultChars: Math.min(CONTEXT_WINDOW * 2 * 0.5, 400_000),
    });

    // Verify context is within budget
    const cache = createMessageCharEstimateCache();
    const totalChars = estimateContextChars(messages, cache);
    const budget = CONTEXT_WINDOW * CHARS_PER_TOKEN_ESTIMATE * 0.75;
    expect(totalChars).toBeLessThanOrEqual(budget);

    // Verify large outputs were artifacted (not just that the directory exists)
    const artifactDir = path.join(stateDir, "tool-artifacts");
    expect(fs.existsSync(artifactDir)).toBe(true);
    expect(messages.some((msg) => {
      const details = msg.details as Record<string, unknown> | undefined;
      return details?.[ARTIFACT_STUB_MARKER] === true;
    })).toBe(true);
  });
});
```

### 8.5 Metrics to Track

| Metric | What it tells you | How to interpret it |
|--------|------------------|---------------------|
| **Artifact hit rate** | % of tool results that get artifact-stored | Higher values usually mean your thresholds are lower or your tools produce larger outputs. Lower values usually mean more content stays inline. |
| **Deduplication rate** | % of artifact persists that are deduplicates | High values usually mean the agent is re-reading or regenerating the same large content. |
| **Compaction frequency** | How often compaction triggers per session | Rising frequency usually means your app's budgets are tight relative to message volume. |
| **Context utilization** | `currentChars / budgetChars` over time | Sustained high utilization means your app is spending most of its headroom and may need earlier compaction or tighter tool-result handling. |
| **Truncation rate** | % of tool results that get inline-truncated (not artifacted) | High values mean many results are landing between your inline and artifact thresholds. |
| **Quality audit pass rate** | % of compaction summaries passing first-try audit | Lower pass rates usually mean your summarizer prompt/model or locality setup needs adjustment. |
| **Compaction timeout rate** | % of compaction attempts that timeout | Higher values usually mean the summarizer input is too large, the model is too slow, or your app-side timeouts are too aggressive. |

---

## Appendix A: Complete Import Reference

### Barrel import (everything)

```typescript
import { /* ... */ } from "agent-context-kit";
```

### Deep imports (tree-shakeable)

```typescript
// Sanitizer — classification, fact extraction, stub generation
import {
  DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
  calculateStringEntropy,
  isBase64Like,
  isBlobLike,
  classifyToolResultRisk,
  extractStructuredToolResultFacts,
  detectArtifactBackedReadRecovery,
  buildArtifactBackedReadRecoveryText,
  makeToolResultStub,
  sanitizeToolResultForPersistence,
  type ToolResultSanitizerConfig,
  type ToolResultClassification,
  type ToolResultFacts,
  type ToolResultStub,
  type ToolResultSanitizationResult,
  type ArtifactPersistenceContext,
  type ArtifactBackedReadRecovery,
} from "agent-context-kit/sanitizer";

// Artifacts — content-addressed storage
import {
  computeArtifactId,
  validateArtifactDir,
  artifactPathFor,
  checkArtifactExists,
  checkArtifactExistsSync,
  readArtifactMetadata,
  readArtifactMetadataSync,
  readArtifact,
  readArtifactSync,
  persistToolResultArtifact,
  persistToolResultArtifactSync,
  DiskArtifactStoreBackend,
  createArtifactStoreBackend,
  checkQuota,
  pruneArtifacts,
  resolveArtifactDir,
  type ArtifactMetadata,
  type PersistOptions,
  type ArtifactStoreBackend,
  type QuotaInfo,
} from "agent-context-kit/artifacts";

// Guards — session guard, context guard, truncation, estimation
import {
  // Session guard (post-tool)
  createSyncSanitizerTransform,
  enforcePostHookInvariants,
  guardToolResultMessage,
  type ToolResultHandlingConfigInput,
  type ToolResultPersistMeta,
  type GuardHooks,

  // Context guard (pre-LLM)
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
  STALE_TOOL_RESULT_CLEARED_PLACEHOLDER,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
  ARTIFACT_STUB_MARKER,
  enforceToolResultContextBudgetInPlace,
  installToolResultContextGuard,
  type ContextGuardAgent,

  // Truncation
  HARD_MAX_TOOL_RESULT_CHARS,
  truncateToolResultText,
  calculateMaxToolResultChars,
  getToolResultTextLength,
  truncateToolResultMessage,
  truncateOversizedToolResultsInMessages,
  isOversizedToolResult,
  sessionLikelyHasOversizedToolResults,
  type ToolResultTruncationOptions,

  // Char estimator
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  isToolResultMessage,
  getToolResultText,
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  estimateContextChars,
  invalidateMessageCharsCacheEntry,
  type MessageCharEstimateCache,
} from "agent-context-kit/guards";

// Compaction — config, instructions, utilities
import {
  // Config
  DEFAULT_CONFIG,
  resolveConfig,
  isPhaseEnabled,
  type ContextKitPhases,
  type SummarySectionBudgets,
  type CompactionConfig,
  type CompactionSummarizerConfig,
  type ContextKitConfig,

  // Instructions
  REQUIRED_SUMMARY_SECTIONS,
  DEFAULT_COMPACTION_INSTRUCTIONS,
  configureCompactionInstructions,
  getCompactionInstructionsConfig,
  buildCompactionInstructions,
  getMergeSummariesInstructions,
  buildTopicLocalityInstructions,
  hasRequiredSummarySections,
  extractOpaqueIdentifiers,
  extractLatestUserAsk,
  extractTopicLocalityContext,
  filterMessagesForTopicLocality,
  auditSummaryQuality,
  buildStructuredFallbackSummary,
  type TopicLocalityContext,
  type CompactionInstructionsConfig,

  // Utils
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
  isTransportOrMetadataIdentifier,
  estimateTokens,
  extractMessageText,
  stripToolResultDetails,
  estimateMessagesTokens,
  splitMessagesByTokenShare,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  pruneHistoryForContextShare,
} from "agent-context-kit/compaction";
```

## Appendix B: Message Format

`agent-context-kit` uses the `AgentMessage` type for all message processing. This is deliberately generic — it should work with any agent framework after a thin mapping layer.

```typescript
interface AgentMessage {
  id?: string;
  role?: "system" | "user" | "assistant" | "tool" | "toolResult" | "custom" | string;
  type?: string;
  toolName?: string;
  toolCallId?: string;
  timestamp?: string;
  isError?: boolean;
  content?: string | MessageContentBlock[] | unknown;
  details?: unknown;
  [key: string]: unknown;  // Extension point
}

// Content blocks
type MessageContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; data?: string; mimeType?: string }
  | {
      type: "toolCall" | "toolUse" | "tool_use";
      name?: string;
      toolName?: string;
      input?: Record<string, unknown>;
      arguments?: Record<string, unknown>;
    }
  | { type: "thinking"; thinking: string }
  | Record<string, unknown>;
```

**Key convention:** Tool results use `role: "toolResult"` (or `role: "tool"` — both are recognized). For best interoperability, use an array with at least one `{ type: "text", text: "..." }` block. Some helpers accept string `content` (for example the async sanitizer and char-estimation helpers), but the synchronous session-guard sanitization path extracts text from text blocks. The `details` field carries tool-specific metadata (exit codes, paths, etc.); it contributes to char estimation, and guard paths may strip, cap, or preserve parts of it depending on whether they are compacting content or preserving artifact-stub markers.

**Mapping from OpenAI format:**

```typescript
// OpenAI tool result → AgentMessage
const agentMsg: AgentMessage = {
  role: "toolResult",
  toolCallId: openaiMsg.tool_call_id,
  toolName: toolCallMap[openaiMsg.tool_call_id],  // You need to track this
  content: [{ type: "text", text: openaiMsg.content }],
};
```

**Mapping from Anthropic format:**

```typescript
// Anthropic tool_result → AgentMessage
const agentMsg: AgentMessage = {
  role: "toolResult",
  toolCallId: anthropicBlock.tool_use_id,
  toolName: toolUseMap[anthropicBlock.tool_use_id],  // Track from tool_use blocks
  content: [{ type: "text", text: typeof anthropicBlock.content === "string"
    ? anthropicBlock.content
    : anthropicBlock.content.map((b: any) => b.text).join("\n") }],
  isError: anthropicBlock.is_error,
};
```

## Appendix C: Error Handling Behavior

| Component | Error behavior | Throws? |
|-----------|---------------|---------|
| `classifyToolResultRisk` | Pure function, never throws | No |
| `sanitizeToolResultForPersistence` | Catches artifact errors if `failOpen` is set; returns `usedFallback: true` | Only if `failOpen: false` AND artifact write fails |
| `persistToolResultArtifactSync` | Returns `null` on error if `failOpen: true` | Only if `failOpen: false` |
| `createSyncSanitizerTransform` | Usually fails open for artifact-write issues when `artifactStore.failOpen` is left at its default `true`, but it can still throw during setup or persistence when fail-open is disabled | Yes, in some configurations |
| `guardToolResultMessage` | Wraps the sanitizer + invariant enforcement, but it does not swallow exceptions from `createSyncSanitizerTransform` / hooks | Yes, if the sanitizer setup or hooks throw |
| `enforceToolResultContextBudgetInPlace` | Mutates in place, never throws | No |
| `installToolResultContextGuard` | The installed `transformContext` throws `Error` with `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE` if post-enforcement context still exceeds the computed preemptive overflow threshold | Yes — intentional overflow signal |
| `auditSummaryQuality` | Pure function, returns `{ ok, reasons }` | No |
| `buildStructuredFallbackSummary` | Always returns a valid string | No |
| `pruneArtifacts` | Catches errors per-file, continues | No |

**Design principle:** Artifact-write paths default to fail-open behavior, so persistence problems usually degrade to inline truncation instead of hard failure. Several APIs can still throw when `failOpen` is disabled or inputs/config are invalid (for example invalid artifact IDs/directories, caller-thrown hooks, or the intentional overflow signal from `installToolResultContextGuard`). If you want structured fallback behavior during compaction, wire `buildStructuredFallbackSummary()` into your caller-owned compaction loop.

---

*This guide was generated from the `agent-context-kit` source at v0.1.0. For the latest API surface, always check `src/index.ts` which re-exports the full public API.*
