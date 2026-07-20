import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git";
import { snapshotWorkingTree } from "./snapshot";
import { Worktree } from "./session";
import { resolveInside, assertDeletable, PolicyViolation } from "./policy";
import { listWorktrees, pruneWorktrees, removeWorktrees } from "./cleanup";

const made: string[] = [];

async function repoWithDirtyState(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "aw-test-"));
  made.push(repo);
  await git(repo, ["init", "-q", "-b", "main", "."]);
  await git(repo, ["config", "user.email", "t@t.t"]);
  await git(repo, ["config", "user.name", "T"]);

  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/app.js"), "console.log(1)\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "base"]);

  // Realistic dirty state.
  await writeFile(join(repo, "tracked.txt"), "UNCOMMITTED EDIT\n");
  await writeFile(join(repo, "untracked.txt"), "never committed\n");
  await writeFile(join(repo, "staged.txt"), "staged\n");
  await git(repo, ["add", "staged.txt"]);
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(join(repo, "node_modules/junk.js"), "junk\n");
  return repo;
}

const status = async (dir: string) =>
  (await git(dir, ["status", "--porcelain"])).split("\n").sort().join("\n");

after(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

describe("snapshotWorkingTree", () => {
  test("captures uncommitted, staged and untracked work", async () => {
    const repo = await repoWithDirtyState();
    const snap = await snapshotWorkingTree(repo);

    const files = await git(repo, ["ls-tree", "-r", "--name-only", snap]);
    assert.ok(files.includes("untracked.txt"), "untracked file missing");
    assert.ok(files.includes("staged.txt"), "staged file missing");
    assert.equal(
      await git(repo, ["show", `${snap}:tracked.txt`]),
      "UNCOMMITTED EDIT",
      "uncommitted edit lost",
    );
  });

  // The core promise: the user's own git state is provably untouched.
  test("leaves the index, status and stash byte-identical", async () => {
    const repo = await repoWithDirtyState();
    const before = await status(repo);
    const beforeIndex = await readFile(join(repo, ".git/index"));

    await snapshotWorkingTree(repo);

    assert.equal(await status(repo), before, "status changed");
    assert.deepEqual(
      await readFile(join(repo, ".git/index")),
      beforeIndex,
      "the user's staging index was mutated",
    );
    assert.equal(await git(repo, ["stash", "list"]), "", "a stash entry was written");
  });

  test("excludes gitignored files", async () => {
    const repo = await repoWithDirtyState();
    const snap = await snapshotWorkingTree(repo);
    const files = await git(repo, ["ls-tree", "-r", "--name-only", snap]);
    assert.ok(!files.includes("node_modules"), "ignored files leaked in");
  });

  // A repository with no commits has no HEAD to parent the snapshot on.
  test("works in a repository with no commits", async () => {
    const repo = await mkdtemp(join(tmpdir(), "aw-empty-"));
    made.push(repo);
    await git(repo, ["init", "-q", "-b", "main", "."]);
    await git(repo, ["config", "user.email", "t@t.t"]);
    await git(repo, ["config", "user.name", "T"]);
    await writeFile(join(repo, "draft.md"), "first draft\n");

    const snap = await snapshotWorkingTree(repo);
    assert.equal(await git(repo, ["show", `${snap}:draft.md`]), "first draft");
  });
});

describe("Worktree", () => {
  test("gives the agent the user's current state, uncommitted work included", async () => {
    const repo = await repoWithDirtyState();
    const wt = await Worktree.create({ projectPath: repo, sessionId: "t" });
    made.push(wt.worktree);

    assert.equal(
      await readFile(join(wt.worktree, "tracked.txt"), "utf8"),
      "UNCOMMITTED EDIT\n",
    );
    assert.ok(await readFile(join(wt.worktree, "untracked.txt"), "utf8"));
    await wt.dispose();
  });

  test("destruction inside the worktree cannot reach the user's checkout", async () => {
    const repo = await repoWithDirtyState();
    const before = await status(repo);
    const wt = await Worktree.create({ projectPath: repo, sessionId: "t" });

    await rm(join(wt.worktree, "tracked.txt"));
    await rm(join(wt.worktree, "src"), { recursive: true });
    await wt.commit("agent: destructive change");

    assert.equal(await status(repo), before, "user's status changed");
    assert.equal(
      await readFile(join(repo, "tracked.txt"), "utf8"),
      "UNCOMMITTED EDIT\n",
      "user's uncommitted edit was lost",
    );
    assert.ok(await stat(join(repo, "src")), "user's directory was deleted");
    await wt.dispose();
  });

  test("commits accumulate across calls", async () => {
    const repo = await repoWithDirtyState();
    const wt = await Worktree.create({ projectPath: repo, sessionId: "t" });

    await writeFile(join(wt.worktree, "one.md"), "1\n");
    await wt.commit("agent: one");
    await writeFile(join(wt.worktree, "two.md"), "2\n");
    await wt.commit("agent: two");

    const log = await git(repo, ["log", "--oneline", wt.branch]);
    assert.match(log, /agent: one/, "the first commit was lost");
    assert.match(log, /agent: two/);
    await wt.dispose();
  });

  test("commit returns null when nothing changed", async () => {
    const repo = await repoWithDirtyState();
    const wt = await Worktree.create({ projectPath: repo, sessionId: "t" });
    assert.equal(await wt.commit("agent: nothing"), null);
    await wt.dispose();
  });

  test("the branch and its commits survive dispose", async () => {
    const repo = await repoWithDirtyState();
    const wt = await Worktree.create({ projectPath: repo, sessionId: "t" });
    await writeFile(join(wt.worktree, "idea.md"), "# idea\n");
    await wt.commit("agent: idea");
    await wt.dispose();

    assert.equal(await git(repo, ["show", `${wt.branch}:idea.md`]), "# idea");
  });

  // Two sessions started in the same second must not collide, and an existing
  // branch must never be moved.
  test("never reuses or moves an existing branch", async () => {
    const repo = await repoWithDirtyState();
    const a = await Worktree.create({ projectPath: repo, sessionId: "same" });
    const b = await Worktree.create({ projectPath: repo, sessionId: "same" });

    assert.notEqual(a.branch, b.branch, "two sessions shared a branch");
    await a.dispose();
    await b.dispose();
  });

  test("uses a configurable branch namespace", async () => {
    const repo = await repoWithDirtyState();
    const wt = await Worktree.create({
      projectPath: repo,
      sessionId: "x",
      branchPrefix: "custom",
    });
    assert.match(wt.branch, /^custom\/x-/);
    await wt.dispose();
  });
});

describe("path policy", () => {
  let ctx: { worktree: string; tracked: Set<string> };

  before(async () => {
    const wt = await mkdtemp(join(tmpdir(), "aw-policy-"));
    made.push(wt);
    await mkdir(join(wt, "src"), { recursive: true });
    await writeFile(join(wt, "src/ok.ts"), "x\n");
    await writeFile(join(wt, ".env"), "SECRET=hunter2\n");
    await symlink(tmpdir(), join(wt, "escape-link"));
    ctx = { worktree: wt, tracked: new Set(["src/ok.ts"]) };
  });

  test("allows a normal path", async () => {
    assert.equal((await resolveInside(ctx, "src/ok.ts")).relative, "src/ok.ts");
  });

  // A new file at the root resolves its nearest existing ancestor to the root
  // itself, which must not be mistaken for an escape.
  test("allows creating a file at the project root", async () => {
    assert.equal((await resolveInside(ctx, "NEW.md")).relative, "NEW.md");
  });

  for (const bad of ["../outside.txt", "src/../../etc/passwd", "escape-link/x"]) {
    test(`blocks traversal: ${bad}`, async () => {
      await assert.rejects(() => resolveInside(ctx, bad), PolicyViolation);
    });
  }

  test("blocks absolute paths", async () => {
    await assert.rejects(() => resolveInside(ctx, "/etc/passwd"), PolicyViolation);
  });

  test("blocks the worktree root itself", async () => {
    await assert.rejects(() => resolveInside(ctx, "."), PolicyViolation);
  });

  for (const secret of [".env", ".git/config", "deploy.pem", ".ssh/id_rsa", ".npmrc"]) {
    test(`blocks secret: ${secret}`, async () => {
      await assert.rejects(() => resolveInside(ctx, secret), PolicyViolation);
    });
  }

  // macOS and Windows resolve .ENV to the same file as .env, so a
  // case-sensitive deny-list is bypassable by changing case.
  for (const secret of [".ENV", ".Env", ".GIT/config", "KEY.PEM", ".SSH/config"]) {
    test(`blocks case variant: ${secret}`, async () => {
      await assert.rejects(() => resolveInside(ctx, secret), PolicyViolation);
    });
  }

  test("refuses to delete an untracked file", () => {
    assert.throws(() => assertDeletable(ctx, "brand-new.txt"), PolicyViolation);
  });

  test("permits deleting a tracked file", () => {
    assert.doesNotThrow(() => assertDeletable(ctx, "src/ok.ts"));
  });
});

describe("cleanup", () => {
  test("lists live worktrees", async () => {
    const repo = await repoWithDirtyState();
    const wt = await Worktree.create({ projectPath: repo, sessionId: "t" });

    const entries = await listWorktrees(repo);
    assert.ok(entries.length >= 2, "expected the main checkout plus one worktree");
    assert.ok(entries.every((e) => e.exists));
    await wt.dispose();
  });

  // The crash case: the directory vanishes but git still lists it.
  test("prunes worktrees whose directory has vanished", async () => {
    const repo = await repoWithDirtyState();
    const wt = await Worktree.create({ projectPath: repo, sessionId: "t" });
    await rm(wt.worktree, { recursive: true, force: true });

    assert.equal(await pruneWorktrees(repo), 1, "the stale entry was not detected");
    assert.ok(
      (await listWorktrees(repo)).every((e) => e.exists),
      "a stale entry survived pruning",
    );
  });

  test("removeWorktrees clears abandoned directories but keeps branches", async () => {
    const repo = await repoWithDirtyState();
    const wt = await Worktree.create({ projectPath: repo, sessionId: "t" });
    await writeFile(join(wt.worktree, "work.md"), "important\n");
    await wt.commit("agent: work");

    const removed = await removeWorktrees(repo);
    assert.equal(removed.length, 1);
    // The commits are the whole point of the isolation — they must survive.
    assert.equal(await git(repo, ["show", `${wt.branch}:work.md`]), "important");
  });

  test("removeWorktrees ignores worktrees it did not create", async () => {
    const repo = await repoWithDirtyState();
    const mine = await mkdtemp(join(tmpdir(), "user-owned-"));
    made.push(mine);
    await rm(mine, { recursive: true, force: true });
    await git(repo, ["worktree", "add", "-q", "-b", "my-branch", mine, "HEAD"]);

    assert.deepEqual(await removeWorktrees(repo), [], "a user worktree was removed");
    assert.ok(await stat(mine), "a user worktree was deleted");
    await git(repo, ["worktree", "remove", "--force", mine]).catch(() => undefined);
  });
});
