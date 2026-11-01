# Atlas改善・段階Aの実装と検証

2026-10-31（日本時間）。[改善計画](atlas-improvement-plan-2026-10-31.md)の段階Aを実装した記録。段階B〜Gの実装完了を意味しない。

## 今回の変更

- Collectの画像保存時の `TransactionInactiveError` を修正。暗号化IndexedDBと旧データ移行の両方を対象にした。
- Collectの入力欄でCtrl / ⌘ + Vの画像貼り付けに対応。ファイル選択と同じ原本検証・保存経路を使う。
- 文章だけの貼り付けはブラウザの標準動作を維持。入力済みのタイトル、メモ、スペースを残す。リンクのURLは画像の出典へ移し、異なるURLと出典URLが両方ある場合は、両方を保持できるようリンクの保存を案内する。
- 選択済みの画像は貼り付けで上書きしない。保存済み資料の編集中は、新しい収集からの追加を案内する。
- Recallの「このメモから描く」を削除。既存の関連スケッチを開くリンクは維持した。
- Recall、Collect、Sketchbook、Atlasの見出し、空画面、補足、アプリ名の装飾的なコピーを、操作と状態を伝える文言へ整理した。ユーザーが保存した本文は変更していない。

開始時点の多数の作業中変更は保持した。開始時の状態と追跡済みファイルの差分は `work/atlas-improvement-2026-10-31/baseline-status.txt` と `baseline.patch` に記録した。

## 再現と修正の根拠

WindowsのBrave（headless、Chromium 156）を、通常利用とは別のブラウザコンテキスト・別origin（`127.0.0.1:3190`）で起動した。実際のIndexedDB、Blob、WebCryptoを使用し、修正前に次のエラーを再現した。

```text
TransactionInactiveError: Failed to execute 'put' on 'IDBObjectStore': The transaction is not active.
```

従来の実装は読み取りリクエストを繰り返してトランザクションの自動確定を防いでいたが、Blob読込・暗号処理の継続処理から直接 `put` していた。トランザクションが生存していても、別タスクでは書き込み可能なactive状態とは限らない。[IndexedDBのトランザクション仕様](https://www.w3.org/TR/IndexedDB/#transaction-lifecycle)に合わせ、ネイティブのリクエストコールバック内でDB操作を実行する待ち行列に変更した。

revisionの確認と書き込みは、従来どおり同じネイティブのトランザクション内で行う。原本、記録、下書きの解除、同期待ちの一括確定と、失敗時の取り消しを維持する。暗号化やDB操作の失敗はトランザクションのabortへ伝え、commit前に保存成功を返さない。スキーマと暗号文の形式は変更していない。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| `pnpm test` | 156件成功。失敗・スキップ・中断なし |
| `pnpm typecheck` | 4アプリ成功 |
| `pnpm build` | 4アプリ成功 |
| 実IndexedDBの追加試験 | 7項目成功 |
| 実ブラウザの画面操作 | 10項目成功。開発版と本番ビルドの両方で実施 |
| 既存の本番HTTP確認スクリプト | 23項目成功。4アプリ、Atlas静的ファイル、manifest等を確認。AI APIとURL自動取得は410で停止を維持 |
| 画面の目視確認 | CollectのPC幅・390px幅、RecallのPC幅をスクリーンショットで確認 |

実IndexedDBの7項目は、画像下書き・投稿・再接続後の原本取得、Blob読込と暗号処理の遅延下での連続保存、独立した2接続の同時編集、容量エラー時の全体取り消し、暗号処理中のロック、ネイティブリクエストの非同期エラー、旧形式の画像下書きの暗号化移行。

画面操作の10項目は、画像ファイル選択と自動保存、再読込後の下書き復元・投稿、実際のCtrl+Vによる画像貼り付けと入力保持、投稿画像2件の再読込後の表示、編集中の原本上書き防止、通常文章のCtrl+V、破損画像の拒否、容量エラー時の表示・入力保持・再試行、390px幅での貼り付け・投稿、Recallの不要なボタンの削除と既存関連リンクの維持。

容量エラーは `QuotaExceededError` を注入した試験であり、PCのディスクを満杯にはしていない。非同期エラー試験は、ネイティブIndexedDBの重複キーによる `ConstraintError` を発生させている。遅延試験では、Blob読込とWebCryptoにそれぞれ20ms・35msの遅延を加えた。ロック試験は暗号処理に100msの遅延を加えて途中でロックし、確定済み下書きが残り、未確定の原本と記録が残らないことを確認した。

結果、ログ、画面画像は `work/atlas-improvement-2026-10-31/` に保存している。主なファイルは `browser-baseline.json`、`browser-results.json`、`browser-ui-results.json`、`browser-ui-production.log`、`tests.log`、`typecheck.log`、`build.log`、`production-http.log`、`collect-desktop.png`、`collect-mobile.png`、`recall-desktop.png`。

## 再実行

本番ビルドの後、別々のターミナルで以下を起動する。3190番は試験用の保存領域であり、通常の3100番のデータを試験に使わない。

```powershell
$env:GATEWAY_PORT='3191'
node scripts/run-apps.mjs start
```

```powershell
node scripts/verify-collect-browser.mjs
```

`http://127.0.0.1:3190/__verify/` を開くと、実IndexedDBの7項目が実行される。通常利用とは別のブラウザプロファイルで開くこと。専用のサンプル金庫、サンプル画像、検証用のメモとスケッチを作成する。

画面操作の自動試験は、利用できるPlaywright CoreとChromium系ブラウザを指定して `node scripts/verify-collect-ui.mjs` を実行する。`PLAYWRIGHT_MODULE` はモジュール指定またはESMのfile URL、`COLLECT_BROWSER_EXECUTABLE` はブラウザ実行ファイルの絶対パス。省略時は通常の `playwright-core` とそのChromiumを使う。このリポジトリの通常テストにPlaywrightのインストールは必須ではない。

## 未確認と次の段階

- Galaxy実機、AndroidのOS画像クリップボード、Macの⌘+V、Safariは未確認。390px幅のPCブラウザ試験を実機試験の代わりには扱わない。
- HTTPS公開先への反映、PCとスマホの実アカウント同期、24時間の解錠保持は今回の対象外。
- 段階BのRecall基準の共通UIとAtlasホームへの入口変更は未実装。既存のルートと画面配置を前提に、段階Aだけを先に出せる状態にした。
- 段階C以降の公開先・費用確認、プロジェクトと削除の共通化、出力用ツール、Drive・インポート対応は改善計画に残っている。
