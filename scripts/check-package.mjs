// Fails the release when the package would ship anything but the build, the
// docs and the license: a stray test fixture or .env must never reach npm.
import { execFileSync } from "node:child_process";

const allowed = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^CHANGELOG\.md$/, /^dist\/.+\.(js|d\.ts|js\.map|d\.ts\.map)$/];
const [{ files }] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const unexpected = files.map((f) => f.path).filter((path) => !allowed.some((re) => re.test(path)));
const entries = ["dist/nextjs/index.js", "dist/react/index.js", "dist/core/index.js"];
const missing = entries.filter((entry) => !files.some((f) => f.path === entry));

if (unexpected.length || missing.length) {
  if (unexpected.length) console.error("Not allowed in the package:\n  " + unexpected.join("\n  "));
  if (missing.length) console.error("Missing from the package (run pnpm build):\n  " + missing.join("\n  "));
  process.exit(1);
}
console.log(`Package contents OK: ${files.length} files.`);
