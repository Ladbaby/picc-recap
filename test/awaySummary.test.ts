import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildAwaySummaryPrompt,
	buildSummaryMessages,
	recentMessagesToPi,
} from "../src/awaySummary.ts";
import { type RecapConfig, resolveRecapModel } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Prompt — must be byte-for-byte Claude Code
// ---------------------------------------------------------------------------

const CLAUDE_CODE_BASE_PROMPT =
	"The user stepped away and is coming back. Write exactly 1-3 short sentences. " +
	"Start by stating the high-level task — what they are building or debugging, " +
	"not implementation details. Next: the concrete next step. " +
	"Skip status reports and commit recaps.";

describe("buildAwaySummaryPrompt", () => {
	it("matches Claude Code exactly when there is no memory", () => {
		expect(buildAwaySummaryPrompt(null)).toBe(CLAUDE_CODE_BASE_PROMPT);
	});

	it("prepends the Claude Code memory block when memory is present", () => {
		const memory = "The project is a pi extension.";
		expect(buildAwaySummaryPrompt(memory)).toBe(
			`Session memory (broader context):\n${memory}\n\n${CLAUDE_CODE_BASE_PROMPT}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Message windowing
// ---------------------------------------------------------------------------

function messageEntry(
	id: string,
	role: "user" | "assistant",
	text: string,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content: text },
	};
}

describe("recentMessagesToPi", () => {
	it("keeps the last `window` user/assistant messages", () => {
		const entries: SessionEntry[] = [
			messageEntry("1", "user", "hello"),
			messageEntry("2", "assistant", "hi there"),
			messageEntry("3", "user", "do x"),
		];
		const messages = recentMessagesToPi(entries, 2);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "hi there" }] });
		expect(messages[1]).toEqual({ role: "user", content: "do x" });
	});

	it("skips non-message entries", () => {
		const entries: SessionEntry[] = [
			messageEntry("1", "user", "hello"),
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				provider: "p",
				modelId: "m",
			},
			messageEntry("2", "assistant", "hi"),
		];
		const messages = recentMessagesToPi(entries, 30);
		expect(messages).toHaveLength(2);
	});

	it("appends the away-summary prompt as a trailing user message", () => {
		const entries: SessionEntry[] = [messageEntry("1", "user", "hello")];
		const messages = buildSummaryMessages(entries, 30, null);
		expect(messages.at(-1)).toEqual({
			role: "user",
			content: buildAwaySummaryPrompt(null),
		});
	});
});

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function makeRegistry(models: Array<{ provider: string; id: string; name: string }>) {
	const map = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));
	return {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, modelId: string) => map.get(`${provider}/${modelId}`),
	};
}

function baseConfig(): RecapConfig {
	return {
		enabled: true,
		auto: true,
		manualCommand: true,
		idleAfterSettleMs: 5 * 60_000,
		model: "small-fast",
		fallbackToCurrentModel: true,
		recentMessageWindow: 30,
		maxTokens: 300,
		sessionMemoryPaths: [],
	};
}

describe("resolveRecapModel", () => {
	it('"current" returns the active model', () => {
		const current = { provider: "Tresor", id: "claude-sonnet" } as never;
		const ctx = { model: current, modelRegistry: makeRegistry([]) } as never;
		expect(resolveRecapModel(ctx, { ...baseConfig(), model: "current" })).toBe(current);
	});

	it('"small-fast" prefers the small/fast model on the current provider', () => {
		const models = [
			{ provider: "Tresor", id: "claude-sonnet", name: "Claude Sonnet" },
			{ provider: "Tresor", id: "claude-haiku", name: "Claude Haiku" },
			{ provider: "Other", id: "gemini-flash", name: "Gemini Flash" },
		];
		const registry = makeRegistry(models);
		const ctx = {
			model: { provider: "Tresor", id: "claude-sonnet" },
			modelRegistry: registry,
		} as never;
		const resolved = resolveRecapModel(ctx, baseConfig());
		expect(resolved).toBe(models[1]); // haiku, same provider
	});

	it('"provider/id" resolves an exact registry match', () => {
		const models = [{ provider: "Tresor", id: "claude-opus", name: "Opus" }];
		const registry = makeRegistry(models);
		const ctx = { model: { provider: "Tresor", id: "claude-sonnet" }, modelRegistry: registry } as never;
		expect(resolveRecapModel(ctx, { ...baseConfig(), model: "Tresor/claude-opus" })).toBe(models[0]);
	});

	it("falls back to the current model when small-fast has no match", () => {
		const current = { provider: "Tresor", id: "claude-sonnet" } as never;
		const ctx = {
			model: current,
			modelRegistry: makeRegistry([{ provider: "Tresor", id: "claude-sonnet", name: "Sonnet" }]),
		} as never;
		expect(resolveRecapModel(ctx, baseConfig())).toBe(current);
	});
});
