# Phase 2 — Supabaseの作成と接続

この設定をしなくても、これまでのRecall端末内版はそのまま動きます。設定後はメールログイン、アカウントごとの保存領域、複数端末同期を使えるようになります。自動タグ付けや画像検索はまだ含みません。

**この作業で利用する開発プロジェクトは作成済みです。** Project refは `zdixgamfhdgnqbgjckpj`、リージョンは東京です。初期migrationも適用済みなので、下記の「新規作成」と「初期SQLの実行」を繰り返す必要はありません。以降はメール認証の設定とアプリの接続確認へ進みます。公開接続情報の設定状況は実際の `.env.local` を確認し、秘密鍵は追加しないでください。

## 1. Supabaseの開発プロジェクトを作る

1. [Supabase Dashboard](https://supabase.com/dashboard)にログインし、組織を選んで新しいプロジェクトを作成します。自分の試作用と分かる名前を付けてください。
2. リージョンと利用プランを確認します。データベースのパスワードは自分で安全に保管します。アプリの公開設定やチャットに貼る必要はありません。
3. プロジェクトが利用可能になるまで待ちます。すでにこの作業でプロジェクトを作成済みの場合は、そのプロジェクトを使い、二重に作らないでください。

## 2. データベースの初期設定を適用する

Supabaseの **SQL Editor** で新しいクエリーを開き、プロジェクト内の次のファイル全体を実行します。

```text
supabase/migrations/202610280001_phase2_sync.sql
```

これは新規の開発プロジェクト向けの初回migrationです。items、notes、spaces、所属・関連・添付情報、変更履歴・競合・操作のテーブル、RLS、同期RPC、private Storageの設定を作ります。**新しく別の開発環境を作る場合は、`supabase/migrations/` 内の全migrationをファイル名順に適用します。** 初回ファイルに加え、追加の権限強化migrationも含めてください。実行済みのデータベースへ同じSQLを何度も貼らないでください。Supabase CLIで管理する場合はmigrationとして一度だけ適用します。

SQLがエラーになった場合は、その状態でアプリの同期テストに進まず、対象プロジェクトとエラーを確認します。このアプリは失敗した操作を端末に残して再送するため、未設定のままでも「同期済み」とは表示しません。

## 3. メール認証のURLを設定する

Supabaseの **Authentication → URL Configuration** で、ローカル開発用に次を設定します。

**Site URL**

```text
http://127.0.0.1:3100/recall/
```

**Redirect URLs**

```text
http://127.0.0.1:3100/recall/auth/callback/
```

`localhost` でも使う場合は、必要な方の完全なURLも追加します。

```text
http://localhost:3100/recall/auth/callback/
```

`localhost` と `127.0.0.1` はブラウザの保存領域が別です。普段使う方を揃えてください。既存の端末内メモを取り込みたい場合は、それまで使っていた同じブラウザとURLで作業します。ワイルドカードで広く許可する必要はありません。[公式：Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)

## 4. 標準のログインメールを使う

**最初はメールテンプレートを変更せず、Supabase標準のメール送信を使います。** SMTPの追加設定やメール本文の編集はRecallを試すための必須作業ではありません。Dashboardで「テンプレートの編集にはCustom SMTPが必要」と出る場合も、そのまま標準テンプレートで進めてください。

Recallはログインメールの送信時にPKCEのcode challengeと戻り先を渡します。標準テンプレートの `ConfirmationURL` を開くと、Supabaseがメールを確認して `/recall/auth/callback/?code=...` へ戻し、アプリが保存済みのcode verifierとともに `exchangeCodeForSession(code)` を呼びます。[公式：PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)

**メールのリンクは、送信を依頼した同じブラウザ・同じ端末で開いてください。** 同じブラウザの新しいタブは使えます。別ブラウザ、別プロファイル、メールアプリ内の独立ブラウザ、`localhost` と `127.0.0.1` の切り替えではverifierが共有されず、ログインに失敗することがあります。複数のログインメールを続けて要求すると前のverifierが置き換わるため、最新のリンクを使います。リンクやcodeをチャットやログへ貼らないでください。

アプリのcallbackは固定の相対LocationでRecallへ戻るため、アプリ側の戻り処理が127.0.0.1をlocalhostへ切り替えることはありません。メールを要求する入口とSupabaseに登録したcallback URLも、同じホスト名に揃えます。

Supabase標準のメール送信は試用向けで、送信先がプロジェクト組織のチームメンバーに限られ、送信回数も制限されます。まず自分のSupabaseアカウントのメールで試してください。一般のメールアドレスを使う場合や繰り返し試験する場合は、Dashboardで独自SMTPを設定します。届かないときは迷惑メール・Authログ・送信先・送信上限を確認してください。[公式：SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

### 任意：独自SMTP導入後にtoken hash形式へ変える

将来、独自SMTPを設定してメールを編集する場合は、**Magic Link** と **Confirm signup** の両方のリンクを次の形式に変更する方法もあります。初回のメールアドレスではsignup確認メールが使われることがあるため、両方を揃えます。

```html
<h2>Recallにログイン</h2>
<p><a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=email">Recallを開く</a></p>
```

この任意の形式では、アプリが指定した許可済みの `RedirectTo` にワンタイムのtoken hashを渡し、コールバックで `verifyOtp({token_hash,type:'email'})` を呼びます。現行アプリは標準PKCE code形式とこのtoken hash形式の両方を受け付けます。リンクやhashはチャットやログに貼らないでください。[公式：Passwordless email sign-in](https://supabase.com/docs/guides/auth/auth-email-passwordless)

実装の確認元：[Supabase Authの標準メールテンプレート](https://github.com/supabase/auth/blob/master/internal/mailer/templatemailer/templatemailer.go)、[Authのverify処理](https://github.com/supabase/auth/blob/master/internal/api/verify.go)。標準テンプレートは `ConfirmationURL`、PKCEのverifyはauth codeを発行して戻り先へ転送する処理です。実際のメール受信からログインまでの試験は、本人が使うメールアドレスで別途確認します。

## 5. アプリに公開接続情報を設定する

Supabaseの **Connect** または **Project Settings → API Keys** から、Project URLと **publishable key** を確認します。旧形式の公開anon keyにも対応します。**service_role key、secret key、データベースのパスワードは使いません。**

PowerShellでプロジェクトのルートへ移動し、例のファイルをコピーします。すでに `.env.local` がある場合は上書きせず、そのファイルを編集します。

```powershell
cd "C:\Users\suwak\Documents\repos\personal-tools"
Copy-Item "apps\recall\.env.example" "apps\recall\.env.local"
```

`apps/recall/.env.local` をエディターで開き、次の2つを自分のプロジェクトの値へ置き換えます。

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
```

この2つはブラウザへ渡す公開設定です。RLSが本人のデータだけを許可することで保護します。`.env.local` はGitへ含めません。アカウントの端末キャッシュはプロジェクトのホスト名とユーザーIDで分け、接続先を変えても別プロジェクトのデータを混ぜません。

## 6. 再起動してログインする

動作中のサーバーを **Ctrl+C** で停止してから実行します。

```powershell
pnpm install
pnpm dev
```

[Recall](http://127.0.0.1:3100/recall/)を開き、右上の保存状態または「保存とバックアップ」を押します。メールアドレスを入力してログインメールを送り、リンクを開きます。成功すると「アカウントのノート」へ切り替わります。最初は元の端末内ノートとは別の場所です。

元のノートを入れたい場合は、件数とメールアドレスを確認し、**「○件をこのアカウントに取り込む」** を押します。自動では送信しません。元の端末内データは残り、取り込みを繰り返すと別IDで再度追加されます。下書きは取り込み対象から除外します。

端末内版へ戻るときは「端末内のノートを開く」。ログアウトはこのブラウザのセッションだけを終了し、他の端末はログインを保ちます。通信断でも現在のアカウント表示と同期処理はすぐ閉じますが、サーバー側のログアウトが失敗した場合は画面にその旨を示します。JWT自体は有効期限まで有効で、ログアウトを即時の全トークン失効とは扱いません。[公式：Sign out and scopes](https://supabase.com/docs/guides/auth/signout)

## 7. 同期と競合を確認する

まず同じPCで別のブラウザまたは別プロファイルを使い、同じメールアカウントでログインします。同じブラウザの2タブは端末キャッシュも共有するので、2台の独立した端末の代わりにはなりません。

1. Aで新規メモを保存し、「クラウド同期済み」になるのを待ちます。Bで「今すぐ同期」を押し、同じメモが出ることを確認します。
2. Aで編集・ごみ箱への移動・復元を行い、Bにも反映することを確認します。
3. Aの通信を切り、複数回編集して保存します。通信復帰後に重複せず同期することを確認します。
4. AとBが同じメモをオフラインで編集してから同期します。「確認が必要」に両方の本文が残ることを確かめ、「両方残す」を選びます。
5. ログアウトすると、そのアカウントの本文・下書き・編集中の画面が閉じることを確認します。別アカウントで以前のユーザーのメモが見えないことも確認します。

アプリを開いている間は、変更後・起動／表示復帰時・通信復帰時・手動操作で同期し、表示中には定期的にも取得します。Safariで使えないBackground Syncには依存しません。アプリを閉じた状態での即時送信は保証しません。

## 8. PWAとスマートフォン実機

オフライン再起動の試験は開発モードではなく、本番モードで行います。

```powershell
pnpm build
pnpm start
```

一度オンラインで開き、「オフライン用の画面を準備できました」を確認します。その後に通信断・再起動・記録・復帰を試してください。service workerは公開の匿名shellと静的assetsだけを保存し、認証コールバックやSupabase API応答は保存しません。更新は古いRecallの全タブを閉じてから反映されます。

PCの `127.0.0.1` はスマートフォン自身からは接続できません。このローカル起動はPC内に限定しています。iPhone／Androidでの本番PWAと2実機の試験は、別途HTTPSでアプリを配信し、その公開URLの `/recall/auth/callback/` をSupabaseに追加してから行います。今回の接続設定だけで外部公開はしません。

## 実装の確認先

- `packages/auth`：ブラウザ／requestごとのSSRクライアントと認証server経路向けproxy処理。通常ページは匿名shellであり、ブラウザSDKと同期RPCのRLSで本人のデータを扱います。Cookieは同じoriginの全アプリで使える `Path=/`。異なるドメイン間の自動SSOは含みません。
- `packages/api-client`：ユーザー別IndexedDB、変更＋outboxのatomic保存、冪等再送、競合の保持、cursor取得。
- `supabase/migrations/202610280001_phase2_sync.sql`：所有者RLS、参照整合性、private Storage、同期RPC。
- `apps/recall/app`：アカウント切り替え前の画面初期化、世代確認による古い非同期応答の無視、取り込みと競合UI。

サーバーがユーザーを扱う場合は `getClaims()` を使い、cookie内のuserを読むだけの `getSession()` は認可根拠にしません。[公式：SSR client](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs)
