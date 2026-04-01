import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactEnvelope } from "../types.js";

export type ArtifactMetadata = {
  id: string;
  sha256: string;
  bytes: number;
  chars: number;
  lineCount: number;
  path: string;
  toolName?: string;
  toolCallId?: string;
  exitCode?: number;
  createdAt: number;
  retentionDays?: number;
  isDuplicate?: boolean;
};

export type PersistOptions = {
  content: string;
  toolName: string;
  toolCallId?: string;
  artifactDir: string;
  artifactId?: string;
  exitCode?: number;
  failOpen?: boolean;
  retentionDays?: number;
  maxTotalBytes?: number;
  maxBytesPerAgent?: number;
};

export interface ArtifactStoreBackend {
  write(id: string, content: string, metadata: ArtifactMetadata): Promise<void>;
  readMetadata(id: string): Promise<ArtifactMetadata | null>;
  exists(id: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

function isValidArtifactId(id: string): boolean {
  return /^[a-f0-9]{64}$/i.test(id);
}

export function computeArtifactId(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

export function validateArtifactDir(
  artifactDir: string,
  baseStateDir: string,
): { valid: true } | { valid: false; reason: string } {
  if (path.isAbsolute(artifactDir)) {
    return { valid: false, reason: "artifactDir must be relative, not absolute" };
  }
  const normalized = path.normalize(artifactDir);
  if (normalized.startsWith("..") || normalized.includes("../") || normalized.includes("..\\")) {
    return { valid: false, reason: "artifactDir must not contain path traversal (..)" };
  }
  const resolved = path.resolve(baseStateDir, normalized);
  const resolvedBase = path.resolve(baseStateDir);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return { valid: false, reason: "artifactDir must resolve under state directory" };
  }
  return { valid: true };
}

export function artifactPathFor(artifactId: string, artifactDir: string): string {
  if (!isValidArtifactId(artifactId)) {
    throw new Error(`Invalid artifact ID: ${artifactId}`);
  }
  const lowerId = artifactId.toLowerCase();
  const shard1 = lowerId.slice(0, 2);
  const shard2 = lowerId.slice(2, 4);
  return path.join(artifactDir, shard1, shard2, `${lowerId}.jsonl`);
}

function ensureDirSync(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  ensureDirSync(filePath);
  const tempPath = path.join(path.dirname(filePath), `.tmp-${crypto.randomUUID()}.jsonl`);
  try {
    await fs.promises.writeFile(tempPath, content, "utf8");
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {}
    throw error;
  }
}

function atomicWriteFileSync(filePath: string, content: string): void {
  ensureDirSync(filePath);
  const tempPath = path.join(path.dirname(filePath), `.tmp-${crypto.randomUUID()}.jsonl`);
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

export async function checkArtifactExists(artifactId: string, artifactDir: string): Promise<boolean> {
  if (!isValidArtifactId(artifactId)) return false;
  try {
    await fs.promises.access(artifactPathFor(artifactId, artifactDir), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function checkArtifactExistsSync(artifactId: string, artifactDir: string): boolean {
  if (!isValidArtifactId(artifactId)) return false;
  try {
    fs.accessSync(artifactPathFor(artifactId, artifactDir), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readArtifactMetadata(
  artifactId: string,
  artifactDir: string,
): Promise<ArtifactMetadata | null> {
  if (!isValidArtifactId(artifactId)) throw new Error(`Invalid artifact ID: ${artifactId}`);
  try {
    const raw = await fs.promises.readFile(artifactPathFor(artifactId, artifactDir), "utf8");
    return (JSON.parse(raw) as ArtifactEnvelope<ArtifactMetadata>).metadata ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readArtifactMetadataSync(artifactId: string, artifactDir: string): ArtifactMetadata | null {
  if (!isValidArtifactId(artifactId)) throw new Error(`Invalid artifact ID: ${artifactId}`);
  try {
    const raw = fs.readFileSync(artifactPathFor(artifactId, artifactDir), "utf8");
    return (JSON.parse(raw) as ArtifactEnvelope<ArtifactMetadata>).metadata ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readArtifact(
  artifactId: string,
  artifactDir: string,
): Promise<ArtifactEnvelope<ArtifactMetadata> | null> {
  if (!isValidArtifactId(artifactId)) throw new Error(`Invalid artifact ID: ${artifactId}`);
  try {
    const raw = await fs.promises.readFile(artifactPathFor(artifactId, artifactDir), "utf8");
    return JSON.parse(raw) as ArtifactEnvelope<ArtifactMetadata>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readArtifactSync(artifactId: string, artifactDir: string): ArtifactEnvelope<ArtifactMetadata> | null {
  if (!isValidArtifactId(artifactId)) throw new Error(`Invalid artifact ID: ${artifactId}`);
  try {
    const raw = fs.readFileSync(artifactPathFor(artifactId, artifactDir), "utf8");
    return JSON.parse(raw) as ArtifactEnvelope<ArtifactMetadata>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function persistToolResultArtifact(options: PersistOptions): Promise<ArtifactMetadata | null> {
  const {
    content,
    toolName,
    toolCallId,
    artifactDir,
    artifactId: precomputedId,
    exitCode,
    failOpen = true,
    retentionDays,
  } = options;

  try {
    const artifactId = precomputedId ?? computeArtifactId(content);
    if (!isValidArtifactId(artifactId)) throw new Error(`Invalid artifact ID: ${artifactId}`);
    const filePath = artifactPathFor(artifactId, artifactDir);

    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      const existing = await readArtifactMetadata(artifactId, artifactDir);
      if (existing) return { ...existing, isDuplicate: true };
    } catch {}

    const metadata: ArtifactMetadata = {
      id: artifactId,
      sha256: computeContentHash(content),
      bytes: Buffer.byteLength(content, "utf8"),
      chars: content.length,
      lineCount: countLines(content),
      path: filePath,
      toolName,
      toolCallId,
      exitCode,
      createdAt: Date.now(),
      retentionDays,
      isDuplicate: false,
    };

    const envelope: ArtifactEnvelope<ArtifactMetadata> = { metadata, content };
    await atomicWriteFile(filePath, JSON.stringify(envelope));
    return metadata;
  } catch (error) {
    if (failOpen) return null;
    throw error;
  }
}

export function persistToolResultArtifactSync(options: PersistOptions): ArtifactMetadata | null {
  const {
    content,
    toolName,
    toolCallId,
    artifactDir,
    artifactId: precomputedId,
    exitCode,
    failOpen = true,
    retentionDays,
  } = options;

  try {
    const artifactId = precomputedId ?? computeArtifactId(content);
    if (!isValidArtifactId(artifactId)) throw new Error(`Invalid artifact ID: ${artifactId}`);
    const filePath = artifactPathFor(artifactId, artifactDir);

    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      const existing = readArtifactMetadataSync(artifactId, artifactDir);
      if (existing) return { ...existing, isDuplicate: true };
    } catch {}

    const metadata: ArtifactMetadata = {
      id: artifactId,
      sha256: computeContentHash(content),
      bytes: Buffer.byteLength(content, "utf8"),
      chars: content.length,
      lineCount: countLines(content),
      path: filePath,
      toolName,
      toolCallId,
      exitCode,
      createdAt: Date.now(),
      retentionDays,
      isDuplicate: false,
    };

    const envelope: ArtifactEnvelope<ArtifactMetadata> = { metadata, content };
    atomicWriteFileSync(filePath, JSON.stringify(envelope));
    return metadata;
  } catch (error) {
    if (failOpen) return null;
    throw error;
  }
}

export class DiskArtifactStoreBackend implements ArtifactStoreBackend {
  constructor(private readonly artifactDir: string) {}

  async write(id: string, content: string, metadata: ArtifactMetadata): Promise<void> {
    await atomicWriteFile(artifactPathFor(id, this.artifactDir), JSON.stringify({ metadata, content }));
  }

  readMetadata(id: string): Promise<ArtifactMetadata | null> {
    return readArtifactMetadata(id, this.artifactDir);
  }

  exists(id: string): Promise<boolean> {
    return checkArtifactExists(id, this.artifactDir);
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidArtifactId(id)) return false;
    try {
      await fs.promises.unlink(artifactPathFor(id, this.artifactDir));
      return true;
    } catch {
      return false;
    }
  }
}

export function createArtifactStoreBackend(artifactDir: string): ArtifactStoreBackend {
  return new DiskArtifactStoreBackend(artifactDir);
}

export type QuotaInfo = {
  totalBytes: number;
  artifactCount: number;
};

export async function checkQuota(artifactDir: string): Promise<QuotaInfo> {
  try {
    const entries = await fs.promises.readdir(artifactDir, { recursive: true, withFileTypes: true });
    let totalBytes = 0;
    let artifactCount = 0;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const parentPath = (entry as fs.Dirent & { parentPath?: string }).parentPath ?? artifactDir;
          const stat = await fs.promises.stat(path.join(parentPath, entry.name));
          totalBytes += stat.size;
          artifactCount += 1;
        } catch {}
      }
    }
    return { totalBytes, artifactCount };
  } catch {
    return { totalBytes: 0, artifactCount: 0 };
  }
}

export async function pruneArtifacts(
  artifactDir: string,
  options: { maxAgeMs?: number; maxTotalBytes?: number; dryRun?: boolean } = {},
): Promise<number> {
  const { maxAgeMs, dryRun = false } = options;
  void options.maxTotalBytes;
  let removed = 0;
  try {
    const entries = await fs.promises.readdir(artifactDir, { recursive: true, withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const parentPath = (entry as fs.Dirent & { parentPath?: string }).parentPath ?? artifactDir;
        const filePath = path.join(parentPath, entry.name);
        const stat = await fs.promises.stat(filePath);
        if (maxAgeMs !== undefined && now - stat.mtimeMs > maxAgeMs) {
          if (!dryRun) await fs.promises.unlink(filePath);
          removed += 1;
        }
      } catch {}
    }
  } catch {}
  return removed;
}

export function resolveArtifactDir(stateDir: string, subdir = "tool-artifacts"): string {
  const validation = validateArtifactDir(subdir, stateDir);
  if (!validation.valid) throw new Error(`Invalid artifact directory: ${validation.reason}`);
  return path.join(stateDir, path.normalize(subdir));
}
