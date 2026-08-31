# サーバー録画機能

各拠点のカメラ映像+音声をサーバー側で常時録画し、タイムラインで振り返り再生・
ライブ視聴できる機能。v1.4.0 (server / server-gui)・v0.6.0 (client) で追加。

## 構成

```
クライアント(カメラ映像 + マイク音声)
   │ WebRTC (カメラOFF中も映像送信は継続 / マイクミュート中は音声RTPが止まる=無音)
   ▼
SFUサーバー ──┬─ 配信consumer ──→ 他拠点(カメラOFF中はサーバーがpauseして配信停止)
              └─ PlainTransport×2 ─→ ffmpeg(映像+音声 RTP受信, stream copy)
                                      │ セグメント(既定5分, raw .webm VP8/Opus)
                                      │   └─ ライブ視聴: 書き込み中ファイルを追記追従配信
                                      ▼
                    バックグラウンド圧縮(H.264+AAC/mp4, タイムスタンプ焼き込み)
                                      │
                                      ▼
                    保存先(recordingsDir)  +  JSONインデックス(dbDir)
                                      │
                    毎時の掃除で保持期間超過分を自動削除
```

## 録画形式(監視システム互換)

- 最終保存形式は **MP4 (H.264 + AAC)**。監視カメラ業界の事実上の標準
  (ONVIF は H.264 必須、市販NVRのエクスポートも MP4/H.264 が主流)で、
  VLC・Windows・Mac・一般のNVR/VMSツールでそのまま再生できる。
- タイムスタンプ焼き込み(右下、`YYYY-MM-DD HH:MM:SS`)は監視カメラ様式。設定でON/OFF可。
- 生セグメントは webm (VP8/Opus = WebRTCのままの無劣化コピー)。ブラウザが直接
  再生できるため、そのままライブ視聴の配信ソースになる。

## ffmpeg の同梱

- `server` は `ffmpeg-static` / `ffprobe-static` を依存に持ち、システムへの
  ffmpeg インストール不要で動作する。
- server-gui のパッケージには `scripts/prepare-ffmpeg.cjs` が
  `resources/ffmpeg/<platform>-<arch>/` に ffmpeg/ffprobe を同梱し(mac arm64 / win x64)、
  起動時に FFMPEG_PATH / FFPROBE_PATH としてサーバーへ渡す。
- 検出優先順: 設定のパス → FFMPEG_PATH → 同梱 ffmpeg-static → システム(PATH等)。

## ライブ視聴(リアルタイム閲覧)

- 再生UIの「🔴 ライブ」ボタンで、録画中の映像を数秒遅れで視聴できる。
- 仕組み: `GET /recordings/live/:producerId` が書き込み中の raw webm を追記追従
  (tail -f 方式)でストリーミングし、クライアントはバッファ末尾へ張り付く。
  サーバー側の再エンコードは発生しない(12拠点でも負荷は増えない)。
- セグメント切替(既定5分ごと)でストリームが終了し、UIが自動再接続する(1〜2秒の断)。
- ライブ視聴はサーバー接続時のみ(ビューアのフォルダ直読みモードでは不可)。
- タイムライン操作・日付変更をするとライブを抜けて過去再生に戻る。

## 音声

- カメラ映像とペアで同一拠点のマイク音声(画面共有録画では画面音声)を記録する。
- **設定でON/OFF可**(`recordAudio`、既定ON。server-gui 設定タブ「音声も録音」)。
  OFFにすると映像のみを録画する。切替は録画中のセッションを自動で貼り直して
  即時反映される(貼り直し時に数秒の欠落あり)。
- **ミュート中は録音されない**: ミュート=音声producerのpause=RTP停止のため、
  その区間は無音になる(録画ファイルには映像だけが進む)。
- 再生UIでは音声は既定でミュート。タイルの 🔇 ボタンで聞きたい拠点を選ぶ
  (混線を防ぐため同時に1拠点のみ)。
- 圧縮時に Opus → AAC 96kbps へ変換(MP4互換のため)。

- 実装: `server/recording.js`(録画マネージャ)、`server/index.js`(組み込み・API)
- 再生UI: `server/public/recordings.html` … `http://サーバー:3000/recordings`
- 専用ビューア: `recording-viewer/`(Electron。UIは同一ファイルのコピー `ui/recordings.html`)

## カメラOFFと録画の関係

- 録画が有効な間、クライアントはカメラOFFでも**送信を継続**する
  (`getServerConfig` の `recording.cameraKeepSendingWhenOff` で配布。接続時に反映)。
- サーバーはカメラOFF通知(`pauseProducer`)を受けると producer は止めず、
  **他拠点への配信consumerだけをpause**する(`isCameraRelayControlled`)。
  → 他拠点には従来どおり「カメラOFF」表示、録画だけが続く。
- マイク・画面共有は従来どおり producer 自体を pause(音声は録画対象外)。
- server-gui の接続端末カードには「⏺ 録画中」「⏺ 録画中(配信OFF)」チップが出る。

## 設定(すべて server-gui 設定タブ、または POST /recordings/api/settings)

