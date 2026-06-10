import { Logger } from "../logger.ts";
import type { Config } from "../config.ts";

export interface NtfyMessage {
	/** Notification title. */
	title: string;
	/** Notification body. */
	message: string;
	/** Emoji shortcodes ["inbox_tray", "tv"]. See https://docs.ntfy.sh/emojis/ */
	tags?: string[];
	/** 1 = min, 3 = default, 5 = max. */
	priority?: 1 | 2 | 3 | 4 | 5;
	/** URL opened when the notification is tapped. */
	click?: string;
}

/**
 * Ntfy.sh publisher (https://docs.ntfy.sh/publish/).
 *
 * Publishes as JSON to the server root so UTF-8 titles/messages work
 * without header-encoding tricks. Supports either token (Bearer) or
 * username/password (Basic) authentication. Token wins if both are set.
 *
 * All sends are fire-and-forget: failures are logged as warnings and
 * never propagate into the HTTP request path.
 */
export class Ntfy {
	private readonly enabled: boolean;
	private readonly url: string;
	private readonly topic: string;
	private readonly authHeader: string | null;

	constructor(cfg: Config["ntfy"]) {
		this.url = (cfg.server ?? "").replace(/\/+$/, "");
		this.topic = (cfg.topic ?? "").trim();
		this.enabled = cfg.enabled === true && this.url.length > 0 && this.topic.length > 0;

		if (cfg.token && cfg.token.trim()) {
			this.authHeader = `Bearer ${cfg.token.trim()}`;
		} else if (cfg.username && cfg.password) {
			this.authHeader = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`;
		} else {
			this.authHeader = null;
		}
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	/** Fire-and-forget publish. Never throws, never blocks the caller. */
	notify(msg: NtfyMessage): void {
		if (!this.enabled) return;
		void this.send(msg).catch((err: any) => {
			Logger.warn(`Ntfy: failed to publish notification: ${err?.message ?? err}`);
		});
	}

	private async send(msg: NtfyMessage): Promise<void> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.authHeader) headers["Authorization"] = this.authHeader;

		const res = await fetch(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				topic: this.topic,
				title: msg.title,
				message: msg.message,
				...(msg.tags?.length ? { tags: msg.tags } : {}),
				...(msg.priority ? { priority: msg.priority } : {}),
				...(msg.click ? { click: msg.click } : {}),
			}),
			signal: AbortSignal.timeout(10_000),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
		}
	}
}
