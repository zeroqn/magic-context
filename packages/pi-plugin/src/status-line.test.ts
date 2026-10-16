import { afterEach, describe, expect, it } from "bun:test";
import type { EmbeddingConfig } from "@magic-context/core/config/schema/magic-context";
import {
	_resetProjectEmbeddingRegistryForTests,
	registerProjectEmbedding,
} from "@magic-context/core/features/magic-context/project-embedding-registry";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { registerStatusLine, renderStatusText, resolveOnnxRuntimeStatus } from "./status-line";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";

const FEATURES = { memoryEnabled: true, gitCommitEnabled: false };

function usageContext(sessionId: string) {
	return {
		...fakeContext(sessionId),
		model: {
			provider: "anthropic",
			id: "claude",
			contextWindow: 100_000,
			maxTokens: 20_000,
		},
		getContextUsage: () => ({
			tokens: 50_000,
			percent: 50,
			contextWindow: 100_000,
		}),
	};
}

describe("Pi footer status", () => {
	it("reports percentage against the scheduler usable window", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-usable";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 50_000,
					percent: 50,
					contextWindow: 100_000,
				}),
			};

			const text = renderStatusText(ctx as never, db, sessionId);

			expect(text).toContain("mc: 50K (63%)");
			expect(text).not.toContain("(50%)");
		} finally {
			closeQuietly(db);
		}
	});

	it("preserves valid zero-valued usage fields", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-zero";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 0,
					percent: 0,
					contextWindow: 100_000,
				}),
			};

			const text = renderStatusText(ctx as never, db, sessionId);

			expect(text).toContain("mc: 0 (0%)");
			expect(text).not.toContain("--");
		} finally {
			closeQuietly(db);
		}
	});

	it("names the local ONNX runtime that config and host resolved", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-onnx";
			const text = renderStatusText(usageContext(sessionId) as never, db, sessionId, {
				preference: "auto",
				loaded: [],
			});

			expect(text).toContain("mc: 50K (63%)");
			expect(text).toMatch(/ · onnx auto→(native|wasm)$/);
		} finally {
			closeQuietly(db);
		}
	});

	it("shows the runtime that loaded when it differs from the preference", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-onnx-loaded";
			const text = renderStatusText(usageContext(sessionId) as never, db, sessionId, {
				preference: "native",
				loaded: ["wasm"],
			});

			expect(text).toContain("onnx native→wasm");
		} finally {
			closeQuietly(db);
		}
	});

	it("reads one value per loaded provider", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-onnx-mixed";
			const text = renderStatusText(usageContext(sessionId) as never, db, sessionId, {
				preference: "auto",
				loaded: ["wasm", "native", "wasm"],
			});

			expect(text).toContain("onnx auto→native+wasm");
		} finally {
			closeQuietly(db);
		}
	});

	it("omits the runtime segment when no local runtime is in play", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-no-onnx";
			const text = renderStatusText(usageContext(sessionId) as never, db, sessionId);

			expect(text).not.toContain("onnx");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi footer ONNX runtime lookup", () => {
	afterEach(() => {
		_resetProjectEmbeddingRegistryForTests();
	});

	function register(
		db: ReturnType<typeof createTestDb>,
		identity: string,
		config: EmbeddingConfig,
	): void {
		registerProjectEmbedding(db, identity, config, FEATURES, "/tmp/pi-onnx");
	}

	it("carries the configured preference of a registered local project", () => {
		const db = createTestDb();
		try {
			register(db, "pi-onnx-wasm", {
				provider: "local",
				model: "fake-embedding-model",
				local_runtime: "wasm",
			});

			expect(resolveOnnxRuntimeStatus("pi-onnx-wasm")).toMatchObject({
				preference: "wasm",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("defaults an unset local preference to auto", () => {
		const db = createTestDb();
		try {
			register(db, "pi-onnx-auto", { provider: "local", model: "fake-embedding-model" });

			expect(resolveOnnxRuntimeStatus("pi-onnx-auto")).toMatchObject({
				preference: "auto",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("reaches the footer line once the project is registered", async () => {
		const db = createTestDb();
		try {
			const projectIdentity = "pi-onnx-footer";
			register(db, projectIdentity, {
				provider: "local",
				model: "fake-embedding-model",
				local_runtime: "wasm",
			});
			const fake = createFakePi();
			registerStatusLine(fake.pi as never, { db, projectIdentity });
			const statuses: Array<string | undefined> = [];
			const ctx = {
				...usageContext("ses-footer-wired"),
				ui: {
					notify: () => undefined,
					setStatus: (_key: string, text?: string) => {
						statuses.push(text);
					},
				},
			};
			const onSessionStart = fake.handlers.get("session_start") as (
				event: unknown,
				ctx: unknown,
			) => Promise<void>;

			await onSessionStart({}, ctx);

			expect(statuses.at(-1)).toContain("onnx wasm→");
		} finally {
			closeQuietly(db);
		}
	});

	it("has no runtime to name for a remote provider or an unregistered project", () => {
		const db = createTestDb();
		try {
			register(db, "pi-onnx-remote", {
				provider: "openai-compatible",
				model: "fake-embedding-model",
				endpoint: "http://127.0.0.1:9/v1",
			});

			expect(resolveOnnxRuntimeStatus("pi-onnx-remote")).toBeNull();
			expect(resolveOnnxRuntimeStatus("pi-onnx-absent")).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});
});