| 項目 | 既定 | 説明 |
|---|---|---|
| enabled | false | 録画の有効/無効 |
| recordingsDir | (空=userData/recordings) | 録画データ保存先。NASのマウント先可 |
| dbDir | (空=保存先/recording-db) | インデックス(DB)保存先 |
| retentionDays | 14 | 保持期間(日)。超過分は毎時自動削除 |
| segmentSeconds | 300 | セグメント長 |
| compressionMode | standard | strong(480p)/standard(720p)/light(1080p)/none |
| recordScreen | false | 画面共有アプリの映像も録画 |
| recordAudio | true | 音声(マイク/画面共有の音声)も録音するか。OFFで映像のみ録画 |
| timestampOverlay | true | 右下に日時を焼き込む(焼き込みは再エンコード時のみ。none設定でもONなら再エンコードされる) |
| compressionConcurrency | 0(自動) | 圧縮の並列数。自動=CPUコア数から2〜4。取り込みは拠点ごとに独立プロセスで元々並列(12拠点=12プロセス) |
| minFreeGb | 10 | 保存先に常に確保する最低空き容量(GB)。下回ると保持期間内でも古い録画から順に自動削除 |
| ffmpegPath | (空=自動) | ffmpeg のパス(通常は同梱版が自動選択される) |

- 設定は `recording-settings.json`(server-gui 経由の起動では userData 配下)に永続化。
- サーバー再起動不要で即時反映(保存先変更時は録画セッションを自動で貼り直す)。
- server-gui の設定タブは表示中に自動更新で入力値が上書きされない
  (0.5秒周期のstats更新で選択状態がリセットされる問題は v1.4.0 で修正済み)。

## 容量管理

- server-gui 設定タブと再生UIに「空き容量」と「予想される残り保存期間」を表示する。
  残り保存期間 = (空き − 最低確保量) ÷ 直近24時間の使用ペース(保持期間を上限)。
- 空き容量が最低確保量(既定10GB)を下回ると、5分周期の監視が保持期間内でも
  **全拠点を通して最も古いセグメントから順に**削除して空きを確保する
  (少し余分に空けて削除のフラッピングを防ぐ)。状態はGUIに「⚠ 空き不足」と表示。

## 並列処理

- **取り込み**: 拠点ごとに独立した ffmpeg プロセス(stream copyで低負荷)。
  12拠点なら12プロセスが並列動作し、mediasoup worker も複数コアを使う。
- **圧縮**: ワーカープール(既定=CPUコア数から自動2〜4、設定変更可)で並列実行。
  各ジョブは `-threads 2` に制限し、リアルタイム系(SFU/取り込み)のCPUを奪わない。
  12拠点が同時にセグメント境界を跨いでも滞留しない。

## NAS運用

- 保存先/DB保存先にマウント済みのNASパス(`/Volumes/nas/...`、`\\NAS\...`)を指定可能。
- 保存先が切断されても録画機能は落ちない: 60秒ごとのヘルスチェックで復旧を検知し、
  reconcile ループが録画セッションを自動再開する。
- インデックスは「拠点×ソース×日」単位の小さなJSON(アトミック書き込み)。
  ロック不要で、ビューアアプリがサーバー無しでNASから直接読める。

## 再生

- ブラウザ: `http://サーバー:3000/recordings`(server-gui の「📹 録画を見る」からも開く)
  - 拠点リスト(複数選択可、**全拠点選択/解除**ボタン)
  - 日付切替+24hタイムライン(セグメントバー、クリック/ドラッグ/タッチでシーク)
  - 選択拠点の同時再生グリッド、速度0.5〜8倍、表示幅ズーム、最新の録画へジャンプ
  - **スマホ対応(レスポンシブ)**: 760px以下では拠点リストが「☰ 拠点」ボタンの
    ドロワーになり、映像は1カラム、タイムラインはタッチ操作可能
  - **タイル最大化(⛶)**: Fullscreen APIで画面いっぱいに再生
    (非対応環境は擬似フルスクリーンに自動フォールバック)。
    最大化中も下部バーの**時間スライダー**で日内の任意時刻へ移動でき、
    再生/一時停止・音声切替もそのまま操作できる
- 専用アプリ `recording-viewer`(CHECKHOUSE Recording Viewer):
  - サーバー接続モード: 上記APIをそのまま利用
  - フォルダ直読みモード: NAS/ローカルの録画フォルダを直接指定(サーバー停止中でも再生可)
  - 初回起動時に「⚙ データソース」設定が開く
  - 開発: `cd recording-viewer && npm install && npm start`

## HTTP API

- `GET /recordings` … 再生UI
- `GET /recordings/api/status` … 設定+稼働状態(ffmpeg/保存先/録画中セッション/圧縮キュー/空き容量)
- `GET /recordings/api/locations` … 録画のある拠点一覧
- `GET /recordings/api/segments?from=&to=&keys=` … セグメント検索
- `POST /recordings/api/settings` … 設定変更
- `GET /recordings/media/:id` … セグメント動画(Range対応)
- `GET /recordings/api/live` … 録画中セッション一覧(ライブ視聴用)
- `GET /recordings/live/:producerId` … 録画中セグメントの追記追従ストリーム

## 注意・既知の制約

- 録画有効化/無効化後、クライアントの「カメラOFFでも送信」挙動は次回接続時に切り替わる。
- タイムライン(過去再生)はセグメント確定+圧縮後に再生可能になる(既定で最大5〜6分遅れ)。
  それより新しい映像は「🔴 ライブ」で視聴する。
- 音声producerが映像より後に現れた場合、録画セッションは一度貼り直される(数秒の欠落)。
- 旧クライアント(〜v0.5.0)はカメラOFF中にRTPが止まるため、その間は録画されない(互換動作)。
- `recording-viewer` のパッケージ名に "viewer" を含むファイル名を配布フォルダへ置くと
  既存の「閲覧用(viewer)」として誤検出されるため、配布フォルダには置かないこと。
