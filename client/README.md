# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## 接続認証

サーバーで `SFU_AUTH_TOKEN` を設定した場合は、クライアントの「接続設定 → SFUサーバー → 接続トークン」に同じ値を入力します。トークンはSocket.IOのhandshake authで送信し、URLには含めません。HTTP自体はTLSではないため、サーバーは信頼できるVPN内かTLS終端のreverse proxy内側で運用します。

## Server GUIからのリモート管理

クライアントの管理HTTPは既定で `127.0.0.1:39210` のみで待ち受けます。リモートのServer GUIから登録・設定変更・再起動を行う端末に限り、次の3変数をクライアント起動環境に設定します。

```dotenv
SFU_CLIENT_CONTROL_HOST=0.0.0.0
SFU_CLIENT_CONTROL_ALLOW_REMOTE=1
SFU_CLIENT_CONTROL_TOKEN=<16文字以上、推奨32文字以上のランダム値>
```

`SFU_CLIENT_CONTROL_ALLOW_REMOTE=1` と空でない `SFU_CLIENT_CONTROL_TOKEN` の両方が無い場合、非loopbackのbind指定は拒否され、自動的に `127.0.0.1` へ縮退します。Server GUIの登録クライアント側にも同じトークンを設定し、管理ポートは信頼できる管理VPN/ファイアウォールからのみ到達可能にしてください。

## 映像瞬断時の表示

リモート映像の受信が一時的に止まった場合は、最後に正常受信したフレームを最大20秒間表示します。表示中は「映像復旧待機中（最終映像）」と明示し、新しいデコード済みフレームを確認した時点でライブ映像へ戻ります。20秒を超えた場合は最終フレームを破棄して従来の未受信表示へ移ります。カメラOFF、共有の意図的な一時停止、自拠点プレビューには適用しません。
