import type { AgentMessage } from "../types.js";

const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;
const MIN_KEEP_CHARS = 2_000;
const TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated — original was too large for the model's context window. " +
  "The content above is a partial view. If you need more, request specific sections or use " +
  "offset/limit parameters to read smaller chunks.]";
const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";

export type ToolResultTruncationOptions = {
  suffix?: string;
  minKeepChars?: number;
  errorTailBias?: boolean;
};

function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

export function truncateToolResultText(
  text: string,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): string {
  const suffix = options.suffix ?? TRUNCATION_SUFFIX;
  const minKeepChars = options.minKeepChars ?? MIN_KEEP_CHARS;
  const errorTailBias = options.errorTailBias ?? false;

  if (text.length <= maxChars) return text;
  const budget = Math.max(minKeepChars, maxChars - suffix.length);
  const shouldUseHeadTail = hasImportantTail(text) || errorTailBias;

  if (shouldUseHeadTail && budget > minKeepChars * 2) {
    const tailRatio = errorTailBias ? 0.5 : 0.3;
    const tailBudget = Math.min(Math.floor(budget * tailRatio), errorTailBias ? 8_000 : 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;

    if (headBudget > minKeepChars) {
      let headCut = headBudget;
      const headNewline = text.lastIndexOf("\n", headBudget);
      if (headNewline > headBudget * 0.8) headCut = headNewline;

      let tailStart = text.length - tailBudget;
      const tailNewline = text.indexOf("\n", tailStart);
      if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) tailStart = tailNewline + 1;

      return text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart) + suffix;
    }
  }

  let cutPoint = budget;
  const lastNewline = text.lastIndexOf("\n", budget);
  if (lastNewline > budget * 0.8) cutPoint = lastNewline;
  return text.slice(0, cutPoint) + suffix;
}

export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
  return Math.min(maxTokens * 4, HARD_MAX_TOOL_RESULT_CHARS);
}

export function getToolResultTextLength(msg: AgentMessage): number {
  if (!msg || msg.role !== "toolResult") return 0;
  if (!Array.isArray(msg.content)) return 0;
  let total = 0;
  for (const block of msg.content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string") total += text.length;
    }
  }
  return total;
}

export function truncateToolResultMessage(
  msg: AgentMessage,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): AgentMessage {
  if (!Array.isArray(msg.content)) return msg;
  const suffix = options.suffix ?? TRUNCATION_SUFFIX;
  const minKeepChars = options.minKeepChars ?? MIN_KEEP_CHARS;
  const errorTailBias = options.errorTailBias ?? false;
  const totalTextChars = getToolResultTextLength(msg);
  if (totalTextChars <= maxChars) return msg;

  const newContent = msg.content.map((block) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") return block;
    const text = (block as { text?: string }).text;
    if (typeof text !== "string") return block;
    const blockShare = text.length / totalTextChars;
    const blockBudget = Math.max(minKeepChars + suffix.length, Math.floor(maxChars * blockShare));
    return {
      ...block,
      text: truncateToolResultText(text, blockBudget, { suffix, minKeepChars, errorTailBias }),
    };
  });

  return { ...msg, content: newContent };
}

export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  contextWindowTokens: number,
): { messages: AgentMessage[]; truncatedCount: number } {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  let truncatedCount = 0;
  const result = messages.map((msg) => {
    if (msg.role !== "toolResult") return msg;
    if (getToolResultTextLength(msg) <= maxChars) return msg;
    truncatedCount += 1;
    return truncateToolResultMessage(msg, maxChars);
  });
  return { messages: result, truncatedCount };
}

export function isOversizedToolResult(msg: AgentMessage, contextWindowTokens: number): boolean {
  if (msg.role !== "toolResult") return false;
  return getToolResultTextLength(msg) > calculateMaxToolResultChars(contextWindowTokens);
}

export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): boolean {
  const maxChars = calculateMaxToolResultChars(params.contextWindowTokens);
  return params.messages.some((msg) => msg.role === "toolResult" && getToolResultTextLength(msg) > maxChars);
}
