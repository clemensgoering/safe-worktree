import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Runs git with an argument array — never a shell string, so repository paths
 * and branch names containing spaces or metacharacters cannot inject commands.
 */
export async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    // trimEnd, never trim: `git status --porcelain` encodes "not staged" as a
    // leading space, and trimming the string strips it from the first line,
    // silently reclassifying an unstaged change as a staged one.
    return stdout.trimEnd();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(
      `git ${args[0]} failed: ${e.stderr?.trim() || e.message}`,
      args,
      e.stderr ?? "",
    );
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return out === "true";
  } catch {
    return false;
  }
}

/** Repository root for a path inside a working tree. */
export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

/** Paths git is tracking, relative to the repo root. */
export async function trackedFiles(dir: string, ref = "HEAD"): Promise<Set<string>> {
  const out = await git(dir, ["ls-tree", "-r", "--name-only", ref]);
  return new Set(out.split("\n").filter(Boolean));
}
