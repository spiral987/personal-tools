import { parseBackup, parseSketchStrokes, parseSketchSpaceIds, parseSketchBackup, assertSketchSyncBudget, jsonbByteLength, parseResource, parseResourceImage, parseCollectDraft, parseCollectBackup, resourceUrl, canonicalResourceUrl, emptyResourceMetadata, MAX_COLLECT_BACKUP_BYTES, MAX_COLLECT_BACKUP_JSON_BYTES, type Resource, type CollectDraft, type CollectBackup, type ResourceImage, type ResourceMetadataJob, type Backup, type SketchBackup, type Sketch, type SketchDraft, type ItemRelation, type SyncRecord, type Note, type Space, type LocalOperation, type SyncOperation, type SyncConflict, type SyncPushResult, type SyncPullResult } from "@personal-tools/core";
import {prepareResourceImage,blobToBase64,base64ToBlob} from "./resource-files.ts";
export class ConflictError extends Error {
    constructor() {
        super("別の画面でこのメモが更新されました。入力を残したまま、最新のメモを読み直してください。");
    }
}
type SaveNoteInput = {
    id?: string;
    body: string;
    spaceIds: string[];
    pinned?: boolean;
    deletedAt?: string | null;
};
export type SaveSketchInput = SketchDraft & { id?: string; pinned?: boolean; deletedAt?: string | null; expectedRevision?: number };
export type SuiteSnapshot = { notes: Note[]; spaces: Space[]; sketches: Sketch[]; relations: ItemRelation[];resources:Resource[] };
export type SaveResourceInput = Omit<CollectDraft,"editingId"|"expectedRevision"> & {id?:string;file?:Blob;pinned?:boolean;deletedAt?:string|null;metadata?:Resource["metadata"]};
export type ResourceChanges = Partial<Pick<Resource,"title"|"memo"|"url"|"sourceUrl"|"spaceIds"|"inbox"|"pinned"|"deletedAt">>;
export type SyncState = {
    pending: number;
    pendingItemIds: string[];
    conflicts: SyncConflict[];
    cursor: string;
    lastSyncedAt: string | null;
};
export interface RecallRepository {
    snapshot(): Promise<SuiteSnapshot>;
    loadDraft(): Promise<{
        body: string;
        spaceIds: string[];
    }>;
    saveDraft(body: string, spaceIds: string[]): Promise<void>;
    saveNote(input: SaveNoteInput, expectedRevision?: number): Promise<Note>;
    saveSketch(input: SaveSketchInput, expectedRevision?: number): Promise<Sketch>;
    updateSketch(id: string, changes: Partial<Pick<Sketch, "title" | "strokes" | "spaceIds" | "pinned" | "deletedAt">>, expectedRevision: number): Promise<Sketch>;
    saveRelation(input: { fromItemId: string; toItemId: string; type: "inspired_by" }): Promise<ItemRelation>;
    deleteRelation(id: string, expectedRevision: number): Promise<void>;
    loadSketchDraft(): Promise<SketchDraft>;
    saveSketchDraft(draft: SketchDraft): Promise<void>;
    exportSketchBackup(): Promise<SketchBackup>;
    importSketchBackup(input: unknown): Promise<{ sketches: number; spaces: number }>;
    saveResource(input:SaveResourceInput,expectedRevision?:number):Promise<Resource>;
    updateResource(id:string,changes:ResourceChanges,expectedRevision:number):Promise<Resource>;
    loadCollectDraft():Promise<CollectDraft>;
    saveCollectDraft(draft:CollectDraft,file?:Blob|null):Promise<void>;
    getCollectDraftFile():Promise<Blob|null>;
    getResourceFile(id:string):Promise<Blob|null>;
    cacheResourceFile(id:string,file:Blob):Promise<void>;
    duplicateResources(input:{url?:string|null;image?:ResourceImage|null},excludeId?:string):Promise<Resource[]>;
    startResourceMetadata(id:string,expectedRevision:number):Promise<ResourceMetadataJob>;
    finishResourceMetadata(id:string,token:string,result:{title:string;description:string}|null):Promise<Resource|null>;
    getResourceMetadataJob(id:string):Promise<ResourceMetadataJob|null>;
    exportCollectBackup(ids?:string[]):Promise<CollectBackup>;
    importCollectBackup(input:unknown):Promise<{resources:number;spaces:number}>;
    createSpace(name: string): Promise<Space>;
    exportBackup(): Promise<Backup>;
    importBackup(input: unknown): Promise<{
        notes: number;
        spaces: number;
    }>;
    close(): void;
    subscribe(listener: () => void): () => void;
}
export type StoredOperation = SyncOperation & {
    sequence: number;
    localRevision: number;
};
export interface AccountRecallRepository extends RecallRepository {
    readonly ownerId: string;
    getSyncState(): Promise<SyncState>;
    importDeviceData(): Promise<{
        notes: number;
        spaces: number;
    }>;
    resolveConflict(id: string, resolution: "keep_remote" | "keep_both"): Promise<void>;
    pendingOperations(): Promise<StoredOperation[]>;
    acceptPush(operation: StoredOperation, result: SyncPushResult): Promise<void>;
    acceptPull(result: SyncPullResult): Promise<void>;
    markSynced(): Promise<void>;
}
const DEVICE_DB = "personal-tools-recall-local-v1";
const STORES = ["notes", "spaces", "sketches", "relations", "resources", "resourceFiles", "resourceJobs", "outbox", "drafts", "syncOutbox", "conflicts", "meta"];
const DEFAULT_SPACES = [["daily", "日常", "#729379"], ["creative", "創作", "#8b7bae"], ["research", "研究", "#b38c58"]] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const copy = <T>(value: T): T => structuredClone(value);
const sameResourceImage=(a:ResourceImage|null,b:ResourceImage|null)=>a===null||b===null?a===b:
    a.sha256===b.sha256&&a.mimeType===b.mimeType&&a.size===b.size&&a.filename===b.filename;
