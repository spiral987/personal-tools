# 段階D — プロジェクトと削除の共通化

2026-11-01。実装・ローカル検証・公開先への反映を実施した。公開入口は [Personal tools](https://personal-tools-seven-ruby.vercel.app/)。Vercel Hobby / Supabase Freeを継続している。

## 使えるようになった操作

- Atlasの既存プロジェクトを4ツールで共有。一覧、絞り込み、作成・編集・削除、記録の所属変更に対応。各アプリ用の複製は作らない。
- 各ツールの「保存とアカウント」からスペースを削除。そのIDへの所属を記録と全下書きから外し、原本・ほかのスペース・手動タグ・プロジェクトは残す。
- Atlas要望の共有元スペースを削除すると、共有を無効として表示して書き出しを止める。同名の別スペースへ自動では切り替えない。
- メモ・資料・スケッチのごみ箱を、日本時間で翌月の同日時に期限切れにする。同じ日がない月は月末に丸め、復元で期限解除、再度ごみ箱に入れたときは新しい期限を設定する。
- 期限切れの記録は編集・復元できない。削除通知を残し、古い端末からの更新で復活させない。

Collectの画面試験で見つかった、新規入力への切替待ち中に入力が上書きされる場合も修正した。切替前の保存が終わるまで入力を待たせる。

## 自動削除と保護範囲

本文・タイトル・タグ等の暗号化を維持する。サーバーが持つ追加情報は削除期限、不透明な原本パス、関連先のID。復号鍵・パスフレーズ・本文は渡さない。同期操作の同一性確認には、この情報も含めたHMACを使う。

既存の暗号文だけでは期限や古いファイル参照を読めないため、更新したアプリでアカウントの金庫を一度開いたときに、端末で現行版・変更履歴・操作履歴・移行アーカイブを確認する。索引がすべて完成してから、そのアカウントの自動削除を有効にする。通信断では続きから再開する。この準備が始まった後は古い同期方式の書き込みを拒否するため、全ツールの古いタブを閉じ、開き直す。

`pg_cron` が10分ごとに期限を確認する。原本の暗号文・その項目の履歴・競合版・該当するアーカイブを削除し、本文を含まない通知と再送確認情報を残す。ラベル・関連付けも対象の記録に合わせて整理する。プロジェクトのほかの記録は残す。

画像は参照索引を使い、ほかの記録が参照する間は保持する。参照がなくなった後、10分の待機期間を置き、`vault-retention` Edge FunctionがStorage APIで実データを削除する。SQLで`storage.objects`だけを消す方式にはしない。失敗は再試行し、処理中のパスへの再アップロードを拒否して、遅い削除処理が新しい参照を消さないようにする。

期限到達と物理削除の完了には時間差がある。通常の小規模な処理では、ファイル削除は期限から数十分程度の時間差が目安。大量件数・通信障害・Freeの休止中などはさらに遅れることがある。期限後の復元は待機中も拒否する。

端末内モードは次回起動時と、開いている間の定期処理で削除する。オフラインのアカウント用キャッシュは期限後に非表示・整理するが、別端末で期限前に復元されていた可能性があるため、それだけでクラウド原本を消さない。サーバーの最新状態と永久削除通知を確認する。別端末での復元に備え、オフライン中の画像の暗号化キャッシュは削除確定まで保持し、確定通知の受信時に整理する。オフライン用service workerもv5へ更新した。

提供元のバックアップ・ログ、手動で出力したバックアップ・PNGの消去は別であり、この処理で回収しない。Driveは未接続で、Drive原本には変更しない。Fで追加する原本の扱いは別途設計する。

## 検証結果

| 対象 | 結果 |
|---|---|
| 自動試験 | 全184テスト成功。月末・うるう年・年越し、復元と再削除、実Postgres互換のSQL、古い端末の更新、所有者とworkerの権限、共有画像と再試行を含む |
| 4アプリ | 型チェックと本番ビルドがすべて成功 |
| Dの実ブラウザ試験 | 9群成功。実IndexedDB、遅い暗号処理、全下書き、4ツールの所属・絞り込み、390px幅、作成・改名・削除、共有無効化、ごみ箱の復元 |
| 既存画面の回帰 | ネイティブ保存7群、画像保存・貼り付け10群、共通画面と移動10群、解錠保持8群、模擬認証2群が成功 |
| 公開HTTP | 61項目成功。4ツールのページ・静的ファイル・manifest・service worker・アイコン・安全なヘッダーと認証戻り先 |
| 公開ブラウザ | 9群成功。新規の隔離した端末内金庫で、保存・オフライン再読込・解錠保持・スマホ幅・3ツールのプロジェクト所属・スペース削除・プロジェクト削除を確認 |
| Supabase実環境 | 2本のmigrationを適用。定期ジョブの自然実行が`succeeded`、Edgeの応答200・失敗0を確認。認証なしの呼び出しは401、応答はno-store |
| アドバイザー | 今回追加したRLSと拡張の指摘を修正。セキュリティは従来からの[漏えいパスワード保護](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)の警告だけ。未使用索引の情報通知は保持 |
| Vercel | 4つの検証済み本番ビルドを昇格。入口の直近15分のruntimeエラー0件 |

公開ブラウザ試験では実アカウントへログインせず、実データを変更していない。実アカウントのメールログイン、Galaxy実機、ホーム画面追加、実際の2端末同期は未確認。期限削除・オフラインの古い操作の拒否は、隔離したIndexedDBとSQL環境で確認した。実環境で本人の記録を試験用に期限切れにはしていない。

## 公開した構成

ソースの基準commitは`b791e28`、作業中の変更を含む。送信したスナップショットは`b67ad839e3a1`、104ファイル・636,995 bytes。許可したソースのパス・ハッシュをCLIの送信対象と照合した。環境ファイル、認証情報、テスト、work、Supabaseの秘密は含めていない。

| アプリ | Vercelプロジェクト | 本番deployment |
|---|---|---|
| Recall・共通入口 | personal-tools | `dpl_2y5XGHXUPfUCoRpki8Z1QJpjw42z` |
| Atlas | personal-tools-atlas | `dpl_5zPbrYH6h5s3JXRa4tEpRYuBUFTe` |
| Collect | personal-tools-collect | `dpl_CgCghuGt5uVgXk2PnphVJCzv6TcP` |
| Sketchbook | personal-tools-sketchbook | `dpl_7mj19gCMAaHVmBFv3jCevTD4obZD` |

Supabaseの追加migrationは`20261031174826_suite_lifecycle.sql`、`20261031225314_harden_vault_retention.sql`。Edge Functionは`vault-retention` v1。`pg_net`はextensions schema、workerの秘密はSupabase Vaultで管理する。アプリ用の環境変数にservice_roleやworker tokenを追加していない。

証跡は `work/atlas-improvement-phase-d-2026-11-01/`。`lifecycle-browser-results.json`、`public-verification/browser-results.json`、`public-verification/http-results.json`、各チェックのログと画面画像を保存した。実行用のスクリプトは `scripts/verify-lifecycle-ui.mjs`、公開確認は `scripts/verify-public-suite.mjs --lifecycle`。

期限削除の仕組みは [Supabaseの定期実行](https://supabase.com/docs/guides/functions/schedule-functions)、画像の削除は [Storage API](https://supabase.com/docs/reference/javascript/storage-from-remove) に従う。契約と上限の扱いは [費用記録](atlas-costs-2026-11-01.md)、利用時の更新手順は [暗号化金庫](encrypted-vault.md) を参照。
