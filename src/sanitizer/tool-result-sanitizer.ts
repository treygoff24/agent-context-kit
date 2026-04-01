import path from "node:path";
import type { AgentMessage } from "../types.js";
import type { ArtifactMetadata } from "../artifacts/store.js";

export type ToolResultHandlingMode = "off" | "standard" | "aggressive";
export type ToolResultHandlingToolMode = "off" | "balanced" | "aggressive";

export type ToolResultSanitizerConfig = {
  mode: ToolResultHandlingMode;
  thresholds: {
    inlineSoftChars: number;
    artifactChars: number;
    giantChars: number;
    blobLineChars: number;
    emergencySyncCeilingChars: number;
  };
  preview: {
    headChars: number;
    tailChars: number;
    errorTailBias: boolean;
    structuredSummaryPreferred: boolean;
  };
  detection: {
    base64RatioThreshold: number;
    highEntropyThreshold: number;
    enableBlobDetection: boolean;
    enableHashDedup: boolean;
  };
  staleClearing: {
    enabled: boolean;
    placeholder: string;
  };
  tools: Record<string, { mode?: ToolResultHandlingToolMode }>;
};

export type ToolResultRiskCategory = "safe" | "oversized" | "blob_like" | "giant";

export type ToolResultClassification = {
  category: ToolResultRiskCategory;
  needsArtifact: boolean;
  needsTruncation: boolean;
  isBase64Like: boolean;
  isHighEntropy: boolean;
  isBlobLike: boolean;
  charCount: number;
  lineCount: number;
  maxLineLength: number;
  entropy: number;
  toolMode?: ToolResultHandlingToolMode;
};

export type ToolResultFacts = {
  toolName: string;
  exitCode?: number;
  status?: string;
  isError: boolean;
  chars: number;
  bytes: number;
  lineCount: number;
  isStructured: boolean;
  structureType?: "json" | "xml" | "yaml" | "table" | "unknown";
  previewHead: string;
  previewTail: string;
  errorHint?: string;
  extractedUrls: string[];
  extractedPaths: string[];
  extractedTestNames: string[];
  metadata: Record<string, unknown>;
};

export type ToolResultStub = {
  toolName: string;
  artifactId: string;
  artifactPath?: string;
  isError: boolean;
  isStructured: boolean;
  structureType?: string;
  isDuplicate?: boolean;
  previewHead: string;
  previewTail: string;
  errorDetails?: { exitCode?: number; errorMessage?: string };
  metadata: {
    chars: number;
    bytes: number;
    lineCount: number;
    sha256?: string;
    urls?: string[];
    paths?: string[];
  };
  recoveryHint: string;
  toTranscriptText: () => string;
};

export type ToolResultSanitizationResult = {
  shouldReplace: boolean;
  originalMessage: AgentMessage;
  replacementMessage?: AgentMessage;
  artifactMetadata?: ArtifactMetadata;
  isDuplicate?: boolean;
  usedFallback?: boolean;
  fallbackReason?: string;
};

export type ArtifactPersistenceContext = {
  artifactDir: string;
  persistArtifact: (options: {
    content: string;
    toolName: string;
    toolCallId?: string;
    exitCode?: number;
  }) => Promise<ArtifactMetadata | null>;
};

export type ArtifactBackedReadRecovery = {
  artifactPath: string;
  hasChunking: boolean;
};

export const DEFAULT_TOOL_RESULT_SANITIZER_CONFIG: ToolResultSanitizerConfig = {
  mode: "standard",
  thresholds: {
    inlineSoftChars: 12_000,
    artifactChars: 25_000,
    giantChars: 64_000,
    blobLineChars: 800,
    emergencySyncCeilingChars: 400_000,
  },
  preview: {
    headChars: 1_200,
    tailChars: 1_200,
    errorTailBias: true,
    structuredSummaryPreferred: true,
  },
  detection: {
    base64RatioThreshold: 0.9,
    highEntropyThreshold: 4.2,
    enableBlobDetection: true,
    enableHashDedup: true,
  },
  staleClearing: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
  tools: {},
};

