import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitSha, stampRevision } from "./stamp-revision.mjs";

const sha = resolveGitSha();
if (!sha) {
  throw new Error("refusing to deploy without a git revision");
}
stampRevision(sha);

const wrangler = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/wrangler/bin/wrangler.js",
);
const result = spawnSync(process.execPath, [wrangler, "deploy"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
