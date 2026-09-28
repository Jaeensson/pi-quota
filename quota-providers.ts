import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaSnapshot } from "./quota-types.ts";
import { githubCopilotQuotaProvider } from "./providers/github-copilot.ts";
import { openAICodexQuotaProvider } from "./providers/openai-codex.ts";
import { zaiQuotaProvider } from "./providers/zai.ts";

/** Provider registry; adapters each implement the shared QuotaProvider contract. */
export const quotaProviders: readonly QuotaProvider[] = [
	zaiQuotaProvider,
	openAICodexQuotaProvider,
	githubCopilotQuotaProvider,
];

const providersById = new Map(quotaProviders.map((provider) => [provider.providerId, provider]));

/** Fetch quota for the currently selected model provider only. */
export async function fetchCurrentQuota(ctx: ExtensionContext): Promise<QuotaSnapshot | undefined> {
	const providerId = ctx.model?.provider;
	if (!providerId) return undefined;
	return providersById.get(providerId)?.fetch(ctx);
}
