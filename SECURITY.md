# Security Policy

## 対象バージョン

セキュリティ修正は、GitHubの `main` に統合された最新版に対して行います。過去の配布バイナリや保全タグは記録として保持しますが、修正版は新しいReleaseとして配布します。

## 脆弱性の報告

公開Issueに脆弱性の再現手順、トークン、TURN資格情報、録画データ、個人情報を記載しないでください。GitHubリポジトリの **Security → Report a vulnerability** から、Private Vulnerability Reportとして報告してください。

報告には、可能な範囲で次を含めてください。

- 影響を受けるコンポーネントとバージョン
- 攻撃者に必要な条件（ネットワーク到達性、認証の有無、必要権限）
- 最小限の再現手順と期待値/実際値
- 想定される影響と、既に確認した回避策
- 可能であれば修正案。実トークンや実録画は添付せず、無効なテスト値を使用

報告を受信したら、影響範囲を確認し、修正ブランチと非公開のSecurity Advisoryで調整します。認証情報が漏えいした場合は、Git履歴の修正より先に失効・再発行します。

## 安全な運用の前提

- 本番では相互に異なる `SFU_AUTH_TOKEN`、`SFU_ADMIN_TOKEN`、`RECORDING_ACCESS_TOKEN` を設定し、`SFU_REQUIRE_AUTH=1` を有効にする
- Originなし/`null`はElectron・native client互換のため許可される。CORS/Origin allowlistだけを認証として扱わない
- `RECORDING_ALLOW_ANONYMOUS` は本番で有効にしない。管理・録画トークンを通常会議クライアントへ配布しない
- HTTP/WSポートをInternetへ直接公開せず、信頼できるVPNまたはTLS終端の内側で運用する
- TURNと管理トークンを定期的にローテーションし、Git・URL・ログへ出力しない
- Client管理HTTPのリモート公開は必要な端末のみに限定し、ファイアウォールと32文字以上のtokenを使う
- 録画保存先・設定ファイル・配布フォルダーのOS権限を、サーバー実行ユーザーと管理者に限定する
- 録画中のカメラOFFは他拠点への配信を止めるが、録画processを安定維持するため無効化trackのRTP送信自体は継続する。実映像はtrack無効化で出力されないが、必要な録画同意表示・運用告知は別途行う
