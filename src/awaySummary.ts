/**
 * picc-recap — away summary.
 *
 * A faithful port of Claude Code's `services/awaySummary.ts` (the "while you were
 * away" summary). The prompt is replicated verbatim; the only intentional deltas
 * are where pi differs from Claude Code (see README "Deltas"):
 *   - pi has no per-session memory file, so the memory block is best-effort.
 *   - pi-ai's `complete` has no "thinking disabled" knob, so we rely on a small/
 *     fast model + a small maxTokens.
 */

import { readFile } from "node:fs/promises";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	TextContent,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { RecapConfig } from "./config.js";

/** Claude Code's `asSystemPrompt([])` — an empty system prompt. */
const EMPTY_SYSTEM_PROMPT = "";

/**
 * A minimal wire message for summary generation. pi-ai's strict `Message` union
 * demands api/provider/model/usage/timestamp fields on assistant messages that a
 * freshly-built message does not carry; the provider only reads `role` + `content`
 * for these, so we build plain objects and cast once when constructing the
 * `Context` (the same approach pi-recap uses with inline objects).
 */
export type SummaryMessage =
	| { role: "user"; content: string }
	| { role: "assistant"; content: TextContent[] };

// ---------------------------------------------------------------------------
// Prompt (verbatim from Claude Code services/awaySummary.ts)
// ---------------------------------------------------------------------------

/**
 * Build the away-summary prompt. Replicated byte-for-byte from Claude Code.
 *
 *   ${memoryBlock}The user stepped away and is coming back. Write exactly 1-3
 *   short sentences. Start by stating the high-level task — what they are
 *   building or debugging, not implementation details. Next: the concrete next
 *   step. Skip status reports and commit recaps.
 */
export function buildAwaySummaryPrompt(memory: string | null): string {
	const memoryBlock = memory
		? `Session memory (broader context):\n${memory}\n\n`
		: "";
	return `${memoryBlock}The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.`;
}

// ---------------------------------------------------------------------------
// Conversation → pi-ai messages
// ---------------------------------------------------------------------------

/**
 * Flatten arbitrary message content (string or content-block array) to plain
 * text. Tool calls are rendered as `[tool:Name args]` so the model can see the
 * trajectory, mirroring pi-recap's approach.
 */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as { type?: string; text?: string; name?: string; arguments?: unknown };
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			parts.push(`[tool:${block.name} ${safeJson(block.arguments)}]`);
		} else if (block.type === "thinking") {
			// Skip thinking blocks — irrelevant to "what happened".
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return "{}";
	}
}

/**
 * Take the last `window` user/assistant messages from a session branch and map
 * them to pi-ai `Message`s. Mirrors Claude Code's `messages.slice(-30)`.
 *
 * Non-message entries (compaction, model_change, custom, labels, ...) are
 * skipped, matching Claude Code which only operates on `messages`.
 */
export function recentMessagesToPi(
	entries: SessionEntry[],
	window: number,
): SummaryMessage[] {
	const messageEntries = entries.filter(
		(entry): entry is Extract<SessionEntry, { type: "message" }> =>
			entry.type === "message" &&
			(entry.message.role === "user" || entry.message.role === "assistant"),
	);

	const recent = messageEntries.slice(-Math.max(1, window));
	const messages: SummaryMessage[] = [];
	for (const entry of recent) {
		const msg = entry.message as { role: "user" | "assistant"; content: unknown };
		const text = contentToText(msg.content).trim();
		if (!text) continue;
		if (msg.role === "user") {
			messages.push({ role: "user", content: text });
		} else {
			messages.push({ role: "assistant", content: [{ type: "text", text }] });
		}
	}
	return messages;
}

/**
 * Build the full message list for the summary call: recent conversation + the
 * away-summary prompt as a trailing user message (Claude Code appends the prompt
 * as a synthetic user message too).
 */
export function buildSummaryMessages(
	entries: SessionEntry[],
	window: number,
	memory: string | null,
): SummaryMessage[] {
	const recent = recentMessagesToPi(entries, window);
	return [
		...recent,
		{ role: "user", content: buildAwaySummaryPrompt(memory) },
	];
}

// ---------------------------------------------------------------------------
// Session memory (best-effort)
// ---------------------------------------------------------------------------

/**
 * Read optional session-memory files (broader context). Best-effort: any missing
 * or unreadable file is skipped, returning null when nothing is found. Claude
 * Code reads a single per-session summary.md; pi has no equivalent, so this is
 * a config-driven best-effort (see `sessionMemoryPaths`).
 */
export async function readSessionMemory(ctx: ExtensionContext, config: RecapConfig): Promise<string | null> {
	const paths = config.sessionMemoryPaths;
	if (paths.length === 0) return null;

	const chunks: string[] = [];
	for (const raw of paths) {
		try {
			const file = raw.startsWith("/") ? raw : raw; // paths are used as given
			const content = await readFile(file, "utf8");
			const trimmed = content.trim();
			if (trimmed) chunks.push(trimmed);
		} catch {
			// Missing / inaccessible → skip (Claude Code returns null on ENOENT).
		}
	}
	// (ctx is unused here but kept for symmetry/future per-session resolution.)
	void ctx;
	return chunks.length > 0 ? chunks.join("\n\n") : null;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type AuthResolver = (model: Model<any>) => Promise<
	| { ok: true; apiKey?: string; headers?: Record<string, string | null> | null; env?: Record<string, string> }
	| { ok: false; error: string }
>;

export interface GenerateAwaySummaryOptions {
	model: Model<any>;
	/** Full message list (recent + prompt). */
	messages: SummaryMessage[];
	maxTokens: number;
	signal?: AbortSignal;
	sessionId?: string;
	/** Injectable for tests. */
	completeModel?: typeof complete;
	/** Injectable for tests. */
	getAuth?: AuthResolver;
}

/**
 * Generate the away summary. Returns the 1-3 sentence plain text, or null on
 * abort / empty / error (Claude Code swallows errors and shows nothing).
 */
export async function generateAwaySummary(opts: GenerateAwaySummaryOptions): Promise<string | null> {
	const { model, messages, maxTokens, signal, sessionId, completeModel = complete, getAuth } = opts;
	if (!getAuth || messages.length === 0) return null;

	try {
		const auth = await getAuth(model);
		if (!auth.ok || !auth.apiKey) return null;

		// The provider reads only role/content from these, so a single cast to the
		// strict `Message` union is safe here.
		const context: Context = {
			systemPrompt: EMPTY_SYSTEM_PROMPT,
			messages: messages as unknown as Message[],
		};

		const response: AssistantMessage = await completeModel(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers ?? undefined,
			env: auth.env,
			maxTokens,
			signal,
			sessionId,
		});

		if (response.stopReason === "aborted") return null;
		if (response.stopReason === "error") return null;

		const text = response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		return text ? text : null;
	} catch (error) {
		if (signal?.aborted) return null;
		console.debug?.("[picc-recap] away summary failed:", error);
		return null;
	}
}
