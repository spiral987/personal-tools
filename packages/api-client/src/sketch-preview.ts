import type { Sketch } from "@personal-tools/core";

type Result<T> = PromiseLike<{ data: T | null; error: { message?: string; statusCode?: string | number; status?: number; code?: string; error?: string } | null }>;
export type SketchPreviewClient = {
    storage: { from(bucket: string): {
        upload(path: string, body: Blob, options: { contentType: string; upsert: boolean; cacheControl: string }): Result<unknown>;
        download(path: string): Result<Blob>;
        remove(paths: string[]): Result<unknown>;
    } };
    rpc(name: string, args: Record<string, unknown>): Result<unknown>;
};
const BUCKET = "personal-tools-private";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Immutable revision-specific preview, never a public URL and never the editable original.
 * SDK signatures: https://supabase.com/docs/reference/javascript/storage-from-upload
 * Private authenticated downloads: https://supabase.com/docs/reference/javascript/storage-from-download
 */
export async function uploadSketchPreview(client: SketchPreviewClient, userId: string, sketch: Sketch, blob: Blob): Promise<string> {
    if (!uuid.test(userId) || !uuid.test(sketch.id) || sketch.ownerId !== userId || !Number.isSafeInteger(sketch.serverRevision) || Number(sketch.serverRevision) < 1 || sketch.deletedAt)
        throw new Error("先にスケッチをクラウドへ同期してください。");
    if (blob.type !== "image/png" || blob.size < 8 || blob.size > 2097152) throw new Error("PNGプレビューは2MB以内で作成してください。");
    const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte)) throw new Error("PNGプレビューを確認できませんでした。");
    const path = `${userId}/${sketch.id}/previews/${sketch.serverRevision}-preview.png`;
    const bucket = client.storage.from(BUCKET);
    const uploaded = await bucket.upload(path, blob, { contentType: "image/png", upsert: false, cacheControl: "0" });
    // Storage's older API uses400 Duplicate; current error codes use409. Check an
    // explicit duplicate code/message as well as status, never accept arbitrary400/409.
    // https://supabase.com/docs/guides/storage/uploads/standard-uploads#overwriting-files
    const status = String(uploaded.error?.status ?? uploaded.error?.statusCode);
    const duplicateCode = [uploaded.error?.code, uploaded.error?.error, uploaded.error?.statusCode].some(code => ["Duplicate", "ResourceAlreadyExists", "KeyAlreadyExists"].includes(String(code)));
    const duplicateMessage = ["Asset Already Exists", "The resource already exists", "The resource already exists."].includes(uploaded.error?.message ?? "");
    const alreadyPresent = !!uploaded.error && ["400", "409"].includes(status) && (duplicateCode || duplicateMessage);
    if (uploaded.error && !alreadyPresent) throw new Error("プレビューを送れませんでした。編集できる原本は保存されています。");
    const registered = await client.rpc("register_sketch_preview", { p_item_id: sketch.id, p_revision: sketch.serverRevision, p_path: path, p_size: blob.size });
    if (registered.error) {
        // Reclaim only a confirmed stale new upload. An uncertain response can have committed
        // successfully: retain its immutable path for a safe retry rather than deleting it.
        if (!alreadyPresent && registered.error.code === "22023" && registered.error.message === "Sketch revision changed")
            await Promise.resolve(bucket.remove([path])).catch(() => {});
        throw new Error("プレビューの更新番号を確認できませんでした。もう一度同期してください。");
    }
    return path;
}
export async function downloadSketchPreview(client: SketchPreviewClient, userId: string, sketchId: string, path: string): Promise<Blob> {
    if (!uuid.test(userId) || !uuid.test(sketchId) || !path.startsWith(`${userId}/${sketchId}/previews/`) || path.includes("..")) throw new Error("プレビューの保存先が正しくありません。");
    const result = await client.storage.from(BUCKET).download(path);
    if (result.error || !result.data) throw new Error("プレビューを読み込めませんでした。");
    return result.data;
}
