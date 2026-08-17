/**
 * picc-recap configuration.
 *
 * A small, Claude Code-flavoured config surface. Unlike pi-recap this is deliberately
 * minimal: the goal is to replicate Claude Code's away-summary, not to add features.
 *
 * Defaults are intentionally close to Claude Code's away-summary constants:
 *   - 5-minute idle window (BLUR_DELAY_MS)
 *   - 30 recent messages (RECENT_MESSAGE_WINDOW)
 *
 * Loaded from (project overrides global; project only read when trusted):
 *   $PI_CODING_AGENT_DIR/extension-data/picc-recap/config.json
 *   <cwd>/.pi/extension-data/picc-recap/config.json
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ModelSpec = "current" | "small-fast" | (string & {});

export interface RecapConfig {
	/** Master switch. When false, nothing is generated. */
	enabled: boolean;
	/** Generate automatically after the agent settles and stays idle. */
	auto: boolean;
	/** Enable the manual `/away` command. */
	manualCommand: boolean;
	/** Idle window before an auto summary is generated (ms). */
	idleAfterSettleMs: number;
	/** Which model to call. */
	model: ModelSpec;
	/** Fall back to the current model if `model` cannot be resolved. */
	fallbackToCurrentModel: boolean;
	/** How many recent messages to feed the summary (Claude Code: 30). */
	recentMessageWindow: number;
	/** Cap on the summary generation (Claude Code uses thinking off + a small model). */
	maxTokens: number;
	/** Best-effort session-memory file(s) to read (broader context). Empty = none. */
	sessionMemoryPaths: string[];
}

export const DEFAULT_CONFIG: RecapConfig = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: unknown): T {
	if (!isRecord(override)) return { ...base };
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = result[key];
		if (isRecord(current) && isRecord(value)) {
			result[key] = deepMerge(current, value);
		} else {
			result[key] = value;
		}
	}
	return result as T;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeModel(value: unknown, fallback: ModelSpec): ModelSpec {
	return typeof value === "string" && value.length > 0 ? (value as ModelSpec) : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return value.filter((v): v is string => typeof v === "string");
}

export function normalizeConfig(config: RecapConfig): RecapConfig {
	return {
		enabled: normalizeBool(config.enabled, DEFAULT_CONFIG.enabled),
		auto: normalizeBool(config.auto, DEFAULT_CONFIG.auto),
		manualCommand: normalizeBool(config.manualCommand, DEFAULT_CONFIG.manualCommand),
		idleAfterSettleMs: positiveNumber(config.idleAfterSettleMs, DEFAULT_CONFIG.idleAfterSettleMs),
		model: normalizeModel(config.model, DEFAULT_CONFIG.model),
		fallbackToCurrentModel: normalizeBool(
			config.fallbackToCurrentModel,
			DEFAULT_CONFIG.fallbackToCurrentModel,
		),
		recentMessageWindow: Math.max(
			1,
			Math.floor(positiveNumber(config.recentMessageWindow, DEFAULT_CONFIG.recentMessageWindow)),
		),
		maxTokens: positiveNumber(config.maxTokens, DEFAULT_CONFIG.maxTokens),
		sessionMemoryPaths: normalizeStringArray(
			config.sessionMemoryPaths,
			DEFAULT_CONFIG.sessionMemoryPaths,
		),
	};
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

function getGlobalConfigPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "extension-data", "picc-recap", "config.json");
}

function getProjectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "extension-data", "picc-recap", "config.json");
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		const code = isRecord(error) ? error.code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		// Preserve malformed files; warn and ignore.
		console.warn(`[picc-recap] ignoring invalid config at ${file}:`, error);
		return undefined;
	}
}

export async function loadRecapConfig(ctx: ExtensionContext): Promise<RecapConfig> {
	let config: RecapConfig = { ...DEFAULT_CONFIG };
	const global = await readJsonIfExists(getGlobalConfigPath());
	if (global !== undefined) {
		config = deepMerge(
			config as unknown as Record<string, unknown>,
			global,
		) as unknown as RecapConfig;
	}
	if (ctx.isProjectTrusted()) {
		const project = await readJsonIfExists(getProjectConfigPath(ctx.cwd));
		if (project !== undefined) {
			config = deepMerge(
				config as unknown as Record<string, unknown>,
				project,
			) as unknown as RecapConfig;
		}
	}
	return normalizeConfig(config);
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

interface ModelLike {
	id: string;
	name: string;
	provider: string;
}

// Heuristic used to pick a "small/fast" model from the registry, mirroring the
// intent of Claude Code's getSmallFastModel(). Prefer the current provider first.
const SMALL_FAST_HINTS = ["haiku", "flash", "nano", "mini", "small", "fast", "lite", "instant"];

function modelKey(m: ModelLike): string {
	return `${m.provider}/${m.id}`.toLowerCase();
}

function smallFastScore(m: ModelLike): number {
	const key = modelKey(m);
	let best = 0;
	for (const hint of SMALL_FAST_HINTS) {
		if (key.includes(hint)) {
			// Prefer an id that exactly equals or starts with the hint.
			const idPart = m.id.toLowerCase();
			const score = idPart === hint ? 100 : idPart.startsWith(hint) ? 80 : 40;
			if (score > best) best = score;
		}
	}
	return best;
}

/**
 * Resolve the model to use for summary generation.
 *
 *   - "current"      → the active session model
 *   - "small-fast"   → best small/fast model in the registry (preferring the
 *                      current provider), else fall back per fallbackToCurrentModel
 *   - "prov/id"      → exact registry lookup, else fall back
 */
export function resolveRecapModel(
	ctx: ExtensionContext,
	config: RecapConfig,
): Model<any> | undefined {
	const current = ctx.model;
	if (config.model === "current") return current;

	const registry = ctx.modelRegistry;
	const candidates: ModelLike[] = (registry.getAvailable?.() ?? registry.getAll()) as unknown as ModelLike[];

	if (config.model === "small-fast") {
		const currentProvider = current?.provider;
		let best: ModelLike | undefined;
		let bestScore = 0;
		for (const m of candidates) {
			let score = smallFastScore(m);
			if (score === 0) continue;
			// Prefer the current provider so we stay on the same backend/auth.
			if (currentProvider && m.provider === currentProvider) score += 50;
			if (score > bestScore) {
				bestScore = score;
				best = m;
			}
		}
		if (best) return registry.find(best.provider, best.id) ?? current;
		return config.fallbackToCurrentModel ? current : undefined;
	}

	// Explicit "provider/modelId"
	const separator = config.model.indexOf("/");
	if (separator > 0) {
		const provider = config.model.slice(0, separator);
		const modelId = config.model.slice(separator + 1);
		const found = registry.find(provider, modelId);
		if (found) return found;
	}
	return config.fallbackToCurrentModel ? current : undefined;
}