export function calculateStringEntropy(content: string): number {
  if (content.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const char of content) freq.set(char, (freq.get(char) ?? 0) + 1);
  let entropy = 0;
  const len = content.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const MIN_BASE64_DETECTION_CHARS = 200;

export function isBase64Like(content: string, threshold: number): boolean {
  if (content.length === 0 || content.length < MIN_BASE64_DETECTION_CHARS) return false;
  const base64Chars = /^[A-Za-z0-9+/=]+$/;
  let base64CharCount = 0;
  for (const char of content) {
    if (base64Chars.test(char)) base64CharCount += 1;
  }
  return base64CharCount / content.length >= threshold;
}

export function isBlobLike(content: string, blobLineChars: number): boolean {
  if (content.length === 0) return false;
  const lines = content.split("\n");
  if (lines.length === 1 && content.length > blobLineChars) return true;
  return lines.some((line) => line.length > blobLineChars);
}

function detectStructureType(content: string): ToolResultFacts["structureType"] {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {}
  }
  if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.includes("</"))) {
    return "xml";
  }
  if (/^---\s*$/.test(trimmed.split("\n")[0] ?? "") || /^[\w-]+:\s*.+$/m.test(trimmed)) {
    return "yaml";
  }
  const lines = trimmed.split("\n").filter((line) => line.trim());
  if (lines.length >= 2) {
    const hasCommas = lines.every((line) => line.includes(","));
    const hasPipes = lines.every((line) => line.includes("|"));
    const hasTabs = lines.every((line) => line.includes("\t"));
    if (hasCommas || hasPipes || hasTabs) return "table";
  }
  return undefined;
}

function isValidJson(content: string): boolean {
  const trimmed = content.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function extractUrls(content: string): string[] {
  const matches = content.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/gi) ?? [];
  return Array.from(new Set(matches));
}

function extractPaths(content: string, details?: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (details?.path && typeof details.path === "string") paths.push(details.path);
  if (details?.filePath && typeof details.filePath === "string") paths.push(details.filePath);
  const pathRegex = /(?:^|\s)(\/[^\s:<>",|*?]+|\.{0,2}\/[^^\s:<>",|*?]+|\w+\.\w{1,10})(?=\s|$|[;:,])/g;
  const matches = content.match(pathRegex) ?? [];
  for (const match of matches) {
    const trimmed = match.trim();
    if (trimmed && (trimmed.startsWith("/") || trimmed.includes("/"))) paths.push(trimmed);
  }
  return Array.from(new Set(paths));
}

function extractTestNames(content: string): string[] {
  const testNames: string[] = [];
  const patterns = [
    /(?:it|test|describe)\s*\(\s*["']([^"']+)["']/g,
    /✓\s+(\S.+)/g,
    /✗\s+(\S.+)/g,
    /FAIL\s+(.+)/g,
    /PASS\s+(.+)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      testNames.push(match[1]?.trim() ?? "");
    }
  }
  return testNames.filter(Boolean);
}

function extractErrorHint(content: string): string | undefined {
  const errorPatterns = [
    /(?:error|exception|failed|fatal|traceback|panic):\s*(.+)/i,
    /(?:errno|exit code|status code):\s*(\d+)/i,
    /(?:syntaxerror|referenceerror|typeerror|rangeerror):\s*(.+)/i,
  ];
  for (const pattern of errorPatterns) {
    const match = content.match(pattern);
    if (match) return match[1]?.trim() ?? match[0]?.trim();
  }
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (/at\s+.+:\d+:\d+/.test(line) || /\s+\^\s*$/.test(line)) {
      if (index > 0) return lines[index - 1]?.trim();
    }
  }
  return undefined;
}

