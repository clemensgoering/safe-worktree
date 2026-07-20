# agent-worktree

Run a coding agent against a developer's working tree without being able to
damage it.

```bash
npm install agent-worktree
```

## The problem

An agent that edits files in place can destroy uncommitted work, and the
developer can't keep working while it runs. The usual workarounds are worse than
they look:

- **`git stash`** moves the user's work somewhere they didn't put it, and a
  crash mid-session leaves it there.
- **Copying the tree** loses git context — no history, no branch, no way to
  review what changed.
- **Editing in place with a "please be careful" prompt** is not a mechanism.

## The approach

1. **Snapshot** the working tree — staged, unstaged and untracked files — into a
   real commit object, using a temporary index so the user's own index, status
   and stash are provably unchanged.
2. **Check that snapshot out** into a separate worktree on a new branch.
3. **Let the agent work there.** The user keeps editing, undisturbed.
4. **Commit as you go.** The branch survives teardown, so nothing is orphaned.

The developer's checkout is never written to. If the agent does something wrong,
they ignore the branch and lose nothing.

## Usage

```ts
import { Worktree, resolveInside, assertDeletable } from "agent-worktree";
import { readFile, writeFile, unlink } from "node:fs/promises";

const wt = await Worktree.create({
  projectPath: "/path/to/repo",   // any directory inside the repository
  sessionId: "task-1234",         // becomes part of the branch name
});

try {
  // The agent sees exactly what the developer sees, uncommitted work included.
  const readme = await readFile(`${wt.worktree}/README.md`, "utf8");

  await writeFile(`${wt.worktree}/NOTES.md`, "# Notes\n");
  await wt.commit("agent: add notes");     // → commit sha, or null if nothing changed

  console.log(await wt.diffStat());        // what changed since the snapshot
} finally {
  await wt.dispose();                      // removes the worktree; branch survives
}

console.log(wt.branch);  // "agent/task-1234-20260719-142233"
```

Review the result from the developer's own checkout:

```bash
git log agent/task-1234-20260719-142233
git merge --no-ff agent/task-1234-20260719-142233
```

### Mediating file access

`Worktree` isolates; it doesn't police individual paths. Route every
agent-supplied path through the policy layer before touching the filesystem:

```ts
import { resolveInside, assertDeletable, PolicyViolation } from "agent-worktree";

try {
  const { absolute, relative } = await resolveInside(wt.policy, agentPath);
  const content = await readFile(absolute, "utf8");
} catch (err) {
  if (err instanceof PolicyViolation) {
    // Return this to the model as a tool error — it can adapt.
    return { error: err.message, rule: err.rule };
  }
  throw err;
}

// Deleting a file git has no copy of would be unrecoverable.
assertDeletable(wt.policy, relative);
await unlink(absolute);
```

`resolveInside` rejects absolute paths, `..` traversal, symlinks pointing out of
the worktree, and a case-insensitive deny-list covering `.env*`, `.git/`,
`.ssh/`, `.aws/`, `*.pem` and common credential filenames.

### Cleaning up after a crash

`dispose()` handles the normal path. A killed process leaves a temp directory
and a git administrative entry behind:

```ts
import { listWorktrees, pruneWorktrees, removeWorktrees } from "agent-worktree";

await pruneWorktrees(repo);   // clear entries whose directory is gone
await removeWorktrees(repo);  // remove leftover worktrees this library created
```

Both leave branches alone. Their commits are the point of the isolation.

## API

| Export | Purpose |
|---|---|
| `Worktree.create(opts)` | Snapshot + isolated worktree on a new branch |
| `wt.worktree` / `wt.branch` / `wt.policy` | Path, branch name, policy context |
| `wt.commit(message)` | Commit changes; `null` if nothing changed |
| `wt.diffStat()` | Changes since the snapshot |
| `wt.dispose()` | Remove the worktree, keep the branch |
| `snapshotWorkingTree(repo)` | The primitive alone, if you want to build your own |
| `resolveInside(ctx, path)` | Confine and validate an agent-supplied path |
| `assertDeletable(ctx, path)` | Refuse deletion of untracked files |
| `listWorktrees` / `pruneWorktrees` / `removeWorktrees` | Cleanup |

## How the snapshot works

The interesting part is capturing uncommitted work without disturbing it:

```
GIT_INDEX_FILE=<temp>  git add -A     # populate a throwaway index
GIT_INDEX_FILE=<temp>  git write-tree # tree of the working tree as-is
GIT_INDEX_FILE=<temp>  git commit-tree <tree> -p HEAD
```

Because `GIT_INDEX_FILE` points at a temp file, `.git/index` is never touched.
No stash entry is written, no ref is moved, and `git status` is identical before
and after. The result is a real commit object, so everything after it is
ordinary git.

Verified by a test that compares the index byte-for-byte across the operation.

## Requirements

- Node 18+
- `git` on `PATH` (2.5+, for `git worktree`)
- A git repository. Repositories with no commits work.

## Limitations

Read [SECURITY.md](SECURITY.md) before relying on this. In short:

- **If your agent has shell access, none of this holds.** A shell escapes every
  check trivially. Containing that needs OS-level sandboxing.
- The deny-list is a blocklist, not a sandbox.
- Submodules aren't snapshotted; `.gitignore`d files are excluded.
- No resource limits — an agent can fill the disk.

## Status

Extracted from a working product where it has been running in anger, but the
package itself is new. 34 tests cover the guarantees above. Bug reports very
welcome; API may shift before 1.0.

## License

MIT
