import type { AgentMessage } from "../types.js";
import {
  resolveArtifactDir,
  persistToolResultArtifactSync,
  validateArtifactDir,
  type ArtifactMetadata,
} from "../artifacts/store.js";
import {
  ARTIFACT_STUB_MARKER,
} from "./context-guard.js";
import { HARD_MAX_TOOL_RESULT_CHARS, truncateToolResultMessage } from "./truncation.js";
import {
  DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
  buildArtifactBackedReadRecoveryText,
  classifyToolResultRisk,
  detectArtifactBackedReadRecovery,
  extractStructuredToolResultFacts,
  makeToolResultStub,
  type ToolResultHandlingToolMode,
  type ToolResultSanitizerConfig,
} from "../sanitizer/tool-result-sanitizer.js";

const GUARD_TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";

export type ToolResultHandlingConfigInput = {
  mode?: string;
  thresholds?: Record<string, number>;
  preview?: Record<string, unknown>;
  detection?: Record<string, unknown>;
  staleClearing?: Record<string, unknown>;
  tools?: Record<string, { mode?: ToolResultHandlingToolMode }>;
  artifactStore?: {
    enabled?: boolean;
    dir?: string;
    failOpen?: boolean;
    rootDir?: string;
  };
};

export type ToolResultPersistMeta = {
  toolCallId?: string;
  toolName?: string;
  isSynthetic?: boolean;
};

export interface GuardHooks {
  beforePersist?: (message: AgentMessage) => AgentMessage;
  afterPersist?: (message: AgentMessage, meta: ToolResultPersistMeta) => AgentMessage;
}

function toSanitizerConfig(config: ToolResultHandlingConfigInput): ToolResultSanitizerConfig {
  return {
    ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG,
    mode: (config.mode as ToolResultSanitizerConfig["mode"]) ?? DEFAULT_TOOL_RESULT_SANITIZER_CONFIG.mode,
    thresholds: {
      ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG.thresholds,
      ...(config.thresholds ?? {}),
    },
    preview: {
      ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG.preview,
      ...(config.preview ?? {}),
    },
    detection: {
      ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG.detection,
      ...(config.detection ?? {}),
    },
    staleClearing: {
      ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG.staleClearing,
      ...(config.staleClearing ?? {}),
    },
    tools: config.tools ?? {},
  };
}

