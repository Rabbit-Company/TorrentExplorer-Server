/**
 * Storage abstraction used for torrent files and per-episode media
 * (mediainfo text + screenshots).
 */
export interface Storage {
	save(key: string, data: Uint8Array, contentType?: string): Promise<void>;

	read(key: string): Promise<Uint8Array>;

	exists(key: string): Promise<boolean>;

	delete(key: string): Promise<void>;

	/**
	 * Lists every key starting with `prefix` (recursive). Returns full keys,
	 * forward-slash separated, example: "media/anime/Title/screenshots/Ep_1.png".
	 * Returns an empty array when the prefix does not exist.
	 */
	list(prefix: string): Promise<string[]>;
}
