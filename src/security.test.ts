import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git";
import { Worktree } from "./session";
import { resolveInside, PolicyViolation } from "./policy";

/**
 * Adversarial tests.
 *
 * Each case here was run against the library as an actual probe before being
 * written down; several of them passed at the time and are now regressions in
 * waiting. They are grouped by the mechanism an attacker would be exploiting
 * rather than by function, so a future change that weakens one mechanism fails
 * a legible group.
 */

const made: string[] = [];
let wt: string;
let ctx: { worktree: string; tracked: Set<string> };

const NUL = String.fromCharCode(0);

before(async () => {
  wt = await mkdtemp(join(tmpdir(), "aw-sec-"));
  made.push(wt);
  await mkdir(join(wt, "src"), { recursive: true });
  await writeFile(join(wt, "src/ok.ts"), "x\n");
  await writeFile(join(wt, ".env"), "SECRET=hunter2\n");

  // A secret outside the worktree, and links to it planted from inside — this
  // is what an agent would do if it wanted to read something it cannot name.
  const outside = join(tmpdir(), "aw-sec-outside.txt");
  made.push(outside);
  await writeFile(outside, "OUTSIDE SECRET\n");
  await symlink(outside, join(wt, "innocent.txt"));
  await symlink("/etc", join(wt, "src/etc-link"));

  ctx = { worktree: wt, tracked: new Set(["src/ok.ts"]) };
});

after(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

describe("symlink escapes", () => {
  // The agent can create files inside its worktree, so it can create symlinks.
  // Following one out of the worktree would defeat the entire isolation.
  test("refuses to follow a symlink the agent planted", async () => {
    await assert.rejects(() => resolveInside(ctx, "innocent.txt"), PolicyViolation);
  });

  test("refuses to traverse through a symlinked directory", async () => {
    await assert.rejects(() => resolveInside(ctx, "src/etc-link/passwd"), PolicyViolation);
  });
});

describe("malformed paths", () => {
  // Each of these makes the string that gets validated differ from the file
  // that eventually gets opened.
  const malformed: [string, string][] = [
    ["empty", ""],
    ["whitespace only", "   "],
    ["null byte truncation", `src/ok.ts${NUL}.env`],
    ["null byte prefix", `.env${NUL}.txt`],
    ["newline", "src/ok.ts\n.env"],
    ["trailing space (Windows strips it)", ".env "],
    ["trailing dot (Windows strips it)", "secrets."],
    ["alternate data stream", ".env:hidden"],
    ["ADS explicit", ".env::$DATA"],
  ];

  for (const [label, path] of malformed) {
    test(`rejects ${label}`, async () => {
      await assert.rejects(() => resolveInside(ctx, path), PolicyViolation);
    });
  }

  // Not bypasses: these name different files, and creating them is harmless.
  // Asserted so nobody "fixes" them into rejections and breaks real filenames.
  for (const [label, path] of [
    ["percent-encoded text", "%2e%2e%2fnot-traversal"],
    ["unicode lookalike", "．env"],
  ] as [string, string][]) {
    test(`allows ${label} — a distinct filename, not an escape`, async () => {
      const r = await resolveInside(ctx, path);
      assert.equal(r.relative, path);
    });
  }
});

describe("traversal", () => {
  for (const bad of [
    "..",
    "../outside.txt",
    "src/../../etc/passwd",
    "a/b/c/../../../../../../etc/passwd",
    "./.env",
    "src//..//.env",
    "..\\..\\etc\\passwd",
  ]) {
    test(`blocks ${bad}`, async () => {
      await assert.rejects(() => resolveInside(ctx, bad), PolicyViolation);
    });
  }

  test("blocks absolute paths", async () => {
    await assert.rejects(() => resolveInside(ctx, "/etc/passwd"), PolicyViolation);
  });
});

describe("deny-list coverage", () => {
  for (const secret of [
    ".env",
    ".env.local",
    ".env.production",
    ".git/config",
    "sub/.git/config",
    ".ssh/id_rsa",
    ".aws/credentials",
    ".npmrc",
    "deploy.pem",
    "server.key",
    "credentials.json",
    "service-account-prod.json",
  ]) {
    test(`blocks ${secret}`, async () => {
      await assert.rejects(() => resolveInside(ctx, secret), PolicyViolation);
    });
  }

  // Filesystems on macOS and Windows are case-insensitive by default, so a
  // case-sensitive deny-list is bypassable by changing case. This was a live
  // bypass: .ENV returned the contents of .env.
  for (const variant of [".ENV", ".Env", ".GIT/config", "KEY.PEM", ".SSH/config"]) {
    test(`blocks case variant ${variant}`, async () => {
      await assert.rejects(() => resolveInside(ctx, variant), PolicyViolation);
    });
  }

  test("does not leak the secret in the rejection message", async () => {
    await assert.rejects(
      () => resolveInside(ctx, ".env"),
      (err: Error) => !err.message.includes("hunter2"),
    );
  });
});

describe("branch naming", () => {
  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "aw-branch-"));
    made.push(dir);
    await git(dir, ["init", "-q", "-b", "main", "."]);
    await git(dir, ["config", "user.email", "t@t.t"]);
    await git(dir, ["config", "user.name", "T"]);
    await writeFile(join(dir, "a.txt"), "a\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "first"]);
    return dir;
  }

  // sessionId reaches a git command. Arguments are passed as an array, never a
  // shell string, so metacharacters cannot become commands — but a caller-
  // supplied id should still not be able to produce a surprising ref.
  test("a sessionId with shell metacharacters cannot execute anything", async () => {
    const dir = await repo();
    const evil = "x; rm -rf /tmp/should-not-exist; echo";
    let created: Worktree | null = null;
    try {
      created = await Worktree.create({ projectPath: dir, sessionId: evil });
      made.push(created.worktree);
      // If it succeeded the id was used literally, which is safe.
      assert.ok(created.branch.includes(";"), "expected the id to be literal");
    } catch (err) {
      // Git rejecting the ref name is equally acceptable.
      assert.ok(err instanceof Error);
    } finally {
      await created?.dispose();
    }
  });

  test("a sessionId containing a path traversal cannot escape the namespace", async () => {
    const dir = await repo();
    let created: Worktree | null = null;
    try {
      created = await Worktree.create({ projectPath: dir, sessionId: "../../evil" });
      made.push(created.worktree);
      assert.ok(
        created.branch.startsWith("agent/"),
        `branch escaped its namespace: ${created.branch}`,
      );
    } catch (err) {
      assert.ok(err instanceof Error); // git refused the ref name
    } finally {
      await created?.dispose();
    }
  });
});

describe("isolation of the user's checkout", () => {
  test("nothing the agent does reaches the developer's files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aw-iso-"));
    made.push(dir);
    await git(dir, ["init", "-q", "-b", "main", "."]);
    await git(dir, ["config", "user.email", "t@t.t"]);
    await git(dir, ["config", "user.name", "T"]);
    await writeFile(dir + "/keep.txt", "precious\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "first"]);
    await writeFile(dir + "/uncommitted.txt", "also precious\n");

    const w = await Worktree.create({ projectPath: dir, sessionId: "iso" });
    // Worst case: delete everything the agent can see.
    for (const f of ["keep.txt", "uncommitted.txt"]) {
      await rm(join(w.worktree, f), { force: true });
    }
    await w.commit("agent: delete everything");
    await w.dispose();

    assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "precious\n");
    assert.equal(
      await readFile(join(dir, "uncommitted.txt"), "utf8"),
      "also precious\n",
    );
  });
});
