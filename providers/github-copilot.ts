import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaSample, QuotaSnapshot } from "../quota-types.ts";
import { asRecord, clampPercent, fetchJson, finiteNumber, getProviderToken, timestampMs } from "../quota-utils.ts";

const PROVIDER_ID = "github-copilot";
const USAGE_URL = "https://api.github.com/copilot_internal/user";
const PREMIUM_INTERACTIONS_KEY = "premium_interactions";

function parsePremiumInteractions(value: unknown, resetMs?: number): QuotaSample | undefined {
	const quota = asRecord(value);
	if (!quota) return undefined;
	const unlimited = quota.unlimited === true;
	const total = finiteNumber(quota.entitlement, quota.total);
	const remaining = finiteNumber(quota.remaining, quota.quota_remaining);
	const percentRemaining = finiteNumber(quota.percent_remaining);
	if (!unlimited && total === undefined && percentRemaining === undefined) return undefined;
	const used = total !== undefined && remaining !== undefined
		? Math.max(0, total - remaining)
		: percentRemaining !== undefined ? 100 - percentRemaining : 0;
	const percentUsed = unlimited ? 0
		: percentRemaining !== undefined ? 100 - percentRemaining
			: total !== undefined && total > 0 ? used / total * 100 : 0;
	return {
		label: "1mo",
		percent: clampPercent(percentUsed),
		used,
		total: total ?? 0,
		resetMs: timestampMs(quota.reset_at ?? quota.reset_date ?? resetMs),
		unlimited,
	};
}

export function parseCopilotUsage(payload: unknown, now = Date.now()): QuotaSnapshot {
	const root = asRecord(payload);
	const quotas = asRecord(root?.quota_snapshots);
	if (!quotas) throw new Error("Unexpected GitHub Copilot quota response: missing quota_snapshots");
	const commonReset = timestampMs(root?.quota_reset_date_utc ?? root?.quota_reset_date ?? root?.quota_reset_at);
	const premiumInteractions = parsePremiumInteractions(quotas[PREMIUM_INTERACTIONS_KEY], commonReset);
	if (!premiumInteractions) throw new Error("GitHub Copilot response contained no premium interactions quota snapshot");
	return {
		fetchedAt: now,
		provider: "GitHub Copilot",
		level: typeof root?.copilot_plan === "string" ? root.copilot_plan : undefined,
		samples: [premiumInteractions],
	};
}

/** Read the original OAuth access token used to authenticate the Copilot login.
 * Pi's resolved `apiKey` is a Copilot-specific session token; GitHub rejects it
 * at /copilot_internal/user. The raw token is used only for this first-party
 * quota request and is never logged or persisted by this extension.
 */
function readStoredCopilotOAuthToken(): string | undefined {
	try {
		const authPath = join(getAgentDir(), "auth.json");
		const authStore = asRecord(JSON.parse(readFileSync(authPath, "utf8")));
		const credential = asRecord(authStore?.[PROVIDER_ID]);
		if (credential?.type === "oauth" && typeof credential.refresh === "string" && credential.refresh.length > 0) {
			return credential.refresh;
		}
	} catch {
		// Auth file missing/unreadable: fall back to the provider-resolved token.
	}
	return undefined;
}

async function fetch(ctx: ExtensionContext): Promise<QuotaSnapshot | undefined> {
	if (!ctx.model || ctx.model.provider !== PROVIDER_ID) return undefined;
	const resolvedToken = await getProviderToken(ctx, PROVIDER_ID);
	const storedOAuthToken = readStoredCopilotOAuthToken();
	const tokens = [...new Set([storedOAuthToken, resolvedToken].filter((token): token is string => Boolean(token)))];
	if (tokens.length === 0) return undefined;

	let lastError: unknown;
	for (const token of tokens) {
		try {
			const payload = await fetchJson(USAGE_URL, token);
			return parseCopilotUsage(payload);
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error);
			// Only try another credential after an auth rejection; don't mask network or server errors.
			if (!/HTTP (401|403) /.test(message)) throw error;
		}
	}
	throw lastError ?? new Error("No GitHub Copilot credential available");
}

export const githubCopilotQuotaProvider: QuotaProvider = { providerId: PROVIDER_ID, fetch };
