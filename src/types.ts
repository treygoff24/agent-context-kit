export type MessageRole = "system" | "user" | "assistant" | "tool" | "toolResult" | "custom";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  url?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolCallBlock {
  type: "toolCall" | "toolUse" | "tool_use";
  name?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type MessageContentBlock = TextBlock | ImageBlock | ToolCallBlock | ThinkingBlock | Record<string, unknown>;

export interface AgentMessage {
  id?: string;
  role?: MessageRole | string;
  type?: string;
  toolName?: string;
  toolCallId?: string;
  timestamp?: string;
  isError?: boolean;
  content?: string | MessageContentBlock[] | unknown;
  details?: unknown;
  [key: string]: unknown;
}

export interface SessionHeaderEntry {
  type: "session";
  id?: string;
  [key: string]: unknown;
}

export interface MessageEntry {
  type: "message";
  id: string;
  parentId?: string | null;
  message: AgentMessage;
  [key: string]: unknown;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId?: string | null;
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export type TranscriptEntry = SessionHeaderEntry | MessageEntry | CompactionEntry | Record<string, unknown>;

export interface ActiveEntityInfo {
  entityId: string;
  weight: number;
  lastMentionTurn: number;
}

export interface EntityIndexLike {
  entities: Record<string, string[]>;
  summaries?: Record<string, string>;
  entityDisplayNames?: Record<string, string>;
}

export interface SummarizerConfig {
  modelId: string;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface SummarizerClient {
  summarize(params: {
    messages: Array<{ role: string; content: string }>;
    systemPrompt: string;
    config: SummarizerConfig;
    signal?: AbortSignal;
    maxTokens?: number;
  }): Promise<string>;
}

export interface RuntimeContextLike {
  provider?: string;
  model?: string;
  config?: Record<string, unknown>;
  summarizerConfig?: Partial<SummarizerConfig> & { resolvedApiKey?: string };
}

export interface ArtifactEnvelope<TMetadata = Record<string, unknown>> {
  metadata: TMetadata;
  content: string;
}
