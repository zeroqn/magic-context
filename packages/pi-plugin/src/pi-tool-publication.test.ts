/**
 * The tool bridge publication — how a Magic Context instance offers its tools to a code-mode kernel
 * (wayfinder ticket 04 in zeroqn/pi's `.scratch/tool-bridge/`).
 *
 * What these protect: a reader is told exactly what it may call, and nothing more. The catalogue and
 * the executor answer from one policy; a session this instance does not own is offered nothing; and
 * a tool the convention makes unpublishable never appears, however the policy is written.
 */
import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerPiRegistry } from "./pi-registry";
import {
	__bridgePublicationsForTests,
	BRIDGE_OWNERS_SYMBOL,
	type BridgePublication,
	bridgeToolEntries,
	publishBridgeTools,
} from "./pi-tool-publication";

const PROJECT_DIR = "/bridge-test-w";
const OTHER_PROJECT_DIR = "/bridge-test-other-w";

function fakeCtx(id: string, cwd = PROJECT_DIR) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `/sessions/${id}.jsonl`,
		},
	};
}

/** A definition whose `execute` records the call, so delegation is observable. */
function fakeTool(name: string, calls: string[]): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		promptSnippet: `${name} snippet`,
		parameters: { type: "object" },
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			calls.push(`${name}:${JSON.stringify(params)}`);
			return {
				content: [{ type: "text" as const, text: `${name} says ok` }],
				details: undefined,
			};
		},
	} as unknown as ToolDefinition;
}

function toolsMap(calls: string[], names: string[]) {
	return new Map<string, ToolDefinition>(
		names.map((name) => [name, fakeTool(name, calls)]),
	);
}

function registryStub() {
	return {
		transformContext: async () => undefined,
		compact: async () => undefined,
		scrubMessage: () => undefined,
		bindChild: () => undefined,
		clearSession: () => undefined,
	};
}

/** The facade pi-registry publishes, so a test can bind a session the way the child shim does. */
function bindSession(childSessionId: string, cwd = PROJECT_DIR): void {
	const facade = (globalThis as Record<symbol, unknown>)[
		Symbol.for("@cortexkit/magic-context:pi-registry")
	] as {
		bindChild(input: Record<string, unknown>): void;
	};
	facade.bindChild({
		childSessionFile: `/sessions/${childSessionId}.jsonl`,
		childSessionId,
		cwd,
	});
}

function bridgePublications(): BridgePublication[] {
	return __bridgePublicationsForTests().filter(
		(entry) => entry.owner === "magic-context",
	);
}

/** The one publication whose catalogue answers for this ctx. */
function publicationFor(ctx: unknown): BridgePublication | undefined {
	return bridgePublications().find((entry) => entry.catalogue(ctx).length > 0);
}

function textOf(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0].text;
}

describe("the publication slot", () => {
	it("writes at the agreed symbol, replaces by instance key, and leaves later writers alone", () => {
		const first: BridgePublication = {
			owner: "magic-context",
			apiVersion: 1,
			catalogue: () => [],
			execute: async () => undefined,
		};
		const second: BridgePublication = { ...first, apiVersion: 2 };
		const slotBefore = bridgePublications().length;
		const withdrawFirst = publishBridgeTools("slot-test", first);
		const withdrawSecond = publishBridgeTools("slot-test", second);
		try {
			expect(
				(globalThis as Record<symbol, unknown>)[BRIDGE_OWNERS_SYMBOL],
			).toBeInstanceOf(Map);
			expect(bridgePublications()).toHaveLength(slotBefore + 1);
			expect(__bridgePublicationsForTests()).toContain(second);
			expect(__bridgePublicationsForTests()).not.toContain(first);
			// An older instance's shutdown must not withdraw the live publication.
			withdrawFirst();
			expect(__bridgePublicationsForTests()).toContain(second);
		} finally {
			withdrawSecond();
		}
		expect(__bridgePublicationsForTests()).not.toContain(second);
	});

	it("keeps two instances apart", () => {
		const a = publishBridgeTools("slot-a", {
			owner: "magic-context",
			apiVersion: 1,
			catalogue: () => [],
			execute: async () => undefined,
		});
		const b = publishBridgeTools("slot-b", {
			owner: "magic-context",
			apiVersion: 1,
			catalogue: () => [],
			execute: async () => undefined,
		});
		try {
			expect(bridgePublications().length).toBeGreaterThanOrEqual(2);
		} finally {
			a();
			b();
		}
	});
});

