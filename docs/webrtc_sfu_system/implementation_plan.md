# クライアント機能拡張およびサーバーGUI管理者向け高機能化 計画

ご要望に基づき、クライアントアプリでのデバイス選択機能の追加と、サーバーGUIの本格的な管理者ダッシュボード化を実施します。

## 1. クライアント：デバイス（カメラ・マイク・スピーカー）選択機能

クライアントの待機画面（SettingsView）にて、使用する入力・出力デバイスを選択できるように改修します。

*   **デバイスの取得**: `navigator.mediaDevices.enumerateDevices()` を用いて、接続されているカメラ(`videoinput`)、マイク(`audioinput`)、スピーカー(`audiooutput`)のリストを取得します。
*   **UIの追加**: 待機画面にデバイス選択用のプルダウン（`<select>`）を追加します。
*   **設定の適用**:
    *   選択されたカメラ/マイクの `deviceId` を `getUserMedia` の制約パラメータ（`constraints`）に適用し、特定のデバイスでプレビューおよび本会議への送信を行います。
    *   選択されたスピーカーについては、HTML5の `setSinkId()` API を使用して、受信した音声の出力先デバイスを明示的に切り替えます。
*   **設定の記憶**: 選択したデバイスのIDを `localStorage` に保存し、次回起動時にも復元されるようにします。

## 2. サーバーGUI：管理者ダッシュボード化

現状の「起動/停止とログ表示」のみのシンプルなGUIから、SFUサーバーの運用に必要な情報を網羅した**高度な管理者ダッシュボード**へとアーキテクチャを拡張します。

### バックエンド（server/index.js）の改修
*   **IPC通信の導入**: サーバープロセスとGUIプロセス間でリアルタイムにデータをやり取りするため、プロセス間通信（IPC）チャネルを確立します。
*   **統計情報の送信**: 定期的にCPU使用率、メモリ使用量、現在の接続ピア数、アクティブなプロデューサー/コンシューマー数をGUIへ送信します。
*   **リモート制御用API**: GUIからの命令（特定ユーザーのキック、全クライアントの一斉再起動など）を受け取るリスナーを追加します。

### フロントエンド（server-gui/index.html & main.cjs）の改修
GUI画面をタブ構成に変更し、以下の機能を兼ね備えたプロフェッショナルなUIへと刷新します。

1.  **ダッシュボード (Dashboard) タブ**
    *   サーバーの稼働状態（Uptime）
    *   CPU・メモリ使用量のリアルタイムモニター
    *   総接続数、映像/音声ストリーム数の統計表示
2.  **接続管理 (Clients) タブ**
    *   現在接続している各拠点のリスト一覧（Socket ID, IPアドレス等）
    *   **Kick（強制切断）ボタン**: 特定の拠点を強制的に切断する機能
    *   **Force Restart All ボタン**: 全クライアントへ再起動コマンド（`restartCommand`）を一斉送信する機能
3.  **ログ (Logs) タブ**
    *   従来のログ表示機能を強化。エラーログと通常ログの色分け、自動スクロール機能などを搭載。
4.  **設定 (Settings) タブ**
    *   サーバーディレクトリの選択や、ポート番号などの表示。

## Proposed Changes

### クライアント側の変更
#### [MODIFY] [client/src/pages/SettingsView.jsx](file:///Users/kiroku_keizo/開発/webRTC会議室システム/client/src/pages/SettingsView.jsx)
デバイス一覧の取得ロジックとプルダウンUIを追加。

#### [MODIFY] [client/src/pages/MainView.jsx](file:///Users/kiroku_keizo/開発/webRTC会議室システム/client/src/pages/MainView.jsx)
`SettingsView` から渡された `deviceId` を基に `getUserMedia` を実行し、また `setSinkId` で出力スピーカーを設定する処理を追加。

### サーバー側の変更
#### [MODIFY] [server/index.js](file:///Users/kiroku_keizo/開発/webRTC会議室システム/server/index.js)
`process.send()` を利用したステータス送信と、`process.on('message')` による強制切断等のコマンド受信ロジックを追加。

#### [MODIFY] [server-gui/main.cjs](file:///Users/kiroku_keizo/開発/webRTC会議室システム/server-gui/main.cjs)
`spawn` 時の `stdio` に `['pipe', 'pipe', 'pipe', 'ipc']` を追加し、バックエンドサーバーからの統計情報をUIへ中継。

#### [MODIFY] [server-gui/index.html](file:///Users/kiroku_keizo/開発/webRTC会議室システム/server-gui/index.html)
タブナビゲーションと、各管理者向けウィジェット（モニター、ユーザー表、ログ、コントロール）を備えた高度なUIへ書き換え。

## User Review Required
> [!IMPORTANT]
> 1. スピーカー（音声出力）のデバイス変更は、Webの仕様上 `setSinkId` を用いますが、OSや環境によっては制限がかかる場合があります（通常Electron環境では動作します）。
> 2. 管理者機能について、「特定のクライアントをキック（切断）する」「全クライアントを強制再起動する」などの強い権限を持つボタンを配置しますが、誤操作防止の確認ダイアログなどを設ける設計でよろしいでしょうか？
> 3. これらの改修後、再度パッケージビルド（コンパイル）を行います。

## Verification Plan
1. クライアント待機画面で、プルダウンからUSBカメラやマイクを選択し、正しくプレビューに反映されるか確認。
2. サーバーGUIを起動し、タブの切り替えやダッシュボードの数値がリアルタイムで変動するか確認。
3. サーバーGUIの「接続管理」タブから再起動コマンドを発行し、クライアントが正しく再起動されるかテスト。
