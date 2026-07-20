import { rm } from "node:fs/promises";
import { git } from "./git";

/**
 * Housekeeping for worktrees that outlived the process which created them.
 *
 * `Worktree.dispose()` removes a worktree cleanly, but a crash, a kill -9, or a
 * host application shutting down without running its teardown leaves both a
 * temp directory on disk and an administrative entry under `.git/worktrees`.
 * Git will keep reporting those as live worktrees and refuse to reuse their
 * paths, so a long-lived process needs a way to clear them.
 */

export interface WorktreeEntry {
  /** Absolute path git believes the worktree lives at. */
  readonly path: string;
  /** Branch checked out there, if any. */
  readonly branch: string | null;
  /** False when the directory no longer exists — a stale administrative entry. */
  readonly exists: boolean;
}

/**
 * Every worktree git currently knows about, including the main checkout.
 *
 * Uses the porcelain format, which is explicitly documented as stable for
 * scripting; the human-readable output is not.
 */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]).catch(() => "");
  const entries: WorktreeEntry[] = [];

  let path: string | null = null;
  let branch: string | null = null;
  let prunable = false;

  const flush = () => {
    if (path) entries.push({ path, branch, exists: !prunable });
    path = null;
    branch = null;
    prunable = false;
  };

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line.startsWith("prunable")) {
      prunable = true;
    }
  }
  flush();

  return entries;
}

/**
 * Clears administrative entries for worktrees whose directories are gone.
 *
 * Safe by construction: `git worktree prune` only removes bookkeeping for
 * directories that no longer exist. It never deletes a worktree that is still
 * present, and never touches branches — commits made in an abandoned worktree
 * remain reachable from their branch.
 */
export async function pruneWorktrees(repo: string): Promise<number> {
  const before = (await listWorktrees(repo)).filter((w) => !w.exists).length;
  await git(repo, ["worktree", "prune"]);
  return before;
}

/**
 * Removes worktrees created by this library that are still on disk.
 *
 * For a host application that wants to clean up after an unclean shutdown.
 * Only paths whose basename starts with `prefix` are touched, so a worktree the
 * user created themselves is never removed.
 *
 * Branches are left alone. Their commits are the whole point of the isolation —
 * deleting them here would destroy the work this library exists to preserve.
 */
export async function removeWorktrees(
  repo: string,
  prefix = "worktree-",
): Promise<string[]> {
  const removed: string[] = [];

  for (const entry of await listWorktrees(repo)) {
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    if (!name.startsWith(prefix)) continue;

    await git(repo, ["worktree", "remove", "--force", entry.path]).catch(
      () => undefined,
    );
    await rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
    removed.push(entry.path);
  }

  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  return removed;
}
