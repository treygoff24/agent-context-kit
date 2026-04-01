import type { AgentMessage } from "../types.js";

export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;
const IMAGE_CHAR_ESTIMATE = 8_000;

export type MessageCharEstimateCache = WeakMap<AgentMessage, number>;

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined) return 0;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

export function isToolResultMessage(msg: AgentMessage): boolean {
  return msg.role === "toolResult" || msg.role === "tool" || msg.type === "toolResult";
}

function getToolResultContent(msg: AgentMessage): unknown[] {
  if (!isToolResultMessage(msg)) return [];
  const content = msg.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function estimateContentBlockChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (isTextBlock(block)) chars += block.text.length;
    else if (isImageBlock(block)) chars += IMAGE_CHAR_ESTIMATE;
    else chars += estimateUnknownChars(block);
  }
  return chars;
}

export function getToolResultText(msg: AgentMessage): string {
  const content = getToolResultContent(msg);
  const chunks: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) chunks.push(block.text);
  }
  return chunks.join("\n");
}

function estimateMessageChars(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object") return 0;

  if (msg.role === "user") {
    if (typeof msg.content === "string") return msg.content.length;
    if (Array.isArray(msg.content)) return estimateContentBlockChars(msg.content);
    return 0;
  }

  if (msg.role === "assistant") {
    let chars = 0;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const typed = block as { type?: unknown; text?: unknown; thinking?: unknown; arguments?: unknown };
        if (typed.type === "text" && typeof typed.text === "string") chars += typed.text.length;
        else if (typed.type === "thinking" && typeof typed.thinking === "string") chars += typed.thinking.length;
        else if (typed.type === "toolCall" || typed.type === "toolUse" || typed.type === "tool_use") {
          try {
            chars += JSON.stringify(typed.arguments ?? {}).length;
          } catch {
            chars += 128;
          }
        } else {
          chars += estimateUnknownChars(block);
        }
      }
    }
    return chars;
  }

  if (isToolResultMessage(msg)) {
    let chars = estimateContentBlockChars(getToolResultContent(msg));
    chars += estimateUnknownChars(msg.details);
    const weightedChars = Math.ceil(chars * (CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE));
    return Math.max(chars, weightedChars);
  }

  return 256;
}

export function createMessageCharEstimateCache(): MessageCharEstimateCache {
  return new WeakMap<AgentMessage, number>();
}

export function estimateMessageCharsCached(msg: AgentMessage, cache: MessageCharEstimateCache): number {
  const hit = cache.get(msg);
  if (hit !== undefined) return hit;
  const estimated = estimateMessageChars(msg);
  cache.set(msg, estimated);
  return estimated;
}

export function estimateContextChars(messages: AgentMessage[], cache: MessageCharEstimateCache): number {
  return messages.reduce((sum, msg) => sum + estimateMessageCharsCached(msg, cache), 0);
}

export function invalidateMessageCharsCacheEntry(cache: MessageCharEstimateCache, msg: AgentMessage): void {
  cache.delete(msg);
}
