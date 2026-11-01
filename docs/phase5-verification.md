# Phase 5の検証記録

2026-10-31（日本時間）。実装、自動試験、ローカルHTTP、実際のSupabase反映、未実施の本人評価を区別します。

## 実装した範囲

Atlasの匿名shellと独立したPWA scope、Recall／Sketchbook／Collectの原本を参照する一覧、日本語AND部分一致、種類・スペース・手動タグ・プロジェクトの絞り込み、原本へのリンク。5種類の関係と逆向き表示、対称関係の重複防止、プロジェクトの説明・状態・期日・所属、手動タグ、整理情報のJSON書き出しを追加しました。

IndexedDBはv5。既存の原本・下書き・未送信操作を保持し、projects／labelsを追加します。immutable outbox、revision、競合版の保持を既存同期へ統合し、全4アプリで新しいowner別streamを読みます。古いstreamには新しい種類を混ぜません。

AIは初期状態で無効。選択した記録だけを解析予約でき、永続jobを別プロセスのワーカーが処理します。caption／OCR／候補タグとtext embeddingを保存し、手動タグは変更しません。可変次元の正確なcosine比較を使用し、モデル・次元・最新revisionを確認します。owner・種類・スペース・手動タグ・プロジェクトとAI除外設定をSQL内でランキング前に適用します。

## 自動試験

| 確認 | 結果 |
| --- | --- |
| 全体試験 | 136件すべて成功。失敗・スキップ・中断0件 |
| 4アプリのTypeScript | Recall／Sketchbook／Collect／Atlasすべて成功 |
| 4アプリの本番ビルド | すべて成功。Atlasの静的shell・manifest、動的AI API・proxyを確認 |
| ローカル本番HTTP | 20項目成功。全4アプリの200応答、Atlas shell header・JS/CSS・manifest・SVG/PNG・SW、AI無効状態・外国originの403。公開JSへサーバー用AI実装が混入していないことも確認 |
| 実際のSupabase | Phase 5反映済み。既存件数・RLS・worker実行権限を確認 |

主な追加試験は、日本語・全角英数字・複数語検索、分類なしの原本、関係の逆向き表示と対称ID、古いrevisionの拒否、2つの独立した端末キャッシュ間でのプロジェクト／タグ／関連の同期、競合版保持、別ownerの所属参照拒否です。

AIは提供元への通信を差し替え、Structured Outputsの形、caption／OCR／候補タグ、embeddingの有限値・次元・モデルID、長い日本語OCRのUTF-8上限、拒否・不完全応答、private画像原本のハッシュ検証を確認しました。APIのOrigin・ログイン・利用設定の確認が外部AI呼び出しより前に行われることも確認しています。

実SQLでは明示同意、除外スペース、job重複・lease・token・再試行、更新／ごみ箱／再分類／モデル変更後の古い結果破棄、owner・space・kind・tag・projectで絞ってからLIMITされることを確認しました。20〜30クエリーの評価集計は、人が目的のIDを指定していない空欄テンプレートを拒否します。

最初の全体試験ではsandboxのloopback接続制限でgatewayの2件だけEACCESとなりました。ローカル接続を許可した最終実行では成功しています。AtlasとRecallの最終ビルドでもsandboxから `.next` 内の再生成がEPERMとなったため、同じビルドを制限外で再実行して成功しました。ログは `work/phase5-tests-final.log`。Node.jsの実行環境は22.23.4、pnpmは11.25.0、Next.js16.4.3／React19.3.1／TypeScript5.9.3です。日常のセットアップ手順は従来どおりNode.js24以降を推奨しています。

PGliteはmigrationの実SQLを実行しますが、Auth／Storageのscaffoldは試験用です。実際のメール認証、複数Postgres接続のロック競合、提供元APIの品質や性能とは区別します。

## Supabase反映

既存の開発project `zdixgamfhdgnqbgjckpj`（personal-tools／東京）に追加しました。既存migrationはPhase 4までであることを事前に確認し、CLI一括pushや履歴修復は行っていません。

| 確認 | 結果 |
| --- | --- |
| 管理側migration | `20261031074910` / `phase5_atlas` |
| リポジトリSQL | `supabase/migrations/20261031072324_phase5_atlas.sql` |
| 内容の照合 | コメント・空白・文区切りを除いたSQLのMD5 `b7c2b09f678a0671f80f8ead2013af04` が一致。改行表現の差は除外 |
| 既存データ | items 3、notes 3、spaces 6を維持 |
| 新しい6テーブル | すべてRLS有効。anonのSELECT不可、authenticatedのSELECT可・直接INSERT不可 |
| workerのclaim RPC | anon／authenticatedのEXECUTE不可、service_roleのみ可 |
| AIの実行状態 | settings 0、jobs 0、search_documents 0。私有資料の外部送信は実施していない |
| Security Advisors | 追加の指摘なし。従来からの漏えいpassword保護WARN 1件 |
| Performance Advisors | 未使用indexのINFO 9件（今回の3個を含む）。それ以外の指摘なし |

管理側時刻とローカルファイル名は過去段階と同様に一致しません。同じmigrationを再適用する理由にはしません。

既存WARNの説明：[漏えいpassword保護](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)。INFOの説明：[未使用index](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)。設定変更や既存index削除は今回行っていません。

## 未実施

- Computer Useは現在のブラウザURLを十分な確度で確認できず停止しました。その後の画面自動操作は行っていません。今回はブラウザでの表示・クリック・レスポンシブ配置の確認を完了したとは扱いません。
- 私有画像を使った実OpenAI APIの解析と、本人による20〜30件の日本語検索品質評価。モデルも未選定です。`phase5-evaluation.template.json` と `pnpm atlas:evaluate` を用意しています。
- 描画そのものの視覚解析、画像と日本語の直接multimodal embedding、近似vector indexは未採用です。
- 公開HTTPS、iPhone／Androidの導入・完全終了・機内モード試験、Atlasのservice workerの実ブラウザでのオフライン起動。
- 実機2台での操作、実Postgresの複数接続による負荷・ロック競合、ワーカーの常駐配置。

Phase 5の機能と評価基盤の実装は完了しています。ロードマップの「本人が目的の画像を探せるか評価する」という受け入れ項目は未完了です。
