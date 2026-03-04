// Feature 1: Extension Registration
//
// Entry point that wires all features together via pi.registerProvider().
// Uses Kiro as primary provider with automatic Bedrock fallback on failure.

import type { Api, Model, OAuthCredentials } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { streamWithFallback } from "./fallback.js";
import { getKiroCliCredentials } from "./kiro-cli.js";
import { kiroModels } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiroBuilderID, refreshKiroToken } from "./oauth.js";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("kiro", {
    baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    api: "kiro-api",
    models: kiroModels,
    oauth: {
      name: "Kiro (AWS Builder ID)",
      login: loginKiroBuilderID,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      getCliCredentials: getKiroCliCredentials,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const region = (cred as KiroCredentials).region || "us-east-1";
        return models.map((m: Model<Api>) =>
          m.provider === "kiro" ? { ...m, baseUrl: `https://q.${region}.amazonaws.com/generateAssistantResponse` } : m,
        );
      },
      // biome-ignore lint/suspicious/noExplicitAny: ProviderConfig.oauth doesn't include getCliCredentials but OAuthProviderInterface does
    } as any,
    streamSimple: streamWithFallback,
  });
}
