"use client";

import {useEffect, useRef, useState} from "react";
import {assertVault, requireVault, type RecallRepository} from "@personal-tools/api-client";
import {ATLAS_REQUESTS_SPACE_NAME, type AtlasRequestSharing, type Note, type Space} from "@personal-tools/core";
import {Button} from "@personal-tools/ui";

const message = (error: unknown) => error instanceof Error ? error.message : "Codex向けの書き出しに失敗しました。";

export function useAtlasRequestSharing(repository: RecallRepository | null) {
    const [state, setState] = useState<{
        repository: RecallRepository | null; sharing: AtlasRequestSharing | null; loading: boolean; error: string;
    }>({repository: null, sharing: null, loading: true, error: ""});
    useEffect(() => {
        if (!repository) return;
        let active = true, revision = 0;
        const read = async () => {
            const current = ++revision;
            try {
                const sharing = await repository.loadAtlasRequestSharing();
                if (active && current === revision) setState({repository, sharing, loading: false, error: ""});
            } catch (error) {
                if (active && current === revision) setState({repository, sharing: null, loading: false, error: message(error)});
            }
        };
        void read();
        const unsubscribe = repository.subscribe(() => {void read();});
        return () => {active = false; unsubscribe();};
    }, [repository]);
    return state.repository === repository ? state : {sharing: null, loading: true, error: ""};
}

export function AtlasRequestsSettings({repository, spaces, notes, state, onPrepared, onNotice}: {
    repository: RecallRepository | null;
    spaces: Space[];
    notes: Note[];
    state: {sharing: AtlasRequestSharing | null; loading: boolean; error: string};
    onPrepared: (spaceId: string) => void;
    onNotice: (notice: string) => void;
}) {
    const [busy, setBusy] = useState(false), [error, setError] = useState(""), [choice, setChoice] = useState("");
    const activeRepository = useRef(repository);
    activeRepository.current = repository;
    useEffect(() => {
        activeRepository.current = repository;
        return () => {activeRepository.current = null;};
    }, [repository]);
    const candidates = spaces.filter(space => space.name.normalize("NFKC") === ATLAS_REQUESTS_SPACE_NAME);
    const selected = choice || candidates[0]?.id;
    const sharedSpace = spaces.find(space => space.id === state.sharing?.spaceId);
    const count = notes.filter(note => !note.deletedAt && note.spaceIds.includes(state.sharing?.spaceId ?? "")).length;
    async function run(action: "prepare" | "export" | "disable") {
        if (!repository || busy || state.loading || state.error) return;
        const current = repository;
        setBusy(true); setError("");
        try {
            const vault = requireVault();
            if (action === "prepare") {
                const sharing = await current.prepareAtlasRequestSharing(selected);
                if (activeRepository.current !== current) return;
                onPrepared(sharing.spaceId);
                onNotice("Atlas要望を共有元に設定しました。ファイルは書き出したときだけ作成します");
            } else if (action === "disable") {
                await current.disableAtlasRequestSharing();
                if (activeRepository.current !== current) return;
                onNotice("Codex向けの共有設定を解除しました。メモは残っています");
            } else {
                const data = await current.exportAtlasRequests();
                if (activeRepository.current !== current) return;
                assertVault(vault);
                const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
                try {
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `atlas-requests-${data.exportedAt.slice(0, 10)}.json`;
                    link.click();
                } finally {setTimeout(() => URL.revokeObjectURL(url), 1000);}
                onNotice(`Atlas要望の${data.notes.length}件を暗号化なしで書き出しました。Codexにファイルを添付してください`);
            }
        } catch (error) {
            if (activeRepository.current === current) setError(message(error));
        } finally {
            if (activeRepository.current === current) setBusy(false);
        }
    }
    const disabled = !repository || busy || state.loading || !!state.error;
    return <section className="atlas-request-sharing" aria-labelledby="atlas-request-heading">
        <h3 id="atlas-request-heading">Atlas要望をCodexへ</h3>
        <p className="muted">共有元の保存済みメモだけを、暗号化しないJSONファイルに書き出します。Codexにファイルを添付して、改善を依頼できます。</p>
        <p className="sharing-warning">このスペースに入れたメモは、ほかのスペースにも置いていても本文全体が共有対象です。下書きとごみ箱は含みません。</p>
        {state.loading ? <p className="muted" role="status">共有設定を確認しています…</p> : state.sharing ? <>
            <p className="muted">共有元：{sharedSpace?.name ?? "スペースが見つかりません"} · 保存済み {count}件</p>
            <div className="backup-actions">
                <Button disabled={disabled || !sharedSpace} onClick={() => void run("export")}>Atlas要望をCodex向けに書き出す（暗号化なし）</Button>
                <Button disabled={disabled} onClick={() => void run("disable")}>Codex向けの共有設定を解除</Button>
            </div>
        </> : <>
            {candidates.length > 1 && <label className="field-label">共有元のAtlas要望スペース
                <select className="text-input" value={selected} disabled={disabled} onChange={event => setChoice(event.target.value)}>
                    {candidates.map(space => <option key={space.id} value={space.id}>Atlas要望 · {notes.filter(note => !note.deletedAt && note.spaceIds.includes(space.id)).length}件 · {new Date(space.createdAt).toLocaleDateString("ja-JP")} · {space.id.slice(0, 8)}</option>)}
                </select>
            </label>}
            <div className="backup-actions"><Button disabled={disabled} onClick={() => void run("prepare")}>{candidates.length ? "Atlas要望を共有元に設定" : "Atlas要望スペースを作る"}</Button></div>
        </>}
        <p className="small-note">共有元の設定は、この端末の現在のノート専用です。鍵やほかのスペースの情報はファイルに含めません。毎回、対象メモ全件の最新版を書き出します。すでに渡した内容は、共有設定を解除しても回収できません。</p>
        {(error || state.error) && <p className="error" role="alert">{error || state.error}</p>}
    </section>;
}
