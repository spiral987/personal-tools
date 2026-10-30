# Phase 3 — SketchbookとRecallの連携

2026-10-30。PCで動く2アプリを先に完成させる。公開HTTPS環境への配置は後日とする。

## 体験と受け入れ条件

- Sketchbookを独立したNext.jsアプリとして起動し、同じ入口の `/sketchbook/` から開く。
- 単一1200×800キャンバス。マウス・指・ペンはPointer Eventsで扱い、色、太さ、消しゴム、Undo/Redo、保存、再編集、下書き復元を用意する。
- ストロークJSONを原本とし、PNGは書き出しとクラウド上のprivateプレビューに使う。
- 既存のスペースを共有し、1つのスケッチを複数に置ける。ごみ箱・復元・JSONバックアップを備える。
- Recallのメモを着想元に選び、メモIDを参照する `inspired_by` 関係を保存する。メモ本文を複製しない。両側に原本へのリンクを表示する。
- Cookie、端末内DB、アカウント別DBを共有する。同じoriginでログイン・ログアウトを両アプリへ伝える。別アカウントへ前の本文を表示しない。
- オフライン変更はimmutable outboxに保存し、再送・revision・競合版・削除の取得を既存方式へ追加する。既存のRecallデータと旧バックアップを保持する。
- 各アプリのassetsとservice workerはそれぞれのbasePath内に閉じ込める。公開画面だけをキャッシュし、ログイン応答・個人データ・private PNGをCache Storageに入れない。

## 保存と互換性

共通キャッシュをv3へ上げ、notes/spacesにsketches/relationsを追加する。新クライアントは全種類の変更を取得する。旧Phase 2クライアント用のpullはnote/spaceだけを返し、Sketchbook追加で旧Recallが停止しないようにする。ストローク、relation、バックアップは件数・形・座標・文字数を検証する。

## 起動と配置

開発時は専用Node gatewayが3100番の入口を担当し、Recallの3102番へ `/recall/*`、Sketchbookの3101番へ `/sketchbook/*` を転送する。HTTPとWebSocket Upgradeを中継し、両アプリの開発時の起動も維持する。アプリ間の移動は通常の `<a>` でページを読み直す。共通コードはworkspace packageに置く。独立したbuild/startコマンドと外部gatewayの設定例を用意し、後日それぞれを個別に配置できるようにする。

## 公式資料

- [MDN Pointer Events drawing](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Using_Pointer_Events)
- [MDN setPointerCapture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)
- [Next.js Multi-Zones](https://nextjs.org/docs/app/guides/multi-zones)
- [Next.js rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites)
- [Supabase cookie SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
- [Supabase private Storage](https://supabase.com/docs/guides/storage/buckets/fundamentals)

採用版はNext16.4.3/React19.3.1、Supabase SSR0.12.7/JS2.118.0。ローカルに同梱されるNextドキュメントも確認する。

## 除外する機能

無限キャンバス、高度なブラシ、共同編集、Collect/Atlasの本体はこの段階では追加しない。HTTPS公開と実機2台の試験は後日の作業として明示する。
