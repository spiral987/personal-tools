# 個人向けツール群 設計 v0.1

作成日：2026-10-28（日本時間）。新しいユーザーの依頼を基準にし、参照会話で確認できたユーザー発言を引き継ぐ。過去のassistant回答本文は参照記号のみで取得されており、当時の詳細な決定としては扱わない。

## 1. 何を作るか

**4つの入口と、1つの知識基盤。** 各アプリは、その瞬間にしたい操作に集中する。スペースはユーザーが付ける文脈、プロジェクトは目的と期限のある活動、タグは内容を表すラベルとして区別する。

| ツール | 中心となる操作 | 最初に開く画面 | 保存する主な原本 |
|---|---|---|---|
| Recall | 文章ですぐ残し、思い返す | 入力欄＋直近のメモ | 本文テキスト |
| Sketchbook | 描いて発想を残す | 直近キャンバス／新規キャンバス | バージョン付きストロークJSON |
| Collect | 外から拾って集める | URL／画像の取り込み＋収集箱 | 出典URL、利用可能な添付原本 |
| Atlas | 見つけ、関係を付け、活動へまとめる | 横断検索＋最近のつながり | Item間の関係とプロジェクト |

Recallの文章をSketchbookに関連付けても原本はRecallに1件だけ残る。Atlasから編集する場合も同じItem IDを扱う。アプリごとに複製して同期する方式は取らない。

例：Recallで「雨の日の看板が宇宙船に見えた」と書く → Collectの夜景資料を関連付ける → Sketchbookで構図を描く → Atlasの「短編制作」へ3件を追加する。`sketch inspired_by note` と `sketch inspired_by resource` を保存し、後から着想の出どころへ戻れる。

## 2. 要件と優先順位

| 優先度 | 要件 | 完了の目安 |
|---|---|---|
| P0 | Recallをすぐ開いて書ける | 分類必須・タイトル必須にせず、その場で本文を保存できる |
| P0 | 通信断でも記録を失いにくい | 端末保存確定後に表示、再起動復元、下書き、失敗時の本文保持 |
| P0 | ユーザーが情報を持ち出せる | JSON書き出しと追加読み込み、ごみ箱からの復元 |
| P0 | 日本語で振り返れる | 本文の部分一致、AND検索、日付一覧 |
| P0（クラウド導入時） | 本人以外の情報へアクセスできない | 全テーブル・StorageのRLS、2ユーザーで否定試験 |
| P1 | 端末をまたいで共有 | 共通認証、outbox、revision、削除同期、競合保存 |
| P1 | 任意スペースと関係 | 1 Itemに複数スペース、方向付きrelation、同じ所有者の参照のみ |
| P1 | Sketchbook／Collectの基本操作 | まず描画原本保存、URLと画像の収集。AI完了を保存の前提にしない |
| P2 | 自動タグ・画像検索 | AI提案と人の編集を区別し、再処理可能にする |
| P2 | Atlasの統合環境 | 横断検索・関連一覧・プロジェクト。グラフ表示は必要が明確になってから |

最初は本人だけが使う。招待・チーム・公開共有・共同編集・高度な手書き認識・ブラウザ拡張・無制限なSNS巡回は初期範囲に含めない。画像の大容量オフライン保存もCollect導入時に別途上限を定める。

起動速度は端末依存のため、初版の受け入れでは「起動後すぐ入力欄へ到達できること」をまず確認する。実機を決めた後に起動・保存の時間目標を測定して決める。

## 3. スペース・タグ・プロジェクト

- **スペース**：ユーザー定義の文脈。初期候補「日常／創作／研究」は名称も含め固定概念にしない。1件を0〜複数スペースに置ける。未分類のまま保存してよい。
- **タグ**：「青い光／参考文献／都市」等の内容ラベル。手入力とAI提案に由来を保存する。
- **プロジェクト**：「短編Aを完成させる」等の取り組み。複数スペースのItemを集め、状態やメモを持つ。

スペースは初期のアクセス権境界ではない。共有機能を将来追加する場合はworkspace/membershipを別に設計する。スペースに所属しないItemもAtlasの全件検索に出す。

## 4. 主要UI

### Recall

PC：左に「すべて／大切にしたメモ／スペース／ごみ箱」、中央上部に大きな入力欄、その下に検索と日付別カード。スマートフォン：入力と保存を上部に置き、スペースと一覧範囲を小さな選択UIにする。画面幅の都合で情報を削りすぎず、本文は読みやすい行間を取る。