export function classifyToolResultRisk(
  content: string,
  toolName: string,
  config: ToolResultSanitizerConfig,
): ToolResultClassification {
  const charCount = content.length;
  const lines = content.split("\n");
  const lineCount = lines.length;
  const maxLineLength = Math.max(0, ...lines.map((line) => line.length));
  const toolMode = config.tools[toolName]?.mode;
  const entropy = calculateStringEntropy(content);
  const isBase64 = isBase64Like(content, config.detection.base64RatioThreshold);
  const isHighEntropy = entropy > config.detection.highEntropyThreshold;
  const isBlob = config.detection.enableBlobDetection && isBlobLike(content, config.thresholds.blobLineChars);

  let category: ToolResultRiskCategory = "safe";
  let needsArtifact = false;
  let needsTruncation = false;

  const effectiveSoftThreshold = toolMode === "aggressive"
    ? config.thresholds.inlineSoftChars / 2
    : config.thresholds.inlineSoftChars;
  const effectiveArtifactThreshold = toolMode === "aggressive"
    ? config.thresholds.artifactChars / 2
    : config.thresholds.artifactChars;
  const exceedsEmergencyCeiling = charCount > config.thresholds.emergencySyncCeilingChars;

  if (charCount > config.thresholds.giantChars || exceedsEmergencyCeiling) {
    category = "giant";
    needsArtifact = true;
  } else if (isBase64 || isBlob || isHighEntropy || charCount > effectiveArtifactThreshold) {
    category = "blob_like";
    needsArtifact = true;
  } else if (charCount > effectiveSoftThreshold) {
    category = "oversized";
    needsTruncation = true;
  }

  return {
    category,
    needsArtifact,
    needsTruncation,
    isBase64Like: isBase64,
    isHighEntropy,
    isBlobLike: isBlob || isHighEntropy,
    charCount,
    lineCount,
    maxLineLength,
    entropy,
    toolMode,
  };
}

export function extractStructuredToolResultFacts(
  message: AgentMessage,
  content: string,
  config: ToolResultSanitizerConfig,
): ToolResultFacts {
  const toolName = String(message.toolName ?? "unknown").toLowerCase();
  const details = (message.details ?? {}) as Record<string, unknown>;

  let exitCode: number | undefined;
  const exitCodeFromDetails = details.exitCode ?? details.status;
  if (typeof exitCodeFromDetails === "number") exitCode = exitCodeFromDetails;
  else if (typeof exitCodeFromDetails === "string") {
    const parsed = parseInt(exitCodeFromDetails, 10);
    if (!Number.isNaN(parsed)) exitCode = parsed;
  }

  const status = typeof details.status === "string" ? details.status : undefined;
  const isError =
    exitCode !== undefined && exitCode !== 0
      ? true
      : status
        ? /error|fail|timeout|denied|cancel/i.test(status)
        : false;

  const structureType = detectStructureType(content);
  const isStructured = !!structureType;
  const chars = content.length;
  const bytes = Buffer.byteLength(content, "utf8");
  const lineCount = content.split("\n").length;

  const headChars = config.preview.headChars;
  const tailChars = config.preview.tailChars;
  const previewHead = content.slice(0, headChars);
  const previewTail = config.preview.errorTailBias && isError
    ? content.slice(-Math.min(tailChars * 2, 4000))
    : content.slice(-tailChars);

  const extractedUrls = extractUrls(content);
  const extractedPaths = extractPaths(content, details);
  const extractedTestNames = extractTestNames(content);
  const errorHint = isError ? extractErrorHint(content) : undefined;
  const metadata: Record<string, unknown> = {};

  switch (toolName) {
    case "exec":
      metadata.command = details.command ?? details.cmd;
      metadata.cwd = details.cwd;
      metadata.durationMs = details.durationMs ?? details.duration;
      break;
    case "web_search":
      if (isValidJson(content)) {
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          metadata.resultCount = Array.isArray(parsed.results)
            ? parsed.results.length
            : Array.isArray(parsed)
              ? parsed.length
              : undefined;
          metadata.query = parsed.query ?? parsed.q;
        } catch {}
      }
      break;
    case "read":
      metadata.filePath = details.path ?? details.filePath;
      metadata.offset = details.offset;
      metadata.limit = details.limit;
      break;
    case "browser":
      metadata.url = details.url;
      metadata.action = details.action;
      if (isValidJson(content)) {
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          metadata.pageTitle = parsed.title ?? parsed.pageTitle;
          metadata.elementCount = Array.isArray(parsed.elements) ? parsed.elements.length : undefined;
        } catch {}
      }
      break;
    case "process":
      metadata.pid = details.pid;
      metadata.sessionId = details.sessionId;
      metadata.action = details.action;
      if (isValidJson(content)) {
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          metadata.processStatus = parsed.status;
          metadata.logLineCount = Array.isArray(parsed.logs) ? parsed.logs.length : undefined;
        } catch {}
      }
      break;
    case "sessions_history":
      metadata.targetSession = details.sessionKey ?? details.sessionId;
      if (isValidJson(content)) {
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          metadata.messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : undefined;
          metadata.totalTurns = parsed.total;
        } catch {}
      }
      break;
  }

  return {
    toolName,
    exitCode,
    status,
    isError,
    chars,
    bytes,
    lineCount,
    isStructured,
    structureType,
    previewHead,
    previewTail,
    errorHint,
    extractedUrls,
    extractedPaths,
    extractedTestNames,
    metadata,
  };
}

