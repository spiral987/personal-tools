# Phase 4の検証記録

2026-10-31。Collectの収集基盤と3アプリ統合の記録です。作業用コピーの自動検証、PCブラウザの操作確認、Supabaseへの反映結果を区別します。

採用版：Next.js 16.4.3、React 19.3.1、TypeScript 5.9.3、Supabase SSR 0.12.7／JS 2.118.0、Node.js 24、pnpm 11.25.0。ページ情報の取得にはhtmlparser2 10.0.0、IPの分類にはipaddr.js 2.3.0を固定しています。

## 独立した統合レビュー

| 確認 | 実施結果 |
| --- | --- |
| 認証・metadata・gateway・Next zoneの対象試験 | 28件成功、失敗・スキップなし |
| `pnpm typecheck` | Recall・Sketchbook・Collectすべて成功 |
| 全テスト・本番ビルド | 最終116件すべて成功。3アプリの本番ビルドも成功 |
| PCブラウザ | 端末内のURL・メモ編集、画像保存・preview、本番モードで全ローカルサーバー停止後の再読み込み・追加保存を確認 |
| 実際のSupabase反映 | Phase 4を反映済み。履歴・内容hash・既存件数・RLSを確認 |

gatewayのHTTP／WebSocket試験は実際のloopback接続を使います。初回実行では実行環境の接続制限によるEACCESが2件発生し、local-only接続を許可した再実行で28件すべて成功しました。metadataの外部取得は公開ネットワークへ接続せず、DNS・通信adapterを差し替えて境界条件を確認しています。

確認した境界：

- HTTPS／443番／DNS名だけを許可し、代替表記を含むIP、認証情報、localhost、private・特殊・トンネルアドレスを拒否。1つでも非公開DNS回答が含まれる場合は通信adapterを呼ばない。
- 転送ごとに再解決し、private宛・HTTPへの転送を拒否。転送回数、DNSを含む8秒の期限、256KBの宣言サイズとstreamの実サイズを制限する。
- 検査済みIPをlookupで固定し、TLSのservernameと証明書検証をDNS名に保つ。外部リクエストにブラウザのCookie・Authorizationを付けない。
- HTML以外と圧縮応答を拒否し、HTMLは実行せず文字列として解析。entityを復号し、UTF-16のモデル上限で切り詰め、サロゲートペアを分断しない。画像URLは取得しない。
- NextURLがloopback IPをlocalhostへ正規化しても、元のHostとOriginを比較する。外国origin、過大な本文、誤ったContent-Typeを拒否。同時数・全体のレート上限は転送元IPヘッダーに依存しない。
- 固定gatewayが3つの経路へpath・query・Cookie・HEAD・本文を中継。CollectのWebSocket Upgradeと双方向bytes、1アプリ停止中の残りの応答を確認。
- 採用版Nextのroute compilerで、Collectの共有query、metadata endpoint、manifest、service worker、静的assetの末尾slashとpathを保持。
- 公開設定の秘密鍵拒否、固定の相対callback、ユーザー／project別キャッシュ、別タブのログイン・ログアウトと遅延応答の境界を確認。

コードレビューでは各アプリのPWA scopeとcache対象を確認しました。公開shellと静的assetsはcredentialsを省いて取得し、callback・metadata API・原本・認証応答はservice workerのcache対象外です。Recall／Sketchbookのcache版を更新し、Collectへの移動を含む新しいshellへ切り替える構成です。PC本番モードでの再読み込み試験は以下に記録し、実機の機内モードや完全終了後の起動とは区別します。

## 最終の自動検証

| 実行 | 最終結果 |
| --- | --- |
| `pnpm test` | 116件成功。失敗・中断・スキップ・todoはすべて0件 |
| `pnpm typecheck` | Recall・Sketchbook・Collectの3アプリすべて成功 |
| 3アプリの本番ビルド | 開発サーバーを停止後、Recall→Sketchbook→Collectの順に実行し、すべて成功 |

最終テストにはCollectのデータ試験19件とUI試験9件、既存のRecall／Sketchbook同期、実SQL、認証、metadata、gateway、Next zoneの試験を含みます。画像のJSONB key順が変わっても未変更の原本を編集中と誤認しない回帰試験も成功しました。

