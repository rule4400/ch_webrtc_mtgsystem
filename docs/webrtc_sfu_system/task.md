# エラー修正とWindows対応 タスクリスト

- `[x]` 1. Macのカメラ・マイク権限設定の修正
  - `[x]` `client/package.json` の `mac.extendInfo` に `NSCameraUsageDescription` 等を追加
- `[x]` 2. Windowsクロスプラットフォーム対応
  - `[x]` `client/package.json` にWindows(`win`)のビルドターゲット(`nsis`, `portable`)を追加
  - `[x]` `server-gui/package.json` にWindows(`win`)のビルドターゲットを追加
- `[x]` 3. 両アプリのクロスビルド
  - `[x]` クライアント：MacおよびWindows向け再ビルド
  - `[x]` サーバーGUI：MacおよびWindows向け再ビルド
