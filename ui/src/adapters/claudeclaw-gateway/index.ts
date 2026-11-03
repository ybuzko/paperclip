import type { UIAdapterModule } from "../types";
import { parseClaudeclawGatewayStdoutLine } from "@paperclipai/adapter-claudeclaw-gateway/ui";
import { buildSchemaAdapterConfig } from "../schema-config-fields";
import { ClaudeclawGatewayConfigFields } from "./config-fields";

export const claudeclawGatewayUIAdapter: UIAdapterModule = {
  type: "claudeclaw_gateway",
  label: "Claudeclaw Gateway",
  parseStdoutLine: parseClaudeclawGatewayStdoutLine,
  ConfigFields: ClaudeclawGatewayConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
