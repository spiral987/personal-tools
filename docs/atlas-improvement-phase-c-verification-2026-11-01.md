# 段階Cの実装と検証

2026-11-01（日本時間）。24時間の解錠保持を実装し、WindowsのBraveで確認した。Vercel Hobbyで **[共通入口](https://personal-tools-seven-ruby.vercel.app/)** を公開済み。Supabaseの戻り先は本人から設定完了の報告を受けた。実際のメールログイン、Galaxy実機での2端末同期が残っているため、段階Cの最終完了判定は保留。

## 実装済み

- 入力成功から24時間、非抽出のAES/HMAC CryptoKeyをIndexedDBで保持する。平文パスフレーズ・復旧鍵は保存しない。ツール移動・再読込・ブラウザ再起動では期限を延長しない。
- 期限・同期先project・アカウント・金庫の鍵情報・失効番号を照合し、一致しない鍵は再利用しない。期限切れは実行中と次回起動時に削除する。
- 手動ロック・ログアウトは全タブの下書き保存を待つ。保存失敗時は操作を中止して入力を残す。期限切れ・外部アカウント変更では保存を試みた後に失効を優先する。鍵の削除が失敗しても、同期的な失効番号の変更後は画面を閉じる。
- 4ツールの設定で従来の短時間ロック（無操作5分・非表示1分）へ切り替えられる。設定変更時も下書きを保存して全タブをロックする。
- 未編集の古いタブが、ロック時に最新の下書きを上書きしないよう修正。Recallの保存を順番に待ち、CollectとSketchbookは保存が必要な下書きだけを書き込む。
- Vercel用の4プロジェクト設定、入口のAtlas転送、許可したソースだけをまとめる配布準備、費用一覧、公開後のGalaxy利用・既存データ移行手順を追加した。

保護範囲と以前の「鍵を永続化しない」方針からの変更は[暗号化金庫](encrypted-vault.md)に反映。期限はアプリの制御で、鍵そのものの暗号学的な失効やハードウェア保護ではない。

## 確認結果

| 対象 | 結果 |
|---|---|
| `pnpm test` | 170件成功、失敗・skipなし。RLS・同期・移行・保存の既存試験を含む |
| `pnpm typecheck` / `pnpm build` | 4ツールすべて成功 |
| ネイティブIndexedDB | 既存の7項目成功。実ブラウザの暗号化・transaction・原本と下書きの復元 |
| 画像・画面操作 | 段階Aの10項目、段階Bの10グループ成功。1440px / 390pxの全24移動ペア、画像原本、メモ・描画の下書き、保存失敗時の移動中止 |
| 解錠保持 | 実ブラウザ8グループ成功。4ツール移動、再読込、プロセス終了・再起動、固定期限、オフライン再読込、ページ復帰、6タブのロック、短時間ロック、期限超過、異なるscopeの拒否 |
| 認証境界 | ブラウザ2グループ成功。サービス通信を模擬し、通信失敗のログアウト後に端末内モードへ戻ること、別アカウントで再解錠が必要なことを確認。実アカウントへのログイン・メール送信・クラウド書き込みは行っていない |
| HTTP配信 | 23項目成功。4ツールの公開shell、JS/CSS・アイコン・manifest・SW、保護ヘッダー、外部AI・URL自動取得の410 |
| 公開URLのHTTP配信 | 61項目成功。4ツールの全配信JS/CSS、PWA関連ファイル、同一originの入口転送、AI・自動取得の停止、不正な認証リンクの安全な戻り先とno-store |
| 公開URLの実ブラウザ | 6グループ成功。新規のテスト用金庫、メモ・画像原本、4ツールの同一origin、初回準備直後のオフライン再読込と画像・メモ・描画復元、再読込時の解錠保持、390px幅の全ツール移動、手動ロックと下書き復元。ブラウザ実行エラー0件 |
| Supabase | 実契約Free、DB 13,457,075 bytes、Storage 0件・0 bytes、Edge Functions 0件。個人の記録本文は照会していない |
| 旧AIワーカー | このPCの実行中Nodeプロセスにatlas-workerなし。通常の起動経路も停止するコードを確認。他の環境やアプリ外の請求は未確認 |
| Vercel | 本人のCLI認証後にHobbyを再確認。既存3プロジェクトを変更せず、今回の4件を追加し、すべてREADYの本番ビルドを反映。接続ツールの一覧0件・作成403はCLIと可視範囲が異なっていた。10月分請求明細は未取得 |
| 公開直後の実行ログ | 共通入口の本番を直近15分・level:errorで照会し0件。Hobbyの保持期間外になる1時間指定は拒否されたため、15分に限定。外部監視サービスは今回追加していない |

期限切れは待ち時間を短縮するためブラウザの時計を進めて確認。ページ保存からの復帰はpageshow/pagehideのイベントを再現した試験で、Galaxyの実機測定ではない。ブラウザ再起動は実際にプロセスを終了し、同じテスト専用プロファイルで再起動した。

試験コード：`tests/vault-device.test.ts`、`scripts/verify-vault-session.mjs`、`scripts/verify-vault-auth.mjs`、`scripts/verify-public-http.mjs`、`scripts/verify-public-suite.mjs`。実行ログ・結果JSONは `work/atlas-improvement-phase-c-2026-10-31/`、公開先の証跡はその中の `public-verification/`。通常の保存領域とCookieを使わない専用origin・専用プロファイルを使用し、公開先の試験も隔離した端末内モードだけで行った。実アカウントのメール送信やクラウドへのテスト記録追加は行っていない。

## 本番への反映

4プロジェクトともNode 22、Next.js、共通パッケージの参照を有効にした。100ファイル・604,876 bytesの許可したソースだけを配布し、環境ファイル・作業ログ・ブラウザプロファイルが送信対象にないことをdry runで照合した。ソースsnapshotは `8a3c7bc60101`、元のGit HEADは `b791e28` と作業中の変更。Gitへのpush・commitは行っていない。

| プロジェクト | 本番ホスト | ビルドID |
|---|---|---|
| personal-tools（Recall入口） | personal-tools-seven-ruby.vercel.app | dpl_AsUGnoXsMdNGHUgmba8m9XU4Bgrr |
| personal-tools-atlas | personal-tools-atlas.vercel.app | dpl_AtQZP2dSLWUiutQXc91B9PoPBusY |
| personal-tools-collect | personal-tools-collect.vercel.app | dpl_61b1QzpjzLXUNZ2gFTd57GmhBQcS |
| personal-tools-sketchbook | personal-tools-sketchbook.vercel.app | dpl_59whM8ZerL3brHRsHMjN7g9XHpib |

本番向けにドメイン未反映のビルドを作り、保護されたURLへVercelの正規認証でアクセスして画面を確認してから、確認した同じビルドを本番へ昇格した。Deployment Protectionは無効化していない。プロジェクトID・実ホスト・設定状態は `deploy/vercel-deployment-2026-11-01.json` に保存。

## 公開の残作業

1. 公開URLから実際にメールログインし、同じブラウザに戻ることを確認する。必要なSite URLとRedirect URLは本人から2項目とも設定完了の報告あり。
2. [スマホの開始・移行手順](atlas-mobile-setup.md)で既存の記録を引き継ぎ、PCとGalaxyの同じ記録・画像、ホーム画面追加、オフライン後の実同期を確認する。

Vercelの本人認証は完了済み。Supabaseのログインについては[Computer Useスキル](C:/Users/satou/.codex/plugins/cache/openai-bundled/computer-use/26.1027.30824/skills/computer-use/SKILL.md)が参照する操作手順の "Do not automate user authentication dialogs." に従い、本人操作を依頼した。設定画面の読み戻しはGitHub認証ページへのアクセスが自動承認審査で拒否されたため行っておらず、設定完了は本人の報告として記録した。別の経路で認証画面を迂回していない。

費用と選定理由は[費用一覧](atlas-costs-2026-11-01.md)。公開URLのPC試験成功を、Galaxy実機・本番の2端末同期成功として扱わない。
