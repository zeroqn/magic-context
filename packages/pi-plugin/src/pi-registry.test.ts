/**
 * The registry that lets one Magic Context instance serve RLM's bound child sessions
 * (wayfinder ticket 16, seam B).
 *
 * The decision this file protects: recognition is **explicit binding**, never the session
 * header — `SessionManager.forkFrom` also writes `parentSession`, so a `/fork` must not be
 * mistaken for a child.
 */
import { describe, expect, it } from "bun:test";
import { __piRegistrySizeForTests, registerPiRegistry } from "./pi-registry";

const KEY = Symbol.for("@cortexkit/magic-context:pi-registry");

function fakeCtx(id: string, file?: string) {
	return {
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => file ?? `/sessions/${id}.jsonl`,
		},
	};
}

function fakeInstance(label: string) {
	const calls: string[] = [];
	return {
		calls,
		registry: {
			transformContext: async () => {
				calls.push(`${label}:transform`);
				return { messages: [] };
			},
			compact: async () => {
				calls.push(`${label}:compact`);
				return { cancel: true as const };
			},
			scrubMessage: () => {
				calls.push(`${label}:scrub`);
			},
			bindChild: () => undefined,
			clearSession: (sessionId: string) => {
				calls.push(`${label}:clear:${sessionId}`);
			},
		},
	};
}

describe("publishing", () => {
	it("exposes a facade at the agreed symbol and withdraws it with the last instance", () => {
		const a = fakeInstance("a");
		const unpublish = registerPiRegistry({
			dbPath: "/p/context.db",
			projectDir: "/w",
			registry: a.registry,
		});
		try {
			expect(__piRegistrySizeForTests()).toBe(1);
			const facade = (globalThis as Record<symbol, unknown>)[KEY] as
				| { transformContext?: unknown }
				| undefined;
			expect(typeof facade?.transformContext).toBe("function");
		} finally {
			unpublish();
		}
		expect(__piRegistrySizeForTests()).toBe(0);
		expect((globalThis as Record<symbol, unknown>)[KEY]).toBeUndefined();
	});
});

describe("serving a bound child", () => {
	it("routes a child's transform, compaction and cleanup to the instance that bound it", async () => {
		const a = fakeInstance("a");
		const b = fakeInstance("b");
		const unpublishA = registerPiRegistry({
			dbPath: "/a/context.db",
			projectDir: "/a",
			registry: a.registry,
		});
		const unpublishB = registerPiRegistry({
			dbPath: "/b/context.db",
			projectDir: "/b",
			registry: b.registry,
		});
		try {
			const facade = (globalThis as Record<symbol, unknown>)[
				KEY
			] as import("./pi-registry").PiMagicContextRegistry;
			facade.bindChild({
				childSessionFile: "/sessions/child-b.jsonl",
				parentSessionFile: "/sessions/root-b.jsonl",
				cwd: "/b",
			});

			const ctx = fakeCtx("ses-child-b", "/sessions/child-b.jsonl");
			expect(
				await facade.transformContext({ messages: [] } as never, ctx as never),
			).toEqual({ messages: [] });
			expect(await facade.compact(ctx as never)).toEqual({ cancel: true });

			expect(b.calls).toEqual(["b:transform", "b:compact"]);
			expect(a.calls).toEqual([]);

			facade.clearSession("ses-child-b");
			expect(b.calls.at(-1)).toBe("b:clear:ses-child-b");
		} finally {
			unpublishA();
			unpublishB();
		}
	});

	it("does not treat an unbound session as a child, even when its header names a parent", async () => {
		const a = fakeInstance("a");
		const b = fakeInstance("b");
		const unpublishA = registerPiRegistry({
			dbPath: "/a/context.db",
			projectDir: "/a",
			registry: a.registry,
		});
		const unpublishB = registerPiRegistry({
			dbPath: "/b/context.db",
			projectDir: "/b",
			registry: b.registry,
		});
		try {
			const facade = (globalThis as Record<symbol, unknown>)[
				KEY
			] as import("./pi-registry").PiMagicContextRegistry;
			// A fork carries `parentSession` in its header but was never bound.
			const forked = fakeCtx("ses-fork", "/sessions/fork.jsonl");
			expect(
				await facade.transformContext(
					{ messages: [] } as never,
					forked as never,
				),
			).toBeUndefined();
			expect(a.calls).toEqual([]);
			expect(b.calls).toEqual([]);
		} finally {
			unpublishA();
			unpublishB();
		}
	});

	it("serves anything it is handed when it is the only instance in the process", async () => {
		const only = fakeInstance("only");
		const unpublish = registerPiRegistry({
			dbPath: "/p/context.db",
			projectDir: "/w",
			registry: only.registry,
		});
		try {
			const facade = (globalThis as Record<symbol, unknown>)[
				KEY
			] as import("./pi-registry").PiMagicContextRegistry;
			expect(
				await facade.transformContext(
					{ messages: [] } as never,
					fakeCtx("ses-anything") as never,
				),
			).toEqual({ messages: [] });
			expect(only.calls).toEqual(["only:transform"]);
		} finally {
			unpublish();
		}
	});

	it("scrubs through every instance, because a prefix scrub is idempotent", () => {
		const a = fakeInstance("a");
		const b = fakeInstance("b");
		const unpublishA = registerPiRegistry({
			dbPath: "/a/context.db",
			projectDir: "/a",
			registry: a.registry,
		});
		const unpublishB = registerPiRegistry({
			dbPath: "/b/context.db",
			projectDir: "/b",
			registry: b.registry,
		});
		try {
			const facade = (globalThis as Record<symbol, unknown>)[
				KEY
			] as import("./pi-registry").PiMagicContextRegistry;
			facade.scrubMessage({ role: "assistant", content: "§4§ hi" });
			expect(a.calls).toEqual(["a:scrub"]);
			expect(b.calls).toEqual(["b:scrub"]);
		} finally {
			unpublishA();
			unpublishB();
		}
	});
});
