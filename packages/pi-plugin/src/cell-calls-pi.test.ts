/**
 * Reading a cell's trace (wayfinder ticket 03 in zeroqn/pi's `.scratch/one-tool-surface/`).
 *
 * The trace is code mode's, the interpretation is this package's: code mode records the host function it
 * was asked to call without naming what that call meant, because the bridge's route
 * (`tool("<published name>", …)`) is this package's own convention — its generated guideline line is
 * where the model is taught to write it.
 */
import { describe, expect, it } from "bun:test";

import { cellToolCalls } from "./cell-calls-pi";

function result(details: unknown) {
	return { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "out" }], details };
}

describe("cellToolCalls", () => {
	it("resolves the bridge's route, in call order, and nothing else", () => {
		expect(
			cellToolCalls(
				result({
					cellCalls: [
						{ host: "tool", args: ["ctx_note", { action: "read" }] },
						{ host: "zvec_grep_rg", args: ["needle"] },
						{ host: "tool", args: ["ctx_reduce", { drop: "3-5" }] },
					],
				}),
			),
		).toEqual([
			{ name: "ctx_note", params: { action: "read" } },
			{ name: "ctx_reduce", params: { drop: "3-5" } },
		]);
	});

	it("answers a call with no params with an empty object, not undefined", () => {
		expect(cellToolCalls(result({ cellCalls: [{ host: "tool", args: ["ctx_expand"] }] }))).toEqual([
			{ name: "ctx_expand", params: {} },
		]);
	});

	it("treats anything else as no information", () => {
		expect(cellToolCalls(undefined)).toEqual([]);
		expect(cellToolCalls({ role: "toolResult" })).toEqual([]);
		expect(cellToolCalls(result({}))).toEqual([]);
		expect(cellToolCalls(result({ cellCalls: "nonsense" }))).toEqual([]);
		expect(cellToolCalls(result({ cellCalls: [null, 7, { host: "tool" }, { host: "tool", args: [] }] }))).toEqual([]);
		// A record whose first argument is not a name is not a bridge call.
		expect(cellToolCalls(result({ cellCalls: [{ host: "tool", args: [{}, {}] }] }))).toEqual([]);
	});
});
