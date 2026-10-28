import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
function check(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) check(path);
    else if (path.endsWith(".js") || path.endsWith(".mjs")) execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
  }
}
check("extension");
