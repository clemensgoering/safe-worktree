import { realpath } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, basename } from "node:path";

export class PolicyViolation extends Error {
  constructor(message: string, readonly rule: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

/**
 * Paths the agent may never read or write, regardless of confinement. Secrets
 * that leak into a transcript are unrecoverable, and .git surgery can destroy
 * history in ways our commit-everything guarantee does not cover.
 *
 * Every pattern is case-insensitive. macOS and Windows filesystems are
 * case-insensitive by default, so a case-sensitive deny-list is bypassable by
 * asking for ".ENV" — which resolves to the same file and was allowed through.
 */
const DENIED_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.env($|\..*)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)($|\.)/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)service-account.*\.json$/i,
];

/** Bulk deletions above this size require explicit user confirmation. */
export const DELETE_CONFIRM_THRESHOLD = 3;

export interface PolicyContext {
  /** Absolute path of the agent's isolated worktree. */
  readonly worktree: string;
  /** Repo-relative paths tracked by git in the snapshot. */
  readonly tracked: ReadonlySet<string>;
}

/**
 * Resolves a caller-supplied path and proves it lands inside the agent
 * worktree, following symlinks first so a link pointing outside cannot be used
 * as an escape hatch.
 *
 * For paths that do not exist yet (a file about to be created) the nearest
 * existing ancestor is resolved instead, since realpath would otherwise throw.
 */
export async function resolveInside(
  ctx: PolicyContext,
  requested: string,
): Promise<{ absolute: string; relative: string }> {
  assertWellFormed(requested);

  if (isAbsolute(requested)) {
    throw new PolicyViolation(
      `Absolute paths are not accepted: ${requested}`,
      "absolute-path",
    );
  }

  const worktreeReal = await realpath(ctx.worktree);
  const candidate = resolve(worktreeReal, requested);

  // Two separate checks, because they answer different questions.
  //
  // The anchor is the nearest ancestor that exists, resolved through symlinks —
  // it catches a link pointing out of the worktree. An empty relative path here
  // is legitimate: for a new file at the project root, the nearest existing
  // ancestor IS the root. Treating that as an escape made it impossible to
  // create a file at the top level.
  const anchor = await realpathNearest(candidate);
  const anchorRel = relative(worktreeReal, anchor);
  if (anchorRel.startsWith("..") || isAbsolute(anchorRel)) {
    throw new PolicyViolation(
      `Path escapes the project workspace: ${requested}`,
      "confinement",
    );
  }

  // The candidate is the requested path itself. An empty relative path here
  // means the worktree root was requested as a file, which is never valid.
  const relFromWorktree = relative(worktreeReal, candidate);
  if (
    relFromWorktree === "" ||
    relFromWorktree.startsWith("..") ||
    isAbsolute(relFromWorktree)
  ) {
    throw new PolicyViolation(
      `Path escapes the project workspace: ${requested}`,
      "confinement",
    );
  }

  assertNotDenied(relFromWorktree);
  return { absolute: candidate, relative: relFromWorktree };
}

/**
 * Rejects paths whose *text* is dangerous, before any resolution happens.
 *
 * Each of these is a way to make the string that gets validated differ from the
 * file that eventually gets opened:
 *
 *   - NUL truncates a path at the C-string layer. Node rejects it today, but a
 *     path that passes validation and cannot be used is a lie either way.
 *   - Windows silently strips trailing dots and spaces, so ".env " opens ".env"
 *     while the deny-list sees a different name.
 *   - Windows treats "file:stream" as an alternate data stream of "file";
 *     ".env::$DATA" is the classic way to read a file whose name is blocked.
 *     Colons are legal on Unix but a coding agent has no need for them, so they
 *     are refused everywhere rather than only on Windows — a rule that changes
 *     by platform is a rule that gets tested on one and shipped on the other.
 */
function assertWellFormed(requested: string): void {
  if (requested.trim() === "") {
    throw new PolicyViolation("An empty path was requested.", "malformed-path");
  }

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(requested)) {
    throw new PolicyViolation(
      "Path contains control characters.",
      "malformed-path",
    );
  }

  for (const segment of requested.split(/[/\\]/)) {
    if (segment === "") continue;

    if (segment !== segment.trimEnd() || segment.endsWith(".") && segment !== "." && segment !== "..") {
      throw new PolicyViolation(
        `Path segment '${segment}' ends with a space or dot, which some ` +
          `filesystems silently strip.`,
        "malformed-path",
      );
    }

    if (segment.includes(":")) {
      throw new PolicyViolation(
        `Path segment '${segment}' contains a colon.`,
        "malformed-path",
      );
    }
  }
}

export function assertNotDenied(relPath: string): void {
  const normalized = relPath.split("\\").join("/");
  for (const pattern of DENIED_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(basename(normalized))) {
      throw new PolicyViolation(
        `Access to ${relPath} is blocked by policy.`,
        "deny-list",
      );
    }
  }
}

/**
 * Untracked files exist only on disk — git has no copy, so deleting one is
 * genuinely irreversible even inside the isolated worktree. This is a hard
 * block with no confirmation path.
 */
export function assertDeletable(ctx: PolicyContext, relPath: string): void {
  const normalized = relPath.split("\\").join("/");
  if (!ctx.tracked.has(normalized)) {
    throw new PolicyViolation(
      `Refusing to delete '${relPath}': it is untracked by git, so the ` +
        `deletion could not be undone. Ask the user to commit it first.`,
      "untracked-delete",
    );
  }
}

/** Walks up to the nearest existing ancestor and resolves symlinks there. */
async function realpathNearest(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
