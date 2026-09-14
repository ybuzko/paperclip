import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_CLAIMED_API_KEY_PATH,
  DEFAULT_PAPERCLIP_API_URL,
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "url",
        label: "claudeclaw URL",
        type: "text",
        required: true,
        hint: "claudeclaw HTTP base URL reachable from Paperclip, such as http://10.0.0.41:4632.",
      },
      {
        key: "apiToken",
        label: "API token",
        type: "text",
        required: true,
        hint: "claudeclaw settings.apiToken. Stored as a Paperclip secret reference and never sent in the wake message.",
        meta: { secret: true },
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
        hint: "How long Paperclip waits for the blocking inject call before aborting the run.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        default: DEFAULT_PAPERCLIP_API_URL,
        hint: "Paperclip API URL the claudeclaw host can reach. This is not a credential.",
      },
      {
        key: "claimedApiKeyPath",
        label: "Claimed API key path",
        type: "text",
        default: DEFAULT_CLAIMED_API_KEY_PATH,
        hint: "Path (relative to the daemon's project directory) of the env file holding the agent's claimed PAPERCLIP_API_KEY.",
      },
    ],
  };
}
