import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps, CreateConfigValues } from "../types";
import { DraftInput, DraftNumberInput, Field } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_PAPERCLIP_API_URL = "http://10.0.0.34:3100";
const DEFAULT_CLAIMED_API_KEY_PATH = ".claude/claudeclaw/paperclip.env";

type SecretRef = {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
};

function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

function readCreateValue(values: CreateConfigValues | null, key: string, fallback: unknown): unknown {
  return values?.adapterSchemaValues?.[key] ?? fallback;
}

function writeCreateValue(
  values: CreateConfigValues | null,
  set: ((patch: Partial<CreateConfigValues>) => void) | null,
  key: string,
  value: unknown,
) {
  set?.({
    adapterSchemaValues: {
      ...values?.adapterSchemaValues,
      [key]: value,
    },
  });
}

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
  stored,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  stored?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={stored ? "Stored secret; enter a new value to replace it" : placeholder}
        />
      </div>
    </Field>
  );
}

export function ClaudeclawGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const storedApiToken = config.apiToken;
  const hasStoredApiToken = isSecretRef(storedApiToken) || typeof storedApiToken === "string";
  const editApiTokenValue =
    typeof storedApiToken === "string" ? String(eff("adapterConfig", "apiToken", storedApiToken)) : "";

  const readValue = (key: string, fallback: unknown) =>
    isCreate ? readCreateValue(values, key, fallback) : eff("adapterConfig", key, (config[key] ?? fallback) as never);

  const writeValue = (key: string, value: unknown) => {
    if (isCreate) {
      writeCreateValue(values, set, key, value);
    } else {
      mark("adapterConfig", key, value);
    }
  };

  const url = String(readValue("url", "") ?? "");
  const telegramChatId = String(readValue("telegramChatId", "") ?? "");
  const paperclipApiUrl = String(readValue("paperclipApiUrl", "") ?? "");
  const claimedApiKeyPath = String(readValue("claimedApiKeyPath", "") ?? "");
  const timeoutSec = Number(readValue("timeoutSec", DEFAULT_TIMEOUT_SEC) ?? DEFAULT_TIMEOUT_SEC);

  return (
    <>
      <Field
        label="claudeclaw URL"
        hint="HTTP base URL of the claudeclaw daemon that Paperclip can reach, such as http://10.0.0.41:4632."
      >
        <DraftInput
          value={url}
          onCommit={(v) => writeValue("url", v || undefined)}
          immediate
          className={inputClass}
          placeholder="http://10.0.0.41:4632"
        />
      </Field>

      <SecretField
        label="API token"
        value={isCreate ? String(readCreateValue(values, "apiToken", "") ?? "") : editApiTokenValue}
        onCommit={(v) => writeValue("apiToken", v || undefined)}
        placeholder="claudeclaw settings.apiToken, not PAPERCLIP_API_KEY"
        stored={!isCreate && hasStoredApiToken && !editApiTokenValue}
      />

      <Field
        label="Telegram forum chat id"
        hint="Chat id of the Telegram forum group this daemon serves (e.g. -1001234567890). A project whose CLAUDECLAW_THREAD env is a bare topic id is routed to tg:<chatId>:<topicId>. Leave empty when every project binds a full session key."
      >
        <DraftInput
          value={telegramChatId}
          onCommit={(v) => writeValue("telegramChatId", v || undefined)}
          immediate
          className={inputClass}
          placeholder="-1001234567890"
        />
      </Field>

      <Field label="Timeout seconds" hint="How long Paperclip waits for the blocking inject call before aborting the run.">
        <DraftNumberInput
          value={Number.isFinite(timeoutSec) ? timeoutSec : DEFAULT_TIMEOUT_SEC}
          onCommit={(v) => writeValue("timeoutSec", v)}
          immediate
          className={inputClass}
        />
      </Field>

      <Field
        label="Paperclip API URL"
        hint={`Paperclip API URL reachable from the claudeclaw host (default ${DEFAULT_PAPERCLIP_API_URL}). This is not a credential.`}
      >
        <DraftInput
          value={paperclipApiUrl}
          onCommit={(v) => writeValue("paperclipApiUrl", v || undefined)}
          immediate
          className={inputClass}
          placeholder={DEFAULT_PAPERCLIP_API_URL}
        />
      </Field>

      <Field
        label="Claimed API key path"
        hint={`Env file in the daemon's project directory holding PAPERCLIP_API_KEY (default ${DEFAULT_CLAIMED_API_KEY_PATH}). Wake messages point here; the key never travels in the message.`}
      >
        <DraftInput
          value={claimedApiKeyPath}
          onCommit={(v) => writeValue("claimedApiKeyPath", v || undefined)}
          immediate
          className={inputClass}
          placeholder={DEFAULT_CLAIMED_API_KEY_PATH}
        />
      </Field>
    </>
  );
}
