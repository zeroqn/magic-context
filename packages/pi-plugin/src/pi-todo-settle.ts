/**
 * The run's final boundary: does the todo list need one more write?
 *
 * # Why this exists
 *
 * The overlay's only writer is a captured `todowrite` call (see `applyCompatiblePiTodoCapture`), and a
 * non-terminal row never expires — so a list whose last write left items `pending`/`in_progress` stays
 * on screen, looking like work in flight, long after the work ended. Measured on session `01a1421a`
 * (2026-10-16, `.scratch/todo-desync/TARBALL-01a1421a.md`): two writes in 10h44m over 294 cells, with
 * the list's items actually completed by four child sessions and eleven background jobs between the
 * second write and the end of the run. The root's own cadence rule says *call it as each step changes
 * state*, and a **child's** completion reads to the model as somebody else's step — precisely the gap.
 *
 * # What it does
 *
 * At pi's `agent_before_settle` — the last actionable boundary of a run, once per run, where pi will
 * commit appended entries and run exactly one more provider request — this decides whether to append a
 * single line telling the owner to reconcile its list, and (if so) asks for that continuation. The
 * model closes its own list in the same run; a second write from here would be a second writer on a
 * surface that is a *declaration*, and this module never touches the list itself.
 *
 * # The four conditions, and why each is needed
 *
 *  - `outcome === "completed"`: an aborted or failed run is not a run whose report should be complete,
 *    and pi cannot honour a continuation from one.
 *  - **open items remain**: nothing to reconcile otherwise (a fully terminal list retires itself).
 *  - **nothing is live**: `pi-host-bridge:live-work` is zero. This is the clause that keeps the line
 *    from becoming noise mid-delegation — in the session above the run settled a dozen times with
 *    children in flight (06:01), and exactly once with everything drained and the list still wrong
 *    (07:41). A reader with no answer at all (no host-bridge in this process) proceeds: a session with
 *    no children and no background jobs is the case this exists for.
 *  - **the list was not the run's last word**: the run wrote a list at some point *and* did nothing
 *    after it. A run that writes and then ends has said what it knows, even with items open — it may
 *    legitimately be waiting on the user — while a run that writes and then works on (two cells, a
 *    child, a build) may have outrun its own list, which is the whole failure. So: no capture at all
 *    this run proceeds, and a capture followed by any tool call proceeds; only write-then-end is
 *    skipped.
 *
 * One nudge per *list state*: the digest of what the list said when it fired is remembered, so a model
 * that ignores the line is not asked again until the list itself changes. That bound is what makes the
 * continuation safe — pi's boundary can request one more request per run, and this is the guard that
 * stops "one" from becoming an unbounded chain.
 */
import { createHash } from "node:crypto";

/**
 * Where host-bridge publishes "is anything still running in this session?".
 *
 * A documented literal, not an import: magic-context must neither depend on that package nor require it
 * to be installed. Absent (or answering `null`) means *unknown*, and unknown proceeds.
 */
const LIVE_WORK_SYMBOL = Symbol.for("pi-host-bridge:live-work");

/** What host-bridge publishes: `{count, names}`, or `null` for a session it holds no answer for. */
export type LiveWorkAnswer = { count: number; names: string[] };

/** Sessions that captured a compatible `todowrite` payload in the run now under way. */
const wroteThisRun = new Set<string>();

/**
 * Sessions that did *any* other tool call after that capture — the fact that says the list may no longer
 * describe the work. A cell counts: it is one `python` call on the dispatch route, and the work a list
 * item describes is usually cells.
 */
const workedSinceWrite = new Set<string>();

/** `todowrite` is the one call that is not "work": it is the list talking about itself. */
const TODO_TOOL_NAME = "todowrite";

/**
 * The list each session has already been nudged about, by digest of its own `content`+`status` pairs.
 * Kept until the list changes or the session ends (see the module comment).
 */
const nudgedForDigest = new Map<string, string>();

/** Called by the capture, on both call routes, when a payload matched the todo contract exactly. */
export function noteTodoWrite(sessionId: string): void {
	if (!sessionId) return;
	wroteThisRun.add(sessionId);
	// The list is current *at this moment*: whether that survives the rest of the run is what
	// `noteToolCall` records.
	workedSinceWrite.delete(sessionId);
}

/**
 * Called for every tool call this session makes, on either route — the cell's `python`, a spawned
 * child's whole turn is not a tool call here, but the `rlm_spawn`/`rlm_wait` around it is one.
 */
export function noteToolCall(sessionId: string, name: string): void {
	if (!sessionId) return;
	if (name === TODO_TOOL_NAME) return;
	workedSinceWrite.add(sessionId);
}

/** Called at `agent_start`: the run boundary is what "this run" is measured against. */
export function noteRunStart(sessionId: string): void {
	if (!sessionId) return;
	wroteThisRun.delete(sessionId);
	workedSinceWrite.delete(sessionId);
}

/** Called when the session goes away, so a resumed session's state does not leak into the next one. */
export function forgetTodoSettleState(sessionId: string): void {
	wroteThisRun.delete(sessionId);
	workedSinceWrite.delete(sessionId);
	nudgedForDigest.delete(sessionId);
}