const ARTIFACT_PATH_PLACEHOLDER = "<artifact path unavailable>";

function hasArtifactReadChunking(details: Record<string, unknown>): boolean {
  const hasNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const hasString = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  return hasNumber(details.offset) || hasNumber(details.limit) || hasString(details.offset) || hasString(details.limit);
}

export function detectArtifactBackedReadRecovery(
  message: AgentMessage,
  toolName: string,
  artifactDir?: string,
): ArtifactBackedReadRecovery | null {
  if (toolName !== "read" || !artifactDir) return null;
  const details = (message.details ?? {}) as Record<string, unknown>;
  const rawPath = typeof details.path === "string" ? details.path : typeof details.filePath === "string" ? details.filePath : undefined;
  if (!rawPath) return null;
  const resolvedArtifactDir = path.resolve(artifactDir);
  const resolvedPath = path.resolve(rawPath);
  const isArtifactRead = resolvedPath === resolvedArtifactDir || resolvedPath.startsWith(resolvedArtifactDir + path.sep);
  if (!isArtifactRead) return null;
  return { artifactPath: resolvedPath, hasChunking: hasArtifactReadChunking(details) };
}

export function buildArtifactBackedReadRecoveryText(artifactPath: string): string {
  return [
    "[Artifact-backed read requires chunked recovery]",
    `Path: ${artifactPath}`,
    "This read targeted a persisted tool-output artifact.",
    "Use `read` with offset/limit, or `head`, `tail`, `rg`, to page/search small sections instead of re-reading the whole artifact.",
    "Do not dump the full artifact back into the transcript; search first, then page the specific section you need.",
  ].join("\n");
}

function buildArtifactRecoveryHint(artifactId: string, artifactPath?: string): string {
  const resolvedPath = artifactPath ?? ARTIFACT_PATH_PLACEHOLDER;
  return (
    "💡 Recovery: Use targeted retrieval only. " +
    `Use \`read\` with offset/limit, or \`head\`, \`tail\`, \`rg\` against ${resolvedPath} ` +
    `(artifact ${artifactId}). Do not request the full artifact or re-dump it into the transcript; ` +
    "search/page small sections first to avoid re-artifacting loops."
  );
}

