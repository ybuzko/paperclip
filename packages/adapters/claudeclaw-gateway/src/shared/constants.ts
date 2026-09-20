export const ADAPTER_TYPE = "claudeclaw_gateway";
export const ADAPTER_LABEL = "Claudeclaw Gateway";

// 0 = no adapter-side timeout: the run stays open until the daemon finishes the supervisor's turn.
export const DEFAULT_TIMEOUT_SEC = 0;
export const DEFAULT_PAPERCLIP_API_URL = "http://10.0.0.34:3100";
export const DEFAULT_CLAIMED_API_KEY_PATH = ".claude/claudeclaw/paperclip.env";

export const LOG_PREFIX = "[claudeclaw-gateway]";