/** Test seam. */
export function __resetTodoSettleForTests(): void {
	wroteThisRun.clear();
	workedSinceWrite.clear();
	nudgedForDigest.clear();
}

/**
 * The live-work answer for this session, read from the symbol at call time — never captured, because the
 * publisher may load after this module does (and a child's instance republishes it).
 */
export function readLiveWork(ctx: unknown): LiveWorkAnswer | null {
	const reader = (globalThis as Record<symbol, unknown>)[LIVE_WORK_SYMBOL];
	if (typeof reader !== "function") return null;
	try {
		const answer = (reader as (ctx: unknown) => unknown)(ctx);
		if (!answer || typeof answer !== "object") return null;
		const count = Number((answer as { count?: unknown }).count);
		if (!Number.isFinite(count) || count < 0) return null;
		const names = (answer as { names?: unknown }).names;
		return {
			count: Math.trunc(count),
			names: Array.isArray(names)
				? names.filter((name) => typeof name === "string")
				: [],
		};
	} catch {
		// A reader asking between runs must never be able to fail a session.
		return null;
	}
}

/**
 * `agent_before_settle`'s event, as much of it as this module reads.
 *
 * The event postdates the pi types this package builds against (pi 0.83/0.86/0.87 in
 * `devDependencies`; the boundary is in pi 1.2's own `core/extensions/types.d.ts`), so it is declared
 * structurally here and the handler is registered through a narrow view of `pi.on` — a host that does
 * not fire the event simply never calls it, which is the degradation this feature wants.
 */
export type TodoSettleEvent = {
	/** What pi's other boundary handlers drafted so far; a returned array replaces it (see the handler). */
	entries?: unknown[];
	/** pi's `AgentActivityOutcome` for the run that is settling. */
	outcome?: string;
};

/** The one boundary event this feature rides, spelled once. */
export const TODO_SETTLE_EVENT = "agent_before_settle";

/** The `on` this module needs; `ExtensionAPI.on` is a closed set of literal overloads. */
export type SettleSurface = {
	on(
		event: string,
		handler: (event: TodoSettleEvent, ctx: unknown) => unknown,
	): void;
};

export type TodoSettleInput = {
	sessionId: string;
	/** pi's `AgentActivityOutcome` for the run that is settling. */
	outcome: string | undefined;
	/** The session's current list. */
	todos: ReadonlyArray<{ content?: unknown; status?: unknown }>;
	/** `readLiveWork(ctx)` — `null` when this process cannot say. */
	liveWork: LiveWorkAnswer | null;
};

export type TodoSettleDecision =
	| { nudge: false }
	| { nudge: true; text: string };

/** `pending` and `in_progress` are the two states a reader would take for work in flight. */
function isOpen(status: unknown): boolean {
	return status === "pending" || status === "in_progress";
}

function digestOf(todos: TodoSettleInput["todos"]): string {
	const shape = JSON.stringify(
		todos.map((todo) => [
			String(todo.content ?? ""),
			String(todo.status ?? ""),
		]),
	);
	return createHash("sha256").update(shape).digest("hex").slice(0, 16);
}

export function decideTodoSettle(input: TodoSettleInput): TodoSettleDecision {
	if (input.outcome !== "completed") return { nudge: false };
	if (!input.sessionId) return { nudge: false };
	// The list was the run's last word: written, and nothing done since. Nothing to reconcile.
	if (wroteThisRun.has(input.sessionId) && !workedSinceWrite.has(input.sessionId)) {
		return { nudge: false };
	}

	const open = input.todos.filter((todo) => isOpen(todo.status));
	if (open.length === 0) return { nudge: false };

	if (input.liveWork !== null && input.liveWork.count > 0)
		return { nudge: false };

	const digest = digestOf(input.todos);
	if (nudgedForDigest.get(input.sessionId) === digest) return { nudge: false };
	nudgedForDigest.set(input.sessionId, digest);

	return { nudge: true, text: nudgeText(input.todos, open.length) };
}

/**
 * The line the owner reads. It states three facts — what the list still says, that the run is over, and
 * that nothing is running — and then the two honest ways to answer it: the work is done (write the list
 * with those items terminal) or it is not (write it as it stands and say what is next). It never asks
 * for a specific item to be marked, because only the owner knows whether an item is verified.
 */
export function nudgeText(
	todos: TodoSettleInput["todos"],
	openCount: number,
): string {
	const completed = todos.filter((todo) => todo.status === "completed").length;
	const cancelled = todos.filter((todo) => todo.status === "cancelled").length;
	const plural = openCount === 1 ? "item" : "items";
	return (
		`[magic-context] This run ended with the task list still open: ${openCount} ${plural} not finished ` +
		`(${completed} completed, ${cancelled} cancelled of ${todos.length}), and nothing is running any more. ` +
		`The list is what the reader sees after the run, so reconcile it once more: if that work is done, ` +
		`write the list with those ${plural} completed (or cancelled); if it genuinely continues, write it ` +
		`as it stands.`
	);
}
