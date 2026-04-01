import type { AgentMessage } from "../types.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
  type MessageCharEstimateCache,
} from "./char-estimator.js";
import { HARD_MAX_TOOL_RESULT_CHARS, truncateToolResultText } from "./truncation.js";

const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const PREEMPTIVE_OVERFLOW_RATIO = 0.9;

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";
export const STALE_TOOL_RESULT_CLEARED_PLACEHOLDER = "[Old tool result content cleared]";
export const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE =
  "Preemptive context overflow: estimated context size exceeds safe threshold during tool loop";
export const ARTIFACT_STUB_MARKER = "__ARTIFACT_STUB__" as const;

export interface ContextGuardAgent {
  transformContext?: (messages: AgentMessage[], signal: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
}

function hasArtifactStubMarker(message: AgentMessage): boolean {
  const details = message.details as Record<string, unknown> | undefined;
  return details?.[ARTIFACT_STUB_MARKER] === true;
}

function isArtifactBackedStubByTextHeuristic(text: string): boolean {
  return text.includes("[Tool result:") && text.includes("Artifact:") && text.includes("💡 Recovery:");
}

function isArtifactBackedStub(msg: AgentMessage): boolean {
  if (hasArtifactStubMarker(msg)) return true;
  const text = getToolResultText(msg);
  return text ? isArtifactBackedStubByTextHeuristic(text) : false;
}

function isAlreadyTruncated(msg: AgentMessage): boolean {
  const text = getToolResultText(msg);
  return !!text && text.includes(CONTEXT_LIMIT_TRUNCATION_NOTICE);
}

function getCompactionPriority(msg: AgentMessage): number {
  const text = getToolResultText(msg);
  if (!text) return 0;
  if (text === STALE_TOOL_RESULT_CLEARED_PLACEHOLDER) return 0;
  if (text === PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER) return 1;
  if (text === CONTEXT_LIMIT_TRUNCATION_NOTICE) return 2;
  if (isAlreadyTruncated(msg)) return 3;
  if (isArtifactBackedStub(msg)) return 10;
  if (msg.isError === true) return 9;
  if (text.length > 2000) {
    const tail = text.slice(-2000).toLowerCase();
    if (/\b(error|exception|failed|fatal|traceback|panic)\b/.test(tail)) return 7;
    if (/\b(total|summary|result|complete)\b/.test(tail)) return 8;
  }
  return 5;
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = msg.content;
  const replacementContent = typeof content === "string" || content === undefined ? text : [{ type: "text", text }];
  const { details: _details, ...rest } = msg;
  return { ...rest, content: replacementContent } as AgentMessage;
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) return msg;
  if (isArtifactBackedStub(msg)) return msg;
  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) return msg;
  const rawText = getToolResultText(msg);
  if (!rawText) return replaceToolResultText(msg, CONTEXT_LIMIT_TRUNCATION_NOTICE);
  if (rawText.length <= maxChars) return msg;

  const customSuffix = "\n" + CONTEXT_LIMIT_TRUNCATION_NOTICE;
  const isError = msg.isError === true;
  const hasImportantTail =
    rawText.length > 2000 &&
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code|total|summary|result|complete)\b/.test(
      rawText.slice(-2000).toLowerCase(),
    );

  if (isError || hasImportantTail) {
    return replaceToolResultText(
      msg,
      truncateToolResultText(rawText, maxChars, {
        minKeepChars: 2000,
        suffix: customSuffix,
        errorTailBias: isError,
      }),
    );
  }

  const bodyBudget = Math.max(0, maxChars - customSuffix.length);
  if (bodyBudget <= 0) return replaceToolResultText(msg, CONTEXT_LIMIT_TRUNCATION_NOTICE);
  let cutPoint = bodyBudget;
  const newline = rawText.lastIndexOf("\n", bodyBudget);
  if (newline > bodyBudget * 0.7) cutPoint = newline;
  return replaceToolResultText(msg, rawText.slice(0, cutPoint) + customSuffix);
}

function applyMessageMutationInPlace(target: AgentMessage, source: AgentMessage, cache?: MessageCharEstimateCache): void {
  if (target === source) return;
  const targetRecord = target as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) delete targetRecord[key];
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) invalidateMessageCharsCacheEntry(cache, target);
}

function compactExistingToolResultsInPlace(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
}): number {
  const { messages, charsNeeded, cache } = params;
  if (charsNeeded <= 0) return 0;
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!isToolResultMessage(messages[i]) || isArtifactBackedStub(messages[i])) continue;
    toolResultIndices.push(i);
  }
  toolResultIndices.sort((a, b) => getCompactionPriority(messages[a]) - getCompactionPriority(messages[b]));

  let reduced = 0;
  for (const index of toolResultIndices) {
    const msg = messages[index];
    const before = estimateMessageCharsCached(msg, cache);
    if (before <= STALE_TOOL_RESULT_CLEARED_PLACEHOLDER.length) continue;
    const compacted = replaceToolResultText(msg, STALE_TOOL_RESULT_CLEARED_PLACEHOLDER);
    applyMessageMutationInPlace(msg, compacted, cache);
    const after = estimateMessageCharsCached(msg, cache);
    if (after >= before) continue;
    reduced += before - after;
    if (reduced >= charsNeeded) break;
  }
  return reduced;
}

export function enforceToolResultContextBudgetInPlace(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
}): void {
  const estimateCache = createMessageCharEstimateCache();
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const message = params.messages[i];
    if (!isToolResultMessage(message) || isArtifactBackedStub(message)) continue;
    applyMessageMutationInPlace(
      message,
      truncateToolResultToChars(message, params.maxSingleToolResultChars, estimateCache),
      estimateCache,
    );
  }

  const currentChars = estimateContextChars(params.messages, estimateCache);
  if (currentChars <= params.contextBudgetChars) return;
  compactExistingToolResultsInPlace({
    messages: params.messages,
    charsNeeded: currentChars - params.contextBudgetChars,
    cache: estimateCache,
  });
}

export function installToolResultContextGuard(params: {
  agent: ContextGuardAgent;
  contextWindowTokens: number;
}): () => void {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const contextBudgetChars = Math.max(
    1024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1024,
    Math.min(
      Math.floor(contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE),
      HARD_MAX_TOOL_RESULT_CHARS,
    ),
  );
  const preemptiveOverflowChars = Math.max(
    contextBudgetChars,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * PREEMPTIVE_OVERFLOW_RATIO),
  );

  const mutableAgent = params.agent;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    const contextMessages = Array.isArray(transformed) ? transformed : messages;
    enforceToolResultContextBudgetInPlace({ messages: contextMessages, contextBudgetChars, maxSingleToolResultChars });
    const postEnforcementChars = estimateContextChars(contextMessages, createMessageCharEstimateCache());
    if (postEnforcementChars > preemptiveOverflowChars) {
      throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    }
    return contextMessages;
  };

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
