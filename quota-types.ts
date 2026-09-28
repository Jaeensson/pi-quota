import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A normalized provider quota window; percent always means percent used. */
export interface QuotaSample {
	label: string;
	percent: number;
	used: number;
	total: number;
	resetMs?: number;
	unlimited?: boolean;
}

/** Provider-neutral snapshot consumed by the shared footer and command. */
export interface QuotaSnapshot {
	fetchedAt: number;
	provider: string;
	level?: string;
	samples: QuotaSample[];
}

/** Common contract implemented by each provider-specific quota adapter. */
export interface QuotaProvider {
	/** Pi model provider id handled by this adapter. */
	providerId: string;
	/** Fetch and normalize quota for the active provider, or return undefined if unavailable. */
	fetch(ctx: ExtensionContext): Promise<QuotaSnapshot | undefined>;
}