export function makeToolResultStub(
  facts: ToolResultFacts,
  artifactId: string,
  config: ToolResultSanitizerConfig,
  artifactPath?: string,
  isDuplicate = false,
): ToolResultStub {
  const recoveryHint = buildArtifactRecoveryHint(artifactId, artifactPath);
  return {
    toolName: facts.toolName,
    artifactId,
    artifactPath,
    isError: facts.isError,
    isStructured: facts.isStructured,
    structureType: facts.structureType,
    isDuplicate,
    previewHead: facts.previewHead,
    previewTail: facts.previewTail,
    errorDetails: facts.isError ? { exitCode: facts.exitCode, errorMessage: facts.errorHint } : undefined,
    metadata: {
      chars: facts.chars,
      bytes: facts.bytes,
      lineCount: facts.lineCount,
      urls: facts.extractedUrls.slice(0, 10),
      paths: facts.extractedPaths.slice(0, 5),
    },
    recoveryHint,
    toTranscriptText: () => formatStubForTranscript(facts, artifactId, config, artifactPath, isDuplicate),
  };
}

function formatStubForTranscript(
  facts: ToolResultFacts,
  artifactId: string,
  config: ToolResultSanitizerConfig,
  artifactPath?: string,
  isDuplicate = false,
): string {
  const parts: string[] = [];
  parts.push(`[Tool result: ${facts.toolName}]`);
  if (facts.isError) parts.push(`Status: ERROR (exit code ${facts.exitCode ?? "unknown"})`);
  else parts.push(`Status: OK${facts.exitCode !== undefined ? ` (exit code ${facts.exitCode})` : ""}`);
  parts.push(`Size: ${facts.chars} chars, ${facts.lineCount} lines, ${facts.bytes} bytes`);
  if (facts.isStructured && config.preview.structuredSummaryPreferred) {
    parts.push(`Type: Structured ${facts.structureType?.toUpperCase() ?? "DATA"} [preview only - full content stored in artifact]`);
  } else if (facts.isStructured) {
    parts.push(`Type: Structured ${facts.structureType?.toUpperCase() ?? "DATA"}`);
  }
  parts.push(`Artifact: ${artifactId}`);
  parts.push(`Path: ${artifactPath ?? ARTIFACT_PATH_PLACEHOLDER}`);

  if (isDuplicate) {
    parts.push("Dedup: Reused existing artifact for identical oversized content; preview omitted to avoid transcript bloat.");
  } else {
    if (facts.previewHead) parts.push("", "--- Preview (head) ---", facts.previewHead);
    if (facts.previewTail && (facts.isError || facts.previewTail !== facts.previewHead)) {
      parts.push("", "--- Preview (tail) ---", facts.previewTail);
    }
    if (facts.isError) parts.push("", `⚠️ Error: ${facts.errorHint ?? "See artifact for full details"}`);
  }

  if (facts.extractedUrls.length > 0) {
    parts.push("", `URLs (${facts.extractedUrls.length}): ${facts.extractedUrls.slice(0, 5).join(", ")}${facts.extractedUrls.length > 5 ? "..." : ""}`);
  }
  if (facts.extractedPaths.length > 0) {
    parts.push(`Paths: ${facts.extractedPaths.slice(0, 3).join(", ")}${facts.extractedPaths.length > 3 ? "..." : ""}`);
  }
  parts.push("", buildArtifactRecoveryHint(artifactId, artifactPath));
  return parts.join("\n");
}

