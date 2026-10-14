import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * After the build, writes dist/sw.js: the service worker template with the list
 * of built files and a version that changes whenever any of them does.
 */
export default function serviceWorker() {
  let outDir = "dist";
  return {
    name: "vbuddy-service-worker",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split(sep).join("/"))
        .filter((f) => f !== "sw.js" && !f.endsWith(".map") && !/(^|\/)console[.-]/.test(f)) // the bridge-PC window is not part of the phone app
        .sort();
      const hash = createHash("sha1");
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const urls = ["/", ...files.map((f) => "/" + f)];
      const tpl = readFileSync(resolve(import.meta.dirname, "sw.template.js"), "utf8");
      writeFileSync(join(outDir, "sw.js"), tpl.replace("__VBUDDY_VERSION__", hash.digest("hex").slice(0, 12)).replace("__VBUDDY_PRECACHE__", JSON.stringify(urls, null, 2)));
    },
  };
}