function extractTextFromMessageSync(message: AgentMessage): string | undefined {
  const content = message.content;
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

function createMessageWithTextSync(originalMessage: AgentMessage, text: string): AgentMessage {
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

function truncateTextWithHeadTailSync(
  text: string,
  headChars: number,
  tailChars: number,
  errorTailBias = false,
): string {
  const effectiveTailChars = errorTailBias ? Math.min(tailChars * 2, 4000) : tailChars;
  if (text.length <= headChars + effectiveTailChars + 100) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(-effectiveTailChars);
  return (
    head +
    `\n\n⚠️ [Content truncated - showing ${headChars} chars from head and ${effectiveTailChars} chars from tail]\n\n` +
    tail +
    "\n\n💡 Recovery: Use offset/limit parameters to read specific sections of large content."
  );
}

type ArtifactDirResolutionResult =
  | { success: true; artifactDir: string }
  | { success: false; reason: string; fallback: true };

function resolveArtifactDirSafe(config: ToolResultHandlingConfigInput): ArtifactDirResolutionResult {
  if (config.artifactStore?.enabled === false) {
    return { success: false, reason: "artifact_store_disabled", fallback: true };
  }
  const artifactSubdir = config.artifactStore?.dir ?? "tool-artifacts";
  const failOpen = config.artifactStore?.failOpen ?? true;
  const rootDir = config.artifactStore?.rootDir ?? process.cwd();
  try {
    const validation = validateArtifactDir(artifactSubdir, rootDir);
    if (!validation.valid) {
      if (failOpen) return { success: false, reason: validation.reason, fallback: true };
      throw new Error(`Invalid artifact directory: ${validation.reason}`);
    }
    return { success: true, artifactDir: resolveArtifactDir(rootDir, artifactSubdir) };
  } catch (error) {
    if (failOpen) return { success: false, reason: error instanceof Error ? error.message : String(error), fallback: true };
    throw error;
  }
}

export function createSyncSanitizerTransform(
  toolResultHandlingConfig: ToolResultHandlingConfigInput,
): (message: AgentMessage, meta: ToolResultPersistMeta) => AgentMessage {
  const config = toSanitizerConfig(toolResultHandlingConfig);
  const artifactDirResolution = resolveArtifactDirSafe(toolResultHandlingConfig);
  const artifactDir = artifactDirResolution.success ? artifactDirResolution.artifactDir : undefined;
  const failOpen = toolResultHandlingConfig.artifactStore?.failOpen ?? true;
  const sanitizerEnabled = config.mode !== "off";

  return (message: AgentMessage, meta: ToolResultPersistMeta): AgentMessage => {
    if (!sanitizerEnabled) return message;
    const textContent = extractTextFromMessageSync(message);
    if (!textContent) return message;
    const toolName = (meta.toolName ?? message.toolName ?? "unknown").toLowerCase();
    if (config.tools[toolName]?.mode === "off") return message;

    const classification = classifyToolResultRisk(textContent, toolName, config);
    const artifactBackedRead = detectArtifactBackedReadRecovery(message, toolName, artifactDir);

    if (artifactBackedRead) {
      if (artifactBackedRead.hasChunking) {
        if (classification.category === "safe") return message;
        return createMessageWithTextSync(
          message,
          truncateTextWithHeadTailSync(textContent, config.preview.headChars, config.preview.tailChars, false),
        );
      }
      if (classification.category !== "safe") {
        return createMessageWithTextSync(message, buildArtifactBackedReadRecoveryText(artifactBackedRead.artifactPath));
      }
    }

    if (classification.category === "safe") return message;
    const facts = extractStructuredToolResultFacts(message, textContent, config);

    const useInlineTruncation =
      (classification.needsTruncation && !classification.needsArtifact) || !artifactDirResolution.success;

    if (useInlineTruncation) {
      return createMessageWithTextSync(
        message,
        truncateTextWithHeadTailSync(
          textContent,
          config.preview.headChars,
          config.preview.tailChars,
          facts.isError && config.preview.errorTailBias,
        ),
      );
    }

    let artifactMetadata: ArtifactMetadata | null = null;
    try {
      artifactMetadata = persistToolResultArtifactSync({
        content: textContent,
        toolName: facts.toolName,
        toolCallId: meta.toolCallId,
        artifactDir: artifactDir!,
        exitCode: facts.exitCode,
        failOpen,
      });
    } catch (error) {
      if (!failOpen) throw error;
    }

    if (!artifactMetadata) {
      return createMessageWithTextSync(
        message,
        truncateTextWithHeadTailSync(
          textContent,
          config.preview.headChars,
          config.preview.tailChars,
          facts.isError && config.preview.errorTailBias,
        ),
      );
    }

    const stub = makeToolResultStub(
      facts,
      artifactMetadata.id,
      config,
      artifactMetadata.path,
      artifactMetadata.isDuplicate === true,
    );
    const stubMessage = createMessageWithTextSync(message, stub.toTranscriptText());
    return {
      ...stubMessage,
      details: {
        ...((stubMessage.details ?? {}) as Record<string, unknown>),
        [ARTIFACT_STUB_MARKER]: true,
        artifactId: artifactMetadata.id,
        artifactPath: artifactMetadata.path,
        isDuplicate: artifactMetadata.isDuplicate,
      },
    };
  };
}

function capToolResultSize(msg: AgentMessage): AgentMessage {
  if (msg.role !== "toolResult") return msg;
  return truncateToolResultMessage(msg, HARD_MAX_TOOL_RESULT_CHARS, {
    suffix: GUARD_TRUNCATION_SUFFIX,
    minKeepChars: 2_000,
  });
}

function estimateNonTextPayloadChars(msg: AgentMessage): number {
  if (!msg.details) return 0;
  try {
    const serialized = JSON.stringify(msg.details);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 0;
  }
}

function enforceDetailsPayloadPolicy(
  msg: AgentMessage,
  policyCeiling: number,
  preHookDetails: Record<string, unknown> | undefined,
): AgentMessage {
  const currentDetails = msg.details as Record<string, unknown> | undefined;
  if (!currentDetails) return msg;
  if (estimateNonTextPayloadChars(msg) <= policyCeiling) return msg;

  const preserved: Record<string, unknown> = {};
  const markerFields = [ARTIFACT_STUB_MARKER, "artifactId", "artifactPath", "isDuplicate"] as const;
  for (const key of markerFields) {
    if (key in currentDetails) preserved[key] = currentDetails[key];
  }

  if (preHookDetails) {
    for (const [key, value] of Object.entries(preHookDetails)) {
      if (!(key in preserved)) preserved[key] = value;
    }
    const preHookChars = JSON.stringify(preHookDetails).length;
    if (preHookChars > policyCeiling) {
      const markerOnly: Record<string, unknown> = {};
      for (const key of markerFields) {
        if (key in currentDetails) markerOnly[key] = currentDetails[key];
      }
      return { ...msg, details: Object.keys(markerOnly).length > 0 ? markerOnly : undefined };
    }
  }

  return { ...msg, details: Object.keys(preserved).length > 0 ? preserved : undefined };
}

export function enforcePostHookInvariants(
  msg: AgentMessage,
  preHookMessage: AgentMessage,
  config: {
    thresholds?: Record<string, number>;
    preview?: { headChars?: number; tailChars?: number; errorTailBias?: boolean };
  },
): AgentMessage {
  if (msg.role !== "toolResult") return msg;
  const policyCeiling = config.thresholds?.artifactChars ?? 25_000;
  let result = msg;

  const preHookDetails = preHookMessage.details as Record<string, unknown> | undefined;
  const preHookWasStub = preHookDetails?.[ARTIFACT_STUB_MARKER] === true;
  if (preHookWasStub) {
    const postHookDetails = (result.details ?? {}) as Record<string, unknown>;
    if (postHookDetails[ARTIFACT_STUB_MARKER] !== true) {
      result = {
        ...result,
        details: {
          ...postHookDetails,
          [ARTIFACT_STUB_MARKER]: true,
          artifactId: preHookDetails?.artifactId,
          artifactPath: preHookDetails?.artifactPath,
          isDuplicate: preHookDetails?.isDuplicate,
        },
      };
    }
  }

  result = enforceDetailsPayloadPolicy(result, policyCeiling, preHookDetails);

  const textContent = extractTextFromMessageSync(result);
  if (!textContent) return capToolResultSize(result);
  if (textContent.length <= policyCeiling) return capToolResultSize(result);

  const isError = result.isError === true;
  const headChars = config.preview?.headChars ?? 1_200;
  const tailChars = config.preview?.tailChars ?? 1_200;
  const errorTailBias = config.preview?.errorTailBias ?? true;
  return createMessageWithTextSync(
    capToolResultSize(result),
    truncateTextWithHeadTailSync(textContent, headChars, tailChars, isError && errorTailBias),
  );
}

export function guardToolResultMessage(
  message: AgentMessage,
  meta: ToolResultPersistMeta,
  config: ToolResultHandlingConfigInput,
  hooks?: GuardHooks,
): AgentMessage {
  const transform = createSyncSanitizerTransform(config);
  const prepared = hooks?.beforePersist ? hooks.beforePersist(message) : message;
  const preHookMessage = transform(prepared, meta);
  const postHookMessage = hooks?.afterPersist ? hooks.afterPersist(preHookMessage, meta) : preHookMessage;
  return enforcePostHookInvariants(postHookMessage, preHookMessage, config);
}
