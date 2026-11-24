/**
 * src/core/fs-safe.ts — injectable filesystem layer (SPEC §9).
 *
 * `ReadFs` is the read-only surface that planners receive. `Fs` adds the write methods that only
 * `apply()` closures may call, which makes dry-run parity a type-level property (AGENTS.md invariant 3).
 * Every function takes `fs` as its first parameter. There are no module-level singletons.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  type JsonKeyPath,
  JsonPatchError,
  type JsonPatchResult,
  type JsonValue,
  parseJsonText,
  patchJsonKey,
} from "./json-text.js";

export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  /** Permission bits only (`st.mode & 0o7777`). */
  readonly mode: number;
}

export interface ReadFs {
  /** utf8. Rejects with the underlying fs error (ENOENT, EACCES, ...). */
  readFile(path: string): Promise<string>;
  lstat(path: string): Promise<FileStat>;
  stat(path: string): Promise<FileStat>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
}

export interface Fs extends ReadFs {
  writeFile(
    path: string,
    data: string,
    opts: { readonly flag: "w" | "wx"; readonly mode?: number },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, opts: { readonly recursive: boolean; readonly mode?: number }): Promise<void>;
  /** Exclusive: fails with EEXIST when `to` already exists (COPYFILE_EXCL). */
  copyFile(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export const READ_METHODS = ["readFile", "lstat", "stat", "readlink", "realpath"] as const;

/** Node-backed implementation. The only place in src/core that wraps `node:fs/promises`. */
export function createNodeFs(): Fs {
  return {
    readFile: (path) => fsp.readFile(path, "utf8"),
    lstat: async (path) => toFileStat(await fsp.lstat(path)),
    stat: async (path) => toFileStat(await fsp.stat(path)),
    readlink: (path) => fsp.readlink(path),
    realpath: (path) => fsp.realpath(path),
    writeFile: (path, data, opts) =>
      fsp.writeFile(path, data, { encoding: "utf8", flag: opts.flag, mode: opts.mode }),
    rename: (from, to) => fsp.rename(from, to),
    mkdir: async (path, opts) => {
      await fsp.mkdir(path, { recursive: opts.recursive, mode: opts.mode });
    },
    copyFile: (from, to) => fsp.copyFile(from, to, fsp.constants.COPYFILE_EXCL),
    symlink: (target, path) => fsp.symlink(target, path),
    unlink: (path) => fsp.unlink(path),
    chmod: (path, mode) => fsp.chmod(path, mode),
  };
}

function toFileStat(st: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
}): FileStat {
  return {
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
    mode: st.mode & 0o7777,
  };
}

/**
 * Returns a new object that carries only the read methods, bound to `fs`.
 * Because the write methods are absent at runtime, a cast cannot recover them.
 */
export function toReadFs(fs: ReadFs): ReadFs {
  return {
    readFile: (path) => fs.readFile(path),
    lstat: (path) => fs.lstat(path),
    stat: (path) => fs.stat(path),
    readlink: (path) => fs.readlink(path),
    realpath: (path) => fs.realpath(path),
  };
}

/** Returns `err.code` when it is a string, otherwise undefined. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code: unknown = err.code;
  return typeof code === "string" ? code : undefined;
}

/** True for ENOENT and ENOTDIR (a path component is missing or is not a directory). */
export function isNotFound(err: unknown): boolean {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

export class FsSafeError extends Error {
  constructor(
    message: string,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FsSafeError";
  }
}

/** Reads a utf8 file, returning undefined when it does not exist. Other errors propagate. */
export async function readTextIfExists(fs: ReadFs, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path);
  } catch (err: unknown) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export interface AtomicWriteOptions {
  /** Permission bits for the written file. Defaults to the existing file's mode, else the umask default. */
  readonly mode?: number;
  /** Returns the random part of the temp file name. Defaults to 8 random hex chars. */
  readonly tmpSuffix?: () => string;
  /**
   * Defaults to true: a symlink at `path` is kept and its real target is written.
   * When false, a symlink at `path` is replaced by a regular file (SPEC §8.2).
   */
  readonly followSymlinks?: boolean;
  /**
   * Used only when `followSymlinks` is false and `path` is a link. The link is recorded in this session
   * as a text file (kind "link-text") before it is replaced. Without a session nothing is backed up.
   */
  readonly backup?: BackupSession;
}

/**
 * Writes `content` to `path` via a temp file in the same directory followed by `rename` (D6).
 * By default a symlink at `path` is kept: the write goes to its real target. A dangling symlink throws FsSafeError.
 * With `followSymlinks: false` the temp file is created beside the link and `rename` replaces the link itself.
 */
export async function atomicWrite(
  fs: Fs,
  path: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<{ readonly writtenPath: string }> {
  const followSymlinks = opts.followSymlinks ?? true;
  let writtenPath = path;
  let existingMode: number | undefined;

  let lst: FileStat | undefined;
  try {
    lst = await fs.lstat(path);
  } catch (err: unknown) {
    if (!isNotFound(err)) throw err;
  }
  const replacingLink = lst?.isSymbolicLink === true && !followSymlinks;
  if (lst?.isSymbolicLink && followSymlinks) {
    try {
      writtenPath = await fs.realpath(path);
    } catch (err: unknown) {
      throw new FsSafeError("dangling symlink", path, { cause: err });
    }
  }
  if (lst !== undefined) {
    try {
      existingMode = (await fs.stat(writtenPath)).mode;
    } catch (err: unknown) {
      // A dangling link being replaced has no target mode to inherit.
      if (!(replacingLink && isNotFound(err))) throw err;
    }
  }

  const mode = opts.mode ?? existingMode;
  await fs.mkdir(dirname(writtenPath), { recursive: true });
  if (replacingLink && opts.backup !== undefined) {
    await opts.backup.backup(path, { kind: "link-text" });
  }

  const suffix = opts.tmpSuffix ? opts.tmpSuffix() : randomBytes(4).toString("hex");
  const tmp = join(dirname(writtenPath), `${basename(writtenPath)}.${suffix}.yoke.tmp`);

  // Only remove the temp file when this call created it. A foreign file at the same name is left alone.
  let created = false;
  try {
    try {
      await fs.writeFile(tmp, content, { flag: "wx", mode });
    } catch (err: unknown) {
      if (errorCode(err) !== "EEXIST") created = true;
      throw err;
    }
    created = true;
    if (mode !== undefined) {
      await fs.chmod(tmp, mode);
    }
    await fs.rename(tmp, writtenPath);
  } catch (err: unknown) {
    if (created) await fs.unlink(tmp).catch(() => {});
    throw err;
  }

  return { writtenPath };
}

// #region F2 backup+symlink

export interface BackupOptions {
  readonly fs: Fs;
  /** absolute, e.g. <userConfigDir>/backups */
  readonly root: string;
  readonly now: () => Date;
}

export interface BackupSession {
  /**
   * Copies the current file (content, following links), or the link itself (kind "link", stored as a symlink),
   * or the link's target text (kind "link-text", stored as a text file named after the link).
   * Returns the backup path, or undefined if the source is missing.
   */
  backup(
    path: string,
    opts?: { readonly kind?: "content" | "link" | "link-text" },
  ): Promise<string | undefined>;
  /** Backup directory for this session. Set after the first successful backup. */
  readonly dir: () => string | undefined;
}

/** Formats a date as a Windows-safe, sortable directory name (`:` and `.` become `-`). */
export function formatBackupTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/**
 * Maps an absolute source path to its mirror path inside a backup directory.
 * `/home/u/app.json` becomes `home/u/app.json`, and `C:\a\b` becomes `C/a/b`.
 */
export function backupRelativePath(absPath: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(absPath);
  let rel: string;
  if (drive?.[1] !== undefined) {
    rel = `${drive[1]}/${absPath.slice(3).replace(/\\/g, "/")}`;
  } else if (absPath.startsWith("/")) {
    rel = absPath.replace(/^\/+/, "");
  } else {
    throw new FsSafeError("backup path must be absolute", absPath);
  }
  const segments = rel.split("/");
  if (rel === "" || segments.some((segment) => segment === "" || segment === "..")) {
    throw new FsSafeError("backup path has empty or parent segments", absPath);
  }
  return rel;
}

export function createBackupSession(opts: BackupOptions): BackupSession {
  const { fs, root, now } = opts;
  let sessionDir: string | undefined;
  const copied = new Map<string, string>();

  async function ensureSessionDir(): Promise<string> {
    if (sessionDir !== undefined) return sessionDir;
    await fs.mkdir(root, { recursive: true });
    const base = formatBackupTimestamp(now());
    for (let attempt = 0; attempt < 100; attempt++) {
      const name = attempt === 0 ? base : `${base}-${attempt}`;
      const candidate = join(root, name);
      try {
        await fs.mkdir(candidate, { recursive: false, mode: 0o700 });
        sessionDir = candidate;
        return candidate;
      } catch (err: unknown) {
        if (errorCode(err) !== "EEXIST") throw err;
      }
    }
    throw new FsSafeError("could not create a unique backup directory", root);
  }

  return {
    dir: () => sessionDir,
    async backup(path, backupOpts = {}) {
      const kind = backupOpts.kind ?? "content";
      const rel = backupRelativePath(path);

      const already = copied.get(path);
      if (already !== undefined) return already;

      let st: FileStat;
      try {
        st = kind === "content" ? await fs.stat(path) : await fs.lstat(path);
      } catch (err: unknown) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
      if (st.isDirectory) {
        throw new FsSafeError("cannot back up a directory", path);
      }
      if (kind !== "content" && !st.isSymbolicLink) {
        throw new FsSafeError("expected a symbolic link", path);
      }

      const dir = await ensureSessionDir();
      const dest = join(dir, rel);
      await fs.mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      if (kind === "link") {
        await fs.symlink(await fs.readlink(path), dest);
      } else if (kind === "link-text") {
        await fs.writeFile(dest, `${await fs.readlink(path)}\n`, { flag: "wx" });
      } else {
        await fs.copyFile(path, dest);
      }
      copied.set(path, dest);
      return dest;
    },
  };
}

export type SymlinkInspection =
  | { readonly state: "missing" }
  | { readonly state: "same-link" }
  | { readonly state: "other-link"; readonly target: string }
  | { readonly state: "file" }
  | { readonly state: "other" };

/** Relative link text for `linkPath` pointing at `targetPath`. Both must be absolute. */
export function relativeLinkTarget(linkPath: string, targetPath: string): string {
  if (!isAbsolute(linkPath)) throw new FsSafeError("link path must be absolute", linkPath);
  if (!isAbsolute(targetPath)) throw new FsSafeError("target path must be absolute", targetPath);
  return relative(dirname(linkPath), targetPath);
}

export async function inspectSymlink(
  fs: ReadFs,
  linkPath: string,
  targetPath: string,
): Promise<SymlinkInspection> {
  let st: FileStat;
  try {
    st = await fs.lstat(linkPath);
  } catch (err: unknown) {
    if (isNotFound(err)) return { state: "missing" };
    throw err;
  }
  if (st.isSymbolicLink) {
    const target = await fs.readlink(linkPath);
    if (target === relativeLinkTarget(linkPath, targetPath)) return { state: "same-link" };
    return { state: "other-link", target };
  }
  if (st.isFile) return { state: "file" };
  return { state: "other" };
}

export type SafeSymlinkResult =
  | {
      readonly kind: "linked" | "unchanged";
      readonly target: string;
      readonly backupPath: string | undefined;
    }
  | {
      readonly kind: "fallback";
      readonly reason: "unsupported" | "blocked";
      readonly detail: string;
    };

const UNSUPPORTED_SYMLINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EACCES"]);

/**
 * Replaces `linkPath` with a relative symlink to `targetPath`. An existing file or foreign link is backed up
 * first. The original is never removed before the new link exists, because the link is created at a temp
 * name and then renamed over `linkPath`. Callers run the drift check before calling this.
 */
export async function safeSymlink(
  fs: Fs,
  linkPath: string,
  targetPath: string,
  opts: { readonly backup: BackupSession; readonly tmpSuffix?: () => string },
): Promise<SafeSymlinkResult> {
  const rel = relativeLinkTarget(linkPath, targetPath);
  const inspection = await inspectSymlink(fs, linkPath, targetPath);

  if (inspection.state === "same-link") {
    return { kind: "unchanged", target: rel, backupPath: undefined };
  }
  if (inspection.state === "other") {
    return {
      kind: "fallback",
      reason: "blocked",
      detail: `${linkPath} is a directory or special file`,
    };
  }

  let backupPath: string | undefined;
  if (inspection.state === "missing") {
    await fs.mkdir(dirname(linkPath), { recursive: true });
  } else {
    backupPath = await opts.backup.backup(linkPath, {
      kind: inspection.state === "file" ? "content" : "link",
    });
  }

  const suffix = opts.tmpSuffix ? opts.tmpSuffix() : randomBytes(4).toString("hex");
  const tmp = join(dirname(linkPath), `${basename(linkPath)}.${suffix}.yoke.tmp`);
  try {
    await fs.symlink(rel, tmp);
  } catch (err: unknown) {
    await fs.unlink(tmp).catch(() => {});
    const code = errorCode(err);
    if (code !== undefined && UNSUPPORTED_SYMLINK_CODES.has(code)) {
      return { kind: "fallback", reason: "unsupported", detail: `symlink refused: ${code}` };
    }
    throw err;
  }
  try {
    await fs.rename(tmp, linkPath);
  } catch (err: unknown) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }

  return { kind: "linked", target: rel, backupPath };
}

// #endregion

// #region F3 json

export {
  type JsonKeyPath,
  JsonPatchError,
  type JsonPatchResult,
  type JsonValue,
  patchJsonKey,
} from "./json-text.js";

/** Converts a JsonPatchError into an FsSafeError that keeps the cause and the path. Other errors pass through. */
function asFsSafeJsonError(path: string, err: unknown): unknown {
  if (err instanceof JsonPatchError) {
    return new FsSafeError(err.message, path, { cause: err });
  }
  return err;
}

/** Reads and parses a JSON file. Returns undefined when the file is missing. Invalid JSON throws FsSafeError. */
export async function readJsonIfExists(
  fs: ReadFs,
  path: string,
): Promise<{ readonly text: string; readonly value: JsonValue } | undefined> {
  const text = await readTextIfExists(fs, path);
  if (text === undefined) return undefined;
  try {
    return { text, value: parseJsonText(text) };
  } catch (err: unknown) {
    throw asFsSafeJsonError(path, err);
  }
}

export interface PlannedJsonPatch {
  readonly path: string;
  readonly keyPath: JsonKeyPath;
  readonly value: JsonValue | undefined;
  /** File text when planned. undefined means the file did not exist. */
  readonly before: string | undefined;
  readonly after: string;
  readonly changed: boolean;
  readonly strategy: JsonPatchResult["strategy"];
}

/** Plans a key-scoped JSON edit. Reads only; nothing is written. */
export async function planJsonPatch(
  fs: ReadFs,
  path: string,
  keyPath: JsonKeyPath,
  value: JsonValue | undefined,
): Promise<PlannedJsonPatch> {
  const before = await readTextIfExists(fs, path);
  let result: JsonPatchResult;
  try {
    result = patchJsonKey(before, keyPath, value);
  } catch (err: unknown) {
    throw asFsSafeJsonError(path, err);
  }
  return {
    path,
    keyPath,
    value,
    before,
    after: result.content,
    changed: result.changed,
    strategy: result.strategy,
  };
}

export interface CommitResult {
  readonly written: boolean;
  readonly rebased: boolean;
  readonly backupPath: string | undefined;
}

/**
 * Applies a planned JSON patch. If the file changed since planning, the key is re-patched on the
 * current text (D7), so unrelated keys written by another process survive.
 */
export async function commitJsonPatch(
  fs: Fs,
  plan: PlannedJsonPatch,
  opts: { readonly backup: BackupSession },
): Promise<CommitResult> {
  if (!plan.changed) {
    return { written: false, rebased: false, backupPath: undefined };
  }

  const current = await readTextIfExists(fs, plan.path);
  let after = plan.after;
  const rebased = current !== plan.before;
  if (rebased) {
    let result: JsonPatchResult;
    try {
      result = patchJsonKey(current, plan.keyPath, plan.value);
    } catch (err: unknown) {
      throw asFsSafeJsonError(plan.path, err);
    }
    if (!result.changed) {
      return { written: false, rebased: true, backupPath: undefined };
    }
    after = result.content;
  }

  const backupPath =
    current === undefined ? undefined : await opts.backup.backup(plan.path, { kind: "content" });
  await atomicWrite(fs, plan.path, after);
  return { written: true, rebased, backupPath };
}

export interface PlannedTextWrite {
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string;
  readonly changed: boolean;
}

/** Plans a whole-file text write. Reads only; nothing is written. */
export async function planTextWrite(
  fs: ReadFs,
  path: string,
  after: string,
): Promise<PlannedTextWrite> {
  const before = await readTextIfExists(fs, path);
  return { path, before, after, changed: before !== after };
}

/** Thrown when a file changed between planning and commit and the whole file would be overwritten. */
export class ConcurrentModificationError extends FsSafeError {
  constructor(path: string) {
    super("file changed after it was planned", path);
    this.name = "ConcurrentModificationError";
  }
}

/** Applies a planned whole-file write. Throws ConcurrentModificationError if the file changed since planning. */
export async function commitTextWrite(
  fs: Fs,
  plan: PlannedTextWrite,
  opts: { readonly backup: BackupSession },
): Promise<CommitResult> {
  const current = await readTextIfExists(fs, plan.path);
  if (current !== plan.before) {
    throw new ConcurrentModificationError(plan.path);
  }
  if (!plan.changed) {
    return { written: false, rebased: false, backupPath: undefined };
  }

  const backupPath =
    current === undefined ? undefined : await opts.backup.backup(plan.path, { kind: "content" });
  await atomicWrite(fs, plan.path, plan.after);
  return { written: true, rebased: false, backupPath };
}

// #endregion
