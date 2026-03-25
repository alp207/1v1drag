import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const distDir = join(root, "dist");
const filesToCopy = ["index.html", "styles.css", "game.js", "dragon.png"];
const liveServerUrl = process.env.LIVE_SERVER_URL || "";

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const filename of filesToCopy) {
  await copyFile(join(root, filename), join(distDir, filename));
}

await writeFile(
  join(distDir, "config.js"),
  `window.__APP_CONFIG__ = Object.freeze({ liveServerUrl: ${JSON.stringify(liveServerUrl)} });\n`,
  "utf8"
);

console.log(`Built static site into ${distDir}`);
