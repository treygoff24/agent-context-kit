export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2;
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

type ContentBlock = { type: string; text?: string };
type MessageLike = { role?: string; content?: string | ContentBlock[] | unknown; details?: unknown };

export function isTransportOrMetadataIdentifier(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (/^(?:https?|file|ftp|gs|s3):\/\//i.test(normalized)) return true;
  if (/^\/?(?:users?|var|tmp|private|home|mnt|volumes)\b/i.test(normalized)) return true;
  if (normalized.startsWith("/") || normalized.startsWith("~/")) return true;
  if (/^[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}$/.test(normalized)) return true;
  if (/^\d{6,}$/.test(normalized)) return true;
  if (/^[a-f0-9]{8,}$/i.test(normalized)) return true;
  return lower.includes("topic_id ") || lower.includes("channel id:");
}

export function estimateTokens(text: string): number {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / 3.5);
}

export function extractMessageText(message: MessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && block.text) {
        const trimmed = block.text.trim();
        if (trimmed.length > 0) textParts.push(trimmed);
      }
    }
    return textParts.join(" ");
  }
  return "";
}

export function stripToolResultDetails(messages: MessageLike[]): MessageLike[] {
  return messages.map((msg) => {
    const cloned = JSON.parse(JSON.stringify(msg)) as MessageLike;
    if (cloned.role === "toolResult" && cloned.details !== undefined) delete cloned.details;
    return cloned;
  });
}

export function estimateMessagesTokens(messages: MessageLike[]): number {
  return stripToolResultDetails(messages).reduce((total, msg) => total + estimateTokens(extractMessageText(msg)), 0);
}

export function splitMessagesByTokenShare(messages: MessageLike[], parts = 2): MessageLike[][] {
  if (messages.length === 0) return [];
  const totalTokens = estimateMessagesTokens(messages);
  const targetPerChunk = totalTokens / parts;
  const chunks: MessageLike[][] = [];
  let currentChunk: MessageLike[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(extractMessageText(msg));
    if (currentTokens + msgTokens > targetPerChunk && currentChunk.length > 0 && chunks.length < parts - 1) {
      chunks.push(currentChunk);
      currentChunk = [msg];
      currentTokens = msgTokens;
    } else {
      currentChunk.push(msg);
      currentTokens += msgTokens;
    }
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

export function chunkMessagesByMaxTokens(messages: MessageLike[], maxTokens: number): MessageLike[][] {
  const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
  if (messages.length === 0) return [];
  const chunks: MessageLike[][] = [];
  let currentChunk: MessageLike[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(extractMessageText(msg));
    if (msgTokens > effectiveMax) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentTokens = 0;
      }
      chunks.push([msg]);
      continue;
    }
    if (currentTokens + msgTokens > effectiveMax && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [msg];
      currentTokens = msgTokens;
    } else {
      currentChunk.push(msg);
      currentTokens += msgTokens;
    }
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

export function computeAdaptiveChunkRatio(messages: MessageLike[], contextWindow: number): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;
  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const threshold = contextWindow * 0.1;
  if (avgTokens <= threshold) return BASE_CHUNK_RATIO;
  const ratio = BASE_CHUNK_RATIO * (threshold / avgTokens);
  return Math.max(MIN_CHUNK_RATIO, Math.min(BASE_CHUNK_RATIO, ratio));
}

export function isOversizedForSummary(msg: MessageLike, contextWindow: number): boolean {
  return estimateTokens(extractMessageText(msg)) * SAFETY_MARGIN > contextWindow * 0.5;
}

export function pruneHistoryForContextShare(params: {
  messages: MessageLike[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
}): {
  messages: MessageLike[];
  droppedMessagesList: MessageLike[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const maxHistoryShare = params.maxHistoryShare ?? 0.5;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  let keptMessages = [...params.messages];
  const allDropped: MessageLike[] = [];
  let droppedChunks = 0;
  let droppedMessages = 0;
  let droppedTokens = 0;
  const parts = Math.max(1, Math.min(params.parts ?? 2, keptMessages.length));

  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) break;
    const [dropped, ...rest] = chunks;
    const flatRest = rest.flat();
    droppedChunks += 1;
    droppedMessages += dropped.length;
    droppedTokens += estimateMessagesTokens(dropped);
    allDropped.push(...dropped);
    keptMessages = flatRest;
  }

  return {
    messages: keptMessages,
    droppedMessagesList: allDropped,
    droppedChunks,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}
