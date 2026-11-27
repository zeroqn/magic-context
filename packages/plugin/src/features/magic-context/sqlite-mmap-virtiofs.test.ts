/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    __resetMmapSkipReportForTests,
    applySqliteTuningPragmas,
    initializeDatabase,
    setSqlitePragmaConfig,
} from "./storage-db";
import { __resetMountTableReaderForTests, __setMountTableReaderForTests } from "./wal-filesystem";

// `sqlite.mmap_size_mb` maps the database file into the process. That needs the file to
// behave like local memory, which is the same assumption `applyContextJournalMode` refuses
// on a virtiofs mount — so the two decisions must agree, including on the re-apply after
// config load and after a config change mid-session.

const roots: string[] = [];
const VIRTIOFS = "/dev/root / virtiofs rw,relatime 0 0\n";
const BTRFS = "/dev/vdb /workspace btrfs rw 0 0\n";

function fixtureStore(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-mmap-"));
    roots.push(root);
    return join(root, "context.db");
}

function pragma(db: Database, name: string): number {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
    return Number(Object.values(row)[0]);
}

function open(path: string): Database {
    const db = new Database(path);
    db.exec("PRAGMA busy_timeout=5000");
    return db;
}

afterEach(() => {
    __resetMountTableReaderForTests();
    __resetMmapSkipReportForTests();
    setSqlitePragmaConfig({ cacheSizeMb: 64, mmapSizeMb: 0 });
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sqlite tuning pragmas", () => {
    describe("#given sqlite.mmap_size_mb is set", () => {
        it("#when the store is on a WAL-safe mount #then the mapping is configured", () => {
            const dbPath = fixtureStore();
            __setMountTableReaderForTests(() => BTRFS);
            setSqlitePragmaConfig({ cacheSizeMb: 32, mmapSizeMb: 256 });
            const db = open(dbPath);
            try {
                applySqliteTuningPragmas(db, dbPath);
                expect(pragma(db, "mmap_size")).toBe(256 * 1024 * 1024);
                expect(pragma(db, "cache_size")).toBe(-(32 * 1024));
            } finally {
                closeQuietly(db);
            }
        });

        it("#when the store is on virtiofs #then the mapping stays off", () => {
            const dbPath = fixtureStore();
            __setMountTableReaderForTests(() => VIRTIOFS);
            setSqlitePragmaConfig({ cacheSizeMb: 32, mmapSizeMb: 256 });
            const db = open(dbPath);
            try {
                applySqliteTuningPragmas(db, dbPath);
                expect(pragma(db, "mmap_size")).toBe(0);
                // The cache is still ours to size: it is process-private memory.
                expect(pragma(db, "cache_size")).toBe(-(32 * 1024));
            } finally {
                closeQuietly(db);
            }
        });

        it("#when a live connection moves to virtiofs #then mmap is cleared, not left behind", () => {
            const dbPath = fixtureStore();
            setSqlitePragmaConfig({ cacheSizeMb: 64, mmapSizeMb: 256 });
            const db = open(dbPath);
            try {
                __setMountTableReaderForTests(() => BTRFS);
                applySqliteTuningPragmas(db, dbPath);
                expect(pragma(db, "mmap_size")).toBe(256 * 1024 * 1024);
                // Same handle, same file, now declared unsafe: the earlier mapping must go.
                __setMountTableReaderForTests(() => VIRTIOFS);
                applySqliteTuningPragmas(db, dbPath);
                expect(pragma(db, "mmap_size")).toBe(0);
            } finally {
                closeQuietly(db);
            }
        });
    });

    describe("#given the boot path opens the store", () => {
        it("#when the mount is virtiofs #then it falls back to the rollback journal without mmap", () => {
            const dbPath = fixtureStore();
            __setMountTableReaderForTests(() => VIRTIOFS);
            setSqlitePragmaConfig({ cacheSizeMb: 64, mmapSizeMb: 512 });
            const db = open(dbPath);
            try {
                initializeDatabase(db, 5000, dbPath);
                expect(
                    String(
                        (db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>)
                            .journal_mode,
                    ).toLowerCase(),
                ).toBe("delete");
                expect(pragma(db, "mmap_size")).toBe(0);
                // The tuning step runs before the handle is in `pathByDatabase`, so it has to
                // be told the path; without that the mount check would answer "safe".
                expect(pragma(db, "cache_size")).toBe(-(64 * 1024));
            } finally {
                closeQuietly(db);
            }
        });

        it("#when the handle is not one this module opened #then it keeps the old behaviour", () => {
            const dbPath = fixtureStore();
            __setMountTableReaderForTests(() => VIRTIOFS);
            setSqlitePragmaConfig({ cacheSizeMb: 64, mmapSizeMb: 64 });
            const db = open(dbPath);
            try {
                // No path argument and no registration: nothing can vouch for the file.
                applySqliteTuningPragmas(db);
                expect(pragma(db, "mmap_size")).toBe(64 * 1024 * 1024);
            } finally {
                closeQuietly(db);
            }
        });
    });
});
