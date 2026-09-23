/**
 * Bound-child mode — the Magic Context half of wayfinder v2's child contract.
 *
 * What this file protects: a bound child gets the tag sentence and compaction, and NOT the
 * parent-oriented prompt surface. The reduced flag is what the pass consults at the note-nudge
 * and auto-search injection sites, so a regression here would quietly start injecting prompts
 * into delegated sessions whose tasks never asked for them.
 *
 * **Amended by `zeroqn/pi`'s `.scratch/child-surface/`.** Membership used to be a second,
 * id-keyed set beside the registry's binding; it is now the binding itself (`isBoundChild` in
 * `pi-registry.ts`), so this file no longer tests a mark that can drift from who is served.
 * The tag sentence also lost the half that advertised the three granted tools: the tool bridge
 * states how a child reaches them, and that advice was actionable only while the shim registered
 * those tools as real Pi tools.
 */
import { describe, expect, it } from "bun:test";
import {
	__clearChildModeForTests,
	CHILD_TAG_SENTENCE,
	CHILD_TOOL_ALLOWLIST,
	ensureChildTagSentence,
	narrowCatalogueForChild,
	shouldLogTagSentence,
} from "./pi-child-mode";

describe("the granted tool allowlist (v2 ticket 02)", () => {
	it("is exactly the three tools, and never the withheld ones", () => {
		expect([...CHILD_TOOL_ALLOWLIST].sort()).toEqual([
			"ctx_expand",
			"ctx_reduce",
			"ctx_search",
		]);
		for (const withheld of [
			"ctx_memory",
			"ctx_note",
			"todowrite",
			"todo_view",
		]) {
			expect(CHILD_TOOL_ALLOWLIST.has(withheld)).toBe(false);
		}
	});
});

describe("the tag sentence's text (child-surface ticket 06)", () => {
	it("explains the tags and names no tool", () => {
		expect(CHILD_TAG_SENTENCE).toContain("tagged with §N§ identifiers");
		// The half that named ctx_reduce/ctx_search/ctx_expand is gone: a child reaches those
		// through the tool bridge, whose own generated line says how, and which does not exist
		// at all in a session with no kernel.
		for (const name of ["ctx_reduce", "ctx_search", "ctx_expand"]) {
			expect(CHILD_TAG_SENTENCE).not.toContain(name);
		}
	});
});

describe("the once-per-child tag diagnostic", () => {
	it("reports once per session and never for a missing id", () => {
		__clearChildModeForTests();
		expect(shouldLogTagSentence("child")).toBe(true);
		expect(shouldLogTagSentence("child")).toBe(false);
		expect(shouldLogTagSentence(undefined)).toBe(false);
		expect(shouldLogTagSentence("")).toBe(false);
	});
});

describe("the tag sentence (v2 ticket 05)", () => {
	it("is not injected for a session that is not a bound child", () => {
		__clearChildModeForTests();
		const messages = [{ role: "user", content: "do the thing" }];
		const result = ensureChildTagSentence({ messages }, false);
		expect(result?.messages[0]?.content).toBe("do the thing");
	});

	it("is appended to the last user message for a bound child", () => {
		__clearChildModeForTests();
		const messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "do the thing" },
		];
		const result = ensureChildTagSentence({ messages }, true);
		expect(result?.messages[0]?.content).toBe("first");
		expect(result?.messages[2]?.content).toBe(
			`do the thing\n\n${CHILD_TAG_SENTENCE}`,
		);
	});

	it("handles array content, and is idempotent", () => {
		__clearChildModeForTests();
		const messages = [
			{ role: "user", content: [{ type: "text", text: "do the thing" }] },
		];
		const once = ensureChildTagSentence({ messages }, true);
		const parts = once?.messages[0]?.content as Array<{ text?: string }>;
		expect(parts.at(-1)?.text).toBe(CHILD_TAG_SENTENCE);

		// A second pass must not add a second copy, however many passes run.
		const twice = ensureChildTagSentence({ messages: once!.messages }, true);
		expect(twice?.messages[0]?.content).toBe(once?.messages[0]?.content);
	});

	it("leaves a child with no user message alone", () => {
		__clearChildModeForTests();
		const messages = [{ role: "assistant", content: "thinking" }];
		const result = ensureChildTagSentence({ messages }, true);
		expect(result?.messages[0]?.content).toBe("thinking");
	});
});

describe("a bound child's catalogue (child-surface ticket 04)", () => {
	const parentLists = [
		["ctx_search", "ctx_memory", "ctx_note", "ctx_expand", "ctx_reduce"],
		["ctx_search", "ctx_expand", "ctx_reduce"],
		["ctx_memory", "ctx_note"],
		[],
	];

	it("is a subset of its parent's for every parent list", () => {
		for (const parent of parentLists) {
			const child = narrowCatalogueForChild(parent, true);
			expect(parent).toEqual(expect.arrayContaining(child));
		}
	});

	it("is the parent's names untouched for a parent session", () => {
		for (const parent of parentLists) {
			expect(narrowCatalogueForChild(parent, false)).toEqual(parent);
		}
	});

	it("keeps only the granted three, and answers nothing when none are granted", () => {
		expect(
			narrowCatalogueForChild(
				["ctx_search", "ctx_memory", "ctx_note", "ctx_expand", "ctx_reduce"],
				true,
			),
		).toEqual(["ctx_search", "ctx_expand", "ctx_reduce"]);
		expect(narrowCatalogueForChild(["ctx_memory", "ctx_note"], true)).toEqual(
			[],
		);
		expect(narrowCatalogueForChild([], true)).toEqual([]);
	});
});
