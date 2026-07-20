import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repoRoot, trackedFiles } from "./git";
import { snapshotWorkingTree } from "./snapshot";
import type { PolicyContext } from "./policy";

export interface WorktreeOptions {
  /** Any directory inside the user's repository. */
  readonly projectPath: string;
  /** Prefix for the branch name; keep it filesystem-safe. */
  readonly sessionId: string;
  /** Branch namespace. Defaults to "agent". */
  readonly branchPrefix?: string;
}

/**
 * An isolated place for the agent to work.
 *
 * The user's checkout is never touched: we snapshot their working tree into a
 * commit object, then check that commit out into a *separate* git worktree.
 * The agent sees exactly what the user sees — uncommitted edits included — but
 * writes land in a different directory on a `companion/*` branch, so the user
 * can keep editing while a session runs and nothing can collide.
 */
export class Worktree {
  private constructor(
    readonly worktree: string,
    readonly branch: string,
    readonly snapshot: string,
    readonly repoRootPath: string,
    readonly policy: PolicyContext,
  ) {}

  static async create(opts: WorktreeOptions): Promise<Worktree> {
    const root = await repoRoot(opts.projectPath);
    const snapshot = await snapshotWorkingTree(root);
    // Unique per session, and created with -b rather than -B.
    //
    // -B resets an existing branch to the new commit. With a session per turn
    // that silently destroyed the previous turn's work every time the user sent
    // a second message — the branch looked healthy and the commits were gone.
    // A branch is now only ever created, never moved.
    const worktree = await mkdtemp(join(tmpdir(), "worktree-"));
    const branch = await createUniqueBranch(
      root,
      worktree,
      snapshot,
      `${opts.branchPrefix ?? "agent"}/${opts.sessionId}`,
    );

    const tracked = await trackedFiles(worktree, snapshot);
    return new Worktree(worktree, branch, snapshot, root, {
      worktree,
      tracked,
    });
  }

  /** When the user's working tree was captured, for reporting staleness. */
  readonly startedAt = new Date();

  /** Commits whatever the agent changed. Returns null when nothing changed. */
  async commit(message: string): Promise<string | null> {
    await git(this.worktree, ["add", "-A"]);
    const staged = await git(this.worktree, ["diff", "--cached", "--name-only"]);
    if (!staged) return null;
    await git(this.worktree, ["commit", "-q", "-m", message]);
    return git(this.worktree, ["rev-parse", "HEAD"]);
  }

  /** Files changed relative to the snapshot, for review on the phone. */
  async diffStat(): Promise<string> {
    return git(this.worktree, ["diff", "--stat", this.snapshot]);
  }

  /**
   * Removes the temporary worktree. The branch and its commits are deliberately
   * kept so the user can review or cherry-pick from their own checkout later.
   */
  async dispose(): Promise<void> {
    await git(this.repoRootPath, [
      "worktree",
      "remove",
      "--force",
      this.worktree,
    ]).catch(() => undefined);
    await rm(this.worktree, { recursive: true, force: true });
  }
}

/**
 * Creates the worktree on a branch name that is definitely free.
 *
 * The timestamp only has second resolution, so two sessions for one project
 * started in the same second collide — which happens for real when a user
 * resets a conversation and immediately sends another message. Retrying with a
 * suffix makes uniqueness certain rather than likely, and `-b` still refuses to
 * move an existing branch, so no commits can be lost to a name clash.
 */
async function createUniqueBranch(
  root: string,
  worktree: string,
  snapshot: string,
  prefix: string,
): Promise<string> {
  const base = `${prefix}-${stamp()}`;

  for (let attempt = 0; attempt < 50; attempt++) {
    const branch = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      await git(root, ["worktree", "add", "-q", "-b", branch, worktree, snapshot]);
      return branch;
    } catch (err) {
      if (!/already exists/.test(String(err))) throw err;
    }
  }
  throw new Error("Could not find an unused branch name for this session.");
}

/** Compact, sortable, human-readable branch suffix. */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