describe("bridgeToolEntries", () => {
	it("carries what a reader renders and drops what the convention forbids", () => {
		const calls: string[] = [];
		const entries = bridgeToolEntries(
			toolsMap(calls, ["ctx_search", "ctx_reduce", "todowrite"]),
			["ctx_search", "ctx_reduce", "todowrite", "ctx_absent"],
		);
		// `todowrite` is not publishable — its effect is pi's dispatch, not its `execute`
		// (ticket 09) — and an unknown name has no definition to describe.
		expect(entries.map((entry) => entry.name)).toEqual([
			"ctx_search",
			"ctx_reduce",
		]);
		expect(entries[0].description).toBe("ctx_search description");
		expect(entries[0].snippet).toBe("ctx_search snippet");
		expect(entries[0].parameters).toEqual({ type: "object" });
	});
});

describe("an instance's publication", () => {
	it("offers exactly what its policy grants and answers a call through the tool", async () => {
		const calls: string[] = [];
		const definitions = toolsMap(calls, [
			"ctx_search",
			"ctx_reduce",
			"todowrite",
		]);
		const unpublish = registerPiRegistry({
			dbPath: "/p/bridge-test.db",
			projectDir: PROJECT_DIR,
			registry: registryStub(),
			tools: definitions,
			bridge: {
				// The policy names `todowrite` too: the publication must drop it anyway.
				publishableNames: () => ["ctx_search", "ctx_reduce", "todowrite"],
				execute: async (name, params, ctx) => {
					const definition = definitions.get(name);
					if (!definition) throw new Error(`no definition for ${name}`);
					return definition.execute("id", params, undefined, undefined, ctx);
				},
			},
		});
		try {
			bindSession("bridge-child");
			const ctx = fakeCtx("bridge-child");
			const publication = publicationFor(ctx);
			expect(publication?.apiVersion).toBe(1);
			expect(publication?.catalogue(ctx).map((entry) => entry.name)).toEqual([
				"ctx_search",
				"ctx_reduce",
			]);

			// Permitted: the same set, by construction.
			const allowed = await publication?.execute(
				"ctx_search",
				{ query: "wal" },
				ctx,
			);
			expect(textOf(allowed)).toBe("ctx_search says ok");

			// Refused: a name the catalogue never advertised.
			const refused = await publication?.execute("todowrite", {}, ctx);
			expect(textOf(refused)).toContain("not available");
			expect(calls).toEqual(['ctx_search:{"query":"wal"}']);
		} finally {
			unpublish();
		}
		expect(publicationFor(fakeCtx("bridge-child"))).toBeUndefined();
	});

	it("offers nothing to a session it does not own", async () => {
		const calls: string[] = [];
		const definitions = toolsMap(calls, ["ctx_search"]);
		const unpublishOwned = registerPiRegistry({
			dbPath: "/p/bridge-test-owned.db",
			projectDir: PROJECT_DIR,
			registry: registryStub(),
			tools: definitions,
			bridge: {
				publishableNames: () => ["ctx_search"],
				execute: async (name, params, ctx) => {
					const definition = definitions.get(name);
					if (!definition) throw new Error(`no definition for ${name}`);
					return definition.execute("id", params, undefined, undefined, ctx);
				},
			},
		});
		// A second instance, so resolution needs an explicit binding rather than "the only one".
		const unpublishOther = registerPiRegistry({
			dbPath: "/p/bridge-test-other.db",
			projectDir: OTHER_PROJECT_DIR,
			registry: registryStub(),
			tools: toolsMap([], ["ctx_search"]),
		});
		try {
			bindSession("bridge-owned");
			const owned = fakeCtx("bridge-owned");
			const publication = publicationFor(owned);
			expect(publication).toBeDefined();

			const stranger = fakeCtx("bridge-stranger");
			expect(publication?.catalogue(stranger)).toEqual([]);
			const refused = await publication?.execute("ctx_search", {}, stranger);
			expect(textOf(refused)).toContain("not available");
			expect(calls).toEqual([]);
		} finally {
			unpublishOwned();
			unpublishOther();
		}
	});
});
