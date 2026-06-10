import type { Web } from "@rabbit-company/web";
import { cache } from "@rabbit-company/web-middleware/cache";
import type { EncoderPoller } from "../encoders.ts";

interface Services {
	encoders: EncoderPoller;
}

export function registerEncoderRoutes(app: Web, services: Services): void {
	const { encoders } = services;

	app.get("/api/encoders/queue", cache({ ttl: 5, generateETags: false }), (ctx) => {
		return ctx.json(encoders.getPayload(), 200, { "Cache-Control": "public, max-age=5, s-maxage=5" });
	});
}
