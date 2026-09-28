/**
 * The gate that decides whether Magic Context says the todo-list discipline itself (wayfinder ticket 04
 * in zeroqn/pi's `.scratch/one-tool-surface/`).
 *
 * Pi injects a tool's `snippet`/`promptGuidelines` only while it is *active*. Publishing `todowrite` to a
 * cell is what stops it being active, so this asks pi's own active set rather than the publication policy —
 * and the two tests below pin both ends: the gate's rule, and that the wording actually reaches the
 * rendered block.
 */
import { describe, expect, it } from "bun:test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import { isTodoListDisciplineNeeded } from "./index";
import { buildMagicContextBlock } from "./system-prompt";
import { createTestDb } from "./test-utils.test";

const CELL_FORM = 'await tool("todowrite"';

describe("the todo-list discipline gate", () => {
	it("is off while pi still offers the tool", () => {
		expect(
			isTodoListDisciplineNeeded({
				todowriteEnabled: true,
				activeTools: ["python", "todowrite"],
			}),
		).toBe(false);
	});

	it("is on once the surface rule has stripped it", () => {
		expect(
			isTodoListDisciplineNeeded({
				todowriteEnabled: true,
				activeTools: ["python"],
			}),
		).toBe(true);
	});

	it("is off when the tool is disabled, however empty the surface is", () => {
		expect(
			isTodoListDisciplineNeeded({ todowriteEnabled: false, activeTools: [] }),
		).toBe(false);
	});

	it("reaches the rendered block, and only then", () => {
		const db = createTestDb();
		try {
			const disabled = buildMagicContextBlock({
				db,
				cwd: "/todo-discipline-test-w",
				memoryEnabled: true,
				includeGuidance: true,
				todoListCallable: false,
			});
			const published = buildMagicContextBlock({
				db,
				cwd: "/todo-discipline-test-w",
				memoryEnabled: true,
				includeGuidance: true,
				todoListCallable: true,
			});
			expect(disabled).not.toContain(CELL_FORM);
			expect(published).toContain(CELL_FORM);
		} finally {
			closeQuietly(db);
		}
	});
});
