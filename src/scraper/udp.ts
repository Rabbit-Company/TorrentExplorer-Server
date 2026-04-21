import { Logger } from "../logger.ts";

/**
 * UDP tracker protocol (BEP-15) client.
 *
 * Protocol flow:
 *   1. Send connect request -> receive connection_id (valid ~2 min)
 *   2. Send scrape request with connection_id + 1..N info_hashes
 *   3. Receive scrape response with (seeders, completed, leechers) per hash
 *
 * Packet layout references:
 *   https://www.bittorrent.org/beps/bep_0015.html
 */

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_SCRAPE = 2;
const ACTION_ERROR = 3;

// Connection IDs are valid for 2 minutes per spec. Refresh a bit early.
const CONNECTION_ID_TTL_MS = 90_000;

export interface ScrapeResult {
	infoHashHex: string;
	seeders: number;
	completed: number;
	leechers: number;
}

export interface UdpScrapeClientOptions {
	/** Per-request timeout in milliseconds. Defaults to 5000. */
	timeoutMs?: number;
	/** Number of retries after an initial failure. Defaults to 2. */
	maxRetries?: number;
}

interface Pending {
	resolve: (buf: Uint8Array) => void;
	reject: (err: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

/**
 * One UDP socket shared across all tracker requests from this client.
 * Connection IDs are cached per (host:port) pair so repeated scrapes to
 * the same tracker only pay for one connect handshake.
 */
export class UdpScrapeClient {
	private socket: Bun.udp.Socket<"buffer"> | null = null;
	private readonly pending = new Map<number, Pending>();
	private readonly connCache = new Map<string, { id: bigint; expiresAt: number }>();
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private closed = false;

	private constructor(opts: UdpScrapeClientOptions) {
		this.timeoutMs = opts.timeoutMs ?? 5000;
		this.maxRetries = opts.maxRetries ?? 2;
	}

	static async create(opts: UdpScrapeClientOptions = {}): Promise<UdpScrapeClient> {
		const client = new UdpScrapeClient(opts);
		client.socket = await Bun.udpSocket({
			port: 0,
			socket: {
				data: (_s, buf: Uint8Array) => {
					if (buf.byteLength < 8) return;
					const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
					const txId = view.getUint32(4, false);
					const p = client.pending.get(txId);
					if (!p) return; // stale / unknown transaction
					client.pending.delete(txId);
					clearTimeout(p.timeout);
					p.resolve(buf);
				},
				error: (_s, err) => {
					Logger.debug(`UDP socket error: ${err.message}`);
				},
			},
		});
		return client;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.socket?.close();
		} catch {}
		for (const [, p] of this.pending) {
			clearTimeout(p.timeout);
			p.reject(new Error("client closed"));
		}
		this.pending.clear();
	}

	/**
	 * Scrape one batch of info hashes from a single tracker endpoint.
	 * Caller is responsible for keeping batch size <= MAX_HASHES_PER_PACKET.
	 */
	async scrape(host: string, port: number, infoHashesHex: string[]): Promise<ScrapeResult[]> {
		if (infoHashesHex.length === 0) return [];
		if (this.closed) throw new Error("client closed");

		let lastErr: Error | null = null;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const connId = await this.getConnectionId(host, port);
				return await this.scrapeOnce(host, port, connId, infoHashesHex);
			} catch (err: any) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				// Any failure may mean stale connection id, so drop it.
				this.connCache.delete(`${host}:${port}`);
				if (attempt < this.maxRetries) {
					// Short backoff. Trackers are either fast or dead, no point waiting long.
					await Bun.sleep(250 * (attempt + 1));
				}
			}
		}
		throw lastErr ?? new Error("scrape failed");
	}

	private async getConnectionId(host: string, port: number): Promise<bigint> {
		const key = `${host}:${port}`;
		const cached = this.connCache.get(key);
		if (cached && Date.now() < cached.expiresAt) return cached.id;

		const txId = randomTransactionId();
		const buf = new Uint8Array(16);
		const view = new DataView(buf.buffer);
		view.setBigUint64(0, PROTOCOL_ID, false);
		view.setUint32(8, ACTION_CONNECT, false);
		view.setUint32(12, txId, false);

		const resp = await this.sendAndWait(buf, host, port, txId);
		if (resp.byteLength < 16) throw new Error("short connect response");

		const rview = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
		const action = rview.getUint32(0, false);
		if (action === ACTION_ERROR) {
			throw new Error(`tracker error on connect: ${decodeError(resp)}`);
		}
		if (action !== ACTION_CONNECT) {
			throw new Error(`unexpected action ${action} in connect response`);
		}
		const id = rview.getBigUint64(8, false);
		this.connCache.set(key, { id, expiresAt: Date.now() + CONNECTION_ID_TTL_MS });
		return id;
	}

	private async scrapeOnce(host: string, port: number, connId: bigint, hashes: string[]): Promise<ScrapeResult[]> {
		const txId = randomTransactionId();
		const buf = new Uint8Array(16 + 20 * hashes.length);
		const view = new DataView(buf.buffer);
		view.setBigUint64(0, connId, false);
		view.setUint32(8, ACTION_SCRAPE, false);
		view.setUint32(12, txId, false);
		for (let i = 0; i < hashes.length; i++) {
			hexToBytesInto(hashes[i]!, buf, 16 + i * 20);
		}

		const resp = await this.sendAndWait(buf, host, port, txId);
		if (resp.byteLength < 8) throw new Error("short scrape response");
		const rview = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
		const action = rview.getUint32(0, false);
		if (action === ACTION_ERROR) {
			throw new Error(`tracker error on scrape: ${decodeError(resp)}`);
		}
		if (action !== ACTION_SCRAPE) {
			throw new Error(`unexpected action ${action} in scrape response`);
		}

		const expectedLen = 8 + 12 * hashes.length;
		if (resp.byteLength < expectedLen) {
			throw new Error(`short scrape response (got ${resp.byteLength}, expected ${expectedLen})`);
		}

		const out: ScrapeResult[] = [];
		for (let i = 0; i < hashes.length; i++) {
			const base = 8 + i * 12;
			out.push({
				infoHashHex: hashes[i]!,
				seeders: rview.getUint32(base, false),
				completed: rview.getUint32(base + 4, false),
				leechers: rview.getUint32(base + 8, false),
			});
		}
		return out;
	}

	private sendAndWait(data: Uint8Array, host: string, port: number, txId: number): Promise<Uint8Array> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(txId);
				reject(new Error(`timeout after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			this.pending.set(txId, { resolve, reject, timeout });
			try {
				const sent = this.socket!.send(data, port, host);
				if (sent === false) {
					// Send buffer is full. Treat as a transient failure.
					this.pending.delete(txId);
					clearTimeout(timeout);
					reject(new Error("udp send backpressure"));
				}
			} catch (err: any) {
				this.pending.delete(txId);
				clearTimeout(timeout);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}
}

function randomTransactionId(): number {
	const arr = new Uint32Array(1);
	crypto.getRandomValues(arr);
	return arr[0]!;
}

function hexToBytesInto(hex: string, out: Uint8Array, offset: number): void {
	if (hex.length !== 40) throw new Error(`invalid info_hash hex length: ${hex.length}`);
	for (let i = 0; i < 20; i++) {
		const hi = hexNibble(hex.charCodeAt(i * 2));
		const lo = hexNibble(hex.charCodeAt(i * 2 + 1));
		if (hi < 0 || lo < 0) throw new Error(`invalid hex in info_hash: ${hex}`);
		out[offset + i] = (hi << 4) | lo;
	}
}

function hexNibble(code: number): number {
	if (code >= 48 && code <= 57) return code - 48; // 0-9
	if (code >= 97 && code <= 102) return code - 97 + 10; // a-f
	if (code >= 65 && code <= 70) return code - 65 + 10; // A-F
	return -1;
}

function decodeError(resp: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: false }).decode(resp.subarray(8));
	} catch {
		return "<unparseable>";
	}
}
