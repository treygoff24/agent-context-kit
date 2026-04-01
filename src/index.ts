// === Types ===
export type {
  MessageRole,
  TextBlock,
  ImageBlock,
  ToolCallBlock,
  ThinkingBlock,
  MessageContentBlock,
  AgentMessage,
  SessionHeaderEntry,
  MessageEntry,
  CompactionEntry,
  TranscriptEntry,
  ActiveEntityInfo,
  EntityIndexLike,
  SummarizerConfig,
  SummarizerClient,
  RuntimeContextLike,
  ArtifactEnvelope,
} from "./types.js";

// === Sanitizer ===
export {
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
} from "./sanitizer/tool-result-sanitizer.js";
export type {
  ToolResultHandlingMode,
  ToolResultHandlingToolMode,
  ToolResultSanitizerConfig,
  ToolResultRiskCategory,
  ToolResultClassification,
  ToolResultFacts,
  ToolResultStub,
  ToolResultSanitizationResult,
  ArtifactPersistenceContext,
  ArtifactBackedReadRecovery,
} from "./sanitizer/tool-result-sanitizer.js";

// === Artifacts ===
export {
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
} from "./artifacts/store.js";
export type {
  ArtifactMetadata,
  PersistOptions,
  ArtifactStoreBackend,
  QuotaInfo,
} from "./artifacts/store.js";

// === Guards — Char Estimator ===
export {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  isToolResultMessage,
  getToolResultText,
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  estimateContextChars,
  invalidateMessageCharsCacheEntry,
} from "./guards/char-estimator.js";
export type { MessageCharEstimateCache } from "./guards/char-estimator.js";

// === Guards — Context Guard ===
export {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
  STALE_TOOL_RESULT_CLEARED_PLACEHOLDER,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
  ARTIFACT_STUB_MARKER,
  enforceToolResultContextBudgetInPlace,
  installToolResultContextGuard,
} from "./guards/context-guard.js";
export type { ContextGuardAgent } from "./guards/context-guard.js";

// === Guards — Session Guard ===
export {
  createSyncSanitizerTransform,
  enforcePostHookInvariants,
  guardToolResultMessage,
} from "./guards/session-guard.js";
export type {
  ToolResultHandlingConfigInput,
  ToolResultPersistMeta,
  GuardHooks,
} from "./guards/session-guard.js";

// === Guards — Truncation ===
export {
  HARD_MAX_TOOL_RESULT_CHARS,
  truncateToolResultText,
  calculateMaxToolResultChars,
  getToolResultTextLength,
  truncateToolResultMessage,
  truncateOversizedToolResultsInMessages,
  isOversizedToolResult,
  sessionLikelyHasOversizedToolResults,
} from "./guards/truncation.js";
export type { ToolResultTruncationOptions } from "./guards/truncation.js";

// === Compaction — Config ===
export {
  DEFAULT_CONFIG,
  resolveConfig,
  isPhaseEnabled,
} from "./compaction/config.js";
export type {
  ContextKitPhases,
  SummarySectionBudgets,
  CompactionConfig,
  CompactionSummarizerConfig,
  ContextKitConfig,
} from "./compaction/config.js";

// === Compaction — Instructions ===
export {
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
} from "./compaction/instructions.js";
export type {
  TopicLocalityContext,
  CompactionInstructionsConfig,
} from "./compaction/instructions.js";

// === Compaction — Utils ===
export {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
  isTransportOrMetadataIdentifier,
  estimateTokens,
  extractMessageText as extractMessageTextFromEntry,
  stripToolResultDetails,
  estimateMessagesTokens,
  splitMessagesByTokenShare,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  pruneHistoryForContextShare,
} from "./compaction/utils.js";
