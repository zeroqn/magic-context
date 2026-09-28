/**
 * A call a cell makes is a call — Magic Context's call-side effects, from either entrance
 * (wayfinder tickets 01/02 in zeroqn/pi's `.scratch/one-tool-surface/`).
 *
 * What these protect: the effects pi's dispatch produces for a tool name — the `todowrite` capture and
 * its `todos_complete` trigger, `ctx_note`'s nudge clearing, `ctx_reduce`'s Channel-1 mark — happen when
 * the *same tool* is reached from a code-mode cell through the tool bridge, where pi emits no event by
 * that name. Before this change the bodies were inlined in the `tool_execution_*` handlers, so a bridged
 * root session silently missed `ctx_note` and `ctx_reduce`; test 2 below is the control that keeps the
 * difference measurable.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	getChannel1NudgeState,
	getPersistedNoteNudge,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import { executePublishedToolCall, observePiToolCallStart } from "./index";
import { registerPiRegistry } from "./pi-registry";
import { createTestDb } from "./test-utils.test";
import {
	__resetTodoSnapshotsForTests,
	getTodoSnapshot,
} from "./tools/todo-view-pi";

beforeEach(() => {
	__resetTodoSnapshotsForTests();
});

function ctxFor(sessionId: string) {
	return {
		cwd: "/observe-test-w",
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
		},
	} as never;
}

/** A definition that records the call, so delegation is observable. */
function recordingTool(
	name: string,
	calls: string[],
	details?: Record<string, unknown>,
): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: { type: "object" },
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			calls.push(`${name}:${JSON.stringify(params)}`);
			return {
				content: [{ type: "text" as const, text: `${name} ok` }],
				details,
			};
		},
	} as unknown as ToolDefinition;
}

function definitionsMap(calls: string[], names: string[]) {
	return new Map<string, ToolDefinition>(
		names.map((name) => [name, recordingTool(name, calls)]),
	);
}

function called(args: {
	db: ReturnType<typeof createTestDb>;
	sessionId: string;
	name: string;
	params?: Record<string, unknown>;
	calls: string[];
	definitions?: Map<string, ToolDefinition>;
	overlay?: { update: (sessionId?: string) => void };
}) {
	return executePublishedToolCall({
		db: args.db,
		name: args.name,
		params: args.params ?? {},
		ctx: ctxFor(args.sessionId),
		definitions: args.definitions ?? definitionsMap(args.calls, [args.name]),
		todowriteEnabled: true,
		todoOverlay: args.overlay,
		compactionOff: false,
	});
}

/** Arm the note nudge the way `commit_detected` does, so there is something to clear. */
function armNoteNudge(db: ReturnType<typeof createTestDb>, sessionId: string) {
	getOrCreateSessionMeta(db, sessionId);
	onNoteTrigger(db, sessionId, "commit_detected");
	expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(true);
}

const ALL_DONE = [
	{ content: "Write it", status: "completed" },
	{ content: "Ship it", status: "completed" },
];
const IN_FLIGHT = [
	{ content: "Write it", status: "completed" },
	{ content: "Ship it", status: "in_progress" },
];

