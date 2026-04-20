export interface Storage {
	save(key: string, data: Uint8Array): Promise<void>;
	read(key: string): Promise<Uint8Array>;
	exists(key: string): Promise<boolean>;
	delete(key: string): Promise<void>;
}
