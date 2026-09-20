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
        key: "telegramChatId",
        label: "Telegram forum chat id",
        type: "text",
        hint: "Chat id of the Telegram forum group this daemon serves (e.g. -1001234567890). A project whose CLAUDECLAW_THREAD env is a bare topic id is routed to tg:<chatId>:<topicId>. Not needed when every project binds a full session key.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
        hint: "Seconds to wait for the blocking inject call. 0 (default) waits until the daemon finishes the turn. A timed-out run is not retried, because the daemon keeps running the turn and a retry would inject a duplicate wake.",
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
