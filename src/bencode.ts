export type BencodeValue = number | Uint8Array | BencodeValue[] | BencodeDict;
export type BencodeDict = Map<string, BencodeValue>;

export interface TorrentFile {
	/** Path components relative to the torrent root (Example: ["Subs", "en.srt"]). */
	path: string[];
	length: number;
}

export interface TorrentMetadata {
	announceList: string[];
	name: string;
	length: number;
	infoHashHex: string;
	files: TorrentFile[];
}

class BencodeParser {
	private pos = 0;
	private depth = 0;
	private readonly data: Uint8Array;
	private readonly decoder = new TextDecoder("utf-8", { fatal: false });

	public infoStart = -1;
	public infoEnd = -1;

	constructor(data: Uint8Array) {
		this.data = data;
	}

	parse(): BencodeValue {
		return this.parseValue();
	}

	private parseValue(): BencodeValue {
		const c = this.data[this.pos];
		if (c === 0x69) return this.parseInt(); // 'i'
		if (c === 0x6c) return this.parseList(); // 'l'
		if (c === 0x64) return this.parseDict(); // 'd'
		if (c !== undefined && c >= 0x30 && c <= 0x39) return this.parseString();
		throw new Error(`Unexpected byte at position ${this.pos}`);
	}

	private parseInt(): number {
		this.pos++; // skip 'i'
		const end = this.data.indexOf(0x65, this.pos); // 'e'
		if (end === -1) throw new Error("Unterminated integer");
		const n = parseInt(this.decoder.decode(this.data.subarray(this.pos, end)), 10);
		this.pos = end + 1;
		return n;
	}

	private parseString(): Uint8Array {
		const colon = this.data.indexOf(0x3a, this.pos); // ':'
		if (colon === -1) throw new Error("Invalid string length prefix");
		const len = parseInt(this.decoder.decode(this.data.subarray(this.pos, colon)), 10);
		const start = colon + 1;
		const end = start + len;
		if (end > this.data.length) throw new Error("String exceeds file bounds");
		this.pos = end;
		return this.data.subarray(start, end);
	}

	private parseList(): BencodeValue[] {
		this.pos++; // skip 'l'
		const list: BencodeValue[] = [];
		while (this.pos < this.data.length && this.data[this.pos] !== 0x65) {
			list.push(this.parseValue());
		}
		this.pos++; // skip 'e'
		return list;
	}

	private parseDict(): BencodeDict {
		this.pos++; // skip 'd'
		this.depth++;
		const dict: BencodeDict = new Map();
		while (this.pos < this.data.length && this.data[this.pos] !== 0x65) {
			const key = this.decoder.decode(this.parseString());
			const valueStart = this.pos;
			const value = this.parseValue();
			const valueEnd = this.pos;
			if (this.depth === 1 && key === "info" && this.infoStart === -1) {
				this.infoStart = valueStart;
				this.infoEnd = valueEnd;
			}
			dict.set(key, value);
		}
		this.pos++; // skip 'e'
		this.depth--;
		return dict;
	}
}

function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

function asString(v: BencodeValue | undefined): string {
	return v instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: false }).decode(v) : "";
}

/** Parse a .torrent file and pull out the fields needed for a magnet URI / scraping. */
export async function parseTorrent(bytes: Uint8Array): Promise<TorrentMetadata> {
	const parser = new BencodeParser(bytes);
	const root = parser.parse();
	if (!(root instanceof Map)) throw new Error("Torrent root is not a dictionary");
	if (parser.infoStart === -1) throw new Error("Torrent has no info dict");

	const infoBytes = bytes.slice(parser.infoStart, parser.infoEnd);
	const hashBuf = await crypto.subtle.digest("SHA-1", infoBytes);
	const infoHashHex = bytesToHex(new Uint8Array(hashBuf));

	const info = root.get("info");
	if (!(info instanceof Map)) throw new Error("info is not a dictionary");

	const name = asString(info.get("name"));

	// Single-file torrents have `info.length`; multi-file has `info.files[*].length`.
	const files: TorrentFile[] = [];
	let length = 0;
	const singleLen = info.get("length");
	if (typeof singleLen === "number") {
		length = singleLen;
		// Normalize single-file torrents into the same shape as multi-file so
		// frontends can iterate uniformly.
		if (name) files.push({ path: [name], length: singleLen });
	} else {
		const fileList = info.get("files");
		if (Array.isArray(fileList)) {
			for (const f of fileList) {
				if (!(f instanceof Map)) continue;
				const l = f.get("length");
				if (typeof l !== "number") continue;
				length += l;

				const pathVal = f.get("path");
				if (!Array.isArray(pathVal)) continue;
				const pathComponents: string[] = [];
				for (const p of pathVal) {
					const component = asString(p);
					// Skip empty / obviously nonsense components but keep the file.
					if (component) pathComponents.push(component);
				}
				if (pathComponents.length > 0) {
					files.push({ path: pathComponents, length: l });
				}
			}
		}
	}

	// Trackers: `announce` (string) + optional `announce-list` (list of tiers).
	const announceList: string[] = [];
	const announce = asString(root.get("announce"));
	if (announce) announceList.push(announce);

	const tiers = root.get("announce-list");
	if (Array.isArray(tiers)) {
		for (const tier of tiers) {
			if (!Array.isArray(tier)) continue;
			for (const t of tier) {
				const url = asString(t);
				if (url && !announceList.includes(url)) announceList.push(url);
			}
		}
	}

	return { announceList, name, length, infoHashHex, files };
}

/** Build a BitTorrent v1 magnet URI from parsed metadata. */
export function buildMagnetLink(meta: TorrentMetadata): string {
	const parts = [`xt=urn:btih:${meta.infoHashHex}`];
	if (meta.name) parts.push(`dn=${encodeURIComponent(meta.name)}`);
	if (meta.length > 0) parts.push(`xl=${meta.length}`);
	for (const tr of meta.announceList) parts.push(`tr=${encodeURIComponent(tr)}`);
	return `magnet:?${parts.join("&")}`;
}
