# CHECKHOUSE デバッグログ

サーバーとクライアントは、音声・映像・WebRTC経路の疎通確認用ログをJSONL形式で保存します。

## サーバー側

保存先はサーバー実行ディレクトリ配下の `logs/` です。

例:

```text
server-runtime/logs/sfu-debug-YYYY-MM-DD.jsonl
```

サーバー起動ログにも保存先が表示されます。

```text
[DebugLog] writing JSONL logs to ...
```

ブラウザやPowerShellから保存先を確認できます。

```powershell
Invoke-RestMethod http://192.168.2.200:3000/debug/log-info
```

主に記録される内容:

- Socket接続、切断、メタ情報
- `ANNOUNCED_IP`、RTCポート、TURN設定数
- WebRTC Transport作成、ICE状態、DTLS状態、選択されたICE経路
- Producer作成、pause/resume、score
- Consumer作成、resume、score、layers
- クライアントからの1秒テレメトリ
- 送信/受信RTPバイト数、フレーム数、パケットロス、ジッター
- 切り分け用flags

## クライアント側

Electronの userData 配下に保存されます。

Windows例:

```text
%APPDATA%\checkhouse-meeting-client\debug-logs\client-debug-YYYY-MM-DD.jsonl
```

macOS例:

```text
~/Library/Application Support/checkhouse-meeting-client/debug-logs/client-debug-YYYY-MM-DD.jsonl
```

クライアント制御サーバーが有効な場合は、保存先を確認できます。

```powershell
Invoke-RestMethod http://127.0.0.1:39210/health
```

## 原因切り分けflags

ログの `flags` に以下のような値が出ます。

```text
camera-enabled-but-track-missing
mic-enabled-but-track-missing
video-track-live-but-no-outbound-rtp
audio-track-live-but-no-outbound-rtp
remote-peer-present-but-no-inbound-video-rtp
remote-peer-present-but-no-inbound-audio-rtp
socket-connected-send-transport-not-connected
socket-connected-recv-transport-not-connected
ice-using-tcp
ice-using-turn-relay
```

特に重要な見方:

```text
video-track-live-but-no-outbound-rtp
  端末側のカメラは取得できているが、サーバーへ映像RTPが出ていない。

remote-peer-present-but-no-inbound-video-rtp
  相手拠点は存在するが、自端末に映像RTPが届いていない。

ice-using-tcp
  UDPではなくTCP経路でWebRTCが確立している。

ice-using-turn-relay
  TURN中継を使っている。
```

## 調査時に共有してほしいもの

問題発生直後に以下を共有してください。

```text
サーバー側 sfu-debug-YYYY-MM-DD.jsonl
問題が出たクライアント側 client-debug-YYYY-MM-DD.jsonl
発生時刻
拠点名
症状: 音声だけ / 映像だけ / 双方不可 / 片方向のみ
```