タイトル自動抽出は一覧やdeep linkの補助に限定。本文の1行目を使い、タイトル入力は求めない。分類しないまま保存できる。星は再訪したいメモの印。ごみ箱は復元可能。保存状態は「下書きを端末に保存済み」「メモを端末に保存」「同期待ち」「クラウド同期済み」「同期に失敗」の意味を分ける。現行初版が表示するのは端末内保存だけ。

### Sketchbook

起動時は新規または直近のキャンバス。中央に描画、端にペン・消しゴム・太さ・色・Undo/Redo。タイトル・文章・スペース・関連資料は後で開けるパネルに置く。Pointer Eventsで指／マウス／ペンを扱い、編集原本とサムネイルを分ける。独自の無限キャンバスや高度なブラシエンジンは後で判断する。

### Collect

上にURL貼り付けと画像追加、下に未整理の収集箱。カードに出典・自分のメモ・スペース・タグ・解析状態を示す。保存完了と解析完了を別にする。YouTubeはまずURL・タイトル・利用可能なサムネイル・時刻リンクを保存する。動画本体や字幕を必ず取得できるとは扱わない。iPhoneは貼り付け／画像選択が基本。Web Share Target対応端末には共有受信を追加する。

### Atlas

検索窓を中心に、種類／スペース／タグ／プロジェクトで絞る。右の詳細パネルに原本を開くリンク、関連Item、出典、プロジェクト所属。関係追加は「このスケッチは → この資料に着想を得た」と文章で理解できるUIにする。最初は関連一覧を作り、グラフは検索・整理の実用性を確認してから検討する。

## 5. リポジトリの比較と決定案

| 観点 | モノレポ | 別リポジトリ |
|---|---|---|
| 共通型／認証／API変更 | 同じ変更で4アプリを追従できる | パッケージ公開やバージョン調整が必要 |
| 個別起動・個別デプロイ | workspaceごとに可能 | 自然に分離できる |
| 開発環境・依存管理 | 1回のセットアップ | 各repoで設定・更新が増える |
| 体験の独自性 | apps内で自由に持てる | 独立性は高い |
| 新しいツール | appと型アダプターを追加 | repoと共通契約配布を追加 |
| 切り離し | パッケージ境界があれば後から抽出可能 | 初めから独立運営しやすい |

