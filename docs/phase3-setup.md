# Phase 3の起動と使い方

2026-10-30。PCでRecallとSketchbookを使う構成です。HTTPS公開は後日にします。

## 起動

Node.js 24以降、pnpm 11.25.0を使用します。移動先 `C:\Users\suwak\Documents\repos\personal-tools` をターミナルで開きます。

```powershell
pnpm install
pnpm dev
```

- Recall：<http://127.0.0.1:3100/recall/>
- Sketchbook：<http://127.0.0.1:3100/sketchbook/>

`pnpm dev` が2つのアプリと専用の入口を起動します。3100番が共通の入口、3102番がRecall本体、3101番がSketchbook本体です。通常はどちらも **3100番のURL** で開いてください。別ポートを直接開くと別originの端末内保存領域になります。両方を止めるときは起動したターミナルでCtrl+Cを押します。すでに3100番が動いている場合は、先のサーバーを止めてから起動します。

本番モードでは次の順です。同じポートの開発サーバーを先に止めてください。

```powershell
pnpm build
pnpm start
```

個別に作業する場合は、3つのターミナルで `pnpm dev:gateway`、`pnpm dev:recall`、`pnpm dev:sketchbook` を起動できます。それぞれ共通入口3100番、Recall3102番、Sketchbook3101番です。片方だけを再起動する検証にはこちらを使います。まとめて起動するヘルパーでも、片方が停止しても入口ともう片方を継続します。停止中のアプリへのアクセスは503を返し、再起動すると再び開けます。Ctrl+Cは自身が起動したアプリだけを終了し、既存の別プロセスは終了しません。

入口はHTTPに加え、各アプリの開発中の双方向接続（WebSocket Upgrade）も正しいアプリへ中継します。Next.jsの画面転送だけでは、描画画面が読み込み中のままになる問題があったため、独立した小さなNode gatewayにしました。追加パッケージはありません。

開発用の共通入口は `GATEWAY_PORT` で指定します。旧手順との互換性のため `RECALL_PORT` も共通入口の別名として利用できます。Recall本体は `RECALL_BACKEND_PORT`（省略時は入口+2）、Sketchbook本体は `SKETCHBOOK_PORT`（省略時は入口+1）です。ヘルパーは転送先も同じ設定に合わせます。たとえば3300/3301で起動するときは以下です。

```powershell
$env:GATEWAY_PORT = '3300'
pnpm dev
```

## 初回アップデート

RecallとSketchbookのタブをいったんすべて閉じ、更新後のサーバーを起動して開き直してください。共通DBのv2からv3への更新で既存のメモ、スペース、下書きを引き継ぎます。IndexedDBやブラウザの保存データを消す必要はありません。旧画面をオフラインで開き続けると古いDBバージョンで開けない場合があります。オンラインで新しい画面へ更新してください。

この初回だけは、新しいRecallを先に反映してからSketchbookを使い始めます。サーバーは旧Phase 2のメモ・スペース同期契約も保持します。

## 描く・つなぐ

1. Sketchbookで線を描き、色や太さを選びます。消しゴム、元に戻す、やり直すが使えます。
2. タイトルとスペースを選び、保存します。JSONの線を原本にするため、再読み込み後にも編集を続けられます。
3. Recallのメモにある「このメモから描く」を開くと、そのIDを着想元として選べます。保存後はメモとスケッチの両側から開けます。メモ本文のコピーは作りません。
4. PNG書き出しは画像として持ち出すときに、JSONバックアップは編集できる線を持ち出すときに使います。

Recallのバックアップはメモ・スペースを、Sketchbookのバックアップはスケッチ・スペースを含みます。**着想元の関係と入力途中の下書きはバックアップ・端末内からの取り込みに含みません。** 読み込みは新しいIDで追加するので、繰り返すと重複します。読み込み後に着想元を結び直してください。クラウド同期では関係も保存します。

## 共通ログイン

両アプリの `.env.local` に同じSupabaseの公開URLとpublishable keyを設定します。今回の反映では既存Recallから、新規Sketchbookへこの2項目だけをコピーします。秘密鍵は使いません。

```text
NEXT_PUBLIC_SUPABASE_URL=プロジェクトのURL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=publishable key
```

接続設定がなくても端末内で描画・保存できます。設定があると、同じ3100番の入口でCookieとアカウント別キャッシュを共有します。Sketchbookからログインメールを送った場合も既存の `/recall/auth/callback/` を使い、Recallへ戻ります。その後Sketchbookを開いてください。メールリンクは送信したブラウザ・originで開きます。

このブラウザからログアウトすると、同じoriginで開いている両アプリのアカウント画面を閉じます。他の端末のログインは継続します。端末内モードのデータはアカウントに自動アップロードしません。取り込みボタンで対象件数を確認してコピーします。

保存は端末で確定してから表示し、クラウド同期と区別します。通信が戻れば起動・画面復帰・保存後・定期取得・手動操作で同期します。PNGプレビューはprivate Storageへ置く派生データです。プレビューの送信に失敗しても線の原本を失いません。

## 後日のHTTPS公開

2つのNextアプリを個別にbuild/deployできます。外部gatewayで `/recall/*` をRecallへ、`/sketchbook/*` をSketchbookへ転送すれば、一方の更新に他方の再ビルドは不要です。CookieのPathは `/`、assetsとPWA scopeは各basePathに閉じています。異なる公開originをそのまま開くだけでは同じ端末内データやSSOにはなりません。

PCでは `pnpm start` が開発時と同じ専用gatewayを使います。`pnpm start:gateway` で入口だけを独立起動することもできます。専用gatewayは127.0.0.1だけで待ち受けるローカル用途です。公開HTTPSの終端はCaddy等で担当し、各アプリの本体へ直接転送する構成を推奨します。

外部gatewayを使わない配置の選択肢として、Recall自身のrewritesも残しています（本番モード用）。Recallをbuildする時点で、サーバー専用の `SKETCHBOOK_ORIGIN=https://スケッチアプリの配置先` を設定します。path・認証情報・queryを付けないoriginだけを指定してください。転送ルールはbuild時に確定するため、変更時はRecallを再buildします。

独立gatewayの例は `deploy/Caddyfile.example` にあります。HTTPSドメイン、公開環境のSupabase Site URLと正確なcallback URL、両アプリの公開env、private Storageの権限を設定してから公開します。この段階で有料サービスの追加や公開は行っていません。

## 検証

```powershell
pnpm test
pnpm typecheck
pnpm build
```

実行結果と未確認項目は `docs/phase3-verification.md` を参照してください。PCの127.0.0.1はスマートフォンからは開けません。実機PWAの機内モード・筆圧の確認はHTTPS公開後に行います。
