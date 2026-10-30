# 実装ロードマップ

2026-10-28。機能が動く縦断単位で進め、段階ごとに実機確認して次へ進む。時間は作業環境・再利用する既存実装で変わるため、締切としての工数見積もりは置かない。

## Phase 0 — 公式資料と契約を確定（実施済み）

要件・画面・モノレポ比較・データモデルを `design.md` に記録。Next.js App Router、workspaceのtranspile、IndexedDB transaction、PWA manifest／cacheを公式資料で確認した。

使用API：`app/layout.tsx`, `app/page.tsx`, `MetadataRoute.Manifest`, `transpilePackages`, `basePath`, `indexedDB.open`, `db.transaction`, `objectStore.put`, `transaction.oncomplete`, `serviceWorker.register`, `caches.open`, `storage.persist`。

参照：[Next.js installation](https://nextjs.org/docs/app/getting-started/installation)、[PWA guideのManifest節](https://nextjs.org/docs/app/guides/progressive-web-apps)、[MDN IndexedDBのAdding data／Version changes節](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)、[Storage.persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)。

ガード：manifestだけでオフライン対応としない。request successだけで保存完了にしない。実験的なoffline hookを基盤にしない。

## Phase 1 — Recall端末内版（今回の実装）

公式PWA manifest例からアプリ固有のid・scopeを設定し、MDNのtransactionパターンからメモ＋local-only変更意図をatomicに保存する。静的shellのみをキャッシュし、本文はIndexedDBから読み込む。

実装：入力／下書き復元／日付一覧／正規化部分一致／スペース／星／編集／ごみ箱／JSON入出力。`core` と `api-client` をworkspaceに置く。ほか3アプリは配置先のみ。

受け入れ：

- 本文だけで保存でき、再読み込みで同じ内容が残る。
- スペース未指定でも保存でき、1件を複数に置ける。
- 不正な読み込みが既存データを変えず、正しい読み込みは追加する。
- 別タブの古いrevisionで上書きしようとすると拒否し、編集中の本文が残る。
- 初回オンライン→offline shell準備→通信断→再起動→保存・検索が機能する。
- Nodeの保存テスト、本番ビルド、ブラウザ確認。iPhone／Android実機の機内モード試験は未完。

ガード：偽のログイン・偽のクラウド同期状態を表示しない。ローカル変更意図をネットワーク送信キュー完成として扱わない。原稿をAIへ送らない。

## Phase 2 — 共通クラウドとRecall複数端末同期

まずSupabaseの開発projectを用意し、migration・RLS・private Storageを作る。公式SSRクライアント例の `createBrowserClient` / `createServerClient` とCookie `getAll` / `setAll` を `packages/auth` に閉じ込める。Next.js 16の `proxy.ts` パターンと `getClaims()` を採用版に合わせてコピーする。

参照：[Supabase SSR Creating a client](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs)、[RLSのpolicy例](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Storage policies](https://supabase.com/docs/guides/storage/security/access-control)。

次にapply-operation RPC、immutable operation outbox、server revisionと変更cursor、競合版の保持、tombstone取得、再送・再試行を実装する。初回ログイン時にローカルデータの取り込みを選べるようにする。アカウントを切り替えるときはその所有者の端末キャッシュだけを開く。

受け入れ：2端末で新規・編集・削除・復元。通信を途中で切って同じoperationを再送しても重複しない。A/B同時編集で両方の本文が残る。別userのItem／Space／関係／ファイルを読めず作れない。サインアウト後に前userの本文が画面へ残らない。

ガード：`getSession()`のuserをserver認可の根拠にしない。service role keyをブラウザに置かない。UUIDを知っているだけで他userのデータへ結べない。originが違うだけの同一projectをSSO済みと呼ばない。

## Phase 3 — Sketchbook＋2アプリ統合

MDNのPointer Events drawing例から単一canvasを構築し、`setPointerCapture(pointerId)` と `touch-action:none` を使う。ストロークJSONを原本として保存し、プレビューPNGをprivate Storageに置く。Undo/Redo、色、太さ、消しゴム、復元を実装する。

参照：[Using Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Using_Pointer_Events)、[setPointerCapture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)、[Next.js Multi-Zonesのrewrites例](https://nextjs.org/docs/app/guides/multi-zones)。

2アプリを同じドメインへ独立デプロイし、gatewayでpathを転送。Cookieと静的assets、service workerのscopeを検証する。Recallのメモを着想元として関連付ける最小UIを実装。

受け入れ：指／ペン／マウスで描いて再起動後に編集再開できる。RecallのItemは複製されず、relationの両側から開ける。片方だけのデプロイでほかが停止しない。全アプリlogout、並行token refresh、cache更新を統合確認する。

ガード：PNGだけを原本にしない。高度なブラシ・無限canvas・共同編集を同時に作らない。app間をNext.js client routerだけで遷移させない。

## Phase 4 — Collectの収集基盤

URL貼り付け、画像ファイル追加、出典＋自分のメモ、未整理inbox。取り込みと解析を別transaction/jobとして扱う。対応端末のみWeb Share Targetを追加する。外部URL取得はserver側でHTTPS・転送先・サイズ・timeoutを制限し、localhost／private IPなどを拒否する。

参照：[MDN share_targetのGET／POST例](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target)、[Chrome Web Share Target](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target)、[Storage access control](https://supabase.com/docs/guides/storage/security/access-control)。

受け入れ：YouTube／SNS URLはmetadata取得失敗でも自分のメモ付きで残せる。画像の原本と出典を失わず、重複候補を提示。Safariでも貼り付け／画像選択で保存できる。

ガード：任意URLを無制限fetchしない。SNS本文・字幕・動画本体の取得可能性を保証しない。APIから取得したテキストをHTMLとしてそのまま挿入しない。

## Phase 5 — Atlas＋画像意味検索

まず種類・スペースをまたぐ一覧と絞り込み、relation追加・逆向き表示、プロジェクトへの所属を実装。続けて少数の私有テスト資料でcaption/OCR、自動タグ提案、text embedding、必要ならmultimodal embeddingを評価する。

参照：[Supabase semantic searchのSQL関数とrpc例](https://supabase.com/docs/guides/ai/semantic-search)、[vector columns](https://supabase.com/docs/guides/ai/vector-columns)、[Postgres text parser](https://www.postgresql.org/docs/current/textsearch-parsers.html)。

受け入れ：複数のツールのItemを同じ検索結果へ表示し原本へ移動できる。20〜30件の日本語クエリーで目的の画像が探せるか本人が評価。削除・再分類・AIモデル変更時に古い検索文書が適切に更新される。絞り込みとowner検証がランキング前に適用される。

ガード：AI提案を人のタグへ無断上書きしない。ベクトル次元をモデル未決定のまま固定しない。検索結果件数を絞った後でownerやspaceをfilterしない。

## Final — 継続的な検証

各段階で採用版の公式資料と実装を照合し、未文書化API・仮の認証・秘密鍵のclient露出・RLS漏れ・公開cache内の個人データを点検する。必要な保存・同期・権限試験を行い、受け入れ条件を満たした範囲を明記する。PWAはiPhone Safari／Android Chromeで「初回オンライン→完全終了→機内モード再起動→記録→通信復帰」を毎回の重要変更で確認する。
