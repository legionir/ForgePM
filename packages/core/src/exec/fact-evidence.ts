import { sql } from 'kysely';
import { AppError, type ExecFactSource } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { getEffective } from '../settings';
import { makeScopeManifest, type ScopeFileManifest, type ScopeManifestFile } from './scope';
import type { ExecFactFileSource } from './review-source';
import type { LedgerActor } from './open-items-service';

export interface ParsedFactSourceRef {
  kind: 'file' | 'commit' | 'cmd';
  value: string;
  path?: string;
}

export interface FactEvidenceSnapshot {
  files: string[];
  fileHashes: ScopeManifestFile[];
}

/** `file:path[:line]`, `commit:sha[:path]`, `cmd:journal-ref`, or a relative docs path. */
export function parseFactSourceRef(raw: string): ParsedFactSourceRef {
  const ref = raw.trim();
  if (!ref || ref.length > 500 || /[\0\r\n]/.test(ref)) {
    throw invalidSourceRef('source_ref must be a non-empty, inspectable reference');
  }
  if (ref.startsWith('file:')) {
    const path = stripLineSuffix(ref.slice(5));
    assertRelativeRefPath(path);
    return { kind: 'file', value: path, path };
  }
  if (ref.startsWith('commit:')) {
    const value = ref.slice(7);
    const match = /^([0-9a-f]{7,64})(?::(.+))?$/i.exec(value);
    if (!match) throw invalidSourceRef('commit: source_ref must contain a parseable 7–64 character Git SHA');
    const path = match[2] ? stripLineSuffix(match[2]) : undefined;
    if (path !== undefined) assertRelativeRefPath(path);
    return { kind: 'commit', value: match[1]!, ...(path ? { path } : {}) };
  }
  if (ref.startsWith('cmd:')) {
    const value = ref.slice(4).trim();
    if (!value || value.length > 200 || /[\0\r\n]/.test(value)) {
      throw invalidSourceRef('cmd: source_ref must name a completed journal entry');
    }
    return { kind: 'cmd', value };
  }
  if (ref.includes(':')) throw invalidSourceRef('unsupported source_ref; use file:, commit:, or cmd:');
  // Older human promotion calls used a plain documentation path; retain that
  // spelling, but make its inspectability a write-time check rather than trust.
  assertRelativeRefPath(ref);
  return { kind: 'file', value: ref, path: ref };
}

