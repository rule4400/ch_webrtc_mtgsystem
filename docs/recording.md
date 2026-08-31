# サーバー録画機能

各拠点のカメラ映像+音声をサーバー側で常時録画し、タイムラインで振り返り再生・
ライブ視聴できる機能。v1.4.0 (server / server-gui)・v0.6.0 (client) で追加。

## 構成

```
クライアント(カメラ映像 + マイク音声)
   │ WebRTC (カメラOFF中も映像送信は継続 / マイクミュート中は音声RTPが止まる=無音)
   ▼
SFUサーバー ──┬─ 配信consumer ──→ 他拠点(カメラOFF中はサーバーがpauseして配信停止)
              └─ PlainTransport×1〜2 ─→ ffmpeg(映像+任意の音声 RTP受信, stream copy)
                                      │ セグメント(既定5分)
                                      │   └─ ライブ視聴: 書き込み中ファイルを追記追従配信
                                      ▼
                    ローカルstaging/raw（取込み中はNASへ書かない）
                                      │
                     確定キュー（既定1ジョブ、上限時はbackpressure）
                         │ none: コピー/コンテナ変換（既定・会議優先）
                         └ 圧縮/日時焼き込み: H.264+AAC/mp4へ再エンコード
                                      │ staging/encoded（NAS転送前の確定済み一時file）
                                      │
                                      ▼
                    最終保存先(recordingsDir/NAS可) + JSONインデックス(dbDir)
                                      │
                    毎時の掃除で保持期間超過分を自動削除
```

## 録画形式

- 既定の `compressionMode: none` + `timestampOverlay: false` は映像を再エンコードせず、
  WebRTCのcodecを保ったままコピー/コンテナ変換する。VP8/VP9はWebM、H.264は音声なしならMP4、
  Opus音声付きH.264はMKVが基本となる。これが最もCPU負荷が低い。
- `strong` / `standard` / `light` の圧縮、または日時焼き込みをONにした場合は、
  H.264 + AAC / MP4へ再エンコードする。`none` でも日時焼き込みがONなら再エンコードが必要。
  日時焼き込みには対応フォントが必要で、見つからない場合は警告を記録して焼き込みを省略する。
- 取込み中の生セグメントはWebM（VP8/VP9）またはMKV（H.264等）でローカルstagingに保存され、
  ライブ視聴はその書き込み中ファイルを読む。

## ffmpeg の同梱

- `server` は `ffmpeg-static` / `ffprobe-static` を依存に持ち、システムへの
  ffmpeg インストール不要で動作する。
- server-gui のパッケージには `scripts/prepare-ffmpeg.cjs` が
  `resources/ffmpeg/<platform>-<arch>/` に ffmpeg/ffprobe を同梱し(mac arm64 / win x64)、
  起動時に FFMPEG_PATH / FFPROBE_PATH としてサーバーへ渡す。
- 検出優先順: 設定のパス → FFMPEG_PATH → 同梱 ffmpeg-static → システム(PATH等)。

## ライブ視聴(リアルタイム閲覧)

- 再生UIの「🔴 ライブ」ボタンで、録画中の映像を数秒遅れで視聴できる。
- 仕組み: `GET /recordings/live/:producerId` が書き込み中のrawセグメントを追記追従
  (tail -f 方式)でストリーミングし、クライアントはバッファ末尾へ張り付く。
  サーバー側の再エンコードは発生しないが、接続数に応じたファイルI/Oと通信負荷は発生する。
  既定はサーバー全体16本・接続元IPごと4本まで。
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
- 専用ビューア: `recording-viewer/`（Electron。サーバー接続とフォルダ直読みの両モードに対応する専用UI）

## カメラOFFと録画の関係

- 録画が有効で保存可能な間、クライアントはカメラOFFでも**送信を継続**する。
  初期値は `getServerConfig` の `recording.cameraKeepSendingWhenOff` で配布される。
- 保存先障害、最終保存先の空き不足（古い録画の削除中）、staging容量不足、確定キュー過多で録画を縮退すると、サーバーは
  `recordingPolicyChanged` を即時配信する。カメラOFF中の現行クライアントは再接続を待たずに不要なエンコード/RTP送信を停め、復旧時も同じ通知で録画送信を再開する。
- サーバーはカメラOFF通知(`pauseProducer`)を受けると producer は止めず、
  **他拠点への配信consumerだけをpause**する(`isCameraRelayControlled`)。
  → 他拠点には従来どおり「カメラOFF」表示、録画だけが続く。
- マイクをミュートすると音声producer自体がpauseし、その区間は録画でも無音になる。
  画面共有を意図的に一時停止した場合も共有producer自体をpauseする。
- server-gui の接続端末カードには「⏺ 録画中」「⏺ 録画中(配信OFF)」チップが出る。

## 設定（server-gui 設定タブ、または認証付きAPI）

