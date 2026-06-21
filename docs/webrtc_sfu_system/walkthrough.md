# WebRTC会議室システム：Windows対応・バグ修正版 利用ガイド

カメラのプレビューが映らない（権限がない）問題の修正と、システム全体のWindows対応（クロスプラットフォーム化）が完了しました。

## 修正および新機能の内容

### 1. Mac環境でのカメラ・マイクへのアクセス権限修正
クライアントアプリがOSのカメラ・マイクにアクセスするための明示的な権限宣言（`NSCameraUsageDescription`等）をビルド設定に追加しました。これにより、Mac上でアプリを起動した際に「カメラとマイクのアクセスを許可しますか？」という正しいシステムダイアログが表示されるようになり、プレビューおよび通話が正常に動作します。

### 2. Windows（.exe / .exeポータブル）のサポート
Macに加えて、Windows向けの実行ファイル（`.exe`）も同時にビルドされるようにシステムを拡張しました。サーバー・クライアントともに、Windows上でネイティブアプリとして動作します。

## アプリケーションの出力場所（パッケージ）

ビルド（コンパイル）によって、それぞれのOS向けのアプリケーションが生成されています。

> まとめ用の配布先は `release/macOS/` と `release/Windows/` に統一しました。各アプリはその下の個別フォルダに、インストーラー本体だけがまとまります。
> ルートからは `npm run package:mac` または `npm run package:win` で、それぞれのOS向け成果物をまとめて再生成できます。

### クライアント (MeetingClient)
- **Mac用**: `release/macOS/client/`
- **Windows用**: `release/Windows/client/`

### 閲覧専用クライアント (MeetingViewer)
- **Mac用**: `release/macOS/viewer/`
- **Windows用**: `release/Windows/viewer/`

### サーバーGUI (SFU Server GUI)
- **Mac用**: `release/macOS/server-gui/`
- **Windows用**: `release/Windows/server-gui/`

### 画面共有アプリ
- **Mac用**: `release/macOS/screen-share/`
- **Windows用**: `release/Windows/screen-share/`

## Windows環境での利用手順

1. Windows PC上で、出力された `.exe` インストーラーを実行してアプリをインストールするか、ポータブル版を起動します。
2. **サーバー**は、`SFU Server GUI` にSFUサーバー本体・依存ライブラリ・mediasoup workerを内包しています。[Start Server]を押すだけで起動できます。Windows側にNode.jsを別途インストールする必要はありません。
3. **クライアント**は起動後、プルダウンからUSBカメラなどのデバイスを選択し、正常にプレビューが映ることを確認してから会議室に参加してください。
4. **閲覧専用クライアント**は、SFUサーバーのIP/ポートを設定すると受信のみを開始します。カメラ/マイクは取得せず、各拠点の映像・音声だけを表示します。

## VPN拠点間での設定

サーバーGUIは初回起動時に、内蔵サーバーの設定ファイル `.env` をアプリのユーザーデータ領域へコピーします。GUIのSettingsタブに表示される `.env` のパスを開き、以下を各PC/拠点の環境に合わせて設定してください。

- `ANNOUNCED_IP`: 全拠点のクライアントから到達できるSFUサーバーのVPN内IP
- `PORT`: 既定は `3000`
- `RTC_MIN_PORT` / `RTC_MAX_PORT`: 既定は `10000`-`10200`

VPN/Firewallでは `PORT` のTCP通信と、`RTC_MIN_PORT`-`RTC_MAX_PORT` のUDP/TCP通信を許可してください。

`ANNOUNCED_IP` が未設定の場合はサーバーPCのLAN/VPN IPを自動検出します。複数NICや複数VPNを持つPCでは誤ったIPが選ばれることがあるため、その場合は `.env` に実際のVPN内IPを明示してください。

> [!NOTE]
> Windows版では初回起動時に「Windows Defender ファイアウォール」の警告が出ることがあります。その際は「プライベートネットワーク」での通信を許可してください（WebRTCの通信に必要です）。
