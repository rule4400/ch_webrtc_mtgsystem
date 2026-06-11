# CHECKHOUSE Meeting System 拡張計画

## 目的

既存の WebRTC SFU 構成を、クライアント・サーバー・閲覧用・画面共有専用ソフトの 4 アプリ構成へ拡張する。

## アプリ構成

- `CHECKHOUSE Meeting Client`: 各拠点のカメラ/マイク送受信、チャンネル選択、画面共有閲覧。
- `CHECKHOUSE Meeting Viewer`: 閲覧専用。全拠点映像と画面共有を監視する。
- `CHECKHOUSE Meeting Server`: SFU サーバー管理 GUI。チャンネル、端末、版数、更新指示を管理する。
- `CHECKHOUSE Meeting Screen Share`: 新規。画面共有送信専用で、他拠点の映像・音声は受信しない。

## 実装済み基盤

- サーバー signaling に `channelId`, `appType`, `appVersion`, producer `source` を追加。
- `source=screen` の video producer を通常カメラと分離して受信。
- client/viewer は画面共有をチャンネルに関係なく表示。
- client は音声のみ同一チャンネルの peer から再生。
- サーバー GUI でチャンネル一覧、最新版、更新 URL を保存し、サーバー経由で各端末へ配信。
- サーバー GUI から端末ごとのチャンネル変更とアプリ種別ごとの強制更新指示を送信。
- 各アプリ下部/サイドバーにバージョン表示。
- 新規 `screen-share` アプリを追加し、画面全体/アプリケーション選択から画面共有 producer を送信。

## 次段階

1. 署名済みインストーラ/DMG/NSIS の配布先を確定する。
2. 更新 URL のダウンロード、署名検証、OS 別インストール実行を実装する。
3. サーバー GUI の更新登録 UI に SHA-256 と必須更新フラグを追加する。
4. チャンネル設定を JSON import/export できるようにする。
5. Windows/macOS の packaged build で screen-share の画面収録権限と desktopCapturer 動作を確認する。

## 検証計画

1. `server` smoke test で signaling、telemetry、systemState、admin command を確認。
2. `client`, `viewer`, `screen-share` の Vite build を実行。
3. server-gui からチャンネルを変更し、client の音声 gating と左メニュー反映を確認。
4. screen-share から画面全体/アプリケーションを共有し、client/viewer に共有画面が表示されることを確認。
5. macOS arm64 / Windows x64 のパッケージを作成して成果物を検証。