| 項目 | 既定 | 説明 |
|---|---|---|
| enabled | false | 録画の有効/無効 |
| recordingsDir | (空=既定録画フォルダ) | 録画データ保存先。server-gui経由はuserData/recordings、standaloneは設定ファイル所在ディレクトリ配下。NASのマウント先可 |
| dbDir | (空=保存先/recording-db) | インデックス(DB)保存先 |
| stagingDir | (空=既定staging) | server-gui経由はuserData/recording-staging、standaloneは設定ファイル所在ディレクトリ配下。サーバー内蔵SSD推奨、NASは指定しない |
| retentionDays | 14 | 保持期間(日)。超過分は毎時自動削除 |
| segmentSeconds | 300 | セグメント長 |
| compressionMode | none | 再エンコードなし（会議優先）。必要時のみstrong(480p)/standard(720p)/light(1080p) |
| recordScreen | false | 画面共有アプリの映像も録画 |
| recordAudio | true | 音声(マイク/画面共有の音声)も録音するか。OFFで映像のみ録画 |
| timestampOverlay | false | 対応フォントがある場合に右下へ日時を焼き込む。ONは`none`設定でも再エンコードを強制 |
| compressionConcurrency | 1 | 確定処理の同時ジョブ数。0（自動）の現在の実効値も1。会議中の負荷を実測した場合のみ増やす |
| minFreeGb | 10 | 保存先に常に確保する最低空き容量(GB)。下回ると保持期間内でも古い録画から順に自動削除 |
| ffmpegPath | (空=自動) | ffmpeg のパス(通常は同梱版が自動選択される) |

- 設定は `recording-settings.json`(server-gui 経由の起動では userData 配下)に永続化。
- サーバー再起動不要で即時反映(保存先変更時は録画セッションを自動で貼り直す)。
- server-gui の設定タブは表示中に自動更新で入力値が上書きされない
  (0.5秒周期のstats更新で選択状態がリセットされる問題は v1.4.0 で修正済み)。

### 安全設定への一度きり移行

録画設定の現行schemaは `schemaVersion: 1`。値の権威元はサーバー本体の
`recording-settings.json` とする。server-gui の `system-settings.json` 内の`recording`はGUI表示用のmirrorで、
GUI起動時にサーバー設定を取り込み、管理APIからの変更も子プロセスIPCでGUIへ逆同期する。
既存ファイルに保存された設定の `schemaVersion` がない（または1未満）場合だけ、
初回読み込み時に会議安定性のため次の3項目を移行し、`schemaVersion: 1` と一緒に書き戻す。

- `compressionMode: none`
- `timestampOverlay: false`
- `compressionConcurrency: 1`

録画の有効/無効、保存先、保持期間などその他の既存値は維持される。新規インストールは初めからschema 1の安全な既定値を使うため移行対象ではない。
移行後に利用者が変更した値は再起動時も上書きされない。

## 容量管理

- server-gui 設定タブと再生UIに「空き容量」と「予想される残り保存期間」を表示する。
  残り保存期間 = (空き − 最低確保量) ÷ 直近24時間の使用ペース(保持期間を上限)。
  使用ペースはNAS負荷を抑えるcache値で、録画中は最大約30分、無負荷時は最大約5分の遅れがある。
- 空き容量が最低確保量(既定10GB)を下回ると、5分周期の監視が保持期間内でも
  **全拠点を通して最も古いセグメントから順に**削除して空きを確保する
  (少し余分に空けて削除のフラッピングを防ぐ)。容量不足中は新規取込みと確定処理を止め、
  非同期・件数制限付きの削除で会議処理を塞がず、回復後に自動再開する。状態はGUIに「⚠ 空き不足」と表示。

## 並列処理

- **取り込み**: 拠点ごとに独立した ffmpeg プロセス(stream copyで低負荷)。
  同時取込み上限は既定12セッション。音声付きは1セッションあたりPlainTransportを2本使う。
- **mediasoup worker**: 録画用PlainTransport/consumerは現在の1つのrouter上に作られる。
  サーバーが複数workerプロセスを起動していても、1つのrouterのメディア処理が自動的に複数worker/複数コアへ分散されるわけではない。
- **確定処理**: 常駐threadの「ワーカープール」ではなく、キューから1ジョブごとに独立したffmpeg子プロセスを起動する。
  既定の同時実行数は1（`0=自動`も実効値1）。再エンコードの各ジョブは `-threads 1` / `-filter_threads 1` に制限し、
  `none` + 日時焼き込みOFFならコピー/コンテナ変換のみとなる。複数拠点が同時に区切りを迎えた場合は、会議を優先してキューで順番に処理する。

## バックプレッシャと保護上限

- 確定待ち+実行中ジョブが `RECORDING_MAX_COMPRESSION_QUEUE`（既定256）に達すると、
  会議のCPU/I/Oとローカル容量を守るため新規録画を一時停止する。キューが半分（既定128）以下に戻ると自動再開する。
