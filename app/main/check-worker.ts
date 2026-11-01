// Runs the PDF checker off the main thread.
import { parentPort, workerData } from "node:worker_threads";
import { loadBook } from "../../core/config.ts";
import { runChecks } from "../../core/check.ts";

try {
  const { pdf, root } = workerData as { pdf: string; root: string };
  const report = await runChecks(pdf, loadBook(root));
  parentPort!.postMessage({ ok: true, report });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message });
}