旧同期試験のmockへ新しい `pull_tools_changes` RPCを追加し、DB更新の確認先をv4へ合わせました。`pull_sync_changes`／`pull_suite_changes` の旧streamに収集データが混入しない互換性試験は残し、最終実行でも成功しています。最初の制限付き実行ではgatewayのloopback接続だけがEACCESで2件失敗しました。local-only接続を許可し、最終変更を含めて全件を再実行した結果が上表です。

ログは作業フォルダー `work/` に `phase4-verify-tests-final.log`、`phase4-verify-typecheck-final.log`、`phase4-verify-build-final.log` として保存しました。最初の接続制限付き実行も `phase4-verify-tests-restricted.log` に残しています。本番ビルドでCollectの `/api/metadata` とmanifestの生成も確認しました。

PGliteはmigrationの実SQLを実行し、独立した端末キャッシュ間の同期、owner境界、原本の整合性、backupのbytes検証とround tripを確認しています。Auth／Storage schemaは試験用であり、実サービスのメール配信・JWT・Storage HTTP・複数Postgres接続の同時実行とは区別します。

## PCブラウザと実環境への反映

試験用の共通入口は `http://127.0.0.1:3400/`、本体はRecall3402／Sketchbook3401／Collect3403番です。通常起動は入口3100／本体3102・3101・3103番です。別ポート間でIndexedDBを共有したという意味ではありません。

PCブラウザの端末内モードで、次を確認しました。

- URLと自分のメモを保存し、再読み込み後も保持。
- Example Domainのページ情報取得後、自分のメモを編集して保存。
- 512pxの試験用PNGを選び、出典とメモを付けて保存。再読み込み後の画像previewを確認。

画面記録は `outputs/collect-phase4.png` に保存しました。これらの操作でメール送信やクラウドへの試験資料の書き込みは行っていません。ブラウザ操作用ツールの接続が失われたため、ダウンロードした原本・JSON backupのブラウザ実操作による確認は完了していません。自動試験のbytes検証・round tripと区別します。

追加で、ビルド済みの本番モードを同じ3400番入口で起動し、設定画面の「オフライン起動の準備完了」を確認しました。その後gatewayと3アプリのローカルサーバーをすべて停止し、次を確認しました。

- Collectの再読み込みでshellと既存データを表示。
- `https://example.org/offline-check` と自分のメモを追加保存し、保存件数が3件へ増加。
- もう一度再読み込みし、追加した資料の出典・メモと、既存512px PNGのpreviewを保持。
- ページ情報の取得は失敗状態となり、URLと自分のメモを保持。

画面記録は `outputs/collect-phase4-offline.png` です。これはPCで全ローカルサーバーを停止した状態の確認です。コンピューター全体のネットワーク切断、ブラウザの完全終了後の起動、モバイル実機の機内モードは確認していません。

Supabaseの管理側ではPhase 4の適用成功と、次の反映後状態を確認しました。

| 確認対象 | 結果 |
| --- | --- |
| 管理側のmigration履歴 | `20261031065150` / `phase4_collect` |
| ローカルSQL | `supabase/migrations/20261031011207_phase4_collect.sql` |
| 適用内容のSHA256 | `2DFAD73D8DCF4A111A5351B0E4A3F1673FA9899220FA1528664EA62A752A6C33`。ローカルSQLと一致 |
| 既存の件数 | notes 3、items 3、spaces 6、sketches 0、resources 0、assets 0を維持 |
| resourcesのRLS・権限 | RLS有効、anonのSELECT不可、authenticatedのSELECT可・直接INSERT不可 |
| Advisors | 従来からの漏えいpassword保護WARN 1件と未使用indexのINFO 6件。設定手順は[Phase 2](phase2-setup.md)を参照 |

管理側の適用時刻 `20261031065150` とローカルファイル名の時刻 `20261031011207` は一致しません。同じ内容hashで反映済みです。履歴の時刻差だけを理由に再適用せず、管理側の履歴と内容を照合してください。確認なしのCLI一括pushや履歴修復は行っていません。

## まだ確認していないこと

- 公開HTTPSへの配置、iPhone／AndroidへのPWA導入とWeb Share Targetの共有メニュー。
- ブラウザでダウンロードした原本・JSON backupの検証。
- 実機の機内モードでの完全終了・再起動、インターネット全体を切断した操作。
- 実際の別端末・別ブラウザ間での画像原本の送受信と同時token更新。
- 複数のPostgres接続での負荷・ロック競合。

端末キャッシュを独立させた自動試験、PCブラウザの操作、実機2台の確認を混同しません。
