# Security

This library exists to contain a coding agent. Please read the threat model
before relying on it — it is deliberate about what it does **not** protect
against.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Email **clemens.goe@gmx.de** with a description and, if possible, a reproduction.
You should get an acknowledgement within a few days. If a fix is warranted, the
report will be credited unless you prefer otherwise.

This is a small project maintained by one person. There is no bug bounty and no
guaranteed response time — please calibrate expectations accordingly.

## Threat model

**The adversary is a confused or manipulated model, not a determined attacker
with local code execution.**

Concretely, this library assumes:

- The agent proposes paths and file contents; it does not run arbitrary code.
- The host application executes tool calls and routes every path through
  `resolveInside` before touching the filesystem.
- The developer's machine is not already compromised.

If the agent can execute shell commands — as it can in many harnesses — the
guarantees below **do not hold**. A shell escapes every check here trivially
(`cat ../../.env`). Containing a shell requires OS-level sandboxing, which is
out of scope for this library.

## What is guaranteed

Each item is covered by a test in `src/worktree.test.ts`.

| Property | Mechanism |
|---|---|
| The user's working tree is never modified | The agent operates in a separate worktree; the user's checkout is never written to |
| The user's git state is unchanged | Snapshot uses `GIT_INDEX_FILE`; index, status and stash are byte-identical afterwards |
| Uncommitted and untracked work is preserved | Captured into a commit object before the worktree is created |
| Agent commits cannot be lost | Branches are created with `-b`, never `-B`; a name clash retries rather than moving a ref |
| No path escapes the worktree | `realpath` resolution before the boundary check, so symlinks cannot be used as an exit |
| Secrets are unreachable | Case-insensitive deny-list covering `.env*`, `.git/`, `.ssh/`, `.aws/`, `*.pem`, credentials |
| Untracked files are never deleted | Hard refusal — git holds no copy, so the deletion would be unrecoverable |

## What is NOT guaranteed

Be explicit with yourself about these before shipping.

- **Shell access defeats everything.** See the threat model above.
- **The deny-list is a blocklist, not a sandbox.** It covers the paths that
  matter in practice; it is not exhaustive and cannot be. If your repository
  contains secrets under project-specific names, extend it or keep them out of
  the tree.
- **Resource exhaustion is not handled.** An agent can fill the disk, write a
  file of unbounded size, or create millions of files. Impose your own limits.
- **Snapshot cost scales with repository size.** A very large working tree makes
  `git add -A` against a temp index slow. Nothing here streams or throttles.
- **Symlinks created by the agent inside the worktree are not restricted.** They
  cannot be *followed* out of the worktree by `resolveInside`, but the files
  themselves are written.
- **Submodules are not snapshotted.** Their contents are not part of the commit
  object, so the agent sees an empty directory.
- **`.gitignore`d files are excluded.** The agent cannot see `.env` files or
  build output. Usually what you want; occasionally surprising.
- **No protection against a malicious host application.** This library trusts
  its caller completely.

## Reasoning about the branch

Agent commits land on a branch and never touch the user's. That is the recovery
story: if the agent does something wrong, the user ignores the branch and loses
nothing.

It also means **branches accumulate**. `listWorktrees` and `removeWorktrees`
clean up worktrees; branches are deliberately left alone, because deleting them
would destroy the work this library exists to preserve. Cleaning them up is the
host application's decision, and `git branch -d` — which refuses unmerged
branches — is the right tool.

## Known non-issues

- **The snapshot commit is unreachable until a worktree is created.** This is
  intentional: it is a real object, recoverable via `git fsck`, and becomes
  reachable the moment the branch exists.
- **Two sessions in the same second get different branches.** Branch creation
  retries with a suffix rather than reusing a name.