function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function complete(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("保存を中断しました。"));
        tx.onerror = () => reject(tx.error ?? new Error("端末に保存できませんでした。"));
    });
}
async function atomic<T>(tx: IDBTransaction, work: () => Promise<T> | T): Promise<T> {
    const done = complete(tx);
    void done.catch(() => {
    });
    try {
        const result = await work();
        await done;
        return result;
    }
    catch (error) {
        try {
            tx.abort();
        }
        catch {
        }
        await done.catch(() => {
        });
        throw error;
    }
}
const isNote = (record: SyncRecord): record is Note => "kind" in record && record.kind === "note";
const entityOf = (record: SyncRecord): "note" | "space" | "sketch" | "relation" | "resource" => "kind" in record ? record.kind : "space";
const storeOf = (entity: string) => ({ note: "notes", space: "spaces", sketch: "sketches", relation: "relations",resource:"resources" }[entity]!);
const revision = (record: SyncRecord) => record.serverRevision ?? 0;
function portable(data: {
    notes: Note[];
    spaces: Space[];
}): Backup {
    return {
        format: "personal-tools.recall", version: 1, exportedAt: new Date().toISOString(), notes: data.notes.map(n => ({
            ...n, ownerId: null, serverRevision: null
        })), spaces: data.spaces.map(s => ({
            id: s.id, name: s.name, color: s.color, createdAt: s.createdAt
        }))
    };
}
export function openRecallRepository(name = DEVICE_DB): Promise<RecallRepository> {
    return openRepository(name, null);
}
export function openAccountRecallRepository(userId: string, options: {
    name?: string;
} = {}): Promise<AccountRecallRepository> {
    if (!uuidPattern.test(userId))
        return Promise.reject(new Error("アカウントを確認できません。もう一度ログインしてください。"));
    return openRepository(options.name ?? `personal-tools-recall-account-${userId.toLowerCase()}`, userId.toLowerCase()) as Promise<AccountRecallRepository>;
}
async function openRepository(name: string, ownerId: string | null): Promise<RecallRepository | AccountRecallRepository> {
    if (typeof indexedDB === "undefined")
        throw new Error("このブラウザでは端末内保存を利用できません。");
    // Missing stores are created only during versionchange; the v1 device notes and drafts survive.
    // https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB
    let invalidated = false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        let blocked = false;
        const req = indexedDB.open(name, 4);
        req.onupgradeneeded = (event) => {
            for (const store of STORES)
                if (!req.result.objectStoreNames.contains(store))
                    req.result.createObjectStore(store, {
                        keyPath: "id"
                    });
            // A v3 cursor may already have passed a resource hidden from its stream.
            // Replay the full owner stream once; server revisions protect cached newer values.
            if (event.oldVersion < 4) req.transaction!.objectStore("meta").put({ id: "cursor", value: "0" });
        };
        req.onsuccess = () => {
            if (blocked) {
                req.result.close();
                return;
            }
            req.result.onversionchange = () => {
                invalidated = true;
                req.result.close();
            };
            resolve(req.result);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => {
            blocked = true;
            reject(new Error("ほかのRecallのタブを閉じて、開き直してください。"));
        };
    });
    let closed = false;
    const listeners = new Set<() => void>();
    function ensureOpen() {
        if (closed || invalidated)
            throw new Error("このノートは閉じられました。画面を開き直してください。");
    }
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(`personal-tools-data:${name}`) : null;
    if (channel && "unref" in channel) (channel as BroadcastChannel & { unref(): void }).unref();
    const notify = () => {
        if (!closed)
            for (const listener of listeners)
                listener();
    };
    if (channel) channel.onmessage = () => notify();
    const emit = () => { notify(); channel?.postMessage("changed"); };
    function transaction(stores: string[] = STORES, mode: IDBTransactionMode = "readwrite") {
        ensureOpen();
        return db.transaction(stores, mode, mode === "readwrite" ? {
            durability: "strict"
        } : undefined);
    }
    async function readAll<T>(store: string): Promise<T[]> {
        const tx = transaction([store], "readonly");
        return atomic(tx, () => request(tx.objectStore(store).getAll()) as Promise<T[]>);
    }
    async function queue(tx: IDBTransaction, record: SyncRecord) {
        if (!ownerId) {
            if (isNote(record)) {
                const op: LocalOperation = {
                    id: record.id, entityId: record.id, baseRevision: null, operation: "put_note", payload: record, createdAt: record.updatedAt, state: "local_only"
                };
                tx.objectStore("outbox").put(op);
            }
            return;
        }
        const store = tx.objectStore("syncOutbox");
        const existing = await request(store.getAll()) as StoredOperation[];
        const kind = `put_${entityOf(record)}` as SyncOperation["kind"];
        const prior = existing.filter(op => op.kind === kind && op.entityId === record.id).sort((a, b) => b.sequence - a.sequence)[0];
        const sequenceRecord = await request(tx.objectStore("meta").get("sequence"));
        const sequence = Number(sequenceRecord?.value ?? 0) + 1;
        tx.objectStore("meta").put({
            id: "sequence", value: sequence
        });
        // Immutable id/payload survive retries with an uncertain network result.
        const operation: StoredOperation = {
            id: crypto.randomUUID(), kind, entityId: record.id, baseRevision: record.serverRevision ?? null, ...(prior ? {
                previousOperationId: prior.id
            } : {}), payload: copy(record), createdAt: new Date().toISOString(), sequence, localRevision: record.localRevision ?? 1
        };
        if (kind === "put_sketch" || kind==="put_resource") {
            const { sequence: _sequence, localRevision: _localRevision, ...wire } = operation;
            if (jsonbByteLength(wire) > 1048576) throw new Error("スケッチのデータが大きすぎます。別のスケッチに分けてください。");
        }
        store.add(operation);
    }
    try {
        const tx = transaction();
        await atomic(tx, async () => {
            const identity = await request(tx.objectStore("meta").get("identity"));
            if (identity && identity.value !== ownerId)
                throw new Error("別のアカウントの保存領域は開けません。");
            tx.objectStore("meta").put({
                id: "identity", value: ownerId
            });
            const seeded = await request(tx.objectStore("meta").get("seeded"));
            const count = await request(tx.objectStore("spaces").count());
            if (!seeded && !count) {
                for (const [id, spaceName, color] of DEFAULT_SPACES) {
                    const space: Space = {
                        id, name: spaceName, color, createdAt: new Date().toISOString(), ...(ownerId ? {
                            ownerId, serverRevision: null, localRevision: 1
                        } : {})
                    };
                    tx.objectStore("spaces").put(space);
                    if (ownerId)
                        await queue(tx, space);
                }
            }
            tx.objectStore("meta").put({
                id: "seeded", value: true
            });
        });
    }
    catch (error) {
        closed = true;
        db.close();
        throw error;
    }
    const repo: RecallRepository = {
        close() {
            closed = true;
            listeners.clear();
            channel?.close();
            db.close();
        },
        subscribe(listener) {
            ensureOpen();
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async loadDraft() {
            const tx = transaction(["drafts"], "readonly");
            return atomic(tx, async () => {
                const d = await request(tx.objectStore("drafts").get("composer"));
                return d ? {
                    body: d.body as string, spaceIds: d.spaceIds as string[]
                } : {
                    body: "", spaceIds: []
                };
            });
        },
        async saveDraft(body, spaceIds) {
            const tx = transaction(["drafts"]);
            await atomic(tx, () => {
                tx.objectStore("drafts").put({
                    id: "composer", body, spaceIds
                });
            });
        },
        async snapshot() {
            const tx = transaction(["notes", "spaces", "sketches", "relations","resources"], "readonly");
            return atomic(tx, async () => {
                const [notes, spaces, sketches, relations,resources] = await Promise.all([request(tx.objectStore("notes").getAll()) as Promise<Note[]>, request(tx.objectStore("spaces").getAll()) as Promise<Space[]>, request(tx.objectStore("sketches").getAll()) as Promise<Sketch[]>, request(tx.objectStore("relations").getAll()) as Promise<ItemRelation[]>,request(tx.objectStore("resources").getAll()) as Promise<Resource[]>]);
                return {
                    notes, spaces, sketches, relations,resources
                };
            });
        },
        async loadSketchDraft() {
            const tx = transaction(["drafts"], "readonly");
            return atomic(tx, async () => {
                const draft = await request(tx.objectStore("drafts").get("sketch-composer"));
                return draft ? { title: draft.title, strokes: draft.strokes, spaceIds: draft.spaceIds,
                    ...(draft.editingId ? { editingId: draft.editingId, expectedRevision: draft.expectedRevision } : {}) } : { title: "", strokes: [], spaceIds: [] };
            });
        },
        async saveSketchDraft(draft) {
            if (typeof draft.title !== "string" || draft.title.length > 120) throw new Error("タイトルは120文字以内で入力してください。");
            const strokes = parseSketchStrokes(draft.strokes);
            const spaceIds = parseSketchSpaceIds(draft.spaceIds);
            jsonbByteLength(draft.title);
            const tx = transaction(["drafts"]);
            if (draft.editingId && (!uuidPattern.test(draft.editingId) || !Number.isSafeInteger(draft.expectedRevision) || Number(draft.expectedRevision) < 1)) throw new Error("下書きの更新番号が正しくありません。");
            await atomic(tx, () => { tx.objectStore("drafts").put({ id: "sketch-composer", title: draft.title, strokes, spaceIds, ...(draft.editingId ? { editingId: draft.editingId, expectedRevision: draft.expectedRevision } : {}) }); });
        },
        async saveSketch(input, expectedRevision) {
            if (typeof input.title !== "string" || input.title.length > 120) throw new Error("タイトルは120文字以内で入力してください。");
            const strokes = parseSketchStrokes(input.strokes);
            const spaceIds = parseSketchSpaceIds(input.spaceIds);
            if (input.deletedAt !== undefined && input.deletedAt !== null && !Number.isFinite(Date.parse(input.deletedAt))) throw new Error("削除日時が正しくありません。");
            const tx = transaction(), id = input.id ?? crypto.randomUUID();
            const saved = await atomic(tx, async () => {
                const previous = await request(tx.objectStore("sketches").get(id)) as Sketch | undefined;
                if ((input.id && !previous) || (previous && (expectedRevision ?? input.expectedRevision) !== previous.localRevision)) throw new ConflictError();
                const spaces = await request(tx.objectStore("spaces").getAllKeys());
                if (spaceIds.some(spaceId => !spaces.includes(spaceId))) throw new Error("スペースが見つかりません。");
                const now = new Date().toISOString();
                const sketch: Sketch = { id, kind: "sketch", originApp: "sketchbook", ownerId, title: input.title.trim(), width: 1200, height: 800,
                    strokes, spaceIds, pinned: input.pinned ?? previous?.pinned ?? false,
                    createdAt: previous?.createdAt ?? now, updatedAt: now, deletedAt: input.deletedAt === undefined ? previous?.deletedAt ?? null : input.deletedAt,
                    localRevision: (previous?.localRevision ?? 0) + 1, serverRevision: previous?.serverRevision ?? null };
                assertSketchSyncBudget(sketch);
                tx.objectStore("sketches").put(sketch); await queue(tx, sketch);
                if (!input.id) tx.objectStore("drafts").delete("sketch-composer");
                return sketch;
            });
            emit(); return saved;
        },
        async updateSketch(id, changes, expectedRevision) {
            const previous = (await readAll<Sketch>("sketches")).find(sketch => sketch.id === id);
            if (!previous) throw new ConflictError();
            return repo.saveSketch({ ...previous, ...changes, id }, expectedRevision);
        },
        async saveRelation(input) {
            if (input.type !== "inspired_by" || input.fromItemId === input.toItemId) throw new Error("着想元のメモを選んでください。");
            // Independent devices derive the same edge ID before opening the IDB transaction.
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`inspired_by:${input.fromItemId}:${input.toItemId}`)));
            digest[6] = (digest[6] & 15) | 80; digest[8] = (digest[8] & 63) | 128;
            const hex = [...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
            const edgeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            const tx = transaction();
            const saved = await atomic(tx, async () => {
                const sketch = await request(tx.objectStore("sketches").get(input.fromItemId)) as Sketch | undefined;
                const note = await request(tx.objectStore("notes").get(input.toItemId)) as Note | undefined;
                if (!sketch || sketch.deletedAt || !note || note.deletedAt) throw new Error("スケッチまたは着想元のメモが見つかりません。");
                const existing = (await request(tx.objectStore("relations").getAll()) as ItemRelation[]).find(relation => relation.fromItemId === input.fromItemId && relation.toItemId === input.toItemId && relation.type === input.type);
                if (existing && !existing.deletedAt) return existing;
                const now = new Date().toISOString();
                const relation: ItemRelation = { id: existing?.id ?? edgeId, kind: "relation", ownerId, ...input, createdAt: existing?.createdAt ?? now,
                    updatedAt: now, deletedAt: null, localRevision: (existing?.localRevision ?? 0) + 1, serverRevision: existing?.serverRevision ?? null };
                tx.objectStore("relations").put(relation); await queue(tx, relation); return relation;
            });
            emit(); return saved;
        },
        async deleteRelation(id, expectedRevision) {
            const tx = transaction();
            await atomic(tx, async () => {
                const previous = await request(tx.objectStore("relations").get(id)) as ItemRelation | undefined;
                if (!previous || previous.localRevision !== expectedRevision) throw new ConflictError();
                const now = new Date().toISOString(), saved: ItemRelation = { ...previous, updatedAt: now, deletedAt: now, localRevision: previous.localRevision + 1 };
                tx.objectStore("relations").put(saved); await queue(tx, saved);
            });
            emit();
        },
        async exportSketchBackup() {
            const data = await repo.snapshot();
            const sketches = [...data.sketches];
            if (ownerId) {
                for (const conflict of await readAll<SyncConflict>("conflicts")) {
                    if ("kind" in conflict.local && conflict.local.kind === "sketch") sketches.push({ ...conflict.local, id: crypto.randomUUID() });
                }
            }
            return { format: "personal-tools.sketchbook", version: 1, exportedAt: new Date().toISOString(),
                sketches: sketches.map(sketch => ({ ...sketch, ownerId: null, serverRevision: null })),
                spaces: data.spaces.map(space => ({ id: space.id, name: space.name, color: space.color, createdAt: space.createdAt })) };
        },
        async importSketchBackup(input) {
            const data = parseSketchBackup(input), tx = transaction();
            await atomic(tx, async () => {
                const spaces = new Map<string, string>();
                for (const space of data.spaces) {
                    const id = crypto.randomUUID(); spaces.set(space.id, id);
                    const saved: Space = { ...space, id, ...(ownerId ? { ownerId, serverRevision: null, localRevision: 1 } : {}) };
                    tx.objectStore("spaces").put(saved); await queue(tx, saved);
                }
                for (const sketch of data.sketches) {
                    const saved: Sketch = { ...sketch, id: crypto.randomUUID(), ownerId, spaceIds: sketch.spaceIds.map(id => spaces.get(id)!), serverRevision: null, localRevision: 1 };
                    assertSketchSyncBudget(saved);
                    tx.objectStore("sketches").put(saved); await queue(tx, saved);
                }
            });
            emit(); return { sketches: data.sketches.length, spaces: data.spaces.length };
        },
        async loadCollectDraft(){
            const tx=transaction(["drafts"],"readonly");
            return atomic(tx,async()=>{const draft=await request(tx.objectStore("drafts").get("collect-composer"));return draft?parseCollectDraft(draft):{resourceType:"link",url:"",sourceUrl:"",title:"",memo:"",spaceIds:[],inbox:true,image:null};});
        },
        async saveCollectDraft(input,file){
            const draft=parseCollectDraft(input);
            if(file){const image=await prepareResourceImage(file,draft.image?.filename);if(!draft.image||image.sha256!==draft.image.sha256||image.mimeType!==draft.image.mimeType||image.size!==draft.image.size)throw new Error("下書きの原本が一致しません。");}
            const tx=transaction(["drafts","resourceFiles","resources"]);
            await atomic(tx,async()=>{
                if(draft.image){
                    if(file)tx.objectStore("resourceFiles").put({id:draft.image.sha256,blob:file});
                    else if(!await request(tx.objectStore("resourceFiles").get(draft.image.sha256))){
                        const existing=draft.editingId?await request(tx.objectStore("resources").get(draft.editingId)) as Resource|undefined:undefined;
                        if(!existing||!sameResourceImage(existing.image,draft.image))throw new Error("下書きの画像をもう一度選んでください。");
                    }
                }
                tx.objectStore("drafts").put({id:"collect-composer",...draft});
            });
        },
        async getCollectDraftFile(){
            const tx=transaction(["drafts","resourceFiles"],"readonly");
            return atomic(tx,async()=>{const draft=await request(tx.objectStore("drafts").get("collect-composer"));if(!draft?.image)return null;const stored=await request(tx.objectStore("resourceFiles").get(draft.image.sha256));return stored?.blob??null;});
        },
        async saveResource(input,expectedRevision){
            let original:ResourceImage|null=null;
            if(input.file){original=await prepareResourceImage(input.file,input.image?.filename);if(input.image&&(original.sha256!==input.image.sha256||original.size!==input.image.size||original.mimeType!==input.image.mimeType))throw new Error("画像の原本が一致しません。");}
            const id=input.id??crypto.randomUUID(),tx=transaction();
            const saved=await atomic(tx,async()=>{
                const previous=await request(tx.objectStore("resources").get(id)) as Resource|undefined;
                if((input.id&&!previous)||(previous&&expectedRevision!==previous.localRevision))throw new ConflictError();
                const image=original??(input.image?parseResourceImage(input.image):null);
                if(previous&&(previous.resourceType!==input.resourceType||!sameResourceImage(previous.image,image)))throw new Error("画像の原本を変更するときは、新しい資料として追加してください。");
                const now=new Date().toISOString(),url=resourceUrl(input.url,input.resourceType==="image");
                const resource=parseResource({
                    id,kind:"resource",originApp:"collect",ownerId,resourceType:input.resourceType,url,sourceUrl:resourceUrl(input.sourceUrl||url,true),
                    title:input.title.trim(),memo:input.memo,spaceIds:input.spaceIds,inbox:input.inbox,pinned:input.pinned??previous?.pinned??false,image,
                    metadata:previous&&previous.url!==url?emptyResourceMetadata():input.metadata??previous?.metadata??emptyResourceMetadata(),
                    createdAt:previous?.createdAt??now,updatedAt:now,deletedAt:input.deletedAt===undefined?previous?.deletedAt??null:input.deletedAt,
                    localRevision:(previous?.localRevision??0)+1,serverRevision:previous?.serverRevision??null,
                });
                const spaces=await request(tx.objectStore("spaces").getAllKeys());if(resource.spaceIds.some(spaceId=>!spaces.includes(spaceId)))throw new Error("スペースが見つかりません。");
                if(image){
                    if(input.file)tx.objectStore("resourceFiles").put({id:image.sha256,blob:input.file});
                    else if(!previous&&!await request(tx.objectStore("resourceFiles").get(image.sha256)))throw new Error("画像の原本を選んでください。");
                }
                if(previous?.url!==resource.url||resource.deletedAt)tx.objectStore("resourceJobs").delete(id);
                tx.objectStore("resources").put(resource);await queue(tx,resource);
                if(!input.id)tx.objectStore("drafts").delete("collect-composer");
                return resource;
            });emit();return saved;
        },
        async updateResource(id,changes,expectedRevision){
            const resource=(await readAll<Resource>("resources")).find(value=>value.id===id);if(!resource)throw new ConflictError();
            return repo.saveResource({...resource,...changes,id,url:changes.url===undefined?resource.url??"":changes.url??"",sourceUrl:changes.sourceUrl===undefined?resource.sourceUrl??"":changes.sourceUrl??""},expectedRevision);
        },
        async getResourceFile(id){
            const tx=transaction(["resources","resourceFiles"],"readonly");
            return atomic(tx,async()=>{const resource=await request(tx.objectStore("resources").get(id)) as Resource|undefined;if(!resource?.image)return null;const stored=await request(tx.objectStore("resourceFiles").get(resource.image.sha256));return stored?.blob??null;});
        },
        async cacheResourceFile(id,file){
            const resource=(await readAll<Resource>("resources")).find(value=>value.id===id);if(!resource?.image)throw new Error("画像資料が見つかりません。");
            const image=await prepareResourceImage(file,resource.image.filename);
            if(image.sha256!==resource.image.sha256||image.size!==resource.image.size||image.mimeType!==resource.image.mimeType)throw new Error("取得した原本が一致しません。");
            const tx=transaction(["resources","resourceFiles"]);
            await atomic(tx,async()=>{const latest=await request(tx.objectStore("resources").get(id)) as Resource|undefined;if(!latest?.image||latest.image.sha256!==image.sha256)throw new Error("画像資料が更新されました。");tx.objectStore("resourceFiles").put({id:image.sha256,blob:file});});emit();
        },
        async duplicateResources(input,excludeId){
            const url=input.url?canonicalResourceUrl(input.url):null;
            return (await readAll<Resource>("resources")).filter(resource=>!resource.deletedAt&&resource.id!==excludeId&&
                ((!!url&&!!resource.url&&canonicalResourceUrl(resource.url)===url)||(!!input.image&&resource.image?.sha256===input.image.sha256)));
        },
        async startResourceMetadata(id,expectedRevision){
            const tx=transaction();
            const job=await atomic(tx,async()=>{
                const resource=await request(tx.objectStore("resources").get(id)) as Resource|undefined;
                if(!resource||resource.deletedAt||resource.localRevision!==expectedRevision)throw new ConflictError();
                if(resource.resourceType!=="link"||!resource.url)throw new Error("URLの資料を選んでください。");
                const job:ResourceMetadataJob={id,resourceId:id,token:crypto.randomUUID(),url:resource.url,createdAt:new Date().toISOString()};
                const next:Resource={...resource,metadata:{...resource.metadata,status:"pending"},localRevision:resource.localRevision+1,updatedAt:new Date().toISOString()};
                tx.objectStore("resourceJobs").put(job);tx.objectStore("resources").put(next);await queue(tx,next);return job;
            });emit();return job;
        },
        async finishResourceMetadata(id,token,result){
            const tx=transaction();
            const saved=await atomic(tx,async()=>{
                const job=await request(tx.objectStore("resourceJobs").get(id)) as ResourceMetadataJob|undefined;
                const resource=await request(tx.objectStore("resources").get(id)) as Resource|undefined;
                if(!job||job.token!==token)return null;
                if(!resource||resource.deletedAt||resource.url!==job.url){tx.objectStore("resourceJobs").delete(id);return null;}
                const next=parseResource({...resource,metadata:result?{status:"ready",title:result.title,description:result.description,fetchedAt:new Date().toISOString()}:{...resource.metadata,status:"failed"},
                    localRevision:resource.localRevision+1,updatedAt:new Date().toISOString()});
                tx.objectStore("resourceJobs").delete(id);tx.objectStore("resources").put(next);await queue(tx,next);return next;
            });if(saved)emit();return saved;
        },
        async getResourceMetadataJob(id){
            const tx=transaction(["resourceJobs"],"readonly");return atomic(tx,async()=>await request(tx.objectStore("resourceJobs").get(id)) as ResourceMetadataJob??null);
        },
        async exportCollectBackup(ids){
            const tx=transaction(["resources","spaces","resourceFiles","conflicts"],"readonly");
            const stored=await atomic(tx,async()=>{
                const resources=await request(tx.objectStore("resources").getAll()) as Resource[];
                const conflicts=await request(tx.objectStore("conflicts").getAll()) as SyncConflict[];
                const selected=resources.filter(resource=>!ids||ids.includes(resource.id));
                for(const conflict of conflicts)if("kind" in conflict.local&&conflict.local.kind==="resource"&&(!ids||ids.includes(conflict.entityId)))selected.push({...conflict.local,id:crypto.randomUUID()});
                const spaces=await request(tx.objectStore("spaces").getAll()) as Space[];
                const files: {image:ResourceImage;blob:Blob}[]=[];const seen=new Set<string>();let total=0;
                for(const resource of selected)if(resource.image&&!seen.has(resource.image.sha256)){
                    const file=await request(tx.objectStore("resourceFiles").get(resource.image.sha256));
                    if(!file?.blob)throw new Error("原本の画像を取得してからバックアップしてください。");
                    total+=resource.image.size;if(total>MAX_COLLECT_BACKUP_BYTES)throw new Error("画像の合計が32MBを超えています。資料ごとに分けて書き出してください。");
                    seen.add(resource.image.sha256);files.push({image:resource.image,blob:file.blob});
                }
                return {resources:selected,spaces,files};
            });
            const backup:CollectBackup={format:"personal-tools.collect",version:1,exportedAt:new Date().toISOString(),
                resources:stored.resources.map(resource=>({...resource,ownerId:null,serverRevision:null})),
                spaces:stored.spaces.map(space=>({id:space.id,name:space.name,color:space.color,createdAt:space.createdAt})),
                files:await Promise.all(stored.files.map(async file=>({...file.image,data:await blobToBase64(file.blob)})))};
            if(new TextEncoder().encode(JSON.stringify(backup,null,2)).byteLength>MAX_COLLECT_BACKUP_JSON_BYTES)throw new Error("バックアップが64MBを超えています。資料ごとに分けて書き出してください。");
            return backup;
        },
        async importCollectBackup(input){
            const data=parseCollectBackup(input),files=await Promise.all(data.files.map(async file=>{
                const blob=base64ToBlob(file.data,file.mimeType),image=await prepareResourceImage(blob,file.filename);
                if(image.sha256!==file.sha256||image.size!==file.size||image.mimeType!==file.mimeType)throw new Error("バックアップの原本画像が一致しません。");
                return {image,blob};
            }));
            const tx=transaction();
            await atomic(tx,async()=>{
                const spaces=new Map<string,string>();
                for(const space of data.spaces){const id=crypto.randomUUID();spaces.set(space.id,id);const saved:Space={...space,id,...(ownerId?{ownerId,serverRevision:null,localRevision:1}:{})};tx.objectStore("spaces").put(saved);await queue(tx,saved);}
                for(const file of files)tx.objectStore("resourceFiles").put({id:file.image.sha256,blob:file.blob});
                for(const resource of data.resources){
                    const saved=parseResource({...resource,id:crypto.randomUUID(),ownerId,spaceIds:resource.spaceIds.map(id=>spaces.get(id)!),serverRevision:null,localRevision:1,
                        metadata:resource.metadata.status==="pending"?{...resource.metadata,status:"none"}:resource.metadata});
                    tx.objectStore("resources").put(saved);await queue(tx,saved);
                }
            });emit();return {resources:data.resources.length,spaces:data.spaces.length};
        },
        async saveNote(input, expectedRevision) {
            if (!input.body.trim() || input.body.length > 100000)
                throw new Error("メモは1〜100,000文字で入力してください。");
            const tx = transaction();
            const id = input.id ?? crypto.randomUUID();
            const note = await atomic(tx, async () => {
                const previous = await request(tx.objectStore("notes").get(id)) as Note | undefined;
                if ((input.id && !previous) || (previous && expectedRevision !== previous.localRevision))
                    throw new ConflictError();
                const spaces = await request(tx.objectStore("spaces").getAllKeys());
                if (input.spaceIds.some(spaceId => !spaces.includes(spaceId)))
                    throw new Error("スペースが見つかりません。");
                const now = new Date().toISOString();
                const saved: Note = {
                    id, kind: "note", originApp: "recall", ownerId, body: input.body.trim(), spaceIds: [...new Set(input.spaceIds)], pinned: input.pinned ?? previous?.pinned ?? false, createdAt: previous?.createdAt ?? now, updatedAt: now, deletedAt: input.deletedAt === undefined ? previous?.deletedAt ?? null : input.deletedAt, localRevision: (previous?.localRevision ?? 0) + 1, serverRevision: previous?.serverRevision ?? null
                };
                tx.objectStore("notes").put(saved);
                await queue(tx, saved);
                if (!input.id)
                    tx.objectStore("drafts").delete("composer");
                return saved;
            });
            emit();
            return note;
        },
        async createSpace(spaceName) {
            spaceName = spaceName.trim();
            if (!spaceName || spaceName.length > 40)
                throw new Error("スペース名は1〜40文字で入力してください。");
            const tx = transaction();
            const saved = await atomic(tx, async () => {
                const existing = await request(tx.objectStore("spaces").getAll()) as Space[];
                if (existing.some(s => s.name.normalize("NFKC") === spaceName.normalize("NFKC")))
                    throw new Error("同じ名前のスペースがあります。");
                const space: Space = {
                    id: crypto.randomUUID(), name: spaceName, color: ["#729379", "#8b7bae", "#b38c58", "#638eaa"][existing.length % 4], createdAt: new Date().toISOString(), ...(ownerId ? {
                        ownerId, localRevision: 1, serverRevision: null
                    } : {})
                };
                tx.objectStore("spaces").put(space);
                await queue(tx, space);
                return space;
            });
            emit();
            return saved;
        },
        async exportBackup() {
            return portable(await repo.snapshot());
        },
        async importBackup(input) {
            const data = parseBackup(input);
            const tx = transaction();
            const result = await atomic(tx, async () => {
                const spaceMap = new Map<string, string>();
                for (const space of data.spaces) {
                    const id = crypto.randomUUID();
                    spaceMap.set(space.id, id);
                    const imported: Space = {
                        ...space, id, ...(ownerId ? {
                            ownerId, localRevision: 1, serverRevision: null
                        } : {})
                    };
                    tx.objectStore("spaces").put(imported);
                    await queue(tx, imported);
                }
                for (const note of data.notes) {
                    const imported: Note = {
                        ...note, id: crypto.randomUUID(), ownerId, spaceIds: note.spaceIds.map(id => spaceMap.get(id)!), localRevision: 1, serverRevision: null
                    };
                    tx.objectStore("notes").put(imported);
                    await queue(tx, imported);
                }
                return {
                    notes: data.notes.length, spaces: data.spaces.length
                };
            });
            emit();
            return result;
        },
    };
    if (!ownerId)
        return repo;
    const account: AccountRecallRepository = {
        ...repo, ownerId,
        async exportBackup() {
            const tx = transaction(["notes", "spaces", "conflicts"], "readonly");
            return atomic(tx, async () => {
                const [notes, spaces, conflicts] = await Promise.all([
                    request(tx.objectStore("notes").getAll()) as Promise<Note[]>,
                    request(tx.objectStore("spaces").getAll()) as Promise<Space[]>,
                    request(tx.objectStore("conflicts").getAll()) as Promise<SyncConflict[]>,
                ]);
                // Unresolved local edits must survive an export, including edits newer than
                // the first operation that the server rejected. Give those versions new IDs.
                const localSpaceIds = new Map<string, string>();
                for (const conflict of conflicts) {
                    if (entityOf(conflict.local) === "space") {
                        const local = conflict.local as Space;
                        const id = crypto.randomUUID();
                        localSpaceIds.set(local.id, id);
                        spaces.push({ ...local, id });
                    }
                }
                for (const conflict of conflicts) {
                    if (isNote(conflict.local)) {
                        notes.push({
                            ...conflict.local,
                            id: crypto.randomUUID(),
                            spaceIds: conflict.local.spaceIds.map(id => localSpaceIds.get(id) ?? id),
                        });
                    }
                }
                return portable({ notes, spaces });
            });
        },
        async getSyncState() {
            const tx = transaction(["syncOutbox", "conflicts", "meta"], "readonly");
            return atomic(tx, async () => {
                const [pending, conflicts, cursor, last] = await Promise.all([request(tx.objectStore("syncOutbox").getAll()) as Promise<StoredOperation[]>, request(tx.objectStore("conflicts").getAll()) as Promise<SyncConflict[]>, request(tx.objectStore("meta").get("cursor")), request(tx.objectStore("meta").get("lastSyncedAt"))]);
                return {
                    pending: pending.length, pendingItemIds: [...new Set(pending.filter(o => o.kind !== "put_space").map(o => o.entityId))], conflicts, cursor: String(cursor?.value ?? "0"), lastSyncedAt: last?.value ?? null
                };
            });
        },
        async pendingOperations() {
            return (await readAll<StoredOperation>("syncOutbox")).sort((a, b) => a.sequence - b.sequence);
        },
        async acceptPush(operation, result) {
            if (result.operationId !== operation.id || result.record.id !== operation.entityId || result.record.ownerId !== ownerId)
                throw new Error("同期応答のアカウントまたはメモが一致しません。");
            const tx = transaction();
            await atomic(tx, async () => {
                const persisted = await request(tx.objectStore("syncOutbox").get(operation.id)) as StoredOperation | undefined;
                if (!persisted)
                    return;
                const entity = operation.kind.slice(4) as SyncConflict["entity"];
                const target = storeOf(entity);
                const previous = await request(tx.objectStore(target).get(operation.entityId)) as SyncRecord | undefined;
                const deferredKey = `deferred:${entity}:${operation.entityId}`;
                const deferred = await request(tx.objectStore("meta").get(deferredKey)) as { id: string; value: SyncRecord } | undefined;
                // A different app may have pulled a newer remote while this immutable
                // operation was in flight. Its cursor already committed, so retain that
                // full record until all local operations on the entity are acknowledged.
                const remote = deferred && revision(deferred.value) > revision(result.record) ? deferred.value : result.record;
                const allPending = await request(tx.objectStore("syncOutbox").getAll()) as StoredOperation[];
                const later = allPending.filter(o => o.kind === operation.kind && o.entityId === operation.entityId && o.sequence > operation.sequence);
                if (result.status === "conflict") {
                    const conflict: SyncConflict = {
                        id: result.conflictId ?? operation.id, entity, entityId: operation.entityId, local: copy(previous ?? operation.payload), remote: copy(remote), createdAt: new Date().toISOString()
                    };
                    tx.objectStore("conflicts").put(conflict);
                    for (const pending of allPending)
                        if (pending.kind === operation.kind && pending.entityId === operation.entityId)
                            tx.objectStore("syncOutbox").delete(pending.id);
                    tx.objectStore(target).put({
                        ...remote, localRevision: (previous?.localRevision ?? 0) + 1
                    });
                    tx.objectStore("meta").delete(deferredKey);
                }
                else {
                    tx.objectStore("syncOutbox").delete(operation.id);
                    if (previous && later.length)
                        tx.objectStore(target).put({
                            ...previous, serverRevision: Math.max(revision(previous), revision(result.record))
                        });
                    else if (!previous || revision(remote) >= revision(previous))
                        tx.objectStore(target).put({
                            ...remote, localRevision: (previous?.localRevision ?? 1) + (previous && revision(remote) > revision(result.record) ? 1 : 0)
                        });
                    if (!later.length) tx.objectStore("meta").delete(deferredKey);
                }
                const conflicts = await request(tx.objectStore("conflicts").getAll()) as SyncConflict[];
                for (const conflict of conflicts) {
                    if (conflict.entity === entity && conflict.entityId === operation.entityId && revision(remote) > revision(conflict.remote))
                        tx.objectStore("conflicts").put({ ...conflict, remote: copy(remote) });
                }
            });
            emit();
        },
        async acceptPull(result) {
            if (!/^\d+$/.test(result.cursor))
                throw new Error("同期位置が正しくありません。");
            for (const change of result.changes)
                if (change.record.ownerId !== ownerId)
                    throw new Error("別のアカウントの同期結果を拒否しました。");
            const tx = transaction();
            await atomic(tx, async () => {
                const currentCursor = await request(tx.objectStore("meta").get("cursor"));
                if (BigInt(result.cursor) < BigInt(String(currentCursor?.value ?? "0")))
                    return;
                const pending = await request(tx.objectStore("syncOutbox").getAll()) as StoredOperation[];
                const conflicts = await request(tx.objectStore("conflicts").getAll()) as SyncConflict[];
                for (const change of result.changes) {
                    const target = storeOf(change.entity);
                    const kind = `put_${change.entity}`;
                    for (const conflict of conflicts) {
                        if (conflict.entity === change.entity && conflict.entityId === change.record.id && revision(change.record) > revision(conflict.remote)) {
                            conflict.remote = copy(change.record);
                            tx.objectStore("conflicts").put(conflict);
                        }
                    }
                    const deferredKey = `deferred:${change.entity}:${change.record.id}`;
                    if (pending.some(op => op.kind === kind && op.entityId === change.record.id)) {
                        const deferred = await request(tx.objectStore("meta").get(deferredKey)) as { id: string; value: SyncRecord } | undefined;
                        if (!deferred || revision(change.record) > revision(deferred.value))
                            tx.objectStore("meta").put({ id: deferredKey, value: copy(change.record) });
                        continue;
                    }
                    const deferred = await request(tx.objectStore("meta").get(deferredKey)) as { id: string; value: SyncRecord } | undefined;
                    const remote = deferred && revision(deferred.value) > revision(change.record) ? deferred.value : change.record;
                    const previous = await request(tx.objectStore(target).get(change.record.id)) as SyncRecord | undefined;
                    if (!previous || revision(remote) > revision(previous))
                        tx.objectStore(target).put({
                            ...remote, localRevision: (previous?.localRevision ?? 0) + 1
                        });
                    tx.objectStore("meta").delete(deferredKey);
                }
                tx.objectStore("meta").put({
                    id: "cursor", value: result.cursor
                });
            });
            emit();
        },
        async markSynced() {
            const tx = transaction();
            await atomic(tx, async () => {
                if (!(await request(tx.objectStore("syncOutbox").count())) && !(await request(tx.objectStore("conflicts").count())))
                    tx.objectStore("meta").put({
                        id: "lastSyncedAt", value: new Date().toISOString()
                    });
            });
            emit();
        },
        async importDeviceData() {
            const device = await openRecallRepository();
            try {
                return await repo.importBackup(await device.exportBackup());
            }
            finally {
                device.close();
            }
        },
        async resolveConflict(id, resolution) {
            const tx = transaction();
            await atomic(tx, async () => {
                const conflict = await request(tx.objectStore("conflicts").get(id)) as SyncConflict | undefined;
                if (!conflict)
                    return;
                if (resolution === "keep_both") {
                    const local = conflict.local;
                    const newId = crypto.randomUUID();
                    const saved: SyncRecord = "kind" in local && local.kind === "relation" ? {
                        ...local, ownerId, deletedAt: null, updatedAt: new Date().toISOString(),
                        serverRevision: conflict.remote.serverRevision ?? null,
                        localRevision: (conflict.remote.localRevision ?? 0) + 1,
                    } : "kind" in local ? {
                        ...local, id: newId, ownerId, deletedAt: null, localRevision: 1, serverRevision: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
                    } : {
                        ...local, id: newId, ownerId, localRevision: 1, serverRevision: null, createdAt: new Date().toISOString()
                    };
                    tx.objectStore(storeOf(entityOf(saved))).put(saved);
                    await queue(tx, saved);
                }
                tx.objectStore("conflicts").delete(id);
            });
            emit();
        },
    };
    return account;
}
