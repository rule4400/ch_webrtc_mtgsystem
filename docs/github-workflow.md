# GitHub 運用方針

このリポジトリでは、元ソースを復元できる状態のまま、すべての変更を feature branch と Pull Request（PR）で管理します。配布用バイナリと秘密情報は Git の履歴に含めません。

## 1. 元ソースの保全

セキュリティ改善前のソースは、次の参照で固定します。

- 保全タグ: `pre-security-audit-20260831`
- 保全ブランチ: `codex/archive-pre-security-audit-20260831`
- 保全コミット: `8530fe750a027b1fe40eca47c7aa078d1d43302f`

タグと保全ブランチは削除、移動、rebase、force push を禁止します。GitHub に未反映の場合は、内容を確認した管理者がこの2参照だけを明示的に push します。`git push --mirror` や無差別な `git push --all` は、Codex内部参照や意図しないローカルブランチまで送る危険があるため使用しません。

## 2. `main` とブランチ保護

GitHub の既定ブランチは、統合済みの `main` に設定します。2026-08-31時点では既定ブランチが`codex/debug-logging`のままの移行途中であり、今回のPRをレビュー・統合して履歴差分を整理した後に、管理者が`main`へ変更します。デバッグ用または作業用ブランチを既定ブランチにしません。`main` には GitHub Ruleset または Branch protection rule を設定し、少なくとも次を必須にします。

- 変更はPR経由とし、`main` への直接 push を禁止する
- CIの全必須チェックが成功してからマージする
- 未解決のレビュー会話があるPRをマージしない
- force push とブランチ削除を禁止する
- 可能であれば1名以上の承認と linear history を必須にする

必須CIチェックは、`Node syntax`、3つの `Renderer (...)`、2つの `Desktop install (...)`、`Server smoke` です。管理者による保護規則の迂回も、障害対応で事前承認された場合を除いて無効にします。

## 3. 通常の開発フロー

作業ブランチは最新の `main` から作成し、目的ごとに分けます。

- 機能追加: `feature/<短い名前>`
- 不具合修正: `fix/<短い名前>`
- セキュリティ修正: `security/<短い名前>`
- 保守作業: `chore/<短い名前>`
- Codexによる作業: `codex/<短い名前>`（同じくPR必須）

基本手順は次のとおりです。

```bash
git switch main
git pull --ff-only origin main
git switch -c fix/example

# 変更、テスト、レビュー可能な単位でコミット
git push -u origin fix/example
```

その後、`main` 宛てのPRを作成します。PRには、変更理由、影響範囲、確認したテスト、手動確認手順、既知の制約を記載します。依存関係を変更した場合は、対応する `package.json` と `package-lock.json` を同じPRに含めます。マージ方式は原則 squash merge とし、マージ後の作業ブランチは削除します。

作業ツリーに配布物がある状態で `git add -A` を実行しません。必ず意図したソースパスだけを明示して stage し、`git status` と `git diff --cached` を確認します。

## 4. CIと依存関係管理

`.github/workflows/ci.yml` は Node.js 24 を使用し、次を検証します。

- `client`、`screen-share`、`viewer`: `npm ci`、lint、Vite build
- `recording-viewer`、`server-gui`: `npm ci`、同一FileHandle配信・symlink競合・秘密設定のアトミック保存テスト
- `server`: `npm ci`、録画の冪等保存/予約解放・連続録画中retention・symlink保護テスト、認証/Origin/Range付き signaling smoke test
- Server/Electronの主要エントリポイント: `node --check`
- Server GUI、録画Viewer、録画Web UI: インラインJavaScriptの構文解析
- 20秒の最終フレーム保持ポリシーと同梱binaryのversion/size/SHA-256 manifest
- 6つのnpmパッケージ: `npm audit --audit-level=low`（low以上をCI失敗にする）

Dependabot は6つのnpmパッケージディレクトリとGitHub Actionsを毎週確認します。Actionsはcommit SHAへ固定し、Dependabot PRで追随します。Dependabot PRも通常のPRと同じCIを通し、特に Electron、mediasoup、Socket.IO、ビルドツールの更新では実機確認を追加します。lockfileだけを手編集せず、許可されたNode/npm環境で再生成します。

## 5. 配布物は GitHub Releases で管理する

`.exe`、`.dmg`、`.zip`、`.blockmap`、生成PDFなどの配布物はコミットしません。`release/`、`release2/`、`dist/`、`output/` はローカル生成物として扱い、GitHub Release の asset にアップロードします。現状の配布物には GitHub の通常Git blob上限である100 MBを超えるファイルがあるため、通常の `git add` / `git push` では管理できません。Git LFSではなく、原則としてGitHub Releasesを使用します。

リリース手順は次の順序にします。

1. 対象アプリのversionとlockfileを更新する
2. PRのCIと、macOS/Windowsの実機テストを完了する
3. 署名・notarization済みバイナリをクリーンな環境で生成する
4. リリースタグを作成し、GitHub上でDraft Releaseを作る
5. 各配布物、`SHA256SUMS`、版対応表、変更履歴をassetとして添付する
6. 別環境でchecksum、起動、更新導線を確認してから公開する

リリース用ワークフローを追加する場合、macOS成果物はmacOS runner、Windows成果物はWindows runnerで生成します。コード署名証明書、notarization資格情報、トークンはGitHub ActionsのEnvironment secretsに保存し、ログへ出力しません。外部から取得するmediasoup worker、FFmpeg、FFprobeも、固定したversionとSHA-256を検証してから同梱します。

## 6. 秘密情報と運用データ

次の情報は、公開・非公開を問わずGitへコミットしません。

- `.env` と環境別 `.env.*`（ダミー値だけの `.env.example` は可）
- TURNのユーザー名・パスワード、管理トークン、API key、アクセストークン
- 秘密鍵、証明書、署名用ファイル（`.key`、`.pem`、`.p12`、`.pfx` など）
- server-guiのユーザー設定、クライアント登録情報、runtime state
- 録画、録音、ringtone、ログ、診断dumpなどの運用データ

秘密はローカルのOS keychain、権限を制限した設定ファイル、またはGitHub Actions secretsで管理します。実値をissue、PR本文、レビューコメント、CIログへ貼り付けません。

秘密情報を誤ってpushした場合は、履歴から消す前に該当credentialを直ちに失効・再発行します。その後、影響範囲を確認し、リポジトリ管理者が関係者と調整した上で履歴修復を行います。通常運用のforce push禁止を、個人判断で解除しません。

## 7. GitHubの推奨設定

- Dependabot security updatesを有効にする
- Private vulnerability reportingを有効にし、脆弱性の詳細を公開Issueへ書かせない
- Secret scanningとpush protectionを有効のまま維持する
- Actionsの既定権限をread-onlyにし、必要なjobだけ最小権限を付ける
- squash mergeを標準にし、マージ後のブランチ自動削除を有効にする
- `SECURITY.md` に非公開の脆弱性報告窓口を定義する
- Release公開前にSBOMとchecksumを生成し、成果物に添付する

保全タグ、`main`、公開済みReleaseは監査可能な記録です。後から内容を差し替えず、修正が必要な場合は新しいコミット、タグ、Releaseとして追加します。
