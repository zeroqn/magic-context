/**
 * What a cell reached, read from the `python` result (wayfinder ticket 03 in
 * `.scratch/one-tool-surface/`).
 *
 * A cell's calls leave no trace in the transcript by themselves: pi records one `python` call and its
 * printed output, so a reader that hunts for a block named `ctx_note` finds nothing and concludes the
 * agent never read its notes. Code mode now records what the cell reached on the result's `details`
 * (`cellCalls`), and pi persists the whole message, so this is durable across a later pass and a resume.
 *
 * Only the **tool bridge's** route is resolved here. Code mode records the host function it was asked to
 * call, deliberately without interpreting it (`{host: "tool", args: ["ctx_note", {…}]}`), because the
 * naming belongs to the reader — and the reader here is a *publisher* of that convention: the bridge's
 * single entry point is `await tool("<published name>", …)`, which is the form this package's own
 * generated guideline line teaches.
 */
const BRIDGE_HOST_FN = "tool";

export type CellToolCall = {
	/** The published tool's name — what the cell asked the bridge for. */
	name: string;
	/** The keyword arguments the cell passed, or `{}` when it passed none. */
	params: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The pi tools one message's cell reached through the tool bridge, in call order.
 *
 * Empty for a message that carries no trace, which is every message a cell did not produce — a plain
 * (non-cell) session, another harness, or an older code mode. A reader must therefore treat "no trace"
 * as "no information", exactly as it treats a transcript with no such block.
 */
export function cellToolCalls(message: unknown): CellToolCall[] {
	if (!isRecord(message)) return [];
	const details = message.details;
	if (!isRecord(details)) return [];
	const trace = details.cellCalls;
	if (!Array.isArray(trace)) return [];

	const calls: CellToolCall[] = [];
	for (const record of trace) {
		if (!isRecord(record)) continue;
		if (record.host !== BRIDGE_HOST_FN) continue;
		const args = record.args;
		if (!Array.isArray(args)) continue;
		const name = args[0];
		if (typeof name !== "string" || name.length === 0) continue;
		calls.push({ name, params: isRecord(args[1]) ? args[1] : {} });
	}
	return calls;
}

/**
 * The name a cell's result is **filed** under when the cell ran a reduce, or `undefined` when it did not.
 *
 * The live tagger and the read-session projection both ask this, so a cell's reduction is one thing to
 * Magic Context wherever it is observed: `transcript-pi` (the transform's own tagging pass, which writes
 * the `tags` rows) and `read-session-pi` (the projection the historian and the readers see). Before this
 * existed the rule lived only in the projection — which is why a cell reduce's tag row said `python` in
 * the database while the readers saw `ctx_reduce` (`zeroqn/pi`'s `.scratch/one-tool-surface/` ticket 11).
 *
 * A *filing* name only: the part's own `tool` stays what the transcript says, because the historian, the
 * formatter and the stale-reduce drop read that one and must not be told a cell's printed output was a
 * bare reduce call.
 */
export function cellReduceFilingName(message: unknown): string | undefined {
	return cellToolCalls(message).some((call) => call.name === "ctx_reduce")
		? "ctx_reduce"
		: undefined;
}
