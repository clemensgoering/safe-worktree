import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repoRoot } from "./git";

/**
 * Captures the user's current working tree — including staged, unstaged and
 * untracked changes — as a real commit object, WITHOUT mutating anything the
 * user can observe.
 *
 * The trick is `GIT_INDEX_FILE`: `git add -A` populates a throwaway index in
 * a temp directory instead of `.git/index`, so the user's staging area stays
 * byte-identical. No stash entry is written and no ref is moved; the commit is
 * initially reachable only by the SHA we return.
 *
 * Files ignored via .gitignore are excluded, which keeps node_modules and build
 * output out of the snapshot for free.
 *
 * Verified invariant: after this call, `git status --porcelain`, the index
 * checksum, and `git stash list` are all unchanged.
 */
export async function snapshotWorkingTree(
  cwd: string,
  message = "snapshot of working tree",
): Promise<string> {
  const root = await repoRoot(cwd);
  const scratch = await mkdtemp(join(tmpdir(), "snapshot-idx-"));
  const indexFile = join(scratch, "index");

  try {
    // The temp index starts absent, so `add -A` builds a tree that mirrors the
    // working tree exactly rather than diffing against the user's staged state.
    await git(root, ["add", "-A"], { GIT_INDEX_FILE: indexFile });
    const tree = await git(root, ["write-tree"], { GIT_INDEX_FILE: indexFile });

    // Parent the snapshot on HEAD when one exists; an unborn branch has none.
    const head = await currentHead(root);
    const args = ["commit-tree", tree, "-m", message];
    if (head) args.push("-p", head);

    return await git(root, args, { GIT_INDEX_FILE: indexFile });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function currentHead(root: string): Promise<string | null> {
  try {
    return await git(root, ["rev-parse", "HEAD"]);
  } catch {
    return null; // repository with no commits yet
  }
}
