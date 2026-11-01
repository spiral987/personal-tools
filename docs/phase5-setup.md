# Phase 5 — Atlasの起動と使い方

AtlasでRecall・Sketchbook・Collectの記録を横断し、関係・タグ・プロジェクトを整理できます。原本を複製せず、元のItem IDを参照します。AIを設定しなくても一覧・部分一致検索・整理は動作します。

## 起動

```sh
pnpm install
pnpm build
pnpm start
```

共通入口は `http://127.0.0.1:3100/atlas/` です。入口3100番、本体はRecall3102／Sketchbook3101／Collect3103／Atlas3104番。`pnpm dev` も4アプリを起動します。Atlasだけの開発は `pnpm dev:atlas` ですが、端末データはorigin単位のため、日常の利用は共通入口へ揃えてください。

更新時は4アプリの古いタブを閉じて開き直してください。IndexedDBはv5へ移行し、既存の原本・下書き・未送信操作を保持します。アカウントの変更cursorを一度巻き戻し、新しい種類を取得します。保存領域の削除は不要です。

## 探す・つなぐ・まとめる

- 検索は日本語の部分一致、空白区切りAND、NFKC正規化。本文・タイトル・収集メモ・ページ情報・手動タグが対象です。種類／スペース／タグ／プロジェクトを組み合わせて絞れます。未分類の記録も全件一覧に含みます。
- 記録を選び「原本を開く」で元のツールへ移動します。画像原本は端末またはprivate Storageから取得し、ハッシュを検証します。
- 関係は「着想を得た／詳しく展開した／根拠にしている／異なる見方を示す／関連する」。逆向きにも表示します。「関連する」は両端のIDを正規化し、逆方向に追加しても同じ関係になります。
- プロジェクトは名前・説明・進行中／保留／完了・期日・所属する記録を保存します。プロジェクトを削除しても原本は残ります。
- 自分のタグは50個まで、1個40文字まで。AI候補は「＋」を選んだものだけ自分のタグになります。
- 整理情報のJSON書き出しにはプロジェクト・関係・タグと原本IDを含みます。これは参照情報の書き出しで、原本・画像を含む一括復元用形式ではありません。原本は各ツールでも書き出してください。各ツールでの追加読み込みは原本IDを再発行するため、Atlasの参照を自動で結び直しません。

同じアカウントでは整理情報も既存のimmutable operation／revision／競合保存を使って同期します。プロジェクトの「端末の変更も残す」は別プロジェクトを作り、タグと関係では同じ対象へ端末の版を再適用します。端末内の原本をアカウントへ移す操作は、従来どおり各ツールで明示的に実行します。

## Supabase

新しい開発projectには `supabase/migrations/` のSQLを順番に適用します。既存の `personal-tools` projectでは過去の管理側migration時刻がファイル名と異なるため、履歴と内容を照合し、未適用のPhase 5だけを適用します。一括pushや履歴修復は不要です。

今回のmigrationは `20261031072324_phase5_atlas.sql`。projects／project_items／item_labels、AI設定／job／検索文書とRLS、`pull_atlas_changes`、解析と検索用RPCを追加します。既存streamは新しい種類を返しません。実際の反映状況は[検証記録](phase5-verification.md)を参照してください。

4アプリの `.env.local` に同じ `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` を設定します。メール認証のcallbackは引き続きRecallです。新しいログイン先URLの登録は不要です。

## 任意の画像意味検索

初期状態では無効です。本人が選んだ少数のテスト資料から開始してください。

1. `apps/atlas/.env.example` を参考に、Atlasのサーバーへ `ATLAS_AI_ENABLED=true`、`OPENAI_API_KEY`、`ATLAS_VISION_MODEL`、`ATLAS_EMBEDDING_MODEL` を設定して再起動します。画像入力・Structured Outputs対応モデルとtext embeddingモデルの正確なIDを指定します。モデル選定は固定していません。embeddingのAPI応答モデルIDも設定値と一致する必要があります。
2. ワーカーの実行環境へ同じ設定と、対象projectのサーバー専用 `ATLAS_WORKER_SECRET` を設定します。この鍵はservice_role／secret keyです。`NEXT_PUBLIC_`へ設定しないでください。公開キーだけではワーカーRPCを呼べません。
3. `pnpm atlas:worker` を別プロセスで起動します。1回の処理確認は `pnpm atlas:worker -- --once`。本番ではプロセス管理下で常駐させます。ブラウザを閉じてもjobは残り、ワーカーが処理します。
4. Atlasでアカウントを開き、「AI設定」で送信内容とモデルを確認します。送信しないスペースを選び、利用設定を保存します。
5. 対象の原本をクラウドへ同期し、画像はCollectで原本の送信も完了させます。記録の詳細から「この記録を送信して解析」を選びます。保存操作だけでは解析を予約しません。
6. 解析完了後、「意味で探す」で検索します。設定モデルで解析済みの、最新revisionの原本だけが対象です。検索語もOpenAIへ送信します。API利用料が発生します。

送信内容は選択した原本の画像・本文・タイトル・出典URL・自分のメモ・取得済みページ情報です。外部URLをワーカーが取得することはありません。Recallとリンク資料は文章、Collectの画像は画像＋文章を解析します。Sketchbookはタイトルを解析し、描画の視覚解析は今回の対象にしていません。

画像のcaption／OCRと候補タグを検索用文章へまとめてembeddingを作ります。画像と日本語を直接同じ空間に置くmultimodal embeddingは未採用です。構図や色の検索品質は本人の資料で評価してください。OpenAIへのResponsesリクエストは `store:false` を指定しますが、これを提供元の全データ保持が無効になる保証とは扱いません。

検索は少数資料の評価に向けた可変次元の数値配列＋正確なcosine比較です。owner・種類・スペース・手動タグ・プロジェクト・除外設定をSQL内で先に適用してから順位とLIMITを決定します。次元を固定するmigrationや近似indexはモデル評価後に検討します。

原本更新・削除・スペース変更では古い解析文書を同じtransactionで削除し、jobをstaleにします。モデル変更後の検索は以前のモデルと比較せず、選択した記録を再解析します。AI候補は手動タグを更新しません。除外設定と利用解除は実行中jobの結果反映も止めます。すでに送信中の外部リクエストを取り消すことは保証しません。

失敗は最大3回、待ち時間を増やして再試行します。5分のleaseとtokenでワーカー再起動・遅延結果・二重反映を扱います。3回失敗後は詳細から再予約できます。画面を開いている間は15秒ごとに状態を確認します。

## 本人による日本語検索の評価

`docs/phase5-evaluation.template.json` に25件の検索例があります。自分の20〜30件へ変更し、各 `expectedItemIds` に目的の原本ID、`rankedItemIds` に意味検索結果を上から順に記録します。空欄のままでは評価を拒否します。

```sh
pnpm atlas:evaluate docs/my-atlas-evaluation.json
```

Hit@1／5／10とMRR、見つからなかった件数を出します。モデル・日時・使用資料も別途記録し、本人の「欲しい画像が見つかったか」という判断と合わせて比較します。今回の自動試験の成功は、この本人評価の代わりにはなりません。

参考：[OpenAIの画像入力](https://developers.openai.com/api/docs/guides/images-vision)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[Embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create)、[Supabase semantic search](https://supabase.com/docs/guides/ai/semantic-search)。
