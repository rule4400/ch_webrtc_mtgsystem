# MeetingViewer

SFUサーバーから映像・音声を受信するだけの閲覧専用アプリです。

## 動作

- カメラ/マイクを取得しません。
- SFUサーバーにはProducerを作成せず、既存拠点のProducerだけをconsumeします。
- 拠点端末が増減した場合、1秒間隔の同期で表示を追従します。

## 起動

```bash
npm install
npm run electron:dev
```

## ビルド

```bash
npm run package
```
