/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { applyContextJournalMode } from "./storage-db";
import { __resetMountTableReaderForTests, __setMountTableReaderForTests } from "./wal-filesystem";

const roots: string[] = [];

function fixtureStore(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-journal-mode-"));
    roots.push(root);
    return join(root, "context.db");
}

function modeName(db: Database): string {
    const row = db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
    return String(row.journal_mode ?? Object.values(row)[0]).toLowerCase();
}

function syncName(db: Database): number {
    const row = db.prepare("PRAGMA synchronous").get() as Record<string, unknown>;
    return Number(Object.values(row)[0]);
}

afterEach(() => {
    __resetMountTableReaderForTests();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("context store journal mode", () => {
    describe("#given a store an earlier life left in WAL", () => {
        it("#when any opener runs on a WAL-unsafe filesystem #then the store moves to the rollback journal", () => {
            const dbPath = fixtureStore();
            const legacy = new Database(dbPath);
            legacy.exec("PRAGMA journal_mode=WAL");
            legacy.exec("CREATE TABLE legacy_rows(value TEXT)");
            legacy.exec("INSERT INTO legacy_rows(value) VALUES ('row-0'), ('row-1')");
            closeQuietly(legacy);
            // Closing the last WAL connection checkpoints and removes the -wal,
            // but the file's header stays at write/read version 2 = WAL.
            expect(Array.from(readFileSync(dbPath).subarray(18, 20))).toEqual([2, 2]);
            __setMountTableReaderForTests(() => "/dev/root / virtiofs rw,relatime 0 0\n");

            const db = new Database(dbPath);
            try {
                db.exec("PRAGMA busy_timeout=5000");
                applyContextJournalMode(db, dbPath);

                expect(modeName(db)).toBe("delete");
                // FULL, not NORMAL: NORMAL is corruption-safe only because of WAL.
                expect(syncName(db)).toBe(2);
                expect(existsSync(`${dbPath}-wal`)).toBe(false);
                expect(Array.from(readFileSync(dbPath).subarray(18, 20))).toEqual([1, 1]);
                const rows = db.prepare("SELECT count(*) AS rows FROM legacy_rows").get() as {
                    rows: number;
                };
                expect(rows.rows).toBe(2);
                const integrity = db.prepare("PRAGMA integrity_check").get() as Record<
                    string,
                    unknown
                >;
                expect(Object.values(integrity)[0]).toBe("ok");
            } finally {
                db.close();
            }
        });
    });

    describe("#given a store already on the rollback journal", () => {
        it("#when a second connection runs the same opener #then it does not return the file to WAL", () => {
            const dbPath = fixtureStore();
            __setMountTableReaderForTests(() => "/dev/root / virtiofs rw,relatime 0 0\n");
            const first = new Database(dbPath);
            const second = new Database(dbPath);
            try {
                first.exec("PRAGMA busy_timeout=5000");
                second.exec("PRAGMA busy_timeout=5000");
                applyContextJournalMode(first, dbPath);
                applyContextJournalMode(second, dbPath);

                expect(modeName(second)).toBe("delete");
                expect(existsSync(`${dbPath}-wal`)).toBe(false);

                first.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY)");
                first.exec("INSERT INTO probe(id) VALUES (1)");
                second.exec("INSERT INTO probe(id) VALUES (2)");
                const rows = first.prepare("SELECT count(*) AS rows FROM probe").get() as {
                    rows: number;
                };
                expect(rows.rows).toBe(2);
            } finally {
                first.close();
                second.close();
            }
        });
    });

    describe("#given a filesystem where WAL is safe", () => {
        it("#when any opener runs #then the store keeps WAL and synchronous=NORMAL", () => {
            const dbPath = fixtureStore();
            __setMountTableReaderForTests(() => "/dev/sda1 / ext4 rw,relatime 0 0\n");
            const db = new Database(dbPath);
            try {
                applyContextJournalMode(db, dbPath);
                expect(modeName(db)).toBe("wal");
                expect(syncName(db)).toBe(1);
            } finally {
                db.close();
            }
        });
    });

    describe("#given a read-only inspection of a WAL-unsafe store", () => {
        it("#when it runs #then it does not switch the file's journal mode", () => {
            const dbPath = fixtureStore();
            const writer = new Database(dbPath);
            writer.exec("CREATE TABLE probe(id INTEGER)");
            closeQuietly(writer);
            const bytes = readFileSync(dbPath);
            __setMountTableReaderForTests(() => "/dev/root / virtiofs rw,relatime 0 0\n");

            const reader = new Database(dbPath, { readonly: true });
            try {
                applyContextJournalMode(reader, dbPath, true);
                expect(modeName(reader)).toBe("delete");
                expect(existsSync(`${dbPath}-wal`)).toBe(false);
            } finally {
                reader.close();
            }
            expect(readFileSync(dbPath)).toEqual(bytes);
        });
    });
});
