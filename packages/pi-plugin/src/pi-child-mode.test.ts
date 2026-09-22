/**
 * Bound-child mode — the Magic Context half of wayfinder v2's child contract.
 *
 * What this file protects: a bound child gets the tag sentence and compaction, and
 * NOT the parent-oriented prompt surface. The reduced flag is what the pass consults at
 * the note-nudge and auto-search injection sites, so a regression here would quietly
 * start injecting prompts into delegated sessions whose tasks never asked for them.
 */
import { describe, expect, it } from "bun:test";
import {
	__clearReducedSessionsForTests,
	CHILD_TAG_SENTENCE,
	CHILD_TOOL_ALLOWLIST,
	ensureChildTagSentence,
	isReducedSession,
	markReducedSession,
	unmarkReducedSession,
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

describe("reduced mode membership (v2 ticket 02/03)", () => {
	it("marks and clears by session id, and ignores empty ids", () => {
		__clearReducedSessionsForTests();
		expect(isReducedSession("child")).toBe(false);
		markReducedSession("child");
		expect(isReducedSession("child")).toBe(true);
		unmarkReducedSession("child");
		expect(isReducedSession("child")).toBe(false);
		markReducedSession(undefined);
		expect(isReducedSession(undefined)).toBe(false);
	});
});

describe("the tag sentence (v2 ticket 05)", () => {
	it("is not injected for a session that is not a bound child", () => {
		__clearReducedSessionsForTests();
		const messages = [{ role: "user", content: "do the thing" }];
		const result = ensureChildTagSentence({ messages }, "root");
		expect(result?.messages[0]?.content).toBe("do the thing");
	});

	it("is appended to the last user message for a bound child", () => {
		__clearReducedSessionsForTests();
		markReducedSession("child");
		const messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "do the thing" },
		];
		const result = ensureChildTagSentence({ messages }, "child");
		expect(result?.messages[0]?.content).toBe("first");
		expect(result?.messages[2]?.content).toBe(
			`do the thing\n\n${CHILD_TAG_SENTENCE}`,
		);
	});

	it("handles array content, and is idempotent", () => {
		__clearReducedSessionsForTests();
		markReducedSession("child");
		const messages = [
			{ role: "user", content: [{ type: "text", text: "do the thing" }] },
		];
		const once = ensureChildTagSentence({ messages }, "child");
		const parts = once?.messages[0]?.content as Array<{ text?: string }>;
		expect(parts.at(-1)?.text).toBe(CHILD_TAG_SENTENCE);

		// A second pass must not add a second copy, however many passes run.
		const twice = ensureChildTagSentence({ messages: once!.messages }, "child");
		expect(twice?.messages[0]?.content).toBe(once?.messages[0]?.content);
	});

	it("leaves a child with no user message alone", () => {
		__clearReducedSessionsForTests();
		markReducedSession("child");
		const messages = [{ role: "assistant", content: "thinking" }];
		const result = ensureChildTagSentence({ messages }, "child");
		expect(result?.messages[0]?.content).toBe("thinking");
	});
});
