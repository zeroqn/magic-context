import { describe, expect, it } from "bun:test";
import { hasVisibleNoteReadCallPi } from "./note-visibility-pi";

describe("hasVisibleNoteReadCallPi", () => {
	it("returns true when an assistant has a ctx_note(action='read') tool call", () => {
		const messages = [
			{ role: "user", content: "Hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Reading notes..." },
					{
						type: "toolCall",
						id: "call_1",
						name: "ctx_note",
						arguments: { action: "read" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(true);
	});

	it("returns false when ctx_note action is not 'read'", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "ctx_note",
						arguments: { action: "write", content: "save this" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(false);
	});

	it("returns false when no ctx_note call is present", () => {
		const messages = [
			{ role: "user", content: "Hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Hello" },
					{
						type: "toolCall",
						id: "call_1",
						name: "ctx_search",
						arguments: { query: "anything" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(false);
	});

	it("returns true if any assistant in the array has a visible read", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_old",
						name: "ctx_note",
						arguments: { action: "read" },
					},
				],
			},
			{ role: "user", content: "follow-up" },
			{
				role: "assistant",
				content: [{ type: "text", text: "no tool here" }],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(true);
	});

	it("returns false for a sentinel-stripped ctx_note read", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "[dropped]" }],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(false);
	});

	it("returns false on empty array", () => {
		expect(hasVisibleNoteReadCallPi([])).toBe(false);
	});

	it("ignores user messages even if they contain a toolCall-shaped object", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "toolCall",
						name: "ctx_note",
						arguments: { action: "read" },
					},
				],
			},
		];
		expect(hasVisibleNoteReadCallPi(messages)).toBe(false);
	});
});

describe("hasVisibleNoteReadCallPi, for a call a cell made", () => {
	const trace = (args: unknown[]) => ({
		role: "toolResult",
		toolCallId: "call_python",
		content: [{ type: "text", text: "notes: []" }],
		details: { cellCalls: [{ host: "tool", args }] },
	});

	it("sees a cell-routed read through the result that carried it", () => {
		expect(
			hasVisibleNoteReadCallPi([
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: [{ type: "text", text: "reading" }] },
				trace(["ctx_note", { action: "read" }]),
			]),
		).toBe(true);
	});

	it("does not count a write, or another capability, or a trace-less result", () => {
		expect(
			hasVisibleNoteReadCallPi([trace(["ctx_note", { action: "write", content: "x" }])]),
		).toBe(false);
		expect(hasVisibleNoteReadCallPi([trace(["ctx_search", { query: "x" }])])).toBe(false);
		// An older code mode records nothing, and "no trace" must mean "no information".
		expect(
			hasVisibleNoteReadCallPi([
				{ role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "out" }] },
			]),
		).toBe(false);
	});

	it("returns true when the read was a keyword-less positional call, as monty delivers it", () => {
		// `tool("ctx_note", {"action": "read"})` arrives as a trailing object, the same way
		// `tool("ctx_note", action="read")` does — the bridge's own note (adapter.ts:305-307).
		expect(hasVisibleNoteReadCallPi([trace(["ctx_note", { action: "read" }])])).toBe(true);
	});
});
