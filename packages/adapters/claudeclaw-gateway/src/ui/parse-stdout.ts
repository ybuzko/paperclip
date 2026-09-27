import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const LOG_PREFIX = "[claudeclaw-gateway]";

export function parseClaudeclawGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith(LOG_PREFIX)) {
    return [{ kind: "system", ts, text: trimmed.slice(LOG_PREFIX.length).trim() }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