export async function sanitizeToolResultForPersistence(
  message: AgentMessage,
  config: ToolResultSanitizerConfig,
  artifactContext: ArtifactPersistenceContext,
): Promise<ToolResultSanitizationResult> {
  if (config.mode === "off") return { shouldReplace: false, originalMessage: message };
  const textContent = extractTextFromMessage(message);
  if (!textContent) return { shouldReplace: false, originalMessage: message };
  const toolName = String(message.toolName ?? "unknown").toLowerCase();
  if (config.tools[toolName]?.mode === "off") return { shouldReplace: false, originalMessage: message };

  const classification = classifyToolResultRisk(textContent, toolName, config);
  const artifactBackedRead = detectArtifactBackedReadRecovery(message, toolName, artifactContext.artifactDir);

  if (artifactBackedRead) {
    if (artifactBackedRead.hasChunking) {
      if (classification.category === "safe") return { shouldReplace: false, originalMessage: message };
      return {
        shouldReplace: true,
        originalMessage: message,
        replacementMessage: createMessageWithText(
          message,
          truncateTextWithHeadTail(textContent, config.preview.headChars, config.preview.tailChars),
        ),
        usedFallback: true,
        fallbackReason: "artifact_read_chunked_passthrough",
      };
    }
    if (classification.category !== "safe") {
      return {
        shouldReplace: true,
        originalMessage: message,
        replacementMessage: createMessageWithText(message, buildArtifactBackedReadRecoveryText(artifactBackedRead.artifactPath)),
        usedFallback: true,
        fallbackReason: "artifact_read_requires_chunking",
      };
    }
  }

  if (classification.category === "safe") return { shouldReplace: false, originalMessage: message };

  const facts = extractStructuredToolResultFacts(message, textContent, config);
  if (classification.needsTruncation && !classification.needsArtifact) {
    return {
      shouldReplace: true,
      originalMessage: message,
      replacementMessage: createMessageWithText(
        message,
        truncateTextWithHeadTail(textContent, config.preview.headChars, config.preview.tailChars),
      ),
      usedFallback: true,
      fallbackReason: "inline_truncation",
    };
  }

  let artifactMetadata: ArtifactMetadata | null = null;
  let usedFallback = false;
  let fallbackReason: string | undefined;
  try {
    artifactMetadata = await artifactContext.persistArtifact({
      content: textContent,
      toolName: facts.toolName,
      toolCallId: message.toolCallId,
      exitCode: facts.exitCode,
    });
  } catch (error) {
    usedFallback = true;
    fallbackReason = `artifact_error: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (!artifactMetadata) {
    usedFallback = true;
    fallbackReason ??= "artifact_null";
    return {
      shouldReplace: true,
      originalMessage: message,
      replacementMessage: createMessageWithText(
        message,
        truncateTextWithHeadTail(
          textContent,
          config.preview.headChars,
          facts.isError && config.preview.errorTailBias ? config.preview.tailChars * 2 : config.preview.tailChars,
        ),
      ),
      usedFallback,
      fallbackReason,
    };
  }

  const stub = makeToolResultStub(
    facts,
    artifactMetadata.id,
    config,
    artifactMetadata.path,
    artifactMetadata.isDuplicate === true,
  );

  return {
    shouldReplace: true,
    originalMessage: message,
    replacementMessage: createMessageWithText(message, stub.toTranscriptText()),
    artifactMetadata,
    isDuplicate: artifactMetadata.isDuplicate,
    usedFallback: false,
  };
}

function extractTextFromMessage(message: AgentMessage): string | undefined {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function createMessageWithText(originalMessage: AgentMessage, text: string): AgentMessage {
  const content = originalMessage.content;
  if (!Array.isArray(content)) return { ...originalMessage, content: [{ type: "text", text }] };
  let replacedFirst = false;
  const newContent = content.flatMap((block) => {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      if (!replacedFirst) {
        replacedFirst = true;
        return [{ ...(block as object), text }];
      }
      return [] as unknown[];
    }
    return [block];
  });
  if (!replacedFirst) newContent.unshift({ type: "text", text });
  return { ...originalMessage, content: newContent };
}

function truncateTextWithHeadTail(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars + 100) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return (
    head +
    `\n\n⚠️ [Content truncated - showing ${headChars} chars from head and ${tailChars} chars from tail]\n\n` +
    tail +
    "\n\n💡 Recovery: Use offset/limit parameters to read specific sections of large content."
  );
}
