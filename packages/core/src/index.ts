import type {Resource} from "./collect.ts";
export * from "./collect.ts";
export * from "./atlas.ts";
export * from "./atlas-requests.ts";
export * from "./lifecycle.ts";
import type {AtlasProject, ItemLabels} from "./atlas.ts";
import { jsonbByteLength } from "./jsonb.ts";
export { jsonbByteLength } from "./jsonb.ts";
export type AppId = "recall" | "sketchbook" | "collect" | "atlas";
export type Space = {
    id: string;
    name: string;
    color: string;
    createdAt: string;
    ownerId?: string | null;
    serverRevision?: number | null;
    localRevision?: number;
    deletedAt?: string|null;
};
export type Note = {
    id: string;
    kind: "note";
    originApp: "recall";
    ownerId: string | null;
    body: string;
    spaceIds: string[];
    pinned: boolean;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    localRevision: number;
    serverRevision: number | null;
};
export type RelationType = "inspired_by" | "elaborates" | "supports" | "contradicts" | "related_to";
export type Relation = {
    id: string;
    fromItemId: string;
    toItemId: string;
    type: RelationType;
};
export type SketchPoint = { x: number; y: number; pressure: number };
export type SketchStroke = { id: string; tool: "pen" | "eraser"; color: string; width: number; points: SketchPoint[] };
export type Sketch = {
    id: string; kind: "sketch"; originApp: "sketchbook"; ownerId: string | null;
    title: string; width: 1200; height: 800; strokes: SketchStroke[]; spaceIds: string[];
    pinned: boolean; createdAt: string; updatedAt: string; deletedAt: string | null;
    localRevision: number; serverRevision: number | null;
};
export type ItemRelation = Relation & {
    kind: "relation"; ownerId: string | null;
    createdAt: string; updatedAt: string; deletedAt: string | null;
    localRevision: number; serverRevision: number | null;
};
export type SyncRecord = Note | Space | Sketch | ItemRelation | Resource | AtlasProject | ItemLabels;
export type SketchDraft = { title: string; strokes: SketchStroke[]; spaceIds: string[]; editingId?: string; expectedRevision?: number; sourceNoteId?:string };
export type SketchBackup = {
    format: "personal-tools.sketchbook"; version: 1; exportedAt: string;
    sketches: Sketch[]; spaces: Space[];
};
export type LocalOperation = {
    id: string;
    entityId: string;
    baseRevision: number | null;
    operation: "put_note";
    payload: Note;
    createdAt: string;
    state: "local_only";
};
export type Backup = {
    format: "personal-tools.recall";
    version: 1;
    exportedAt: string;
    notes: Note[];
    spaces: Space[];
};
export type SyncOperation = {
    id: string;
    kind: "put_note" | "put_space" | "put_sketch" | "put_relation" | "put_resource" | "put_project" | "put_labels";
    entityId: string;
    baseRevision: number | null;
    previousOperationId?: string;
    payload: SyncRecord;
    createdAt: string;
};
export type SyncConflict = {
    id: string;
    entity: "note" | "space" | "sketch" | "relation" | "resource" | "project" | "labels";
    entityId: string;
    local: SyncRecord;
    remote: SyncRecord;
    createdAt: string;
};
export type SyncChange = {
    cursor: string;
    entity: "note" | "space" | "sketch" | "relation" | "resource" | "project" | "labels";
    record: SyncRecord;
};
export type SyncPushResult = {
    status: "applied" | "conflict";
    operationId: string;
    record: SyncRecord;
    conflictId?: string;
} | {status:"purged";operationId:string;purged:import("./lifecycle.ts").PurgeNotice};
export type SyncPullResult = {
    changes: SyncChange[];
    cursor: string;
    hasMore: boolean;
    purges?:import("./lifecycle.ts").PurgeNotice[];
};
export type SyncStatus = {
    phase: "idle" | "syncing" | "error" | "conflict" | "stopped";
    pending: number;
    conflicts: number;
    lastSyncedAt: string | null;
    error?: string;
};
export function normalizeText(value: string): string {
    return value.normalize("NFKC").toLocaleLowerCase("ja-JP").trim();
}
export function matchesQuery(note: Note, query: string): boolean {
    const body = normalizeText(note.body);
    return normalizeText(query).split(/\s+/u).filter(Boolean).every((word) => body.includes(word));
}
export function noteTitle(body: string): string {
    return body.trim().split("\n")[0].slice(0, 80);
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export function parseBackup(input: unknown): Backup {
    if (!isObject(input) || input.format !== "personal-tools.recall" || input.version !== 1 ||
        !isDate(input.exportedAt) || !Array.isArray(input.notes) || !Array.isArray(input.spaces)) {
        throw new Error("Recallのバックアップ形式を確認してください。");
    }
    if (input.notes.length > 100000 || input.spaces.length > 10000)
        throw new Error("データ件数が多すぎます。");
    const spaceIds = new Set<string>();
    const spaces: Space[] = input.spaces.map((s: unknown) => {
        if (!isObject(s) || !isId(s.id) || typeof s.name !== "string" || !s.name.trim() || s.name.length > 40 ||
            typeof s.color !== "string" || !/^#[0-9a-f]{6}$/i.test(s.color) || !isDate(s.createdAt) || spaceIds.has(s.id)) {
            throw new Error("スペースのデータが正しくありません。");
        }
        spaceIds.add(s.id);
        return {
            id: s.id, name: s.name, color: s.color, createdAt: s.createdAt
        };
    });
    const noteIds = new Set<string>();
    const notes: Note[] = input.notes.map((n: unknown) => {
        if (!isObject(n) || !isId(n.id) || noteIds.has(n.id) || n.kind !== "note" || n.originApp !== "recall" ||
            n.ownerId !== null || typeof n.body !== "string" || !n.body.trim() || n.body.length > 100000 ||
            !Array.isArray(n.spaceIds) || !n.spaceIds.every((id: unknown) => typeof id === "string" && spaceIds.has(id)) ||
            typeof n.pinned !== "boolean" || !isDate(n.createdAt) || !isDate(n.updatedAt) ||
            !(n.deletedAt === null || isDate(n.deletedAt)) || !Number.isSafeInteger(n.localRevision) || Number(n.localRevision) < 1 ||
            n.serverRevision !== null)
            throw new Error("メモのデータが正しくありません。端末内版のバックアップを選んでください。");
        noteIds.add(n.id);
        return {
            id: n.id, kind: "note", originApp: "recall", ownerId: null, body: n.body,
            spaceIds: [...new Set(n.spaceIds as string[])], pinned: n.pinned, createdAt: n.createdAt,
            updatedAt: n.updatedAt, deletedAt: n.deletedAt as string | null,
            localRevision: Number(n.localRevision), serverRevision: null
        };
    });
    return {
        format: "personal-tools.recall", version: 1, exportedAt: input.exportedAt, notes, spaces
    };
}

/** The editable original is bounded stroke JSON; PNG previews are derived assets. */
export function parseSketchStrokes(value: unknown): SketchStroke[] {
    if (!Array.isArray(value) || value.length > 2000) throw new Error("ストロークは2,000本以内で保存してください。");
    let points = 0;
    const ids = new Set<string>();
    const strokes = Array.from(value, (stroke: unknown): SketchStroke => {
        if (!isObject(stroke) || !isId(stroke.id) || ids.has(stroke.id) || !["pen", "eraser"].includes(String(stroke.tool)) ||
            typeof stroke.color !== "string" || !/^#[0-9a-f]{6}$/i.test(stroke.color) ||
            typeof stroke.width !== "number" || !Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 80 ||
            !Array.isArray(stroke.points) || stroke.points.length < 1) throw new Error("ストロークのデータが正しくありません。");
        ids.add(stroke.id);
        points += stroke.points.length;
        if (points > 20000) throw new Error("描画点は20,000点以内で保存してください。");
        const parsed = Array.from(stroke.points, (point: unknown): SketchPoint => {
            if (!isObject(point) || typeof point.x !== "number" || !Number.isFinite(point.x) || point.x < 0 || point.x > 1200 ||
                typeof point.y !== "number" || !Number.isFinite(point.y) || point.y < 0 || point.y > 800 ||
                typeof point.pressure !== "number" || !Number.isFinite(point.pressure) || point.pressure < 0 || point.pressure > 1)
                throw new Error("描画点のデータが正しくありません。");
            return { x: point.x, y: point.y, pressure: point.pressure };
        });
        return { id: stroke.id, tool: stroke.tool as "pen" | "eraser", color: stroke.color, width: stroke.width, points: parsed };
    });
    if (new TextEncoder().encode(JSON.stringify(strokes)).length > 750000 || jsonbByteLength(strokes) > 850000)
        throw new Error("描画データが大きすぎます。元に戻すか、別のスケッチに分けてください。");
    return strokes;
}
export function parseSketchSpaceIds(value: unknown): string[] {
    if (!Array.isArray(value) || !Array.from(value).every(isId)) throw new Error("スペースのデータが正しくありません。");
    const ids = [...new Set(value as string[])];
    if (ids.length > 1000) throw new Error("1つのスケッチに設定できるスペースは1,000個までです。");
    return ids;
}
/** Reserve the largest metadata fields before saving even in device mode, so a
 * later account import or predecessor chain cannot exceed the SQL 1MiB limit. */
export function assertSketchSyncBudget(sketch: Sketch): void {
    const id = "00000000-0000-4000-8000-000000000000";
    const operation: SyncOperation = {
        id, kind: "put_sketch", entityId: sketch.id, baseRevision: Number.MAX_SAFE_INTEGER,
        previousOperationId: id, createdAt: "9999-12-31T23:59:59.999Z",
        payload: { ...sketch, ownerId: id, localRevision: Number.MAX_SAFE_INTEGER, serverRevision: Number.MAX_SAFE_INTEGER },
    };
    if (jsonbByteLength(operation) > 1048576) throw new Error("スケッチのデータが大きすぎます。別のスケッチに分けてください。");
}
export function parseSketchBackup(input: unknown): SketchBackup {
    if (!isObject(input) || input.format !== "personal-tools.sketchbook" || input.version !== 1 || !isDate(input.exportedAt) ||
        !Array.isArray(input.sketches) || input.sketches.length > 10000) throw new Error("Sketchbookのバックアップ形式を確認してください。");
    // Reuse the established strict portable-space parser; importing never trusts owner/revision metadata.
    const { spaces } = parseBackup({ format: "personal-tools.recall", version: 1, exportedAt: input.exportedAt, notes: [], spaces: input.spaces });
    const spaceIds = new Set(spaces.map(space => space.id)), ids = new Set<string>();
    const sketches = input.sketches.map((sketch: unknown): Sketch => {
        if (!isObject(sketch) || !isId(sketch.id) || ids.has(sketch.id) || sketch.kind !== "sketch" || sketch.originApp !== "sketchbook" ||
            sketch.ownerId !== null || sketch.serverRevision !== null || typeof sketch.title !== "string" || sketch.title.length > 120 ||
            sketch.width !== 1200 || sketch.height !== 800 || !Array.isArray(sketch.spaceIds) || !sketch.spaceIds.every(id => typeof id === "string" && spaceIds.has(id)) ||
            typeof sketch.pinned !== "boolean" || !isDate(sketch.createdAt) || !isDate(sketch.updatedAt) || !(sketch.deletedAt === null || isDate(sketch.deletedAt)) ||
            !Number.isSafeInteger(sketch.localRevision) || Number(sketch.localRevision) < 1) throw new Error("スケッチのデータが正しくありません。");
        ids.add(sketch.id);
        const parsed: Sketch = { id: sketch.id, kind: "sketch", originApp: "sketchbook", ownerId: null, title: sketch.title, width: 1200, height: 800,
            strokes: parseSketchStrokes(sketch.strokes), spaceIds: parseSketchSpaceIds(sketch.spaceIds), pinned: sketch.pinned,
            createdAt: sketch.createdAt, updatedAt: sketch.updatedAt, deletedAt: sketch.deletedAt as string | null,
            localRevision: Number(sketch.localRevision), serverRevision: null };
        assertSketchSyncBudget(parsed);
        return parsed;
    });
    return { format: "personal-tools.sketchbook", version: 1, exportedAt: input.exportedAt, sketches, spaces };
}