function assertRelativeRefPath(path: string): void {
  if (
    !path || path.length > 400 || path.startsWith('/') || path.includes('\\') || hasControlChars(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw invalidSourceRef('source_ref file paths must be relative and cannot escape the repository');
  }
}

export async function inspectFactEvidence(
  db: DbLike,
  actor: LedgerActor,
  input: {
    source: ExecFactSource;
    sourceRef?: string | null;
    files: readonly string[];
    requireSourceRef?: boolean;
    requireCodeFiles?: boolean;
  },
  source: (ExecFactFileSource & { fileSnapshot?: (input: { roots: string[] }) => Promise<ScopeFileManifest> }) | null,
): Promise<FactEvidenceSnapshot> {
  const sourceRef = input.sourceRef?.trim() || null;
  if (input.requireSourceRef && !sourceRef) {
    throw new AppError('VALIDATION_ERROR', `a '${input.source}' fact must name an inspectable source_ref`, {
      needed_action: "send file:<path>, commit:<sha>, or cmd:<completed journal ref>; a guess is not evidence",
    });
  }

  const files = [...new Set(input.files.map((path) => path.trim()).filter(Boolean))];
  let parsed: ParsedFactSourceRef | null = null;
  if (sourceRef) {
    parsed = parseFactSourceRef(sourceRef);
    if (parsed.kind === 'file' && parsed.path && !files.includes(parsed.path)) files.push(parsed.path);
    if (parsed.kind === 'commit') {
      if (!source?.resolveCommit) {
        throw unavailable('a Git source is not configured to inspect commit references');
      }
      try {
        await source.resolveCommit(parsed.value);
      } catch {
        throw unavailable(`commit reference '${parsed.value}' does not resolve to a commit`);
      }
    }
    if (parsed.kind === 'cmd') await requireCompletedJournal(db, actor, parsed.value);
  }
  if (input.source === 'tool_output' && sourceRef && parsed?.kind !== 'cmd') {
    throw invalidSourceRef("tool_output facts must cite cmd:<completed journal ref>");
  }
  if (input.requireCodeFiles && files.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'code-sourced facts must name at least one file to hash', {
      needed_action: 'include the source file in files (or cite it with file:<path>)',
    });
  }

  const normalizedFiles = files.sort();
  if (!normalizedFiles.length) return { files: normalizedFiles, fileHashes: [] };
  const roots = await allowedRoots(db, actor);
  if (!roots.length) throw unavailable('exec.allowed_repo_roots is empty; configure a read-only repository root first');
  if (!source?.hashFiles && !source?.fileSnapshot) throw unavailable('no read-only file-hash source is configured');

  let manifest: ScopeFileManifest;
  try {
    if (source.hashFiles) {
      manifest = await source.hashFiles({ roots, files: normalizedFiles, allowMissing: false });
    } else {
      const all = await source.fileSnapshot!({ roots });
      const wanted = new Set(normalizedFiles);
      manifest = makeScopeManifest(all.files.filter((file) => wanted.has(file.path)));
    }
  } catch {
    throw new AppError('EVIDENCE_UNAVAILABLE', 'a fact source file is missing, outside allowed roots, or could not be hashed safely', {
      needed_action: 'use an existing relative file under exec.allowed_repo_roots, or ask a human to confirm the source',
    });
  }
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  const missing = normalizedFiles.filter((path) => !byPath.has(path));
  if (missing.length) {
    throw new AppError('EVIDENCE_UNAVAILABLE', `fact source file(s) are not inspectable: ${missing.slice(0, 5).join(', ')}`, {
      needed_action: 'use existing files under exec.allowed_repo_roots and record their exact relative paths',
    });
  }
  return { files: normalizedFiles, fileHashes: normalizedFiles.map((path) => byPath.get(path)!) };
}

export async function allowedRoots(db: DbLike, actor: Pick<LedgerActor, 'organizationId' | 'projectId'>): Promise<string[]> {
  const setting = await getEffective(db, 'exec.allowed_repo_roots', actor.organizationId, actor.projectId);
  if (!Array.isArray(setting?.value)) return [];
  return [...new Set(setting.value.filter((value): value is string => typeof value === 'string'))];
}

export function sourceRefPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = parseFactSourceRef(raw);
    return parsed.kind === 'file' ? (parsed.path ?? null) : null;
  } catch {
    return null;
  }
}

function stripLineSuffix(path: string): string {
  return path.replace(/:\d+(?::\d+)?$/, '');
}

async function requireCompletedJournal(db: DbLike, actor: LedgerActor, ref: string): Promise<void> {
  const rows = await sql<{ code: string }>`
    SELECT j.code
    FROM exec_action_journal j JOIN exec_tasks t ON t.id = j.task_id
    WHERE t.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${actor.projectId}::uuid
      AND (j.code = ${ref} OR j.id::text = ${ref})
      AND j.status = 'done' AND j.result_ref IS NOT NULL
    LIMIT 1
  `.execute(db as never);
  if (!rows.rows[0]) {
    throw new AppError('EVIDENCE_UNAVAILABLE', `command source '${ref}' is not a completed journal entry with a result_ref`, {
      needed_action: 'journal the command, settle it as done, and cite cmd:<journal code or id>',
    });
  }
}

function hasControlChars(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function invalidSourceRef(message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    needed_action: 'use an inspectable file:<path>, commit:<sha>, or cmd:<completed journal ref>',
  });
}

function unavailable(message: string): AppError {
  return new AppError('EVIDENCE_UNAVAILABLE', message, {
    needed_action: 'configure exec.allowed_repo_roots and a read-only file/Git source, or ask a human to confirm the source',
  });
}
