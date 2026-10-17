/** Fails when the gzipped Worker bundle exceeds the budget (DESIGN.md §2: 400 KiB). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const LIMIT = 400 * 1024;
const dir = process.argv[2] ?? "dist";
const bytes = gzipSync(readFileSync(path.join(dir, "index.js")), { level: 9 }).length;
const kib = (bytes / 1024).toFixed(1);
if (bytes > LIMIT) {
  console.error(`bundle is ${kib} KiB gzipped, over the 400 KiB budget`);
  process.exit(1);
}
console.log(`bundle ${kib} KiB gzipped (budget 400 KiB)`);
