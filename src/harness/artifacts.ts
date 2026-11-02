import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ARTIFACTS_ROOT = join(process.cwd(), ".data", "runs");

export async function writeRunArtifact(runId: string, filename: string, content: string): Promise<string> {
  const dir = join(ARTIFACTS_ROOT, runId);
  await mkdir(dir, { recursive: true });

  const path = join(dir, filename);
  await writeFile(path, content, "utf8");

  return path;
}
