# Phase 2のデータベース

新しい開発用SupabaseプロジェクトのSQL Editorで、`migrations/` 内のSQLをファイル名順に実行します。最初の `202610280001_phase2_sync.sql` はテーブル作成、後続のmigrationは公開RPCと内部実装の権限境界を強化します。適用済みmigrationは編集・再実行せず、まだ適用していないファイルだけを順に実行してください。既存の同名テーブルを持つ別のプロジェクトに上書き適用するファイルではありません。

このフォルダーには秘密鍵や接続文字列を保存しません。アプリに必要なのはプロジェクトURLとpublishable keyです。service role keyは不要です。アプリ側の接続・メールログイン設定はプロジェクトのセットアップ資料を参照してください。

## RPC契約

`apply_sync_operation(p_operation jsonb)`

```json
{
  "id": "operation UUID",
  "kind": "put_note",
  "entityId": "note UUID",
  "baseRevision": 1,
  "previousOperationId": "optional operation UUID for the same entity",
  "createdAt": "2026-10-28T01:00:00.000Z",
  "payload": {
    "id": "same note UUID",
    "kind": "note",
    "originApp": "recall",
    "ownerId": null,
    "body": "本文",
    "spaceIds": ["daily"],
    "pinned": false,
    "createdAt": "2026-10-28T01:00:00.000Z",
    "updatedAt": "2026-10-28T01:00:00.000Z",
    "deletedAt": null,
    "localRevision": 1,
    "serverRevision": 1
  }
}
```

新規は `baseRevision:null`。`put_space` は `payload:{id,name,color,createdAt}` を使います。space IDは既存の `daily/creative/research` とUUIDを扱えるtext、note IDはUUIDです。

レスポンスは `{status:'applied'|'conflict',operationId,record,conflictId?}`。canonical recordはcamelCaseで、認証済み所有者とserverRevisionを返します。clientが送ったownerIdは採用しません。

1つの端末が未送信の編集を続ける場合、直前の同じItemのoperation IDを `previousOperationId` に保存できます。serverはその操作の結果revisionを基点に比較します。前の操作が競合していたら後続も競合として両方の本文を保管します。

同一operation IDの再送は同じ結果を返します。内容を変えて同じIDを使うと失敗します。後から内容や基点revisionを変える場合は、新しいoperation IDを発行してください。

`pull_sync_changes(p_cursor text='0',p_limit integer=100)` は `{changes:[{cursor,entity,record}],cursor,hasMore}` を返します。cursorはbigintを丸めないため文字列です。ごみ箱もdeletedAtを持ったrecordとして届きます。hasMoreがtrueの間は返されたcursorで次ページを取得します。

## 権限とcursor

syncedテーブルの直接更新権限はauthenticatedへ与えません。更新はownerを検証するRPCに限定し、ownerごとの `sync_clocks` 行を `FOR UPDATE` でロックしてから書き込みます。cursorは同じtransactionで増やすため、別transactionが先に大きいcursorを公開して小さい変更を読み飛ばす状態を防ぎます。

Data APIが公開する `public` schemaの2つのRPCは `SECURITY INVOKER` の入口です。ownerを検証してatomicに書き込む `SECURITY DEFINER` 実装と原本読み出しhelperは、非公開の `private` schemaへ置きます。`authenticated` は内部2関数をwrapper経由で呼ぶためのUSAGE/EXECUTEだけを持ち、helperやschema CREATE権限は持ちません。`anon` とPUBLICには実行権限を与えません。Supabaseの「Exposed schemas」に `private` を追加しないでください。

移動用migration `20261028063752_harden_sync_rpc_wrappers.sql` は、Asset参照用の複合indexも追加します。既存データやoperation履歴は保持し、公開RPCの名前・引数・レスポンスは変えません。ローカルの初期ファイル名は最初の配布版を維持しています。ホスト側の初回migration履歴の時刻とは異なるため、設定なしでCLIのpushを既存プロジェクトへ実行せず、適用済み履歴を確認してください。

各テーブルのSELECTはRLSでownerに限定します。Item・Space・Relation・Assetの参照はownerを含む複合FKです。RelationとAsset metadataは今後のアプリ用に所有者付きのCRUDを許可していますが、Phase 2の変更feedの対象はNoteとSpaceだけです。

Storageは `personal-tools-private` bucketで、`<user UUID>/<owned item UUID>/<filename>` のパスだけを許可します。bucketがprivateであることと、`storage.objects` のSELECT/INSERT/UPDATE/DELETE policyを別に設定しています。DBの原本を消す処理では、ファイルの物理削除は行いません。

## 検証の境界

`tests/database.test.ts` はPGliteの実際のPostgreSQLエンジンでmigrationをそのまま実行し、SQL関数、RLS、複合FK、冪等性、競合保存、cursor、Storage行のpolicyを検証します。テスト用のauthとStorage schemaはharnessで用意します。

Supabaseの実際のメール配信、PostgREST/JWT、Storage upload/download/signed URL、複数の実サーバー接続が同じclock行を競う挙動は、このharnessだけでは検証できません。接続後に実サービスで確認します。

公式資料：

- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Database functionsのsearch_path・execute権限](https://supabase.com/docs/guides/database/functions)
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PGlite API](https://pglite.dev/docs/api)

## Phase 5

Atlasのprojects・project_items・item_labelsと同期stream、任意のAI設定・analysis_jobs・search_documentsを追加します。可変次元のembeddingで少数資料を評価し、ownerと絞り込みをSQL内で順位より前に適用します。新規テーブルはRLS有効、変更はRPCのみ、解析workerはservice_role専用です。手順は [Phase 5](../docs/phase5-setup.md)、実際の反映履歴は [検証記録](../docs/phase5-verification.md) を参照してください。

## 暗号化金庫

`20261031082941_encrypted_vault.sql` が暗号文用の所有者RLS、同期RPC、移行アーカイブ、private画像bucketを追加します。初回の解錠・アカウント接続時に旧データを検証しながら移行します。鍵情報だけの追加で既存データが直ちに暗号化されるわけではありません。[手順と保護範囲](../docs/encrypted-vault.md)を参照してください。

## ごみ箱の自動整理（段階D）

`20261031174826_suite_lifecycle.sql` と `20261031225314_harden_vault_retention.sql` を追加。暗号化同期v2、所有者別の削除通知、削除期限、画像参照索引と再試行キューを使います。初回の端末側の索引移行完了後に期限削除を有効にします。

`pg_cron` が10分ごとに `private.run_vault_retention()` を実行し、本文の暗号文と履歴を削除してから `vault-retention` Edge Functionを呼びます。関数はStorage APIで画像の実データを削除します。スケジューラーの専用トークンはSupabase Vault内で生成・保持し、service_roleはEdgeの実行環境内だけで利用します。ブラウザにはどちらも渡しません。`verify_jwt=false` の代わりに、専用トークンによる認証を関数内で必ず検証します。キューの取得・完了RPCはservice_role専用です。

アプリを閉じた状態の定期実行、Freeでの休止、削除対象・保持する通知は [段階Dの記録](../docs/atlas-improvement-phase-d-verification-2026-11-01.md) と [保護範囲](../docs/encrypted-vault.md) を参照してください。
