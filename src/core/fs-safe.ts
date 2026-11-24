/**
 * src/core/fs-safe.ts — injectable filesystem layer (SPEC §9).
 *
 * `ReadFs` is the read-only surface that planners receive. `Fs` adds the write methods that only
 * `apply()` closures may call, which makes dry-run parity a type-level property (AGENTS.md invariant 3).
 * Every function takes `fs` as its first parameter. There are no module-level singletons.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
}

/**
 * Writes `content` to `path` via a temp file in the same directory followed by `rename` (D6).
 * A symlink at `path` is kept: the write goes to its real target. A dangling symlink throws FsSafeError.
 */
export async function atomicWrite(
  fs: Fs,
  path: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<{ readonly writtenPath: string }> {
  let writtenPath = path;
  let existingMode: number | undefined;

  let lst: FileStat | undefined;
  try {
    lst = await fs.lstat(path);
  } catch (err: unknown) {
    if (!isNotFound(err)) throw err;
  }
  if (lst?.isSymbolicLink) {
    try {
      writtenPath = await fs.realpath(path);
    } catch (err: unknown) {
      throw new FsSafeError("dangling symlink", path, { cause: err });
    }
  }
  if (lst !== undefined) {
    existingMode = (await fs.stat(writtenPath)).mode;
  }

  const mode = opts.mode ?? existingMode;
  await fs.mkdir(dirname(writtenPath), { recursive: true });

  const suffix = opts.tmpSuffix ? opts.tmpSuffix() : randomBytes(4).toString("hex");
  const tmp = join(dirname(writtenPath), `${basename(writtenPath)}.${suffix}.yoke.tmp`);

  try {
    await fs.writeFile(tmp, content, { flag: "wx", mode });
    if (mode !== undefined) {
      await fs.chmod(tmp, mode);
    }
    await fs.rename(tmp, writtenPath);
  } catch (err: unknown) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }

  return { writtenPath };
}