**初期推奨：pnpm workspaceによるモノレポ。** デプロイを分けることとrepoを分けることは独立した判断。開発者1人で変更の整合を取りやすい方を優先する。Turborepoはビルド時間や依存実行管理が必要になるまで入れない。[Next.js transpilePackages](https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages)、[Vercel Monorepos](https://vercel.com/docs/monorepos)で公式サポートを確認。

既存の2リポジトリはこの作業フォルダーには接続されていない。移動や上書きはしていない。再利用する場合は、次段階で対象を特定し、画面・データ・スケッチ実装を比較して移植範囲を決める。

### パッケージの責任

`core`：Item／Space／Relationの契約と純粋な処理。ReactやSupabaseへ依存しない。`api-client`：保存・検索・同期のインターフェースとアダプター。`auth`：認証クライアント、セッション、所有者境界。`ui`：実際に共有する小さな部品とトークン。Recallの入力画面やSketchbookのツールバーまで共通化しない。`apps`同士の直接importは避ける。server秘密鍵とAI処理はクライアントへexportしない。

## 6. FirestoreとSupabase

| 観点 | Supabase / Postgres | Firestore |
|---|---|---|
| 関係・複数スペース・参照整合 | FK／JOIN／transactionで表現しやすい | 参照・非正規化・整合処理を設計する |
| Webのオフライン | 独自IndexedDB/outboxが必要 | 永続キャッシュと再接続同期が強み |
| 日本語検索 | 初期部分一致→検索方式を拡張 | 採用editionと検索サービスを含め判断 |
| ベクトル | pgvector＋SQL関数 | 対応server SDKのvector query |
| 本件の主な負担 | 同期実装 | 関係・検索・非正規化の管理 |

**推奨はSupabase**。Atlasまで含む関係データを中心に選び、Recallのオフライン同期は明示的に実装する。Firestoreは「オフライン記録の完成を最優先し、関係・横断検索を後回しにする」場合の有力な代替。

Firestoreの検索を一律に「存在しない」とは扱わない。現行Enterpriseには[text search](https://firebase.google.com/docs/firestore/enterprise/text-search)がある一方、Pipelineのオフライン制約とSDKが異なる。[Offline persistence](https://firebase.google.com/docs/firestore/manage-data/enable-offline)、[vector search](https://firebase.google.com/docs/firestore/vector-search)も参照。費用の優劣はここでは未評価。契約前に実際の件数・画像量・AI実行頻度で見積もる。

## 7. システム設計

```text
Recall / Sketchbook / Collect / Atlas（独立したNext.jsアプリ）
        │ 共通型・APIクライアント・認証契約
        ├─ 端末：IndexedDB（原稿／対象Item／outbox）
        │          ↓ 接続時の再送・revision検証
        └─ Supabase Auth + Postgres（正本、RLS）+ private Storage
                                  │ transaction内でjobを作成
                                  ↓
                           worker（解析／OCR／タグ提案／embedding）
                                  ↓
                           検索インデックスと解析結果
```

クラウド導入後はPostgresが複数端末の正本、端末は作業中の複製になる。AI処理をブラウザの起動時間に依存させず、失敗・再実行・モデル変更をjob単位で追跡する。

### デプロイと認証

第1段階はRecallを `/recall/` で単独起動。第2アプリを加える段階で、同じ公開originの `/recall/` `/sketchbook/` `/collect/` `/atlas/` を各独立デプロイへ転送するgatewayを置く。各アプリの `basePath` をビルド時に固定し、別アプリへの移動は通常の `<a>` とする。[Next.js Multi-Zones](https://nextjs.org/docs/app/guides/multi-zones)、[basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath)のパターンを使用する。

同じSupabase projectとSSR Cookie設定を使い、host-only CookieのPathを `/` に揃える。gatewayはCookieとSet-Cookieを維持する。同じprojectを使うだけでは別originのログイン状態は共有されない。別サブドメイン案を採る場合は、そのログインフローを別に設計する。

同じoriginの全アプリは共通の信頼境界になる。DBはowner別、端末キャッシュもaccount別に分け、ログアウト時にそのaccountの画面・キャッシュ・同期を閉じる。ローカル版のデータはログイン後に勝手にアップロードせず、件数を示して取り込み先を選んでもらう。

PWAのmanifest `id`・`start_url`・`scope`とservice worker scopeをアプリごとに分ける。ルート全体を制御するworkerは作らない。現行Recallは `/recall/` に限定。認証APIや個人データを含むHTMLは公開shellと同じキャッシュに入れない。クラウド導入時はshellを匿名のまま保つか、キャッシュ対象を再設計する。

### 同期の契約（次段階）

1. クライアントでItem UUIDとimmutableなoperation UUIDを発行する。
2. 端末上の変更と送信operationを同一IndexedDB transactionで確定する。
3. 起動・表示復帰・onlineイベント・手動操作で送信する。Background Syncは補助扱い。
4. `apply_operation(operation_id, entity_id, base_revision, payload)`というアプリ側RPCを実装し、同一operationの再送は同じ結果を返す。これはSupabase標準APIの名称ではない。
5. server transactionでowner検証→revision比較→変更→revision増分→operation結果を保存する。競合は409相当として返し、双方の版を保持してユーザーが選べるようにする。
6. 端末ごとのcursorで変更とtombstoneを取得する。ページング可能なserver側の変更順序を使い、端末時計によるupdated_atの最大値だけに依存しない。

現行初版の `outbox` はItem単位にまとめた **local_onlyの変更意図** であり、送信機能はない。ネットワーク同期追加時にimmutable operation outboxへ移行する。現行の `localRevision` とserver側の `revision` を混同しない。

Safari/iOSはBackground Syncと共有先登録に制約があるため、アプリを開いたときの再送と貼り付け導線を必ず持つ。[MDN Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)、[share_target](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target)。

## 8. データモデル（クラウド版の設計）

| テーブル | 主な列と意味 |
|---|---|
| `items` | `id uuid`, `owner_id`, `kind(note/sketch/resource)`, `origin_app text`, `title`, `created_at`, `updated_at`, `revision bigint`, `deleted_at` |
| `notes` | `item_id`, `owner_id`, `body text`。タイトルは本文から抽出可 |
| `sketches` | `item_id`, `owner_id`, `document_asset_id`, `preview_asset_id`, `format_version`, `width`, `height` |
| `resources` | `item_id`, `owner_id`, `source_url`, `canonical_url`, `provider`, `source_title`, `source_author`, `captured_at`, `user_note`, `metadata jsonb` |
| `assets` | `id`, `owner_id`, `item_id`, `storage_path`, `mime_type`, `size_bytes`, `sha256`, `role(original/preview/ocr)` |
| `spaces` | `id`, `owner_id`, `name`, `color`, `position` |
| `item_spaces` | `owner_id`, `item_id`, `space_id`。複合PK／uniqueで重複を防ぐ |
| `tags` / `item_tags` | タグ名と付与。`provenance(manual/ai)`、`model`, `confidence`, `accepted_at` を保持 |
| `relations` | `id`, `owner_id`, `from_item_id`, `to_item_id`, `relation_type`, `annotation`, `created_at` |
| `projects` / `project_items` | 名前、説明、状態、期日、関連Itemと並び順 |
| `analysis_jobs` | `item_id`, `owner_id`, `job_type`, `input_revision`, `status`, `attempts`, `next_retry_at`, `error_code`, `model_version` |
| `search_documents` | `item_id`, `owner_id`, `field`, `normalized_text`, `embedding`, `model`, `input_revision` |
| `operations` / `item_changes` | 冪等operationの結果と、端末用の単調な変更cursor／tombstone |

`items`は共通の封筒、固有原本は各テーブルへ分ける。可変なサイトメタデータ等だけjsonbにする。Atlas専用Item型は作らず、Atlasはこれらを検索・関連付けする。

### 制約とインデックス

- 全所有データの `owner_id` は認証済みuserから決定。クライアントが送るownerを信頼しない。
- 親に `unique(owner_id,id)`、関連表は `(owner_id,item_id)` 等の複合FKを使い、他ユーザーのSpace・Item・Assetへ結べないようにする。RLSに加え、参照整合性でも守る。
- `relations` は自己参照禁止、同じ有向エッジの重複禁止。`inspired_by` は「着想を得た側 → 着想元」。逆向き表示名は「このItemに着想を得たもの」。`related_to` は初期には両方向表示し、格納時のID順序を正規化する。
- relationとspace所属は循環や階層を強制しない。削除Itemへの関連は残して復元可能にし、通常表示では非表示にする。
- 一覧に `items(owner_id,deleted_at,created_at,id)`、所属に `item_spaces(owner_id,space_id,item_id)`、関係の両端にowner付きindex。
- 重複資料はcanonical URL／hashを使って候補提示。別文脈のメモやキャプションを勝手に統合しない。
- Note作成時はitems＋notes＋space所属を単一server transactionで保存する。初回SQL migrationとpgTAPはクラウド導入段階で作成・検証する。この文書のモデルは未実行の設計。

### 認可

SELECTの `USING(auth.uid()=owner_id)` に加え、INSERTとUPDATEの `WITH CHECK` を全テーブルへ設定する。UPDATEによるowner変更を禁止する。private bucketの `storage.objects` にも別途RLSを設定し、短時間のsigned URLを取得する。DBのRLSだけでファイルが保護されたとはみなさない。[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Storage access control](https://supabase.com/docs/guides/storage/security/access-control)。

## 9. 検索・自動タグ

1. 初版：日本語本文・タイトル・人のタグをNFKCで正規化し部分一致。端末にあるRecallだけを対象とする。
2. クラウド：owner・spaces・kind等を適用して検索。日本語の短い語を含む実データで、部分一致／pg_trgm／日本語分かち書き方式を比較する。`english`の全文検索例をそのまま品質保証にしない。
3. 資料解析：caption・OCR・出典テキストを取り込み、タグは提案として表示。人が確定したタグは再解析で上書きしない。
4. 意味検索：テキストembeddingとpgvectorを導入し、モデル名・次元数・入力revisionを記録する。SQL関数内でowner等をフィルターしてからランキング・LIMITを行う。
5. 画像の見た目で探す検索：日本語テキストと画像を同じ空間に置けるmultimodalモデルを少数の資料で検証。captionだけで「青い光の説明」は探せても、構図や色の類似性まで保証したとは扱わない。

「青い夕方の路地」「俯瞰の人物構図」など本人の検索例を20〜30件作り、目的の資料が上位に来るかを評価してからモデルを決める。embeddingモデルと費用は未決定。初期は外部AIへデータを送らない。導入時に送信対象・除外スペース・利用モデル・実行単位の設定を用意する。[Supabase semantic search](https://supabase.com/docs/guides/ai/semantic-search)、[Postgres pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)。

## 10. 実装前に確認すること

初版の端末内版は実装済み。次のクラウド段階では、主な使用端末（iPhone/Android/PC）、既存repoの再利用対象、ホスティング先・Supabase project、ログイン方法、画像保存量、AIへ送信できる範囲を決める。これらは初版の端末内保存・UI確認を妨げない。
