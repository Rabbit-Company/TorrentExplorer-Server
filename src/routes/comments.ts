import type { Web } from "@rabbit-company/web";
import type { Database, Category, Comment } from "../database/index.ts";
import type { Config } from "../config.ts";
import { Algorithm, rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Logger } from "../logger.ts";
import { timingSafeEqual } from "node:crypto";
import type { Ntfy } from "../notifications/ntfy.ts";

interface Services {
	db: Database;
	config: Config;
	ntfy: Ntfy;
}

const CATEGORIES: ReadonlySet<Category> = new Set<Category>(["anime", "movies", "series"]);

const OWNER_HARD_CAP = 50_000;

type Identity = "anonymous" | "owner" | "invalid";

/** Constant-time-ish token compare */
function tokenValid(token: string, expected: string): boolean {
	const a = Buffer.from(token);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Resolve who is posting:
 * - no Authorization header at all -> "anonymous"
 * - a valid Bearer token           -> "owner"
 * - any present-but-wrong token    -> "invalid" (the request must be refused)
 */
function resolveIdentity(req: Request, expectedToken: string): Identity {
	const header = req.headers.get("authorization");
	if (header === null || header.trim() === "") return "anonymous";

	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return "invalid";

	const token = match[1]!.trim();
	if (!token) return "invalid";

	return tokenValid(token, expectedToken) ? "owner" : "invalid";
}

/** Public-facing shape for a single comment. */
function renderComment(c: Comment, releaseGroup: string) {
	return {
		id: c.id,
		parent_id: c.parent_id,
		author: c.author_type === "owner" ? releaseGroup : "Anonymous",
		author_type: c.author_type,
		body: c.body,
		created_at: c.created_at,
	};
}

/** Human-friendly description of the token-bucket refill cadence. */
function refillLabel(minutes: number): string {
	if (minutes === 1) return "minute";
	if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
	return `${minutes} minutes`;
}

export function registerCommentRoutes(app: Web, services: Services): void {
	const { db, config, ntfy } = services;

	if (!config.comments.enabled) {
		Logger.info("Comments: disabled by config");
		return;
	}

	const maxLength = Math.max(1, Math.floor(config.comments.maxLength) || 1000);
	const burst = Math.max(1, Math.floor(config.comments.rateLimit.burst) || 1);
	const refillMinutes = Math.max(1, Math.floor(config.comments.rateLimit.refillIntervalMinutes) || 5);
	const refillIntervalMs = refillMinutes * 60_000;

	const limitMessage = `You're commenting too fast. You can post a comment once every ${refillLabel(refillMinutes)}.`;

	const limiter = rateLimit({
		algorithm: Algorithm.TOKEN_BUCKET,
		max: burst,
		refillRate: 1,
		refillInterval: refillIntervalMs,
		message: limitMessage,
		headers: true,
		keyGenerator: (ctx) => `comment:${ctx.clientIp ?? "unknown"}`,
		skip: (ctx) => resolveIdentity(ctx.req, config.server.token) === "owner",
	});

	for (const category of ["anime", "movies", "series"] as Category[]) {
		// GET: list the comment tree for a release
		app.get(`/api/${category}/:id/comments`, async (ctx) => {
			if (!CATEGORIES.has(category)) {
				return ctx.json({ error: "Invalid category" }, 400, { "Cache-Control": "no-store" });
			}
			const releaseId = parseInt(ctx.params.id!, 10);
			if (!Number.isFinite(releaseId)) {
				return ctx.json({ error: "Invalid id" }, 400, { "Cache-Control": "no-store" });
			}

			const release = await db.findById(category, releaseId);
			if (!release) {
				console.log("no find");
				return ctx.json({ error: "Not found" }, 404, { "Cache-Control": "no-store" });
			}

			const all = await db.listCommentsForRelease(releaseId);
			const releaseGroup = config.brand.releaseGroup;

			type Node = ReturnType<typeof renderComment> & { replies: ReturnType<typeof renderComment>[] };
			const roots: Node[] = [];
			const rootById = new Map<number, Node>();

			for (const c of all) {
				if (c.parent_id === null) {
					const node: Node = { ...renderComment(c, releaseGroup), replies: [] };
					rootById.set(c.id, node);
					roots.push(node);
				}
			}
			for (const c of all) {
				if (c.parent_id !== null) {
					const parent = rootById.get(c.parent_id);
					// Orphans (parent deleted) are skipped; cascade delete should prevent them.
					if (parent) parent.replies.push(renderComment(c, releaseGroup));
				}
			}

			return ctx.json({ comments: roots }, 200, { "Cache-Control": "no-store" });
		});

		// POST: create a root comment or a single-level reply
		app.post(`/api/${category}/:id/comments`, limiter, async (ctx) => {
			if (!CATEGORIES.has(category)) {
				return ctx.json({ error: "Invalid category" }, 400);
			}
			const releaseId = parseInt(ctx.params.id!, 10);
			if (!Number.isFinite(releaseId)) {
				return ctx.json({ error: "Invalid id" }, 400);
			}

			const identity = resolveIdentity(ctx.req, config.server.token);
			if (identity === "invalid") {
				// A token was supplied but it's wrong -> refuse, publish nothing.
				return ctx.json({ error: "Invalid bearer token." }, 401);
			}
			const isOwner = identity === "owner";

			const release = await db.findById(category, releaseId);
			if (!release) {
				return ctx.json({ error: "Release not found" }, 404);
			}

			let payload: { body?: unknown; parent_id?: unknown } | null = null;
			try {
				payload = await ctx.body<{ body?: unknown; parent_id?: unknown }>();
			} catch {
				return ctx.json({ error: 'Expected a JSON body like { "body": "..." }' }, 400);
			}
			if (!payload || typeof payload !== "object") {
				return ctx.json({ error: 'Expected a JSON body like { "body": "..." }' }, 400);
			}

			if (typeof payload.body !== "string") {
				return ctx.json({ error: "Field 'body' is required." }, 400);
			}
			const body = payload.body.trim();
			if (!body) {
				return ctx.json({ error: "Comment can't be empty." }, 400);
			}
			if (!isOwner && body.length > maxLength) {
				return ctx.json({ error: `Comments are limited to ${maxLength} characters.` }, 400);
			}
			if (body.length > OWNER_HARD_CAP) {
				return ctx.json({ error: "Comment is too long." }, 400);
			}

			// Resolve the (optional) parent and enforce single-level nesting.
			let parentId: number | null = null;
			if (payload.parent_id !== undefined && payload.parent_id !== null) {
				const raw = payload.parent_id;
				const pid = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
				if (!Number.isInteger(pid) || pid < 1) {
					return ctx.json({ error: "Invalid parent_id." }, 400);
				}
				const parent = await db.findComment(pid);
				if (!parent || parent.release_id !== releaseId) {
					return ctx.json({ error: "Parent comment not found." }, 404);
				}
				if (parent.parent_id !== null) {
					return ctx.json({ error: "You can only reply to a top-level comment." }, 400);
				}
				parentId = pid;
			}

			let created: Comment;
			try {
				created = await db.insertComment({
					release_id: releaseId,
					parent_id: parentId,
					author_type: isOwner ? "owner" : "anonymous",
					body,
					created_at: Date.now(),
				});
			} catch (err: any) {
				Logger.error("Comment insert failed:", err);
				return ctx.json({ error: "Failed to save comment" }, 500);
			}

			const snippet = body.length > 300 ? `${body.slice(0, 300)}…` : body;
			const author = isOwner ? config.brand.releaseGroup : "Anonymous";
			ntfy.notify({
				title: parentId ? `New reply on ${release.title}` : `New comment on ${release.title}`,
				message: `${author}: ${snippet}`,
				tags: ["speech_balloon"],
				click: config.frontend.url ? `${config.frontend.url}/${category}/${releaseId}` : undefined,
			});

			return ctx.json(renderComment(created, config.brand.releaseGroup), 201, { "Cache-Control": "no-store" });
		});

		// DELETE: owner-only moderation; root delete cascades to replies
		app.delete(`/api/${category}/:id/comments/:commentId`, async (ctx) => {
			if (!CATEGORIES.has(category)) {
				return ctx.json({ error: "Invalid category" }, 400);
			}
			const releaseId = parseInt(ctx.params.id!, 10);
			const commentId = parseInt(ctx.params.commentId!, 10);
			if (!Number.isFinite(releaseId) || !Number.isFinite(commentId)) {
				return ctx.json({ error: "Invalid id" }, 400);
			}

			// Deletion is strictly owner-only. Anything other than a valid token
			// (including no token at all) is rejected.
			if (resolveIdentity(ctx.req, config.server.token) !== "owner") {
				return ctx.json({ error: "Unauthorized" }, 401);
			}

			const comment = await db.findComment(commentId);
			if (!comment || comment.release_id !== releaseId) {
				return ctx.json({ error: "Comment not found" }, 404);
			}

			try {
				await db.deleteComment(commentId);
			} catch (err: any) {
				Logger.error("Comment delete failed:", err);
				return ctx.json({ error: "Failed to delete comment" }, 500);
			}

			return ctx.json({ deleted: true }, 200, { "Cache-Control": "no-store" });
		});
	}

	Logger.info(`Comments: enabled (max ${maxLength} chars, burst ${burst}, 1 token / ${refillMinutes}m)`);
}