describe("a cell-routed call is observed", () => {
	it("ctx_note from a cell clears an armed note nudge", async () => {
		const db = createTestDb();
		const calls: string[] = [];
		try {
			const sessionId = "ses-cell-ctx-note";
			armNoteNudge(db, sessionId);

			const result = await called({
				db,
				sessionId,
				name: "ctx_note",
				params: { action: "write", content: "note" },
				calls,
			});

			// The tool ran, and the effect the dispatch route would have produced landed.
			expect(calls).toHaveLength(1);
			expect((result as { content: { text: string }[] }).content[0].text).toBe(
				"ctx_note ok",
			);
			expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});

	it("control: the tool's own execute leaves the nudge armed", async () => {
		// Exactly what the bridge did before this change: the definition, run directly, no observer.
		// If this ever stops holding, the test above proves nothing.
		const db = createTestDb();
		const calls: string[] = [];
		try {
			const sessionId = "ses-cell-ctx-note-control";
			armNoteNudge(db, sessionId);
			const definition = recordingTool("ctx_note", calls);

			await definition.execute(
				"direct",
				{ action: "write" },
				undefined,
				undefined,
				undefined,
			);

			expect(calls).toHaveLength(1);
			expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("todowrite from a cell captures the state and fires todos_complete", async () => {
		const db = createTestDb();
		const calls: string[] = [];
		try {
			const sessionId = "ses-cell-todo-done";
			getOrCreateSessionMeta(db, sessionId);

			await called({
				db,
				sessionId,
				name: "todowrite",
				params: { todos: ALL_DONE },
				calls,
			});

			expect(calls).toHaveLength(1);
			expect(getOrCreateSessionMeta(db, sessionId).lastTodoState).toContain(
				"Ship it",
			);
			expect(getTodoSnapshot(sessionId).todos).toHaveLength(2);
			expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("todowrite from a cell with work in flight captures but does not trigger", async () => {
		const db = createTestDb();
		const calls: string[] = [];
		try {
			const sessionId = "ses-cell-todo-inflight";
			getOrCreateSessionMeta(db, sessionId);

			await called({
				db,
				sessionId,
				name: "todowrite",
				params: { todos: IN_FLIGHT },
				calls,
			});

			expect(getOrCreateSessionMeta(db, sessionId).lastTodoState).toContain(
				"in_progress",
			);
			expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});

	it("both entry points land the same state for the same payload", async () => {
		const db = createTestDb();
		const calls: string[] = [];
		try {
			// The dispatch route: pi's `tool_execution_start` handler hands the observer its event,
			// including the `toolCallId` pi minted for the component it renders.
			const dispatchSession = "ses-dispatch-todo";
			observePiToolCallStart({
				db,
				sessionId: dispatchSession,
				name: "todowrite",
				args: { todos: ALL_DONE },
				toolCallId: "call-from-pi",
				todowriteEnabled: true,
				todoOverlay: undefined,
				compactionOff: false,
			});
			// The cell route: no component, so no `toolCallId` to key the render cache on.
			const cellSession = "ses-cell-todo-same";
			await called({
				db,
				sessionId: cellSession,
				name: "todowrite",
				params: { todos: ALL_DONE },
				calls,
			});

			const dispatchState = getOrCreateSessionMeta(
				db,
				dispatchSession,
			).lastTodoState;
			const cellState = getOrCreateSessionMeta(db, cellSession).lastTodoState;
			expect(dispatchState).not.toBe("");
			expect(cellState).toBe(dispatchState);
			expect(getTodoSnapshot(cellSession).todos).toEqual(
				getTodoSnapshot(dispatchSession).todos,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("ctx_reduce from a cell marks the reduction", async () => {
		const db = createTestDb();
		const calls: string[] = [];
		try {
			const sessionId = "ses-cell-reduce";
			await called({ db, sessionId, name: "ctx_reduce", calls });
			expect(getChannel1NudgeState(db, sessionId).postReduceGracePending).toBe(
				true,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("compaction-off mode marks no reduction", async () => {
		const db = createTestDb();
		const calls: string[] = [];
		try {
			const sessionId = "ses-cell-reduce-off";
			await executePublishedToolCall({
				db,
				name: "ctx_reduce",
				params: {},
				ctx: ctxFor(sessionId),
				definitions: definitionsMap(calls, ["ctx_reduce"]),
				todowriteEnabled: true,
				compactionOff: true,
			});
			// The empty state leaves this `undefined` rather than `false`, so the claim is
			// "the mark did not land", not "the flag is false".
			expect(
				Boolean(getChannel1NudgeState(db, sessionId).postReduceGracePending),
			).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});

	it("a bound child's call lands its own state and leaves the root's overlay alone", async () => {
		const db = createTestDb();
		const calls: string[] = [];
		const childSession = "ses-cell-child-todo";
		const rootSession = "ses-cell-root-todo";
		const unregister = registerPiRegistry({
			dbPath: "/p/observe-test.db",
			projectDir: "/observe-test-w",
			registry: {
				transformContext: async () => undefined,
				compact: async () => undefined,
				scrubMessage: () => undefined,
				bindChild: () => undefined,
				clearSession: () => undefined,
			},
		});
		try {
			const facade = (globalThis as Record<symbol, unknown>)[
				Symbol.for("@cortexkit/magic-context:pi-registry")
			] as { bindChild(input: Record<string, unknown>): void };
			facade.bindChild({
				childSessionFile: `/sessions/${childSession}.jsonl`,
				childSessionId: childSession,
				cwd: "/observe-test-w",
			});

			const overlayUpdates: string[] = [];
			const overlay = {
				update: (sessionId?: string) => {
					overlayUpdates.push(sessionId ?? "<none>");
				},
			};

			await called({
				db,
				sessionId: childSession,
				name: "todowrite",
				params: { todos: ALL_DONE },
				calls,
				overlay,
			});
			expect(overlayUpdates).toEqual([]);
			expect(getOrCreateSessionMeta(db, childSession).lastTodoState).not.toBe(
				"",
			);

			await called({
				db,
				sessionId: rootSession,
				name: "todowrite",
				params: { todos: ALL_DONE },
				calls,
				overlay,
			});
			expect(overlayUpdates).toEqual([rootSession]);
		} finally {
			unregister();
			closeQuietly(db);
		}
	});

	it("a name this instance does not hold is answered, not thrown", async () => {
		const db = createTestDb();
		try {
			const result = await executePublishedToolCall({
				db,
				name: "ctx_absent",
				params: {},
				ctx: ctxFor("ses-cell-absent"),
				definitions: new Map(),
				todowriteEnabled: true,
				compactionOff: false,
			});
			expect(
				(result as { content: { text: string }[] }).content[0].text,
			).toContain("not available in this session");
		} finally {
			closeQuietly(db);
		}
	});
});