- ローカルstagingの空きが `RECORDING_MIN_STAGING_FREE_GB`（既定2GB）未満になると新規録画を一時停止する。
  stagingには取込み中の`raw/`だけでなく、NAS転送・index commit前の`encoded/`も一時的に共存する。
  2GBは停止用の最低閾値であり、実際には「全セッションの生segment + 確定待ち + 処理済みsegment」を収容できる余裕を確保する。
- 同時取込みは `RECORDING_MAX_ACTIVE_SESSIONS`（既定12）、録画用PlainTransportは
  `RECORDING_MAX_PLAIN_TRANSPORTS`（RTC port rangeから自動算出）で上限を設ける。上限に達した候補は空きが出た後のreconcileで再試行される。
- simulcastは `RECORDING_SPATIAL_LAYER=1`（中間レイヤ）を既定とし、最高画質の常時取得で会議を圧迫することを避ける。

## NAS運用

- 取込み中のrawセグメントは `stagingDir/raw`、確定済みの転送待ちは`stagingDir/encoded`へ書く。
  `stagingDir` にNASパスを指定してはならない。ライブ視聴もこのローカルrawを読む。
- セグメントの書き込みが止まり、確定キューが処理する段階で初めて `recordingsDir`へ出力し、
  インデックス更新の後にローカルrawを削除する。このため `recordingsDir` / `dbDir` にはマウント済みNASパスを指定できる。
- 最終保存先が利用できないと検知した場合、サーバープロセスは落とさずに圧縮/確定処理と録画セッションを停止する。
  ローカルに残ったrawは削除せず、60秒ごとの確認でNAS復旧を検知すると確定処理と録画を自動再開する。
- OSによってはNASがunmountされた後もmountpoint直下のローカルfilesystemへ書けるため、write/statfsだけでは切断を判別できない場合がある。
  NAS専用mountpointを使い、OS側のmount監視・自動mountと権限設定を併用し、ローカルfallback先へ録画しないことを監視する。
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

`RECORDING_ACCESS_TOKEN` を設定すると、閲覧データAPI・メディア・ライブ配信はすべて認証必須になります。通常クライアント用の `SFU_AUTH_TOKEN`、管理用の `SFU_ADMIN_TOKEN` とは別の値を使います。未設定時は録画データの閲覧を無効化し、旧環境で `RECORDING_ALLOW_ANONYMOUS=1` を明示した場合だけ匿名互換モードになります。`GET /recordings` のUI shellはtoken入力画面を表示するため無認証で配信しますが、録画データは返しません。ブラウザー版は入力したBearer tokenを保存せず、短期のHttpOnly/SameSite session cookieに交換します。専用Recording ViewerはOSの `safeStorage` が使える場合にtokenを暗号化保存し、利用できない環境では権限`0600`の設定JSONへ平文fallbackするため、端末アカウントと設定ディレクトリのアクセス権を厳格に管理します。

- `GET /recordings` … token入力を含む再生UI shell（録画データ自体は返さない）
- `POST /recordings/api/session` … Bearer tokenを閲覧session cookieに交換
- `GET /recordings/api/status` … パスを除いた稼働状態（ffmpeg/録画中件数/圧縮キュー/空き容量）
- `GET /recordings/api/locations` … 録画のある拠点一覧
- `GET /recordings/api/segments?from=&to=&keys=` … セグメント検索
- `POST /recordings/api/settings` … 設定変更（`Authorization: Bearer <SFU_ADMIN_TOKEN>` 必須。管理トークン未設定時はHTTP経由の変更を無効化）
- `GET /recordings/media/:id` … セグメント動画(Range対応)
- `GET /recordings/api/live` … 録画中セッション一覧(ライブ視聴用)
- `GET /recordings/live/:producerId` … 録画中セグメントの追記追従ストリーム

セグメント検索は1回31日以内に制限され、不正な日時は `400` で拒否します。
ライブ視聴と過去録画の同時配信は既定でサーバー全体16本・接続元IPごと4本に制限され、`RECORDING_MAX_CONCURRENT_STREAMS` / `RECORDING_MAX_STREAMS_PER_IP` で調整できます。
管理トークンはURLやGitへ記録せず、信頼できるVPNまたはTLS終端の内側からのみ送信してください。

## 注意・既知の制約

- 現行クライアントは録画方針の変更を `recordingPolicyChanged` で即時反映する。
  このイベントに対応しない旧クライアントは次回接続時の設定取得まで切り替わらない。
- タイムライン(過去再生)はセグメント確定+圧縮後に再生可能になる（平常時は既定の5分segment + 確定処理時間の遅れ）。
  キュー滞留やNAS障害時はさらに遅れ、復旧後に順次確定する。
  それより新しい映像は「🔴 ライブ」で視聴する。
- 音声producerが映像より後に現れた場合、録画セッションは一度貼り直される(数秒の欠落)。
- 旧クライアント(〜v0.5.0)はカメラOFF中にRTPが止まるため、その間は録画されない(互換動作)。
- `recording-viewer` のパッケージ名に "viewer" を含むファイル名を配布フォルダへ置くと
  既存の「閲覧用(viewer)」として誤検出されるため、配布フォルダには置かないこと。
