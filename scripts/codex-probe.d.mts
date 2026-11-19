// Types for codex-probe.mjs, for the tests.
import type { ChildProcess } from "node:child_process";

export interface GitResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}
export function outDirProblem(
  p: string,
  opts?: { run?: (args: string[], env: NodeJS.ProcessEnv) => GitResult; env?: NodeJS.ProcessEnv },
): string | null;
export function isTurnCompleted(m: unknown, turnId: string | undefined): boolean;
export function secretsOf(ed: { args?: unknown[]; env?: Record<string, unknown> }): string[];
export function makeRedactor(secrets: string[]): (s: string) => string;
export function cliConfig(
  ed: { command: string; args?: string[]; env?: Record<string, unknown> },
  baseEnv?: NodeJS.ProcessEnv,
): { args: string[]; env: NodeJS.ProcessEnv };
export function stopTree(child: ChildProcess, startedAt?: number): void;
