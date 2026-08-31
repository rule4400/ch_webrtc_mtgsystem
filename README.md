# CHECKHOUSE WebRTC Meeting System

mediasoup / Socket.IOを使った多拠点WebRTC会議システムです。会議クライアント、画面共有、閲覧専用Viewer、SFUサーバー、Server GUI、録画Viewerを同じリポジトリで管理します。

## 構成

| ディレクトリ | 役割 | 現行version |
|---|---|---:|
| `client/` | カメラ・マイク・通話を扱う会議クライアント | 0.6.0 |
| `screen-share/` | 画面共有専用クライアント | 0.2.1 |
| `viewer/` | 受信専用Viewer | 0.1.1 |
| `server/` | mediasoup SFU、認証、録画、配布API | 1.4.0 |
| `server-gui/` | サーバー起動・監視・端末管理用Electron GUI | 1.4.0 |
| `recording-viewer/` | 過去録画・ライブ録画の閲覧用Electronアプリ | 0.1.0 |

Rendererの表示・telemetry用versionは各`package.json`を単一の情報源とし、CIがlockfileおよびサーバー側fallbackとの一致も検査します。

## 今回の安定化・セキュリティ方針

- 録画取込みはNASへ直接書かず、サーバー内蔵SSDの`recording-staging/raw`へ保存
- 録画の既定は再エンコードなし、日時焼き込みOFF、確定処理1ジョブ
- NAS転送、index読書き、保持期限掃除、空き容量回収を非同期化
- queue、同時録画session、録画用PlainTransport、録画閲覧streamに上限を設定
- 最終保存先またはstagingの容量不足時は録画・確定処理を停止し、回復後に自動再開
- リモート映像の瞬断時は、最後に正常受信したフレームを最大20秒表示
- 会議、管理、録画閲覧に別々のtokenを使用し、Socket.IOのOriginもhandshake時に拒否
- Electronはsandbox/context isolation、navigation・window・permission・IPC送信元を制限
- ElectronのIPCは信頼済みメインフレームに限定し、RendererはCSPで実行・接続先を制限
- 録画メディアと配布ファイルは検証済みの同一FileHandleから配信し、symlink差替え競合を防止
- 秘密設定ファイルは同一FDで検証・読取・権限移行し、0600の一時ファイルからアトミックに更新
- 同梱するmediasoup worker / FFmpeg / FFprobeは固定version・サイズ・SHA-256をpackage作成前に検証

詳細は[録画運用ガイド](docs/recording.md)、[セキュリティポリシー](SECURITY.md)、[GitHub運用方針](docs/github-workflow.md)を参照してください。

## 安全な初期設定

サーバー設定の例をコピーし、少なくとも3種類の異なるランダムtokenを設定します。実値の`.env`はGitへ追加しません。

```bash
cp server/.env.example server/.env
openssl rand -base64 32
```

```dotenv
SFU_AUTH_TOKEN=<会議クライアント用>
SFU_ADMIN_TOKEN=<管理API用の別token>
RECORDING_ACCESS_TOKEN=<録画閲覧用の別token>
SFU_REQUIRE_AUTH=1
RECORDING_ALLOW_ANONYMOUS=0
```

サーバーのHTTP/Socket.IOはInternetへ直接公開せず、信頼できるVPN内またはTLS終端reverse proxyの内側で運用します。Origin allowlistはbrowser由来の接続を減らす防御層ですが、Electron/native互換のOriginなし接続があるため、token認証の代わりにはなりません。

録画を使う場合は、`stagingDir`をサーバー内蔵SSD、`recordingsDir`と`dbDir`を必要に応じてNASへ設定します。`stagingDir`にはNASを指定しません。NAS mount自体はOS側でも監視してください。

## 開発起動

Node.js 24を使用します。各packageは独立したlockfileを持ちます。

```bash
cd server
npm ci
npm start
```

別terminalで必要なRendererを起動します。

```bash
cd client
npm ci
npm run electron:dev
```

`screen-share/`と`viewer/`も同じく`npm ci`後に`npm run electron:dev`で起動できます。Server GUIとRecording Viewerはそれぞれのディレクトリで`npm ci`、`npm start`を使用します。

## 検証

Pull RequestのCIは、Node/Electron entry pointとHTML内scriptの構文、version整合、3つのRendererのlint/build、20秒フレーム保持ポリシー、録画安定性、認証付きsignaling、Origin拒否、同一FileHandleによるGET/HEAD/Range配信とsymlink競合、秘密設定のアトミック保存、同梱binaryのhash manifest、6 packageの低リスク以上dependency auditを確認します。

代表的なローカル試験:

```bash
node tools/check-version-consistency.cjs
node tools/check-inline-scripts.cjs server-gui/index.html recording-viewer/ui/recordings.html server/public/recordings.html
node tools/check-last-frame-policy.cjs
node server-gui/scripts/verify-binary-manifest.cjs

cd server
npm test
npm audit --audit-level=low
```

Desktop固有のファイル安全性試験はそれぞれのpackageで実行します。

```bash
cd server-gui && npm test
cd ../recording-viewer && npm test
```

Rendererごとに次も実行します。

```bash
npm run lint
npm run build
npm audit --audit-level=low
```

ElectronのmacOS/Windows配布物はCIのRenderer buildだけでは保証されません。署名・notarizationを含む実機package試験、checksum確認、別端末での起動確認をRelease公開前に行ってください。

## GitHub管理と原本

改善前の原本は次の不変参照でGitHubへ保全しています。

- branch: `codex/archive-pre-security-audit-20260831`
- tag: `pre-security-audit-20260831`
- commit: `8530fe750a027b1fe40eca47c7aa078d1d43302f`

通常変更は作業branchから`main`宛てのPull Requestで管理し、CI成功とレビュー後に統合します。保全branch/tagへのforce push、生成済み配布物・録画・tokenのcommitは禁止します。
