export interface ContextKitPhases {
  corePort: boolean;
  smartCompaction: boolean;
  dynamicAssembly: boolean;
  sessionSearch: boolean;
  subagentIntelligence: boolean;
  turnLearning: boolean;
  fullCompaction: boolean;
  channelPartitioning: boolean;
  compactionTakeover: boolean;
  entityScoring: boolean;
  entitySummary: boolean;
  toolChainCompression: boolean;
  memoryAwareCompaction: boolean;
  workspaceRecovery: boolean;
  taskGraphCompaction: boolean;
  relationalPinning: boolean;
  identifierBinding: boolean;
  compactionFeedback: boolean;
}

export interface SummarySectionBudgets {
  diagnosticEvidenceChars: number;
  toolFailuresChars: number;
  entityPreservedMessagesChars: number;
  recentTurnsPreservedChars: number;
}

export interface CompactionConfig {
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

export interface CompactionSummarizerConfig {
  provider: string;
  modelId: string;
  baseUrl?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  contextWindow?: number;
}

export interface ContextKitConfig {
  phases: ContextKitPhases;
  compaction: CompactionConfig;
  summarizer?: CompactionSummarizerConfig;
  entityIndexPath: string;
  psmDir: string;
  metricsPath: string;
  relevanceLogPath: string;
  salvageThreshold: number;
  compactionRecoveryBudget: number;
  subagentContextBudget: number;
  nudgeTurnThreshold: number;
  nudgeToolThreshold: number;
  maxActiveEntities: number;
  entityDecayRate: number;
  entityEvictionThreshold: number;
}

export const DEFAULT_CONFIG: ContextKitConfig = {
  phases: {
    corePort: true,
    smartCompaction: true,
    dynamicAssembly: true,
    sessionSearch: true,
    subagentIntelligence: true,
    turnLearning: true,
    fullCompaction: false,
    channelPartitioning: false,
    compactionTakeover: false,
    entityScoring: false,
    entitySummary: false,
    toolChainCompression: false,
    memoryAwareCompaction: false,
    workspaceRecovery: false,
    taskGraphCompaction: false,
    relationalPinning: false,
    identifierBinding: false,
    compactionFeedback: false,
  },
  compaction: {
    recentTurnsPreserve: 3,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
    maxHistoryShare: 0.5,
    identifierPolicy: "strict",
    timeoutMs: 90_000,
    timeoutMsBase: 120_000,
    timeoutMsCap: 300_000,
    oversizedToolResultChars: 16_000,
    giantToolResultChars: 64_000,
    previewHeadChars: 400,
    previewTailChars: 400,
    maxStabilityRetryStages: 3,
    summarySectionBudgets: {
      diagnosticEvidenceChars: 2500,
      toolFailuresChars: 1800,
      entityPreservedMessagesChars: 2200,
      recentTurnsPreservedChars: 2200,
    },
  },
  entityIndexPath: "entity-index.json",
  psmDir: "agents",
  metricsPath: "context-engine-metrics.jsonl",
  relevanceLogPath: "relevance-log.jsonl",
  salvageThreshold: 0.75,
  compactionRecoveryBudget: 5000,
  subagentContextBudget: 3000,
  nudgeTurnThreshold: 10,
  nudgeToolThreshold: 15,
  maxActiveEntities: 200,
  entityDecayRate: 0.9,
  entityEvictionThreshold: 0.05,
};

export function resolveConfig(raw?: Record<string, unknown>): ContextKitConfig {
  if (!raw) {
    return {
      ...DEFAULT_CONFIG,
      phases: { ...DEFAULT_CONFIG.phases },
      compaction: {
        ...DEFAULT_CONFIG.compaction,
        summarySectionBudgets: { ...DEFAULT_CONFIG.compaction.summarySectionBudgets },
      },
    };
  }

  const rawPhases = typeof raw.phases === "object" && raw.phases && !Array.isArray(raw.phases)
    ? (raw.phases as Record<string, unknown>)
    : {};
  const rawCompaction = typeof raw.compaction === "object" && raw.compaction && !Array.isArray(raw.compaction)
    ? (raw.compaction as Record<string, unknown>)
    : {};
  const rawSummarySectionBudgets = typeof rawCompaction.summarySectionBudgets === "object" && rawCompaction.summarySectionBudgets && !Array.isArray(rawCompaction.summarySectionBudgets)
    ? (rawCompaction.summarySectionBudgets as Record<string, unknown>)
    : {};
  const rawSummarizer = typeof raw.summarizer === "object" && raw.summarizer && !Array.isArray(raw.summarizer)
    ? (raw.summarizer as Record<string, unknown>)
    : null;

  const phases: ContextKitPhases = {
    ...DEFAULT_CONFIG.phases,
    ...Object.fromEntries(Object.entries(rawPhases).filter(([, value]) => typeof value === "boolean")),
  };

  const compaction: CompactionConfig = {
    ...DEFAULT_CONFIG.compaction,
    recentTurnsPreserve: typeof rawCompaction.recentTurnsPreserve === "number" ? rawCompaction.recentTurnsPreserve : DEFAULT_CONFIG.compaction.recentTurnsPreserve,
    qualityGuardEnabled: typeof rawCompaction.qualityGuardEnabled === "boolean" ? rawCompaction.qualityGuardEnabled : DEFAULT_CONFIG.compaction.qualityGuardEnabled,
    qualityGuardMaxRetries: typeof rawCompaction.qualityGuardMaxRetries === "number" ? rawCompaction.qualityGuardMaxRetries : DEFAULT_CONFIG.compaction.qualityGuardMaxRetries,
    maxHistoryShare: typeof rawCompaction.maxHistoryShare === "number" ? rawCompaction.maxHistoryShare : DEFAULT_CONFIG.compaction.maxHistoryShare,
    identifierPolicy: rawCompaction.identifierPolicy === "off" || rawCompaction.identifierPolicy === "strict"
      ? rawCompaction.identifierPolicy
      : DEFAULT_CONFIG.compaction.identifierPolicy,
    timeoutMs: typeof rawCompaction.timeoutMs === "number" ? rawCompaction.timeoutMs : DEFAULT_CONFIG.compaction.timeoutMs,
    timeoutMsBase: typeof rawCompaction.timeoutMsBase === "number"
      ? rawCompaction.timeoutMsBase
      : typeof rawCompaction.timeoutMs === "number"
        ? rawCompaction.timeoutMs
        : DEFAULT_CONFIG.compaction.timeoutMsBase,
    timeoutMsCap: typeof rawCompaction.timeoutMsCap === "number" ? rawCompaction.timeoutMsCap : DEFAULT_CONFIG.compaction.timeoutMsCap,
    oversizedToolResultChars: typeof rawCompaction.oversizedToolResultChars === "number" ? rawCompaction.oversizedToolResultChars : DEFAULT_CONFIG.compaction.oversizedToolResultChars,
    giantToolResultChars: typeof rawCompaction.giantToolResultChars === "number" ? rawCompaction.giantToolResultChars : DEFAULT_CONFIG.compaction.giantToolResultChars,
    previewHeadChars: typeof rawCompaction.previewHeadChars === "number" ? rawCompaction.previewHeadChars : DEFAULT_CONFIG.compaction.previewHeadChars,
    previewTailChars: typeof rawCompaction.previewTailChars === "number" ? rawCompaction.previewTailChars : DEFAULT_CONFIG.compaction.previewTailChars,
    maxStabilityRetryStages: typeof rawCompaction.maxStabilityRetryStages === "number" ? rawCompaction.maxStabilityRetryStages : DEFAULT_CONFIG.compaction.maxStabilityRetryStages,
    summarySectionBudgets: {
      ...DEFAULT_CONFIG.compaction.summarySectionBudgets,
      diagnosticEvidenceChars: typeof rawSummarySectionBudgets.diagnosticEvidenceChars === "number" ? rawSummarySectionBudgets.diagnosticEvidenceChars : DEFAULT_CONFIG.compaction.summarySectionBudgets.diagnosticEvidenceChars,
      toolFailuresChars: typeof rawSummarySectionBudgets.toolFailuresChars === "number" ? rawSummarySectionBudgets.toolFailuresChars : DEFAULT_CONFIG.compaction.summarySectionBudgets.toolFailuresChars,
      entityPreservedMessagesChars: typeof rawSummarySectionBudgets.entityPreservedMessagesChars === "number" ? rawSummarySectionBudgets.entityPreservedMessagesChars : DEFAULT_CONFIG.compaction.summarySectionBudgets.entityPreservedMessagesChars,
      recentTurnsPreservedChars: typeof rawSummarySectionBudgets.recentTurnsPreservedChars === "number" ? rawSummarySectionBudgets.recentTurnsPreservedChars : DEFAULT_CONFIG.compaction.summarySectionBudgets.recentTurnsPreservedChars,
    },
  };

  const summarizer = rawSummarizer
    ? {
        provider: typeof rawSummarizer.provider === "string" ? rawSummarizer.provider : "",
        modelId: typeof rawSummarizer.modelId === "string" ? rawSummarizer.modelId : "",
        ...(typeof rawSummarizer.baseUrl === "string" ? { baseUrl: rawSummarizer.baseUrl } : {}),
        ...(typeof rawSummarizer.reasoningEffort === "string"
          ? { reasoningEffort: rawSummarizer.reasoningEffort as CompactionSummarizerConfig["reasoningEffort"] }
          : {}),
        ...(typeof rawSummarizer.contextWindow === "number" ? { contextWindow: rawSummarizer.contextWindow } : {}),
      }
    : DEFAULT_CONFIG.summarizer;

  return {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(
      Object.entries(raw).filter(([key]) => !["phases", "compaction", "summarizer"].includes(key)),
    ),
    phases,
    compaction,
    summarizer,
  } as ContextKitConfig;
}

export function isPhaseEnabled(config: ContextKitConfig, phase: keyof ContextKitPhases): boolean {
  return config.phases[phase] === true;
}
