# Phase 2 検証記録

初回実施日：2026-10-28、最終追試：2026-10-30（日本時間）。対象は移動先 `C:\Users\suwak\Documents\repos\personal-tools` へ反映したPhase 2のソースです。作業用コピーでテストと本番ビルドを行い、クラウドへの接続確認は作成済みSupabaseを対象に実施しました。

## 結果

| 確認 | 結果 |
|---|---|
| 自動テスト | **52件成功、失敗0** |
| Next.js本番ビルド | **成功**。TypeScriptチェックを含む |
| 実Supabaseの公開キーによるHTTP確認 | **4件成功** |
| 実Supabaseのsecurity advisors | **指摘0件**（`lints: []`） |
| 本番プレビューの画面 | メールログインフォームとオフライン用画面の準備完了を確認 |
| 本人のメール受信からログイン完了 | **確認済み**。本人の成功報告とクラウドのログイン記録を確認 |
| 実アカウントのクラウド保存 | **確認済み**。メモ3件・スペース6件・同期操作9件 |
| 実機2台でのログイン・同期 | **未実施** |

エージェントからのメール送信やテスト用Authユーザーの作成は行っていません。本人がログイン操作を行い、保存結果は本文・メールアドレスを取得せず集計だけで確認しました。公開キー以外の秘密キーはHTTP確認に使用せず、キーの値も検証出力へ表示していません。

## 自動テストの内訳

```powershell
node --experimental-strip-types --test tests/*.test.ts
pnpm build
```

| 分類 | 件数 | 主な確認内容 |
|---|---:|---|
| 認証・設定・セッション境界 | 12 | 未設定での端末内起動、秘密キー拒否、固定callback、プロジェクト別キャッシュ、別タブのログイン・ログアウト、遅延session応答の破棄、相対Location・同一origin・非キャッシュ303 |
| PostgreSQL・権限 | 13 | 原本とcursorのatomic保存、操作の冪等再送、revision競合、削除と復元、owner別RLS、他人への参照拒否、Storage方針、公開RPCと非公開実装の権限 |
| 既存Recallの回帰試験 | 8 | 日本語検索、下書き・保存、revision、transaction rollback、ごみ箱、バックアップ、任意スペース |
| 同期応答の検証 | 2 | 種類・日時・cursorの不正応答拒否、例外中のSQLや本文を画面へ出さないこと |
| 同期の統合試験 | 10 | v1端末DBの移行、2端末、応答不明時の再送、連続編集、古いack、競合、差分ページング、アカウント切り替え、明示取り込み、所有者確認 |
| 独立した境界・障害試験 | 7 | 同じ操作を2タブから同時送信、遅延pull、保存失敗時のcursor巻き戻し、205件の実ページ境界、同一UUIDのowner分離、競合版のバックアップ、最新原本を保持した競合解決 |

データベース試験はPGlite上の実PostgreSQLに、`supabase/migrations/` 内の**全migrationをファイル名順に適用**して実行しました。Authのユーザー／claimとStorageの周辺スキーマだけを試験用に用意し、アプリのSQL・同期RPC・JSON検証・IndexedDB保存処理を接続しています。

これは本物のSupabase AuthサーバーのJWT発行やStorage HTTP配信、複数Postgres接続のロック競合を置き換える試験ではありません。同じ操作を2タブから送る試験でも、PGliteへのSQL実行は単一のバックエンドで処理されます。

## 作成済みクラウド環境

