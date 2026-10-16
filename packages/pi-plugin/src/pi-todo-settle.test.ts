/**
 * The run-boundary nudge's decision (`pi-todo-settle.ts`), which is where all of its guards live.
 *
 * Every case here is a false positive the line would otherwise become: a run that was aborted, a run
 * whose last word was the list itself (the model may legitimately be waiting on the user), a list
 * already terminal, a session with work still in flight, and a list this process has already asked
 * about. The positive cases are the failure measured in `.scratch/todo-desync/TARBALL-01a1421a.md` — a
 * run that ended `completed` with children that had finished their items and nothing left running —
 * and its near neighbour: a run that wrote its list and then worked on past it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
	__resetTodoSettleForTests,
	decideTodoSettle,
	forgetTodoSettleState,
	type LiveWorkAnswer,
	noteRunStart,
	noteTodoWrite,
	noteToolCall,
	nudgeText,
	readLiveWork,
} from "./pi-todo-settle";

const LIVE_WORK_SYMBOL = Symbol.for("pi-host-bridge:live-work");

function todos(shape: Array<[string, string]>) {
	return shape.map(([content, status]) => ({ content, status }));
}

const OPEN = todos([
	["Read the release notes", "completed"],
	["Rebuild the firmware", "in_progress"],
	["Publish the assets", "pending"],
]);

function decide(
	overrides: Partial<Parameters<typeof decideTodoSettle>[0]> = {},
) {
	return decideTodoSettle({
		sessionId: "ses-1",
		outcome: "completed",
		todos: OPEN,
		liveWork: { count: 0, names: [] },
		...overrides,
	});
}

beforeEach(() => {
	__resetTodoSettleForTests();
	delete (globalThis as Record<symbol, unknown>)[LIVE_WORK_SYMBOL];
});

describe("deciding to nudge at the run boundary", () => {
	it("nudges when the run completed, the list has open items, and nothing is running", () => {
		const decision = decide();
		expect(decision.nudge).toBe(true);
		if (!decision.nudge) throw new Error("expected a nudge");
		expect(decision.text).toContain("2 items not finished");
		expect(decision.text).toContain("nothing is running any more");
	});

	it("does not nudge a run that was aborted or failed", () => {
		expect(decide({ outcome: "aborted" }).nudge).toBe(false);
		expect(decide({ outcome: "error" }).nudge).toBe(false);
		expect(decide({ outcome: undefined }).nudge).toBe(false);
	});

	it("does not nudge a run whose last word was the list itself", () => {
		// Written and then ended: the model has just said what it knows, open items and all — it may
		// legitimately be waiting on the user, and it is not claiming work that finished.
		noteTodoWrite("ses-1");
		expect(decide().nudge).toBe(false);
		// The next run is a new question, with nothing written in it.
		noteRunStart("ses-1");
		expect(decide().nudge).toBe(true);
	});

	it("nudges when work happened after the write — the run outran its own list", () => {
		noteTodoWrite("ses-1");
		noteToolCall("ses-1", "python");
		expect(decide().nudge).toBe(true);
	});

	it("does not count todowrite itself as work", () => {
		noteToolCall("ses-1", "todowrite");
		expect(decide().nudge).toBe(true); // no capture followed, so nothing was written either
		noteTodoWrite("ses-1");
		expect(decide().nudge).toBe(false); // and a capture with no work after it is still not work
	});

	it("does not nudge a list with nothing open", () => {
		const closed = todos([
			["One", "completed"],
			["Two", "cancelled"],
		]);
		expect(decide({ todos: closed }).nudge).toBe(false);
	});

	it("does not nudge while anything is still running — the mid-delegation case", () => {
		expect(
			decide({ liveWork: { count: 2, names: ["child-2", "bg-7"] } }).nudge,
		).toBe(false);
	});

	it("proceeds when no live-work answer exists at all (no host bridge in this process)", () => {
		expect(decide({ liveWork: null }).nudge).toBe(true);
	});

	it("asks once per list state, and again only when the list changes", () => {
		expect(decide().nudge).toBe(true);
		expect(decide().nudge).toBe(false);
		// The model ignored the line; a later run with the same list stays quiet.
		noteRunStart("ses-1");
		expect(decide().nudge).toBe(false);
		// A different list is a different question.
		const moved = todos([
			["Rebuild the firmware", "completed"],
			["Publish the assets", "in_progress"],
		]);
		expect(decide({ todos: moved }).nudge).toBe(true);
	});

	it("is per session", () => {
		expect(decide().nudge).toBe(true);
		expect(decide({ sessionId: "ses-2" }).nudge).toBe(true);
	});

	it("forgets both facts when the session goes away", () => {
		noteTodoWrite("ses-1");
		expect(decide().nudge).toBe(false); // the write excuses this run
		forgetTodoSettleState("ses-1");
		expect(decide().nudge).toBe(true); // a fresh session's state asks the question again
		expect(decide().nudge).toBe(false); // and the once-per-list bound still holds
	});
});

describe("the line itself", () => {
	it("counts every state it names, and asks for a reconciliation rather than a specific status", () => {
		const text = nudgeText(OPEN, 2);
		expect(text).toContain("This run ended with the task list still open");
		expect(text).toContain("1 completed, 0 cancelled of 3");
		expect(text).toContain("if that work is done");
		// It must never tell the model to mark something completed: only the owner knows that.
		expect(text).not.toContain("mark");
	});

	it("says 'item' for one", () => {
		expect(nudgeText(OPEN, 1)).toContain("1 item not finished");
	});
});

describe("reading the published live-work answer", () => {
	it("is absent, so unknown, when nothing published one", () => {
		expect(readLiveWork({})).toBeNull();
	});

	it("reads the answer for the ctx it is handed", () => {
		const answers = new Map<string, LiveWorkAnswer>([
			["/tmp/sessions/a.jsonl", { count: 1, names: ["child-1"] }],
		]);
		(globalThis as Record<symbol, unknown>)[LIVE_WORK_SYMBOL] = (
			ctx: unknown,
		) =>
			answers.get(
				(
					ctx as { sessionManager: { getSessionFile: () => string } }
				).sessionManager.getSessionFile(),
			) ?? null;
		const ctx = {
			sessionManager: { getSessionFile: () => "/tmp/sessions/a.jsonl" },
		};
		expect(readLiveWork(ctx)).toEqual({ count: 1, names: ["child-1"] });
		expect(
			readLiveWork({
				sessionManager: { getSessionFile: () => "/tmp/sessions/b.jsonl" },
			}),
		).toBeNull();
	});

	it("treats a throwing or malformed reader as unknown rather than failing a run", () => {
		(globalThis as Record<symbol, unknown>)[LIVE_WORK_SYMBOL] = () => {
			throw new Error("the manager is gone");
		};
		expect(readLiveWork({})).toBeNull();

		(globalThis as Record<symbol, unknown>)[LIVE_WORK_SYMBOL] = () => ({
			count: "many",
			names: 7,
		});
		expect(readLiveWork({})).toBeNull();

		(globalThis as Record<symbol, unknown>)[LIVE_WORK_SYMBOL] = () => ({
			count: 2,
			names: ["ok", 7],
		});
		expect(readLiveWork({})).toEqual({ count: 2, names: ["ok"] });
	});
});
