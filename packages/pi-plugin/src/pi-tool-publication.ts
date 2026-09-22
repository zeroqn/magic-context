/**
 * The tool bridge: how a Magic Context instance offers its Pi tools to a code-mode kernel.
 *
 * A code-mode session drives the model through one tool (`python`), so Magic Context's tools are
 * inactive and, as pi resolves a call against the active list, unreachable. `zeroqn/pi`'s
 * `pi-tool-bridge` package reads this publication and turns it into kernel host functions, so a cell
 * can call `await tool("ctx_reduce", drop="3-5")` — and pi's active set stays as code mode left it.
 *
 * The reader **cannot be imported**: this package is built inside this submodule by CI
 * (`bun run --cwd packages/pi-plugin build`), and the reader is a private workspace package of the
 * host repo, unresolvable from here. So the symbol and the shape below are a **documented literal**,
 * duplicated on the reader side exactly as `pi-registry.ts`'s symbol already is. The reader owns
 * validation (apiVersion, malformed entries, name reservation between owners); this file's job is to
 * hand it something true.
 *
 * The decisions this implements are recorded in the host repo's wayfinder map
 * (`zeroqn/pi:.scratch/tool-bridge/`):
 *
 *   - **Per session, from one policy function** (ticket 04). `catalogue(ctx)` and `execute(…)` are
 *     answered by the same predicate, so nothing is advertised that `execute` would refuse, and a
 *     session this instance does not serve is offered nothing at all rather than a false promise.
 *   - **Keyed, and replacing** (ticket 04). Pi's jiti loader re-imports an extension entry per session
 *     while `globalThis` survives, so an appending publish would leave one live publication per
 *     import.
 *   - **`todowrite` is not publishable** (ticket 09). Its effect is produced by pi's dispatch — the
 *     `tool_execution_start` / `message_end` capture into `session_meta.last_todo_state` — and not by
 *     its `execute`, so a cell-routed call would silently persist nothing. It stays a pi tool.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Where readers find every owner's publication. Duplicated as a literal by `pi-tool-bridge`. */
export const BRIDGE_OWNERS_SYMBOL = Symbol.for("pi-tool-bridge:owners");

/** The publication shape this file writes. A reader refuses a major it does not know. */
export const BRIDGE_API_VERSION = 1;

/** This package's name in the slot. One owner, one key prefix. */
export const BRIDGE_OWNER = "magic-context";

/**
 * The tool names this package is willing to offer any kernel.
 *
 * Membership is a statement about the *tool*, not about a session: every name here resolves its own
 * session from the `ctx` it is handed, so it works the same wherever it is called from. A tool whose
 * effect pi's dispatch produces instead is deliberately absent — publishing it would give the model a
 * call that appears to succeed and does nothing (wayfinder ticket 09).
 */
export const BRIDGE_PUBLISHABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"ctx_search",
	"ctx_memory",
	"ctx_note",
	"ctx_expand",
	"ctx_reduce",
]);

/**
 * Whether a tool may be offered at all. Consulted by *both* halves of the offer — the catalogue and
 * the executor — so a policy passed in from above cannot publish a tool this convention forbids.
 */
export function isBridgePublishable(name: string): boolean {
	return BRIDGE_PUBLISHABLE_TOOL_NAMES.has(name);
}

/** One tool as a reader needs to describe it. */
export interface BridgeToolEntry {
	name: string;
	description: string;
	snippet: string;
	parameters: unknown;
}

export interface BridgePublication {
	owner: string;
	apiVersion: number;
	/** The tools this session may call — empty when this owner serves no such session. */
	catalogue(ctx: unknown): BridgeToolEntry[];
	execute(
		name: string,
		params: Record<string, unknown>,
		ctx: unknown,
	): Promise<unknown>;
}

type BridgeSlot = Map<string, BridgePublication>;

function bridgeSlot(): BridgeSlot {
	const holder = globalThis as Record<symbol, unknown>;
	const existing = holder[BRIDGE_OWNERS_SYMBOL];
	if (existing instanceof Map) return existing as BridgeSlot;
	const created: BridgeSlot = new Map();
	holder[BRIDGE_OWNERS_SYMBOL] = created;
	return created;
}

/**
 * Publishes one instance's offer and returns the function that withdraws it.
 *
 * `key` identifies the *instance*, not the owner: two Magic Context instances in one process (two
 * projects) each publish, and each answers only for the sessions it owns. Re-publishing under the
 * same key replaces, which is what a re-import amounts to.
 */
export function publishBridgeTools(
	key: string,
	publication: BridgePublication,
): () => void {
	const slot = bridgeSlot();
	slot.set(key, publication);
	return () => {
		// Only withdraw what is still ours: a re-import publishes over this key, and an older
		// instance's shutdown must not delete the live publication.
		if (slot.get(key) === publication) slot.delete(key);
	};
}

/**
 * Builds the catalogue entries a reader renders, keeping only names this package may publish and
 * only names the caller was granted. Filtering here as well as at the call site is deliberate: the
 * dispatch-effect exclusion is this package's own rule, and no policy passed in from above can
 * publish a tool the convention forbids.
 */
export function bridgeToolEntries(
	definitions: Map<string, ToolDefinition>,
	names: readonly string[],
): BridgeToolEntry[] {
	const entries: BridgeToolEntry[] = [];
	for (const name of names) {
		if (!isBridgePublishable(name)) continue;
		const definition = definitions.get(name);
		if (!definition) continue;
		entries.push({
			name,
			description: definition.description,
			snippet: definition.promptSnippet ?? definition.description,
			parameters: definition.parameters,
		});
	}
	return entries;
}

/** Test seam: every live publication, whoever wrote it. */
export function __bridgePublicationsForTests(): BridgePublication[] {
	return [...bridgeSlot().values()];
}
