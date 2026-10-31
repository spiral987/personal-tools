# Personal Tools — Recall / Sketchbook / Collect / Atlas

日常の思考、描いたアイデア、外から集めた資料を、それぞれに合う小さなツールで残し、Atlasでつなぐためのモノレポです。

**Recall、Sketchbookに加え、Phase 4のCollectでURLと画像の原本を収集できます。** Next.js 16.4.3 / React 19.3.1 / TypeScript 5.9.3。接続設定なしでも端末内版を使えます。Supabaseを設定すると、メールログインと複数端末同期が利用できます。Atlasは設計段階です。

Supabaseの作成・接続は [Phase 2 セットアップ](docs/phase2-setup.md) を参照してください。公開URLとpublishable keyを `apps/recall/.env.local` に設定します。秘密鍵は使いません。

Sketchbookの使い方と2アプリの起動は [Phase 3 セットアップ](docs/phase3-setup.md)、受け入れ条件は [Phase 3 計画](docs/phase3-plan.md) を参照してください。

Collectの使い方と現在の3アプリの起動は [Phase 4 セットアップ](docs/phase4-setup.md)、実施した検証は [Phase 4 検証記録](docs/phase4-verification.md) を参照してください。

## 起動

Node.js 24以降、pnpm 11.25.0を使用。ターミナルでこのフォルダーを開きます。

```sh
pnpm install
pnpm build
pnpm start
```

ブラウザで **http://127.0.0.1:3100/recall/**、**http://127.0.0.1:3100/sketchbook/**、**http://127.0.0.1:3100/collect/** を開いてください。`pnpm dev` / `pnpm start` は3アプリと専用の入口を起動し、3100番からすべて開けます（本体はRecall3102番・Sketchbook3101番・Collect3103番）。開発中は `pnpm dev`。本番サーバーと開発サーバーは同時に同じポートで起動しないでください。

PWAのオフライン用キャッシュは本番モードでのみ登録します。HTTPSまたはlocalhost/127.0.0.1で一度オンライン起動し、「保存とバックアップ」で準備完了を確認してください。スマートフォンからPCの127.0.0.1には接続できません。実機での導入には次段階のHTTPSデプロイが必要です。

## Recallの機能

- 入力中の下書きを端末に自動保存し、再読み込みで復元。
- 「メモを残す」または Ctrl / ⌘ + Enter で保存。保存完了はIndexedDBのtransaction確定後に表示。
- 日付別の振り返り、全文の日本語部分一致検索（空白区切りのAND、全角英数字の正規化）。
- 自由な名前のスペースを追加。1メモを0個以上のスペースに配置。
- 編集、星、ごみ箱への移動・復元。古い画面からの上書きはrevision比較で拒否。
- JSONバックアップの書き出し・追加読み込み。破損したファイルの検証と全体のatomic import。
- 独立したPWA manifest、アイコン、公開app shellのみのservice workerキャッシュ。

**端末内の保存とクラウド同期は別です。** 「端末内モード」のメモは自動でクラウドへ送りません。ログイン後にアカウントのノートを開き、元の端末内メモを移したい場合は件数を確認して「取り込む」を選びます。クラウド側は保存操作を重複させず再送し、更新が競合したら両方の版を保持します。AI解析はありません。

IndexedDB削除、端末紛失やブラウザの容量回収に備えて書き出しを行ってください。バックアップには現在開いているノートの保存済みメモ、ごみ箱、スペースを含み、下書きは含みません。クラウド版からの書き出しも、別のノートへ読み込める持ち運び用形式です。読み込み・端末からの取り込みは毎回別IDで追加するため、繰り返すと重複します。

同期は起動・画面復帰・通信復帰・保存後・手動操作で行い、画面表示中に定期取得します。ログアウト時にはアカウントの画面と処理を閉じ、別ユーザーの保存領域へ切り替えます。

## Sketchbookの機能

単一キャンバスの線・消しゴム・色・太さ・Undo/Redo、保存と再編集、スペース、ごみ箱、PNG書き出し、JSONバックアップ、クラウド同期。Recallのメモを着想元に結び、双方から原本を開けます。編集原本はストロークJSON、private PNGは派生プレビューです。バックアップは各アプリの記録とスペースを含み、着想元の関係は含みません。

## Collectの機能

URL、PNG／JPEG／GIF／WebP画像の原本、出典URL、自分のメモを収集。未整理の収集箱、スペース、検索、お気に入り、ごみ箱、重複候補、原本を含むJSONバックアップ、クラウド同期を利用できます。URLとメモを端末へ保存してから、別の処理でページのタイトル・説明を取得します。取得できなくても収集は残ります。SNS本文・字幕・動画本体の取得やAI解析は行いません。

画像は1件20MBまで、バックアップに含む画像の合計は32MBまでです。対応ブラウザの共有メニューからは、共有内容を確認して下書きに追加できます。SafariなどではURL貼り付け・画像選択を使えます。

初回アップデートでは全アプリの古いタブをすべて閉じてから開き直してください。保存データの削除は不要です。

## 構成

```text
apps/
  recall/         動作するNext.js PWA
  sketchbook/     動作する描画PWA
  collect/        動作する収集PWA・安全なページ情報取得
  atlas/          設計のみ
packages/
  core/           Note・Sketch・Resource・Space・Relationの型とバックアップ検証
  api-client/     IndexedDB・ユーザー別キャッシュ・同期engine
  auth/           共通cookie認証・アプリ別下書きのReact hook・SSR proxy
  ui/             現在共有する小さな表示部品
docs/
  design.md       要件・UI・構成比較・システム・データモデル
  roadmap.md      段階別の実装と受け入れ条件
  verification.md 実行した検証と残る実機確認
  phase2-setup.md  Supabase作成・メール認証・2端末同期の手順
  phase3-setup.md  Sketchbook・着想元・2アプリ起動の手順
  phase4-setup.md  Collect・原本・3アプリ起動の手順
supabase/
  migrations/     共通テーブル・RLS・同期RPC・private Storage
```

## 検証

```sh
pnpm test
pnpm typecheck
pnpm build
```

ブラウザの保存領域はoriginごとに異なります。`localhost` と `127.0.0.1` を切り替えると別のノートになります。開発モードでは本番用service workerが残ることがあるため、通常の開発は別のポートを使うか、ブラウザでservice workerを解除してください。

下書きは保存先ごと・アプリごとに1つです。保存済みの編集にはrevisionによる上書き防止があります。検証の詳細と未確認項目は [Phase 4 検証記録](docs/phase4-verification.md) に記録しています。
