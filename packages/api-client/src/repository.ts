import {trashIsExpired} from "@personal-tools/core";
import { parseBackup, parseSketchStrokes, parseSketchSpaceIds, parseSketchBackup, assertSketchSyncBudget, jsonbByteLength, parseResource, parseResourceImage, parseCollectDraft, parseCollectBackup, resourceUrl, canonicalResourceUrl, emptyResourceMetadata, MAX_COLLECT_BACKUP_BYTES, MAX_COLLECT_BACKUP_JSON_BYTES, type Resource, type CollectDraft, type CollectBackup, type ResourceImage, type ResourceMetadataJob, type Backup, type SketchBackup, type Sketch, type SketchDraft, type ItemRelation, type SyncRecord, type Note, type Space, type LocalOperation, type SyncOperation, type SyncConflict, type SyncPushResult, type SyncPullResult } from "@personal-tools/core";
import {prepareResourceImage,prepareResourceFile,blobToBase64,base64ToBlob} from "./resource-files.ts";
import {resourceOriginal,parseResourceFile,parseResourceDrive,type ResourceFile,type ResourceDrive} from "@personal-tools/core";
import {requireVault,assertVault} from "./vault.ts";
import {encryptedTransaction,migrateEncryptedDatabase} from "./vault-idb.ts";
import {RELATION_TYPES,parseProjectFields,parseTags,type AtlasProject,type ItemLabels,type RelationType,type AtlasItem} from "@personal-tools/core";
import {ATLAS_REQUESTS_SPACE_NAME,type AtlasRequestSharing,type AtlasRequestsExport} from "@personal-tools/core";
import {createRepositoryLifecycle} from "./repository-lifecycle.ts";
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
export type SuiteSnapshot = { notes: Note[]; spaces: Space[]; sketches: Sketch[]; relations: ItemRelation[];resources:Resource[];projects:AtlasProject[];labels:ItemLabels[] };
export type SaveResourceInput = Omit<CollectDraft,"editingId"|"expectedRevision"> & {id?:string;newId?:string;preserveDraft?:boolean;file?:Blob;pinned?:boolean;deletedAt?:string|null;metadata?:Resource["metadata"]};
export type ResourceChanges = Partial<Pick<Resource,"title"|"memo"|"url"|"sourceUrl"|"spaceIds"|"inbox"|"pinned"|"deletedAt">>;
export type CollectDriveSettings={folderId:string;folderName:string;accountId:string;target:"vault"|"drive"};
export type SyncState = {
    pending: number;
    pendingItemIds: string[];
    conflicts: SyncConflict[];
    cursor: string;
    lastSyncedAt: string | null;
};
export interface RecallRepository {
    deleteSpace(id:string):Promise<void>;
    setItemProjects(itemId:string,projectIds:string[]):Promise<void>;
    purgeExpired(force?:boolean):Promise<number>;
    loadAtlasRequestSharing(): Promise<AtlasRequestSharing | null>;
    prepareAtlasRequestSharing(spaceId?: string): Promise<AtlasRequestSharing>;
    disableAtlasRequestSharing(): Promise<void>;
    exportAtlasRequests(): Promise<AtlasRequestsExport>;
    loadRecallEditDraft():Promise<{noteId:string;body:string;spaceIds:string[];revision:number}|null>;
    saveRecallEditDraft(value:{noteId:string;body:string;spaceIds:string[];revision:number}|null):Promise<void>;
    snapshot(): Promise<SuiteSnapshot>;
    loadDraft(): Promise<{
        body: string;
        spaceIds: string[];
    }>;
    saveDraft(body: string, spaceIds: string[]): Promise<void>;
    saveNote(input: SaveNoteInput, expectedRevision?: number): Promise<Note>;
    saveSketch(input: SaveSketchInput, expectedRevision?: number): Promise<Sketch>;
    updateSketch(id: string, changes: Partial<Pick<Sketch, "title" | "strokes" | "spaceIds" | "pinned" | "deletedAt">>, expectedRevision: number): Promise<Sketch>;
    saveRelation(input: { fromItemId: string; toItemId: string; type: RelationType }): Promise<ItemRelation>;
    saveProject(input: Pick<AtlasProject,"name"|"description"|"status"|"dueDate"|"itemIds"> & {id?:string;deletedAt?:string|null}, expectedRevision?:number):Promise<AtlasProject>;
    saveLabels(id:string,tags:string[],expectedRevision?:number):Promise<ItemLabels>;
    exportAtlasBackup():Promise<{format:"personal-tools.atlas";version:1;exportedAt:string;projects:AtlasProject[];labels:ItemLabels[];relations:ItemRelation[]}>;
    deleteRelation(id: string, expectedRevision: number): Promise<void>;
    loadSketchDraft(): Promise<SketchDraft>;
    saveSketchDraft(draft: SketchDraft): Promise<void>;
    exportSketchBackup(): Promise<SketchBackup>;
    importSketchBackup(input: unknown): Promise<{ sketches: number; spaces: number }>;
    saveResource(input:SaveResourceInput,expectedRevision?:number):Promise<Resource>;
    updateResource(id:string,changes:ResourceChanges&Pick<Partial<Resource>,"text"|"drive">,expectedRevision:number):Promise<Resource>;
    refreshResourceOriginal(id:string,original:ResourceFile,file:Blob|undefined,expectedRevision:number,drive?:ResourceDrive):Promise<Resource>;
    loadCollectDriveSettings():Promise<CollectDriveSettings|null>;
    saveCollectDriveSettings(settings:CollectDriveSettings|null):Promise<void>;
    evictResourceFile(id:string):Promise<void>;
    loadCollectDraft():Promise<CollectDraft>;
    saveCollectDraft(draft:CollectDraft,file?:Blob|null):Promise<void>;
    getCollectDraftFile():Promise<Blob|null>;
    getResourceFile(id:string):Promise<Blob|null>;
    cacheResourceFile(id:string,file:Blob):Promise<void>;
    duplicateResources(input:{url?:string|null;image?:ResourceImage|null;original?:ResourceFile|null},excludeId?:string):Promise<Resource[]>;
    startResourceMetadata(id:string,expectedRevision:number):Promise<ResourceMetadataJob>;
    finishResourceMetadata(id:string,token:string,result:{title:string;description:string}|null):Promise<Resource|null>;
    getResourceMetadataJob(id:string):Promise<ResourceMetadataJob|null>;
    exportCollectBackup(ids?:string[],options?:{mode?:"originals"|"references"}):Promise<CollectBackup>;
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
    isEncryptedSyncReady():Promise<boolean>;
    prepareEncryptedSync(records:SyncRecord[],mode?:"legacy"|"existing"):Promise<void>;
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
const STORES = ["notes", "spaces", "sketches", "relations", "resources", "projects", "labels", "resourceFiles", "resourceJobs", "outbox", "drafts", "syncOutbox", "conflicts", "meta"];
const DEFAULT_SPACES = [["daily", "日常", "#729379"], ["creative", "創作", "#8b7bae"], ["research", "研究", "#b38c58"]] as const;
const ATLAS_REQUEST_SHARING_KEY = "atlas-request-sharing";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const copy = <T>(value: T): T => structuredClone(value);
const sameResourceImage=(a:ResourceFile|null,b:ResourceFile|null)=>a===null||b===null?a===b:
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
const entityOf = (record: SyncRecord) => "kind" in record ? record.kind : "space";
const storeOf = (entity: string) => ({ note: "notes", space: "spaces", sketch: "sketches", relation: "relations",resource:"resources",project:"projects",labels:"labels" }[entity]!);
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
export async function migrateVaultDatabases(){
    const vault=requireVault();
    if(!indexedDB.databases)throw new Error("このブラウザは既存データの暗号化移行に対応していません。対応ブラウザで開いてください。");
    for(const entry of await indexedDB.databases()){
        if(!entry.name?.startsWith("personal-tools-recall-"))continue;
        const name=entry.name;
        const db=await new Promise<IDBDatabase>((resolve,reject)=>{let blocked=false;const r=indexedDB.open(name,6);r.onupgradeneeded=()=>{for(const store of STORES)if(!r.result.objectStoreNames.contains(store))r.result.createObjectStore(store,{keyPath:"id"});};r.onsuccess=()=>{if(blocked){r.result.close();return;}resolve(r.result);};r.onerror=()=>reject(r.error);r.onblocked=()=>{blocked=true;reject(new Error("古いツールのタブを閉じてから、もう一度解錠してください。"));};});
        try{await migrateEncryptedDatabase(db,STORES,vault);}finally{db.close();}
    }
}
export function openAccountRecallRepository(userId: string, options: {
    name?: string;
} = {}): Promise<AccountRecallRepository> {
    if (!uuidPattern.test(userId))
        return Promise.reject(new Error("アカウントを確認できません。もう一度ログインしてください。"));
    return openRepository(options.name ?? `personal-tools-recall-account-${userId.toLowerCase()}`, userId.toLowerCase()) as Promise<AccountRecallRepository>;
}
async function openRepository(name: string, ownerId: string | null): Promise<RecallRepository | AccountRecallRepository> {
    const vault=requireVault();
    if (typeof indexedDB === "undefined")
        throw new Error("このブラウザでは端末内保存を利用できません。");
    // Missing stores are created only during versionchange; the v1 device notes and drafts survive.
    // https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB
    let invalidated = false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        let blocked = false;
        const req = indexedDB.open(name, 6);
        req.onupgradeneeded = (event) => {
            for (const store of STORES)
                if (!req.result.objectStoreNames.contains(store))
                    req.result.createObjectStore(store, {
                        keyPath: "id"
                    });
            // A v3 cursor may already have passed a resource hidden from its stream.
            // Replay the full owner stream once; server revisions protect cached newer values.
            if (event.oldVersion < 5) req.transaction!.objectStore("meta").put({ id: "cursor", value: "0" });
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
    try{await migrateEncryptedDatabase(db,STORES,vault);}catch(error){db.close();throw error;}
    let closed = false;
    const listeners = new Set<() => void>();
    function ensureOpen() {
        assertVault(vault);
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
        return encryptedTransaction(db,[...new Set([...stores,"meta"])],mode,vault);
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
    const lifecycle=createRepositoryLifecycle({ownerId,transaction,queue,emit});
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
        deleteSpace:lifecycle.deleteSpace,setItemProjects:lifecycle.setItemProjects,purgeExpired:lifecycle.purgeExpired,
        async loadAtlasRequestSharing() {
            const tx = transaction(["meta"], "readonly");
            return atomic(tx, async () => {
                const entry = await request(tx.objectStore("meta").get(ATLAS_REQUEST_SHARING_KEY));
                return (entry?.value as AtlasRequestSharing | undefined) ?? null;
            });
        },
        async prepareAtlasRequestSharing(spaceId) {
            const tx = transaction();
            const sharing = await atomic(tx, async () => {
                const meta = tx.objectStore("meta"), spaces = tx.objectStore("spaces");
                const entry = await request(meta.get(ATLAS_REQUEST_SHARING_KEY));
                if (entry) {
                    const current = entry.value as AtlasRequestSharing;
                    if (spaceId && spaceId !== current.spaceId)
                        throw new Error("共有元を変更するには、先にCodex向けの共有設定を解除してください。");
                    if (!await request(spaces.get(current.spaceId)))
                        throw new Error("共有元のスペースが見つかりません。共有設定を解除して設定し直してください。");
                    return current;
                }
                const existing = await request(spaces.getAll()) as Space[];
                const candidates = existing.filter(space => space.name.normalize("NFKC") === ATLAS_REQUESTS_SPACE_NAME);
                if (!spaceId && candidates.length > 1)
                    throw new Error("同名のスペースが複数あります。共有元のAtlas要望スペースを選んでください。");
                let space = spaceId ? candidates.find(space => space.id === spaceId) : candidates[0];
                if (spaceId && !space)
                    throw new Error("共有元にはAtlas要望スペースだけを指定できます。");
                if (!space) {
                    space = {
                        id: crypto.randomUUID(), name: ATLAS_REQUESTS_SPACE_NAME, color: "#638eaa",
                        createdAt: new Date().toISOString(), ...(ownerId ? {ownerId, localRevision: 1, serverRevision: null} : {})
                    };
                    spaces.put(space);
                    await queue(tx, space);
                }
                const value: AtlasRequestSharing = {spaceId: space.id, shareId: crypto.randomUUID()};
                meta.put({id: ATLAS_REQUEST_SHARING_KEY, value});
                return value;
            });
            emit();
            return sharing;
        },
        async disableAtlasRequestSharing() {
            const tx = transaction(["meta"]);
            await atomic(tx, () => {tx.objectStore("meta").delete(ATLAS_REQUEST_SHARING_KEY);});
            emit();
        },
        async exportAtlasRequests() {
            const tx = transaction(["meta", "spaces", "notes"], "readonly");
            const result = await atomic(tx, async (): Promise<AtlasRequestsExport> => {
                const entry = await request(tx.objectStore("meta").get(ATLAS_REQUEST_SHARING_KEY));
                if (!entry) throw new Error("Atlas要望の共有元を先に設定してください。");
                const sharing = entry.value as AtlasRequestSharing;
                if (!await request(tx.objectStore("spaces").get(sharing.spaceId)))
                    throw new Error("共有元のスペースが見つかりません。共有設定を解除して設定し直してください。");
                // This runs only inside the unlocked Recall client. Never use
                // exportBackup/snapshot or spread records into this public data.
                const notes = await request(tx.objectStore("notes").getAll()) as Note[];
                return {
                    format: "personal-tools.atlas-requests", version: 1, mode: "snapshot",
                    scope: ATLAS_REQUESTS_SPACE_NAME, shareId: sharing.shareId, exportedAt: new Date().toISOString(),
                    notes: notes.filter(note => !note.deletedAt && note.spaceIds.includes(sharing.spaceId))
                        .map(note => ({id: note.id, body: note.body, updatedAt: note.updatedAt}))
                        .sort((a, b) => a.id.localeCompare(b.id))
                };
            });
            ensureOpen();
            return result;
        },
        async loadRecallEditDraft(){const tx=transaction(["drafts"],"readonly");return atomic(tx,async()=>{const d=await request(tx.objectStore("drafts").get("recall-edit"));return d?.value??null;});},
        async saveRecallEditDraft(value){const tx=transaction(["drafts","notes"]);await atomic(tx,async()=>{if(value){await lifecycle.assertEditable(tx,"note",value.noteId);tx.objectStore("drafts").put({id:"recall-edit",value:{...value,spaceIds:await lifecycle.filterSpaceIds(tx,value.spaceIds)}});}else tx.objectStore("drafts").delete("recall-edit");});},
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
            await atomic(tx, async () => {
                tx.objectStore("drafts").put({
                    id: "composer", body, spaceIds:await lifecycle.filterSpaceIds(tx,spaceIds)
                });
            });
        },
        async snapshot() {
            await lifecycle.purgeExpired();
            const tx = transaction(["notes", "spaces", "sketches", "relations","resources","projects","labels"], "readonly");
            return atomic(tx, async () => {
                const [notes, spaces, sketches, relations,resources] = await Promise.all([request(tx.objectStore("notes").getAll()) as Promise<Note[]>, request(tx.objectStore("spaces").getAll()) as Promise<Space[]>, request(tx.objectStore("sketches").getAll()) as Promise<Sketch[]>, request(tx.objectStore("relations").getAll()) as Promise<ItemRelation[]>,request(tx.objectStore("resources").getAll()) as Promise<Resource[]>]);
                return {
                    notes:notes.filter(r=>!trashIsExpired(r)), spaces:spaces.filter(r=>!r.deletedAt), sketches:sketches.filter(r=>!trashIsExpired(r)), relations,resources:resources.filter(r=>!trashIsExpired(r)),projects:await request(tx.objectStore("projects").getAll()) as AtlasProject[],labels:await request(tx.objectStore("labels").getAll()) as ItemLabels[]
                };
            });
        },
        async loadSketchDraft() {
            const tx = transaction(["drafts"], "readonly");
            return atomic(tx, async () => {
                const draft = await request(tx.objectStore("drafts").get("sketch-composer"));
                return draft ? { title: draft.title, strokes: draft.strokes, spaceIds: draft.spaceIds,
                    ...(draft.sourceNoteId ? { sourceNoteId:draft.sourceNoteId } : {}),
                    ...(draft.editingId ? { editingId: draft.editingId, expectedRevision: draft.expectedRevision } : {}) } : { title: "", strokes: [], spaceIds: [] };
            });
        },
        async saveSketchDraft(draft) {
            if (typeof draft.title !== "string" || draft.title.length > 120) throw new Error("タイトルは120文字以内で入力してください。");
            const strokes = parseSketchStrokes(draft.strokes);
            const spaceIds = parseSketchSpaceIds(draft.spaceIds);
            jsonbByteLength(draft.title);
            if(draft.sourceNoteId&&!uuidPattern.test(draft.sourceNoteId))throw new Error("下書きの関連メモを確認してください。");
            const tx = transaction(["drafts","sketches"]);
            if (draft.editingId && (!uuidPattern.test(draft.editingId) || !Number.isSafeInteger(draft.expectedRevision) || Number(draft.expectedRevision) < 1)) throw new Error("下書きの更新番号が正しくありません。");
            await atomic(tx, async () => {if(draft.editingId)await lifecycle.assertEditable(tx,"sketch",draft.editingId);tx.objectStore("drafts").put({ id: "sketch-composer", title: draft.title, strokes, spaceIds:await lifecycle.filterSpaceIds(tx,spaceIds), ...(draft.sourceNoteId?{sourceNoteId:draft.sourceNoteId}:{}), ...(draft.editingId ? { editingId: draft.editingId, expectedRevision: draft.expectedRevision } : {}) }); });
        },
        async saveSketch(input, expectedRevision) {
            if (typeof input.title !== "string" || input.title.length > 120) throw new Error("タイトルは120文字以内で入力してください。");
            const strokes = parseSketchStrokes(input.strokes);
            const spaceIds = parseSketchSpaceIds(input.spaceIds);
            if (input.deletedAt !== undefined && input.deletedAt !== null && !Number.isFinite(Date.parse(input.deletedAt))) throw new Error("削除日時が正しくありません。");
            const tx = transaction(), id = input.id ?? crypto.randomUUID();
            const saved = await atomic(tx, async () => {
                const previous = await request(tx.objectStore("sketches").get(id)) as Sketch | undefined;
                await lifecycle.assertEditable(tx,"sketch",id,previous);
                if ((input.id && !previous) || (previous && (expectedRevision ?? input.expectedRevision) !== previous.localRevision)) throw new ConflictError();
                const spaces = await request(tx.objectStore("spaces").getAllKeys()),filteredSpaceIds=await lifecycle.filterSpaceIds(tx,spaceIds);
                if (filteredSpaceIds.some(spaceId => !spaces.includes(spaceId))) throw new Error("スペースが見つかりません。");
                const now = new Date().toISOString();
                const sketch: Sketch = { id, kind: "sketch", originApp: "sketchbook", ownerId, title: input.title.trim(), width: 1200, height: 800,
                    strokes, spaceIds:filteredSpaceIds, pinned: input.pinned ?? previous?.pinned ?? false,
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
            if (!RELATION_TYPES.includes(input.type) || input.fromItemId === input.toItemId) throw new Error("別の記録と関係を選んでください。");
            if(input.type==="related_to"&&input.fromItemId>input.toItemId)input={...input,fromItemId:input.toItemId,toItemId:input.fromItemId};
            // Independent devices derive the same edge ID before opening the IDB transaction.
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${input.type}:${input.fromItemId}:${input.toItemId}`)));
            digest[6] = (digest[6] & 15) | 80; digest[8] = (digest[8] & 63) | 128;
            const hex = [...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
            const edgeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            const tx = transaction();
            const saved = await atomic(tx, async () => {
                for(const itemId of [input.fromItemId,input.toItemId]){
                    const candidates=await Promise.all(["notes","sketches","resources"].map(store=>request(tx.objectStore(store).get(itemId)) as Promise<AtlasItem|undefined>));
                    if(!candidates.some(item=>item&&!item.deletedAt&&item.ownerId===ownerId))throw new Error("関連付ける記録が見つかりません。");
                }
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
        async saveProject(input,expectedRevision){
            const fields=parseProjectFields(input),tx=transaction();
            const saved=await atomic(tx,async()=>{
                const previous=input.id?await request(tx.objectStore("projects").get(input.id)) as AtlasProject|undefined:undefined;
                if(input.id&&(!previous||previous.localRevision!==expectedRevision))throw new ConflictError();
                fields.itemIds=(await Promise.all(fields.itemIds.map(async id=>({id,purged:await Promise.all(["note","sketch","resource"].map(entity=>lifecycle.notice(tx,entity,id)))})))).filter(row=>!row.purged.some(p=>p&&!p.temporary)).map(row=>row.id);
                for(const id of fields.itemIds){
                    const items=await Promise.all(["notes","sketches","resources"].map(store=>request(tx.objectStore(store).get(id)) as Promise<AtlasItem|undefined>));
                    if(!items.some(item=>item&&item.ownerId===ownerId))throw new Error("所属する記録が見つかりません。");
                }
                const now=new Date().toISOString();
                const record:AtlasProject={...fields,id:previous?.id??crypto.randomUUID(),kind:"project",ownerId,createdAt:previous?.createdAt??now,updatedAt:now,deletedAt:input.deletedAt??null,localRevision:(previous?.localRevision??0)+1,serverRevision:previous?.serverRevision??null};
                tx.objectStore("projects").put(record);await queue(tx,record);return record;
            });emit();return saved;
        },
        async saveLabels(id,tags,expectedRevision){
            const parsed=parseTags(tags),tx=transaction();
            const saved=await atomic(tx,async()=>{
                const items=await Promise.all(["notes","sketches","resources"].map(store=>request(tx.objectStore(store).get(id)) as Promise<AtlasItem|undefined>));
                if(!items.some(item=>item&&item.ownerId===ownerId&&!item.deletedAt))throw new Error("タグを付ける記録が見つかりません。");
                const previous=await request(tx.objectStore("labels").get(id)) as ItemLabels|undefined;
                if((previous?.localRevision??undefined)!==expectedRevision)throw new ConflictError();
                const now=new Date().toISOString(),record:ItemLabels={id,kind:"labels",ownerId,tags:parsed,createdAt:previous?.createdAt??now,updatedAt:now,deletedAt:null,localRevision:(previous?.localRevision??0)+1,serverRevision:previous?.serverRevision??null};
                tx.objectStore("labels").put(record);await queue(tx,record);return record;
            });emit();return saved;
        },
        async exportAtlasBackup(){const data=await repo.snapshot();return {format:"personal-tools.atlas",version:1,exportedAt:new Date().toISOString(),projects:data.projects,labels:data.labels,relations:data.relations};},
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
            const original=resourceOriginal(draft);
            if(file){const actual=draft.resourceType==="image"?await prepareResourceImage(file,original?.filename):await prepareResourceFile(file,original?.filename);if(!original||!sameResourceImage(actual,original))throw new Error("下書きの原本が一致しません。");}
            const tx=transaction(["drafts","resourceFiles","resources"]);
            await atomic(tx,async()=>{
                draft.spaceIds=await lifecycle.filterSpaceIds(tx,draft.spaceIds);if(draft.editingId)await lifecycle.assertEditable(tx,"resource",draft.editingId);
                if(original){
                    if(file)tx.objectStore("resourceFiles").put({id:original.sha256,blob:file});
                    else if(!await request(tx.objectStore("resourceFiles").get(original.sha256))){
                        const existing=draft.editingId?await request(tx.objectStore("resources").get(draft.editingId)) as Resource|undefined:undefined;
                        if(!existing||!sameResourceImage(resourceOriginal(existing),original))throw new Error("下書きのファイルをもう一度選んでください。");
                    }
                }
                tx.objectStore("drafts").put({id:"collect-composer",...draft});
            });
        },
        async getCollectDraftFile(){
            const tx=transaction(["drafts","resourceFiles","resources"],"readonly");
            return atomic(tx,async()=>{const draft=await request(tx.objectStore("drafts").get("collect-composer"));const original=draft&&resourceOriginal(draft);if(!original)return null;if(draft.editingId){const target=await request(tx.objectStore("resources").get(draft.editingId));if(!target||trashIsExpired(target)||await lifecycle.notice(tx,"resource",draft.editingId))return null;}const stored=await request(tx.objectStore("resourceFiles").get(original.sha256));return stored?.blob??null;});
        },
        async saveResource(input,expectedRevision){
            let prepared:ResourceFile|null=null;const supplied=resourceOriginal(input);
            if(input.file){prepared=input.resourceType==="image"?await prepareResourceImage(input.file,supplied?.filename):await prepareResourceFile(input.file,supplied?.filename);if(supplied&&!sameResourceImage(prepared,supplied))throw new Error("ファイルの原本が一致しません。");}
            if(ownerId&&!input.drive&&((prepared??supplied)?.size??0)>20*1024*1024)throw new Error("暗号化クラウド保存の原本は20MBまでです。大きなファイルはDrive保存を選んでください。");
            if(input.newId!==undefined&&(!uuidPattern.test(input.newId)||input.id!==undefined))throw new Error("新しい資料のIDを確認してください。");
            const id=input.id??input.newId??crypto.randomUUID(),tx=transaction();
            const saved=await atomic(tx,async()=>{
                const previous=await request(tx.objectStore("resources").get(id)) as Resource|undefined;
                await lifecycle.assertEditable(tx,"resource",id,previous);
                if((input.id&&!previous)||(previous&&expectedRevision!==previous.localRevision))throw new ConflictError();
                const original=prepared??supplied,image=input.resourceType==="image"&&original?parseResourceImage(original):null;
                if(previous&&(previous.resourceType!==input.resourceType||!sameResourceImage(resourceOriginal(previous),original)))throw new Error("ファイルの原本を変更するときは、新しい資料として追加してください。");
                const now=new Date().toISOString(),url=resourceUrl(input.url,input.resourceType!=="link");
                const resource=parseResource({
                    id,kind:"resource",originApp:"collect",ownerId,resourceType:input.resourceType,url,sourceUrl:resourceUrl(input.sourceUrl||url,true),
                    title:input.title.trim(),memo:input.memo,spaceIds:await lifecycle.filterSpaceIds(tx,input.spaceIds),inbox:input.inbox,pinned:input.pinned??previous?.pinned??false,image,
                    metadata:previous&&previous.url!==url?emptyResourceMetadata():input.metadata??previous?.metadata??emptyResourceMetadata(),
                    createdAt:previous?.createdAt??now,updatedAt:now,deletedAt:input.deletedAt===undefined?previous?.deletedAt??null:input.deletedAt,
                    localRevision:(previous?.localRevision??0)+1,serverRevision:previous?.serverRevision??null,
                    ...(input.resourceType==="file"||input.original!==undefined?{original}:{}),...(input.text!==undefined?{text:input.text}:{}),...(input.drive!==undefined?{drive:input.drive}:{}),
                });
                const spaces=await request(tx.objectStore("spaces").getAllKeys());if(resource.spaceIds.some(spaceId=>!spaces.includes(spaceId)))throw new Error("スペースが見つかりません。");
                if(original){
                    if(input.file)tx.objectStore("resourceFiles").put({id:original.sha256,blob:input.file});
                    else if(!previous&&!input.drive&&!await request(tx.objectStore("resourceFiles").get(original.sha256)))throw new Error("ファイルの原本を選んでください。");
                }
                if(previous?.url!==resource.url||resource.deletedAt)tx.objectStore("resourceJobs").delete(id);
                tx.objectStore("resources").put(resource);await queue(tx,resource);
                if(!input.id&&!input.preserveDraft)tx.objectStore("drafts").delete("collect-composer");
                return resource;
            });emit();return saved;
        },
        async updateResource(id,changes,expectedRevision){
            const resource=(await readAll<Resource>("resources")).find(value=>value.id===id);if(!resource)throw new ConflictError();
            return repo.saveResource({...resource,...changes,id,url:changes.url===undefined?resource.url??"":changes.url??"",sourceUrl:changes.sourceUrl===undefined?resource.sourceUrl??"":changes.sourceUrl??""},expectedRevision);
        },
        async refreshResourceOriginal(id,input,file,expectedRevision,drive){
            const original=parseResourceFile(input),checkedDrive=drive?parseResourceDrive(drive):undefined;
            if(file){const actual=await prepareResourceFile(file,original.filename);if(!sameResourceImage(actual,original))throw new Error("取得したDrive原本が一致しません。");}
            const tx=transaction();const result=await atomic(tx,async()=>{
                const previous=await request(tx.objectStore("resources").get(id)) as Resource|undefined;
                if(!previous||previous.localRevision!==expectedRevision)throw new ConflictError();
                await lifecycle.assertEditable(tx,"resource",id,previous);
                if(!previous.drive||checkedDrive&&(previous.drive.fileId!==checkedDrive.fileId||previous.drive.accountId!==checkedDrive.accountId))throw new Error("Drive原本の参照先が変わりました。");
                const before=resourceOriginal(previous);
                if(!file&&before?.sha256!==original.sha256)throw new Error("変更した原本を取得してから更新してください。");
                const isImage=previous.resourceType==="image"&&["image/png","image/jpeg","image/gif","image/webp"].includes(original.mimeType)&&original.size<=20*1024*1024;
                if(isImage&&file)await prepareResourceImage(file,original.filename);
                const next=parseResource({...previous,...(previous.resourceType==="image"?{resourceType:isImage?"image":"file",image:isImage?parseResourceImage(original):null,original:isImage?undefined:original}:{original}),...(checkedDrive?{drive:checkedDrive}:{}),localRevision:previous.localRevision+1,updatedAt:new Date().toISOString()});
                tx.objectStore("resources").put(next);if(file)tx.objectStore("resourceFiles").put({id:original.sha256,blob:file});await queue(tx,next);return next;
            });emit();return result;
        },
        async loadCollectDriveSettings(){
            const tx=transaction(["meta"],"readonly");return atomic(tx,async()=>{const row=await request(tx.objectStore("meta").get("collect-drive-settings"));return row?.value??null;});
        },
        async saveCollectDriveSettings(settings){
            if(settings&&(![settings.folderId,settings.accountId].every(value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,100}$/.test(value))||typeof settings.folderName!=="string"||settings.folderName.length>255||!["vault","drive"].includes(settings.target)))throw new Error("Driveの保存先を確認してください。");
            const tx=transaction(["meta"]);await atomic(tx,async()=>{if(settings)tx.objectStore("meta").put({id:"collect-drive-settings",value:copy(settings)});else tx.objectStore("meta").delete("collect-drive-settings");});emit();
        },
        async evictResourceFile(id){
            const tx=transaction();await atomic(tx,async()=>{
                const resource=await request(tx.objectStore("resources").get(id)) as Resource|undefined,original=resource&&resourceOriginal(resource);
                if(!resource||!original||resource.drive?.status!=="ready")throw new Error("原本をDriveへ保存してから端末キャッシュを整理してください。");
                const hash=original.sha256;
                for(const draft of await request(tx.objectStore("drafts").getAll()) as any[])if((draft.original??draft.image)?.sha256===hash)throw new Error("下書きで使っている原本は端末に保持します。");
                for(const other of await request(tx.objectStore("resources").getAll()) as Resource[])if(resourceOriginal(other)?.sha256===hash&&other.drive?.status!=="ready")throw new Error("ほかの記録で使っている原本は端末に保持します。");
                for(const conflict of await request(tx.objectStore("conflicts").getAll()) as SyncConflict[])for(const version of [conflict.local,conflict.remote])if("kind" in version&&version.kind==="resource"&&resourceOriginal(version)?.sha256===hash)throw new Error("競合中の原本は端末に保持します。");
                tx.objectStore("resourceFiles").delete(hash);
            });emit();
        },
        async getResourceFile(id){
            const tx=transaction(["resources","resourceFiles"],"readonly");
            return atomic(tx,async()=>{const resource=await request(tx.objectStore("resources").get(id)) as Resource|undefined;const original=resource&&resourceOriginal(resource);if(!resource||!original||trashIsExpired(resource)||await lifecycle.notice(tx,"resource",id))return null;const stored=await request(tx.objectStore("resourceFiles").get(original.sha256));return stored?.blob??null;});
        },
        async cacheResourceFile(id,file){
            const resource=(await readAll<Resource>("resources")).find(value=>value.id===id),original=resource&&resourceOriginal(resource);if(!resource||!original)throw new Error("ファイル資料が見つかりません。");
            const image=resource.resourceType==="image"?await prepareResourceImage(file,original.filename):await prepareResourceFile(file,original.filename);
            if(!sameResourceImage(image,original))throw new Error("取得した原本が一致しません。");
            const tx=transaction(["resources","resourceFiles"]);
            await atomic(tx,async()=>{const latest=await request(tx.objectStore("resources").get(id)) as Resource|undefined;if(!latest||!sameResourceImage(resourceOriginal(latest),image)||trashIsExpired(latest)||await lifecycle.notice(tx,"resource",id))throw new Error("ファイル資料が更新されました。");tx.objectStore("resourceFiles").put({id:image.sha256,blob:file});});emit();
        },
        async duplicateResources(input,excludeId){
            const url=input.url?canonicalResourceUrl(input.url):null;
            return (await readAll<Resource>("resources")).filter(resource=>!resource.deletedAt&&resource.id!==excludeId&&
                ((!!url&&!!resource.url&&canonicalResourceUrl(resource.url)===url)||(!!(input.original??input.image)&&resourceOriginal(resource)?.sha256===(input.original??input.image)!.sha256)));
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
        async exportCollectBackup(ids,options={}){
            const mode=options.mode??"originals";
            const tx=transaction(["resources","spaces","resourceFiles","conflicts"],"readonly");
            const stored=await atomic(tx,async()=>{
                const resources=await request(tx.objectStore("resources").getAll()) as Resource[];
                const conflicts=await request(tx.objectStore("conflicts").getAll()) as SyncConflict[];
                const selected=resources.filter(resource=>!ids||ids.includes(resource.id));
                for(const conflict of conflicts)if("kind" in conflict.local&&conflict.local.kind==="resource"&&(!ids||ids.includes(conflict.entityId)))selected.push({...conflict.local,id:crypto.randomUUID()});
                const spaces=await request(tx.objectStore("spaces").getAll()) as Space[];
                const files: {image:ResourceFile;blob:Blob}[]=[];const seen=new Set<string>();let total=0;
                for(const resource of selected){const original=resourceOriginal(resource);if(mode==="originals"&&original&&!seen.has(original.sha256)){
                    const file=await request(tx.objectStore("resourceFiles").get(original.sha256));
                    if(!file?.blob)throw new Error("原本のファイルを取得してからバックアップしてください。");
                    total+=original.size;if(total>MAX_COLLECT_BACKUP_BYTES)throw new Error("原本の合計が32MBを超えています。資料ごとに分けて書き出してください。");
                    seen.add(original.sha256);files.push({image:original,blob:file.blob});
                }
                }
                return {resources:selected,spaces,files};
            });
            const modern=mode==="references"||stored.resources.some(resource=>resource.resourceType==="file"||resource.resourceType==="text"||!!resource.drive||!!resource.original);
            const backup:CollectBackup={format:"personal-tools.collect",version:modern?2:1,...(modern?{mode}:{}),exportedAt:new Date().toISOString(),
                resources:stored.resources.map(resource=>({...resource,ownerId:null,serverRevision:null})),
                spaces:stored.spaces.map(space=>({id:space.id,name:space.name,color:space.color,createdAt:space.createdAt})),
                files:await Promise.all(stored.files.map(async file=>({...file.image,data:await blobToBase64(file.blob)})))};
            if(new TextEncoder().encode(JSON.stringify(backup,null,2)).byteLength>MAX_COLLECT_BACKUP_JSON_BYTES)throw new Error("バックアップが64MBを超えています。資料ごとに分けて書き出してください。");
            return backup;
        },
        async importCollectBackup(input){
            const data=parseCollectBackup(input);
            if(ownerId&&data.resources.some(resource=>!resource.drive&&(resourceOriginal(resource)?.size??0)>20*1024*1024))throw new Error("20MBを超える原本はDrive保存先を設定してから取り込んでください。");
            const files=await Promise.all(data.files.map(async file=>{
                const blob=base64ToBlob(file.data,file.mimeType),image=data.version===1||data.resources.some(resource=>resource.resourceType==="image"&&resource.image?.sha256===file.sha256)?await prepareResourceImage(blob,file.filename):await prepareResourceFile(blob,file.filename);
                if(image.sha256!==file.sha256||image.size!==file.size||image.mimeType!==file.mimeType)throw new Error("バックアップの原本ファイルが一致しません。");
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
                await lifecycle.assertEditable(tx,"note",id,previous);
                if ((input.id && !previous) || (previous && expectedRevision !== previous.localRevision))
                    throw new ConflictError();
                const spaces = await request(tx.objectStore("spaces").getAllKeys());
                const filteredSpaceIds=await lifecycle.filterSpaceIds(tx,input.spaceIds);
                if (filteredSpaceIds.some(spaceId => !spaces.includes(spaceId)))
                    throw new Error("スペースが見つかりません。");
                const now = new Date().toISOString();
                const saved: Note = {
                    id, kind: "note", originApp: "recall", ownerId, body: input.body.trim(), spaceIds: [...new Set(filteredSpaceIds)], pinned: input.pinned ?? previous?.pinned ?? false, createdAt: previous?.createdAt ?? now, updatedAt: now, deletedAt: input.deletedAt === undefined ? previous?.deletedAt ?? null : input.deletedAt, localRevision: (previous?.localRevision ?? 0) + 1, serverRevision: previous?.serverRevision ?? null
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
    await lifecycle.purgeExpired(true);
    if (!ownerId)
        return repo;
    const account: AccountRecallRepository = {
        ...repo, ownerId,
        async isEncryptedSyncReady(){const tx=transaction(["meta"],"readonly");return atomic(tx,async()=>!!await request(tx.objectStore("meta").get("encrypted-sync")));},
        async prepareEncryptedSync(records,mode="legacy"){
            const tx=transaction();await atomic(tx,async()=>{
                if(await request(tx.objectStore("meta").get("encrypted-sync")))return;
                const pending=await request(tx.objectStore("syncOutbox").getAll()) as StoredOperation[];
                if(mode==="existing"){
                    const remotes=new Map(records.map(r=>[`${entityOf(r)}:${r.id}`,r]));
                    const pushes:SyncRecord[]=[];
                    tx.objectStore("syncOutbox").clear();tx.objectStore("meta").put({id:"cursor",value:"0"});tx.objectStore("meta").put({id:"sequence",value:0});
                    for(const target of ["spaces","notes","sketches","resources","relations","projects","labels"]){for(const local of await request(tx.objectStore(target).getAll()) as SyncRecord[]){
                        const key=`${entityOf(local)}:${local.id}`,remote=remotes.get(key),dirty=pending.some(p=>p.entityId===local.id&&p.kind===`put_${entityOf(local)}`);
                        const sameSeed=remote&&entityOf(local)==="space"&&DEFAULT_SPACES.some(([id])=>id===local.id)&&JSON.stringify({name:(local as Space).name,color:(local as Space).color})===JSON.stringify({name:(remote as Space).name,color:(remote as Space).color});
                        if(remote&&(!dirty||sameSeed)){tx.objectStore(target).put(remote);remotes.delete(key);}else{const value={...local,serverRevision:null};tx.objectStore(target).put(value);pushes.push(value);remotes.delete(key);}
                    }}
                    for(const remote of remotes.values())tx.objectStore(storeOf(entityOf(remote))).put(remote);
                    for(const value of pushes)await queue(tx,value);
                    const conflicts=await request(tx.objectStore("conflicts").getAll()) as SyncConflict[];
                    for(const conflict of conflicts){const remote=records.find(r=>r.id===conflict.entityId&&entityOf(r)===conflict.entity);if(remote)tx.objectStore("conflicts").put({...conflict,remote});}
                    tx.objectStore("meta").put({id:"encrypted-sync",value:true});return;
                }
                for(const record of records){if(record.ownerId!==ownerId)throw new Error("別の所有者の移行を拒否しました。");const target=storeOf(entityOf(record)),previous=await request(tx.objectStore(target).get(record.id)) as SyncRecord|undefined;
                    if(!previous||!pending.some(p=>p.entityId===record.id&&p.kind===`put_${entityOf(record)}`)&&revision(record)>revision(previous))tx.objectStore(target).put(record);
                }
                tx.objectStore("syncOutbox").clear();tx.objectStore("meta").put({id:"cursor",value:"0"});tx.objectStore("meta").put({id:"sequence",value:0});
                for(const target of ["spaces","notes","sketches","resources","relations","projects","labels"]){for(const record of await request(tx.objectStore(target).getAll()) as SyncRecord[]){const migrated={...record,serverRevision:null};tx.objectStore(target).put(migrated);await queue(tx,migrated);}}
                tx.objectStore("meta").put({id:"encrypted-sync",value:true});
            });emit();
        },
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
            if(result.status==="purged"){
                if(result.operationId!==operation.id||result.purged.id!==operation.entityId||result.purged.entity!==operation.kind.slice(4)||result.purged.ownerId!==ownerId)throw new Error("削除通知が同期先と一致しません。");
                const tx=transaction();await atomic(tx,()=>lifecycle.applyPurges(tx,[result.purged]));emit();return;
            }
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
                const remote = await lifecycle.sanitizeRecord(tx,deferred && revision(deferred.value) > revision(result.record) ? deferred.value : result.record);
                if(!remote){tx.objectStore("syncOutbox").delete(operation.id);return;}
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
                if(result.status==="applied"&&!later.length&&revision(remote)===revision(result.record)&&JSON.stringify(remote)!==JSON.stringify(result.record)){
                    const saved=await request(tx.objectStore(target).get(remote.id)) as SyncRecord|undefined;if(saved)await queue(tx,saved);
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
                if(result.purges?.length)await lifecycle.applyPurges(tx,result.purges);
                const pending = await request(tx.objectStore("syncOutbox").getAll()) as StoredOperation[];
                const conflicts = await request(tx.objectStore("conflicts").getAll()) as SyncConflict[];
                for (const incoming of result.changes) {
                    const clean=await lifecycle.sanitizeRecord(tx,incoming.record);if(!clean)continue;const change={...incoming,record:clean};
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
                    if (!previous || revision(remote) > revision(previous)) {
                        const saved={...remote,localRevision:(previous?.localRevision??0)+1};
                        tx.objectStore(target).put(saved);
                        if(remote===change.record&&JSON.stringify(clean)!==JSON.stringify(incoming.record))await queue(tx,saved);
                    }
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
                    await lifecycle.assertEditable(tx,conflict.entity,conflict.entityId,local);
                    const newId = crypto.randomUUID();
                    const saved: SyncRecord = "kind" in local && (local.kind === "relation" || local.kind === "labels") ? {
                        ...local, ownerId, deletedAt: null, updatedAt: new Date().toISOString(),
                        serverRevision: conflict.remote.serverRevision ?? null,
                        localRevision: (conflict.remote.localRevision ?? 0) + 1,
                    } : "kind" in local ? {
                        ...local, id: newId, ownerId, deletedAt: null, localRevision: 1, serverRevision: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
                    } : {
                        ...local, id: newId, ownerId, localRevision: 1, serverRevision: null, createdAt: new Date().toISOString()
                    };
                    const clean=await lifecycle.sanitizeRecord(tx,saved);if(!clean)throw new Error("この記録は完全に削除されています。");
                    tx.objectStore(storeOf(entityOf(clean))).put(clean);
                    await queue(tx, clean);
                }
                tx.objectStore("conflicts").delete(id);
            });
            emit();
        },
    };
    return account;
}
