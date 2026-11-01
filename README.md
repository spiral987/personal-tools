# Personal Tools — Recall / Sketchbook / Collect / Atlas

**現在の版は暗号化金庫です。** 初回画面で専用パスフレーズと復旧鍵を設定し、端末でだけ復号します。保存・同期・バックアップは暗号文を使います。既存データは初回設定後に移行します。外部AI・URL自動取得・GET共有ターゲットは停止しています。使い方・移行・保護範囲は [暗号化金庫](docs/encrypted-vault.md) を確認してください。以下のPhase 2〜5の説明は従来機能の記録を含み、暗号化金庫の説明を優先します。

**公開入口：** [Personal tools](https://personal-tools-seven-ruby.vercel.app/)（Vercel Hobby）。24時間の解錠保持、4ツール共通のプロジェクト、原本を残すスペース削除、1か月後のごみ箱整理に対応しています。[段階Dの実装と検証](docs/atlas-improvement-phase-d-verification-2026-11-01.md)。メールログインのSupabase設定と、ローカルの既存記録を引き継ぐ手順は [スマホで使い始める手順](docs/atlas-mobile-setup.md) を確認してください。Galaxy実機・実アカウントの2端末同期は未確認です。

日常の思考、描いたアイデア、外から集めた資料を、それぞれに合う小さなツールで残し、Atlasでつなぐためのモノレポです。

**Phase 5のAtlasで、Recall・Sketchbook・Collectの記録を検索し、関係・タグ・プロジェクトにまとめられます。** Next.js 16.4.3 / React 19.3.1 / TypeScript 5.9.3。接続設定なしでも端末内版を使えます。Supabaseを設定すると、メールログインと複数端末同期が利用できます。画像のcaption／OCRと意味検索は任意設定です。

Supabaseの作成・接続は [Phase 2 セットアップ](docs/phase2-setup.md) を参照してください。公開URLとpublishable keyを `apps/recall/.env.local` に設定します。秘密鍵は使いません。

Sketchbookの使い方と2アプリの起動は [Phase 3 セットアップ](docs/phase3-setup.md)、受け入れ条件は [Phase 3 計画](docs/phase3-plan.md) を参照してください。

Collectの使い方とPhase 4の起動は [Phase 4 セットアップ](docs/phase4-setup.md)、実施した検証は [Phase 4 検証記録](docs/phase4-verification.md) を参照してください。

Atlasと4アプリの起動・AI設定は [Phase 5 セットアップ](docs/phase5-setup.md)、確認済みの範囲は [Phase 5 検証記録](docs/phase5-verification.md) を参照してください。

## 起動

Node.js 24以降、pnpm 11.25.0を使用。ターミナルでこのフォルダーを開きます。

```sh
pnpm install
pnpm build
pnpm start
```

最初に **http://127.0.0.1:3100/** を開くとAtlasホームへ移動します。4ツールはRecallを基準とする共通画面枠で使えます。各ツールは **http://127.0.0.1:3100/recall/**、**http://127.0.0.1:3100/sketchbook/**、**http://127.0.0.1:3100/collect/**、**http://127.0.0.1:3100/atlas/** から直接開けます。`pnpm dev` / `pnpm start` は4アプリと専用の入口を起動し、3100番からすべて開けます（本体はRecall3102番・Sketchbook3101番・Collect3103番・Atlas3104番）。開発中は `pnpm dev`。本番サーバーと開発サーバーは同時に同じポートで起動しないでください。

PWAのオフライン用キャッシュは本番モードでのみ登録します。HTTPSまたはlocalhost/127.0.0.1で一度オンライン起動し、「保存とバックアップ」で準備完了を確認してください。スマートフォンからPCの127.0.0.1には接続できません。実機での導入には次段階のHTTPSデプロイが必要です。

## Recallの機能

- 「Atlas要望」だけをCodex向けに書き出し。共有元はIDで固定し、本文全体が共有対象になることを表示します。解錠後に専用JSONを手動で出力します。[使い方と共有範囲](docs/atlas-requests.md)。

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

## Atlasの機能

種類・スペース・手動タグ・プロジェクトを横断する日本語検索、5種類の関係と逆向き表示、原本への移動、プロジェクトの状態・期日・所属、整理情報のJSON書き出しとクラウド同期。AIを設定すると、選んだ記録だけをOpenAIへ送信してcaption／OCR・タグ候補・text embeddingを作り、意味検索を使えます。初期状態は無効です。検索品質の本人評価と実APIでの解析は未実施です。

## 構成

```text
apps/
  recall/         動作するNext.js PWA
  sketchbook/     動作する描画PWA
  collect/        動作する収集PWA・安全なページ情報取得
  atlas/          動作する横断検索・関連・プロジェクトPWA
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
  phase5-setup.md  Atlas・AI設定・4アプリ起動と評価の手順
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

下書きは保存先ごと・アプリごとに1つです。保存済みの編集にはrevisionによる上書き防止があります。検証の詳細と未確認項目は [Phase 5 検証記録](docs/phase5-verification.md) に記録しています。
