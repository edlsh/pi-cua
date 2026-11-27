import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { CloudflareCredentials } from "./jev.ts";

const execFileAsync = promisify(execFile);

// Credentials are "!command" values whose stdout is the secret, so literal keys never sit in cua.json.
const command = z.string().regex(/^!\S/, 'must be a "!command" that prints the credential; keep literal keys out of cua.json');

const configuration = z.object({
  jevClassifier: z.string().min(1).optional(),
  jevApiKey: command.optional(),
  cloudflareAccountId: z.string().min(1).optional(),
  cloudflareApiKey: command.optional(),
}).strict();

export type CuaFileConfig = z.infer<typeof configuration>;

// One execution per command for the process lifetime; a failed command is forgotten so the next call retries.
const credentials = new Map<string, Promise<string>>();

/** Runs a "!command" credential resolver. Neither stdout nor stderr is echoed on error. */
async function runCredential(field: string, value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  let pending = credentials.get(value);
  if (!pending) {
    pending = execFileAsync("/bin/sh", ["-c", value.slice(1)], { timeout: 10_000, encoding: "utf8", maxBuffer: 16_384 })
      .then(({ stdout }) => {
        const key = stdout.trim();
        if (!key) throw new Error("empty");
        return key;
      })
      .catch(() => { throw new Error(`The ${field} command in cua.json failed or printed nothing.`); });
    credentials.set(value, pending);
    pending.catch(() => credentials.delete(value));
  }
  return pending;
}

export function defaultAgentDir(host: "omp" | "pi"): string {
  if (host === "omp") return process.env.OMP_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export async function readCuaConfig(agentDir: string, signal?: AbortSignal): Promise<CuaFileConfig> {
  const path = join(agentDir, "cua.json");
  let raw: string;
  try { raw = await readFile(path, { encoding: "utf8", signal }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); }
  catch { throw new Error(`Invalid JSON in ${path}`); }
  const parsed = configuration.safeParse(parsedJson);
  if (!parsed.success) throw new Error(`Invalid settings in ${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function resolveFileJevKey(agentDir: string, signal?: AbortSignal): Promise<string | undefined> {
  const file = await readCuaConfig(agentDir, signal);
  return runCredential("jevApiKey", file.jevApiKey);
}

export async function resolveFileCloudflare(agentDir: string, signal?: AbortSignal): Promise<CloudflareCredentials | undefined> {
  const file = await readCuaConfig(agentDir, signal);
  if (!file.cloudflareApiKey) return undefined;
  const accountId = (file.cloudflareAccountId ?? process.env.CLOUDFLARE_ACCOUNT_ID)?.trim();
  if (!accountId) return undefined;
  const apiKey = await runCredential("cloudflareApiKey", file.cloudflareApiKey);
  return apiKey ? { accountId, apiKey } : undefined;
}
