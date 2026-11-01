# Googleログインの初回設定

2026-11-01。アプリ側は初回の金庫画面と4ツールの設定画面に「Googleでログイン」を追加済みです。メールアプリを開かず、同じブラウザでGoogle認証を行ってRecallへ戻ります。Google認証後も、金庫を開くには専用パスフレーズが必要です。

**公開版への反映はまだ行っていません。** Supabase管理画面でGoogleが無効、Client IDsとClient Secretが未入力であることを確認しました。Google Cloudはログアウト状態でした。以下の初回設定後に公開版を更新し、実アカウントとスマホで確認します。

## Google Cloud

1. [Google Auth Platformのクライアント一覧](https://console.cloud.google.com/auth/clients)へ本人のGoogleアカウントでログインし、使うプロジェクトを選びます。
2. 未設定ならアプリ名を `Personal Tools` としてOAuth同意画面を設定します。個人のGoogleアカウントではAudienceはExternalにし、Testingで利用する場合は自分のGoogleアカウントをテストユーザーへ追加します。
3. OAuthクライアントを作り、種類を **Web application** にします。Authorized JavaScript originsは次の値です。

   ```text
   https://personal-tools-seven-ruby.vercel.app
   ```

4. Authorized redirect URIsへ次の値を登録します。これはSupabaseの戻り先です。

   ```text
   https://zdixgamfhdgnqbgjckpj.supabase.co/auth/v1/callback
   ```

5. クライアントIDとクライアントシークレットを控えます。シークレットをチャット、Git、アプリの公開環境変数に貼る必要はありません。

要求する権限は `openid`、メールアドレス、基本プロフィールのみです。Gmailのメール本文、Google Driveなどの追加権限は使いません。

## Supabase

1. [このプロジェクトのGoogle設定](https://supabase.com/dashboard/project/zdixgamfhdgnqbgjckpj/auth/providers?provider=Google)を開きます。
2. **Enable Sign in with Google** を有効にし、先ほどのクライアントIDとシークレットをそれぞれの欄へ入力してSaveします。Skip nonce checksとAllow users without an emailは無効のままにします。
3. [URL Configuration](https://supabase.com/dashboard/project/zdixgamfhdgnqbgjckpj/auth/url-configuration)では、既存の次の値を使います。

   | 項目 | 値 |
   | --- | --- |
   | Site URL | `https://personal-tools-seven-ruby.vercel.app` |
   | Redirect URLs | `https://personal-tools-seven-ruby.vercel.app/recall/auth/callback/` |

Google Cloudに登録するSupabaseのcallbackと、このアプリのcallbackは別のURLです。既存のローカルURLの許可は残します。クライアントシークレットはSupabase側だけで管理します。

## 公開後の確認

1. 公開入口をスマホのChromeまたはSamsung Internetで開き、「Googleでログイン」を選びます。すでに使っているアカウントがある場合は、同じメールアドレスのGoogleアカウントを選びます。
2. Googleでの認証が完了するとRecallへ戻ります。既存の金庫のパスフレーズを入力して解錠します。
3. 4ツールを移動し、既存の記録が見えることと同期を確認します。端末内だけのデータの移行は[スマホで使い始める手順](atlas-mobile-setup.md)を参照してください。
4. 認証をキャンセルした場合は、ログインをやり直す案内が金庫画面の上部に表示されます。Googleを使わない場合のメールログインは折りたたみ欄から利用できます。

## 実装と確認の範囲

- 共通のSupabase cookieクライアントでPKCEを維持し、既存のサーバーcallbackでコードをsessionへ交換します。
- Googleへ移る前に編集中の下書きを保存します。保存に失敗した場合は画面を離れません。
- Googleログインの要求内容、開始失敗、固定callback、認証中断時の案内、既存のsession更新・ログアウト境界をテストします。
- 実Googleアカウントの認証、既存メールアカウントとの連携、Galaxy実機、2端末同期は初回設定後の確認事項です。

2026-11-01の確認結果：4ツールの型チェック・本番ビルド、認証関連15テストが成功しました。390×844のブラウザで4ツールのGoogleボタンが最初の画面内に収まり、横はみ出しがないこと、メールの折りたたみ欄が開くこと、認証中断の案内が初回画面に出ることを確認しました。[スマホ表示](../work/google-login-2026-11-01/google-login-mobile.png)、[4ツールの表示記録](../work/google-login-2026-11-01/mobile-checks.json)。

全体の回帰テスト187件は186件成功、ビルドと同時に実行した同期テスト1件が30秒で時間切れになりました。その1件は単独で再実行し16秒で成功しました。ローカルソケットを使うテストと本番ビルドは、Windowsの制限環境での権限エラーを避けるため通常環境で確認しています。

公式資料：[SupabaseのGoogleログイン](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)、[GoogleのWebサーバー向けOAuth](https://developers.google.com/identity/protocols/oauth2/web-server)。
