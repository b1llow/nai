import { execSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function resolveGitSha() {
  const fromCi = process.env.WORKERS_CI_COMMIT_SHA?.trim() ?? "";
  if (GIT_SHA_RE.test(fromCi)) return fromCi.toLowerCase();
  const fromGit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  if (!GIT_SHA_RE.test(fromGit)) {
    throw new Error(`refusing to deploy without a git revision (got ${JSON.stringify(fromGit)})`);
  }
  return fromGit.toLowerCase();
}

const sha = resolveGitSha();
const wrangler = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/wrangler/bin/wrangler.js",
);
const result = spawnSync(
  process.execPath,
  [wrangler, "deploy", "--define", `__NAI_REVISION__:${JSON.stringify(sha)}`],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
