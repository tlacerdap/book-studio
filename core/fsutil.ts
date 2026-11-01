// File writes that cannot leave a half-written chapter behind.

import fs from "node:fs";
import path from "node:path";

/** Write to a temporary file in the same folder, then rename it over the target (atomic on one filesystem). */
export function atomicWrite(file: string, content: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    // Keep the original file's permissions.
    try {
      fs.chmodSync(tmp, fs.statSync(file).mode);
    } catch {
      /* new file */
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