- プロジェクト：`personal-tools`
- Project ref：`zdixgamfhdgnqbgjckpj`
- リージョン：東京（`ap-northeast-1`）
- [Supabase Dashboard](https://supabase.com/dashboard/project/zdixgamfhdgnqbgjckpj)

次の2つのmigrationを実際のプロジェクトへ適用済みです。

```text
supabase/migrations/202610280001_phase2_sync.sql
supabase/migrations/20261028063752_harden_sync_rpc_wrappers.sql
```

公開RPCは呼び出し元権限のwrapperとし、所有者検証を行う実装を非公開schemaへ分けています。全所有データのRLSと複合参照、private Storage方針も含みます。適用後のsecurity advisorsは指摘0件でした。performance advisorsは新規の空データベースに対する未使用indexの情報通知のみで、必要な外部キー用indexも追加されています。advisorsの結果だけでアプリ全体の安全性が保証されたとは扱いません。

アプリ側にはProject URLとpublishable keyだけを `apps/recall/.env.local` に設定済みです。`.env.local` はGitや配布ソースZIPへ含めません。

## URL設定とメール認証

Dashboardで次の値の保存を確認済みです。

```text
Site URL:
http://127.0.0.1:3100/recall/

Redirect URL:
http://127.0.0.1:3100/recall/auth/callback/
```

標準のメールテンプレートは変更していません。Supabase標準のPKCEログインリンクを使い、送信を依頼したブラウザでメールのリンクを開きます。2026-10-30に本人からログイン成功の報告があり、クラウドのログイン記録と保存結果も確認しました。

標準メール送信には送信先・頻度の制約があります。独自SMTPを設定する前は、組織メンバーとして登録されている自分のSupabaseアカウントのメールで確認します。具体的な手順と標準PKCE／任意のtoken hash形式の違いは `docs/phase2-setup.md` に記載しています。

## 実環境のHTTP確認

両migrationの適用後に、公開キーだけで次を再確認しました。

```powershell
node scripts/verify-cloud.mjs
```

| Endpoint | HTTP | 確認したこと |
|---|---:|---|
| `/auth/v1/settings` | 200 | Auth公開設定へ到達でき、メール認証が有効 |
| `/rest/v1/items` | 401 | 未ログインでItemを取得できない |
| `/rest/v1/rpc/pull_sync_changes` | 401 | 未ログインで差分を取得できない |
| `/rest/v1/rpc/apply_sync_operation` | 401 | 未ログインで変更を適用できない |

最後の確認はデータを書き換えられない空payloadを使用しました。これらのHTTP試験自体はユーザー作成・メール送信・保存データ変更を伴いません。その後、本人のログイン操作とクラウドの同期記録で、実アカウントからの保存も確認しました。

## 画面確認

独立した本番プレビュー `http://127.0.0.1:3200/recall/` で、メールログインフォームと「オフライン用の画面を準備できました」の表示を確認しました。画面記録は成果物フォルダーの `recall-phase2.png` です。認証フォームから実際のメール送信は行っていません。

普段使う入口は `http://127.0.0.1:3100/recall/` です。移動先のソースと依存ライブラリ・公開接続情報は反映済みです。環境設定と下記のProxy修正を確実に読み直すには、ターミナルでCtrl+Cを押してから `pnpm dev` を起動します。同じ3100番で本番サーバーと開発サーバーを同時に起動しません。

## 開発サーバーの空白画面の修正と比較確認

Windows上のNext.js 16.4.3の開発モードで、広いProxy matcherが公開shellの `/recall/` を対象にすると、HTTP 200にもかかわらず本文0バイト・Content-Typeなしになる現象を確認しました。移動先だけの古いキャッシュではなく、独立した作業用コピーの3300番でも再現しました。取得には `curl --noproxy '*'` を使い、ブラウザのservice workerと外部プロキシを経由しないHTTP応答を比較しました。

| 作業用3300番の条件 | `/recall/` の結果 |
|---|---|
| 元の広いmatcher＋Supabase cookie更新 | HTTP 200、0バイト、Content-Typeなし |
| 同じmatcher＋最小の `NextResponse.next()` のみ | HTTP 200、0バイト、Content-Typeなし |
| Proxyのファイル登録を一時的に外す | HTTP 200、18,553バイト、text/html |
| 実際のcookie更新処理を戻し、matcherを `/auth/:path*` に限定 | HTTP 200、約18.5KB、text/html、公開shellヘッダーあり |

最終実装は `apps/recall/proxy.ts` のmatcherを認証用server経路に限定しています。Recallの通常ページはアカウント本文を埋め込まない匿名shellであり、ブラウザ側のSDKがセッションを扱い、同期RPCはJWTとRLSで所有者を検証します。server側の認証callbackは有効なままです。認証を省略して個人データを公開する変更ではありません。

修正後の作業用開発サーバーで、クエリーなしの `/recall/` はHTTP 200・18,510バイト、manifestはHTTP 200・422バイトでした。不正なcallbackにはHTTP 303と `Cache-Control: private, no-store`、`Referrer-Policy: no-referrer` が返ることも確認しました。実際のメールリンクによる成功経路は、本人のメール確認に残っています。比較確認に使った3300番のサーバーは停止済みです。

## 2026-10-30：認証callbackのorigin保持を追試

Next.jsのNextURLがループバックIPをlocalhostへ正規化するため、`request.url` から絶対URLを作る以前のcallbackでは、127.0.0.1へ来た認証応答がlocalhostへ移ることを確認していました。ブラウザはこれらを別originとして扱うので、認証cookieと端末内データの参照先が変わる原因になります。

callbackの応答を、固定パス `/recall/` と許可した状態値だけを持つ**相対Locationの303**に変更しました。戻り先を `request.url`、Host、X-Forwarded-Host、`next` 等の入力から作りません。SDKによるcode／token hashの確認は変更していません。

作業用コピーだけを3300番の開発モードで起動し、メール送信やAuthユーザー作成をせず次を確認しました。

| 確認 | 結果 |
|---|---|
| 不正なcallback＋外部URLを指定する `next` | HTTP 303、Locationは `/recall/?auth_error=link_failed` のみ |
| callbackの応答ヘッダー | `Cache-Control: private, no-store`、`Referrer-Policy: no-referrer` |
| 上記303を自動追従 | `http://127.0.0.1:3300` のまま、HTTP 200・HTML 18,586バイト |
| クエリーなしの `/recall/` | HTTP 200・HTML 18,510バイト・公開shellヘッダーあり |
| manifest | HTTP 200・422バイト |
| 全自動テスト | 52件成功、失敗0 |
| 最終ソースのNext.js本番ビルド | 成功、TypeScriptチェックを含む |

追加した3件の回帰テストは、成功／設定なし／リンク失敗の全結果の303と安全なヘッダー、127.0.0.1／localhost／公開URLのorigin保持、未知の状態値をLocationへ反映しないことを確認します。成功の状態値は応答生成の単体試験であり、本人のメールを使ったログイン成功の試験ではありません。開発用3300番は停止済みです。

## 2026-10-30：移動先の通常起動を確認

最終修正を移動先へ反映し、`C:\Users\suwak\Documents\repos\personal-tools` で通常の `pnpm dev` を実行しました。特別なCI設定を付けずに起動でき、公開接続情報を読み込んで3100番で待ち受けました。

- `/recall/` はHTTP 200、18,510バイト、`text/html; charset=utf-8`。
- 不正なcallbackはHTTP 303、Location `/recall/?auth_error=link_failed`。
- callbackを追従しても `http://127.0.0.1:3100` を維持し、HTTP 200。
- `private, no-store` と `no-referrer` を確認。
- 実際の移動先の画面で「保存とバックアップ」からメールログインフォームを開けることを確認。
- 開発ライブラリの保存先はユーザーの標準pnpm storeへ統一。アプリのソース、端末内のメモ、公開接続設定は保持。

同日に実SupabaseのHTTP試験4件を再実行し、Auth設定200・未認証のItem取得／pull／applyは401でした。プロジェクトは `ACTIVE_HEALTHY`、security advisorsは引き続き指摘0件です。

## 2026-10-30：本人のログインと実クラウド保存を確認

本人から「ログインできました」と報告を受け、管理接続の読み取り専用SQLで次の集計を確認しました。

- ログイン記録のある実ユーザー：1人。
- 保存されたメモ：3件。
- 保存されたスペース：6件。
- 記録された同期操作：9件。
- 競合記録：0件。

メモ本文・メールアドレス・認証トークンは確認用に取得していません。エージェント側からテスト用メモを追加していない状態で、本人のブラウザ操作がクラウド保存まで到達したことを確認できました。別ブラウザ／実機2台間の実際の同期と、通信断・同時編集の実機試験は引き続き残っています。

## 本人がログインした後に確認すること

1. 自分のメールへログインリンクを送り、同じ端末・同じブラウザで開く。
2. アカウントのノートへ切り替わり、端末内の既存メモが勝手に送信されないことを確認する。
3. 必要な場合だけ件数と取り込み先を確認して取り込み、元の端末内メモも残ることを確認する。
4. 別ブラウザ／別プロファイルで同じアカウントにログインし、新規・編集・ごみ箱・復元が同期することを確認する。
5. 通信断と同時編集を試し、同じメモが重複せず、競合時は両方の本文を残して解決できることを確認する。
6. ログアウトやアカウント切り替えで、前のアカウントの本文・下書き・編集中の画面が残らないことを確認する。

iPhone／Androidの実機2台での試験には、アプリのHTTPS配信と、その公開callback URLをSupabaseへ追加する設定が必要です。今回の作業でアプリ自体は外部公開していません。
