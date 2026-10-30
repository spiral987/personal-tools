import { parseSketchStrokes, type SyncRecord, type SyncOperation, type SyncChange, type SyncPushResult, type SyncPullResult, type SyncStatus } from "@personal-tools/core";
import type { AccountRecallRepository } from "./repository.ts";
export interface SyncTransport {
    readonly userId: string;
    push(operation: SyncOperation): Promise<SyncPushResult>;
    pull(cursor: string, limit: number): Promise<SyncPullResult>;
}
type RpcClient = {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: {
            message?: string;
            code?: string;
        } | null;
    }>;
};
const RETRY_MESSAGE = "同期できませんでした。端末のメモは残っています。通信と接続設定を確認して、もう一度同期してください。";
export class SyncTransportError extends Error {
}
function rpcError(error: {
    code?: string;
}): SyncTransportError {
    if (["PGRST301", "PGRST302", "PGRST303"].includes(error.code ?? ""))
        return new SyncTransportError("ログインの有効期限を確認できません。通信が戻ってから、もう一度ログインしてください。");
    if (error.code === "PGRST202")
        return new SyncTransportError("クラウド側の同期機能が準備されていません。Supabaseの設定手順を確認してください。");
    return new SyncTransportError(RETRY_MESSAGE);
}
function asObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new SyncTransportError("同期サーバーから正しい応答を取得できませんでした。");
    return value as Record<string, unknown>;
}
function validateRecord(value: unknown, userId: string): SyncRecord {
    const record = asObject(value);
    const isDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
    const isId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
    if (record.ownerId !== userId || !isId(record.id) || !Number.isSafeInteger(record.serverRevision) || Number(record.serverRevision) < 1 || !isDate(record.createdAt))
        throw new SyncTransportError("同期応答を検証できませんでした。");
    if (record.kind === "note") {
        if (record.originApp !== "recall" || typeof record.body !== "string" || !record.body.trim() || record.body.length > 100000 || !Array.isArray(record.spaceIds) || !record.spaceIds.every(isId) || typeof record.pinned !== "boolean" || !isDate(record.updatedAt) || !(record.deletedAt === null || isDate(record.deletedAt)))
            throw new SyncTransportError("メモの同期応答が正しくありません。");
    }
    else if (record.kind === "sketch") {
        if (record.originApp !== "sketchbook" || record.width !== 1200 || record.height !== 800 || typeof record.title !== "string" || record.title.length > 120 ||
            !Array.isArray(record.spaceIds) || !record.spaceIds.every(isId) || typeof record.pinned !== "boolean" || !isDate(record.updatedAt) || !(record.deletedAt === null || isDate(record.deletedAt)))
            throw new SyncTransportError("スケッチの同期応答が正しくありません。");
        try { parseSketchStrokes(record.strokes); } catch { throw new SyncTransportError("描画の同期応答が正しくありません。"); }
    }
    else if (record.kind === "relation") {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (record.type !== "inspired_by" || typeof record.fromItemId !== "string" || !uuid.test(record.fromItemId) || typeof record.toItemId !== "string" || !uuid.test(record.toItemId) || record.fromItemId === record.toItemId ||
            !isDate(record.updatedAt) || !(record.deletedAt === null || isDate(record.deletedAt))) throw new SyncTransportError("関連付けの同期応答が正しくありません。");
    }
    else if ("kind" in record || typeof record.name !== "string" || !record.name.trim() || record.name.length > 40 || typeof record.color !== "string" || !/^#[0-9a-f]{6}$/i.test(record.color))
        throw new SyncTransportError("スペースの同期応答が正しくありません。");
    return value as SyncRecord;
}
export function createSupabaseSyncTransport(client: RpcClient, userId: string): SyncTransport {
    // These are application-owned SQL functions, called with the documented rpc signature.
    // https://supabase.com/docs/reference/javascript/rpc
    return {
        userId,
        async push(operation) {
            const { data, error } = await client.rpc("apply_sync_operation", {
                p_operation: operation
            });
            if (error)
                throw rpcError(error);
            const result = asObject(data);
            if ((result.status !== "applied" && result.status !== "conflict") || result.operationId !== operation.id)
                throw new SyncTransportError("同期の結果が一致しません。");
            const record = validateRecord(result.record, userId);
            if (record.id !== operation.entityId || ("kind" in record ? record.kind : "space") !== operation.kind.slice(4))
                throw new SyncTransportError("同期の項目が一致しません。");
            return {
                status: result.status, operationId: operation.id, record, ...(typeof result.conflictId === "string" ? {
                    conflictId: result.conflictId
                } : {})
            };
        },
        async pull(cursor, limit) {
            const { data, error } = await client.rpc("pull_suite_changes", {
                p_cursor: cursor, p_limit: limit
            });
            if (error)
                throw rpcError(error);
            const result = asObject(data);
            if (typeof result.cursor !== "string" || !/^\d{1,19}$/.test(result.cursor) || typeof result.hasMore !== "boolean" || !Array.isArray(result.changes) || result.changes.length > limit)
                throw new SyncTransportError("同期の一覧が正しくありません。");
            let previousCursor = BigInt(cursor);
            const changes: SyncChange[] = result.changes.map(value => {
                const change = asObject(value);
                if (!["note", "space", "sketch", "relation"].includes(String(change.entity)) || typeof change.cursor !== "string" || !/^\d{1,19}$/.test(change.cursor) || BigInt(change.cursor) <= previousCursor)
                    throw new SyncTransportError("同期の変更位置が正しくありません。");
                previousCursor = BigInt(change.cursor);
                const record = validateRecord(change.record, userId);
                if (("kind" in record ? record.kind : "space") !== change.entity)
                    throw new SyncTransportError("同期の項目が一致しません。");
                return {
                    cursor: change.cursor, entity: change.entity as SyncChange["entity"], record
                };
            });
            if (BigInt(result.cursor) !== previousCursor || (result.hasMore && !changes.length))
                throw new SyncTransportError("同期の変更位置が正しくありません。");
            return {
                changes, cursor: result.cursor, hasMore: result.hasMore
            };
        },
    };
}
export type SyncEngine = {
    run(): Promise<SyncStatus>;
    stop(): void;
    subscribe(listener: (status: SyncStatus) => void): () => void;
    getStatus(): SyncStatus;
};
export function createSyncEngine(repo: AccountRecallRepository, transport: SyncTransport): SyncEngine {
    if (repo.ownerId !== transport.userId)
        throw new Error("同期先のアカウントが一致しません。");
    let stopped = false;
    let inFlight: Promise<SyncStatus> | null = null;
    let status: SyncStatus = {
        phase: "idle", pending: 0, conflicts: 0, lastSyncedAt: null
    };
    const listeners = new Set<(status: SyncStatus) => void>();
    function publish(next: SyncStatus) {
        status = next;
        for (const listener of listeners)
            listener(structuredClone(status));
    }
    async function current(phase: SyncStatus["phase"], error?: string): Promise<SyncStatus> {
        const state = await repo.getSyncState();
        return {
            phase, pending: state.pending, conflicts: state.conflicts.length, lastSyncedAt: state.lastSyncedAt, ...(error ? {
                error
            } : {})
        };
    }
    return {
        stop() {
            stopped = true;
            publish({
                ...status, phase: "stopped"
            });
            listeners.clear();
        },
        subscribe(listener) {
            listeners.add(listener);
            listener(structuredClone(status));
            return () => listeners.delete(listener);
        },
        getStatus() {
            return structuredClone(status);
        },
        run() {
            if (stopped)
                return Promise.resolve(structuredClone(status));
            if (inFlight)
                return inFlight;
            inFlight = (async () => {
                try {
                    const initial = await current("syncing");
                    if (stopped)
                        return structuredClone(status);
                    publish(initial);
                    // Bound each run so continuously typing cannot starve the pull phase.
                    for (let sent = 0; sent < 1000; sent++) {
                        if (stopped)
                            return structuredClone(status);
                        const pending = await repo.pendingOperations();
                        if (!pending.length)
                            break;
                        const op = pending[0];
                        const { sequence: _, localRevision: __, ...wire } = op;
                        const result = await transport.push(structuredClone(wire));
                        // Account switching stops the engine before close; a late HTTP reply is ignored.
                        if (stopped)
                            return structuredClone(status);
                        await repo.acceptPush(op, result);
                    }
                    let cursor = (await repo.getSyncState()).cursor;
                    for (let pages = 0; pages < 10000; pages++) {
                        if (stopped)
                            return structuredClone(status);
                        const result = await transport.pull(cursor, 100);
                        if (stopped)
                            return structuredClone(status);
                        if (result.hasMore && BigInt(result.cursor) <= BigInt(cursor))
                            throw new Error("同期位置が進みませんでした。もう一度お試しください。");
                        await repo.acceptPull(result);
                        cursor = result.cursor;
                        if (!result.hasMore)
                            break;
                        if (pages === 9999)
                            throw new Error("変更が多いため、もう一度同期してください。");
                    }
                    if (stopped)
                        return structuredClone(status);
                    await repo.markSynced();
                    const state = await repo.getSyncState();
                    if (stopped)
                        return structuredClone(status);
                    const finished = await current(state.conflicts.length ? "conflict" : "idle");
                    if (!stopped)
                        publish(finished);
                }
                catch (error) {
                    if (!stopped) {
                        // Backend exceptions can contain SQL or user payloads; expose only known safe messages.
                        const message = error instanceof SyncTransportError ? error.message : RETRY_MESSAGE;
                        try {
                            const failed = await current("error", message);
                            if (!stopped)
                                publish(failed);
                        }
                        catch {
                            if (!stopped)
                                publish({
                                    ...status, phase: "error", error: message
                                });
                        }
                    }
                }
                return structuredClone(status);
            })().finally(() => {
                inFlight = null;
            });
            return inFlight;
        },
    };
}
