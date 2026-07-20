/**
 * agent-worktree — run a coding agent against a developer's working tree
 * without being able to damage it.
 *
 * The problem this solves: an agent that edits files in place can destroy
 * uncommitted work, and a developer cannot keep working while it runs. The
 * usual workarounds are worse than they look — `git stash` moves the user's
 * work somewhere they did not put it, and copying the tree loses git context.
 *
 * The approach here:
 *
 *   1. Snapshot the working tree — including staged, unstaged and untracked
 *      files — into a real commit object, using a temporary index so the user's
 *      own index, stash and status are provably unchanged.
 *   2. Check that snapshot out into a separate worktree on a new branch.
 *   3. Let the agent work there. The user keeps editing, undisturbed.
 *   4. Commit as you go. The branch survives teardown, so nothing is orphaned.
 *
 * Path access is mediated separately: see `resolveInside` and `assertDeletable`.
 *
 * @example
 * ```ts
 * const wt = await Worktree.create({ projectPath: "/repo", sessionId: "task-1" });
 * try {
 *   await fs.writeFile(path.join(wt.worktree, "NOTES.md"), "hello");
 *   await wt.commit("agent: add notes");
 * } finally {
 *   await wt.dispose(); // branch and commits survive
 * }
 * ```
 */

export { Worktree, type WorktreeOptions } from "./session";
export { snapshotWorkingTree } from "./snapshot";

export {
  resolveInside,
  assertNotDenied,
  assertDeletable,
  PolicyViolation,
  type PolicyContext,
} from "./policy";

export {
  listWorktrees,
  pruneWorktrees,
  removeWorktrees,
  type WorktreeEntry,
} from "./cleanup";

export { git, isGitRepo, repoRoot, trackedFiles, GitError } from "./git";
