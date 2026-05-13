# TORITA 設計書 付録メモ（DESIGN_NOTES）
作成日：2026/5/12

設計書本体（DESIGN.md）に対する補足・将来検討事項・実装時の注意点をまとめたもの。
本体ほど確定的ではないが、実装中に必ず参照すべきメモ集。

---

## 1. 将来 Cloud Functions API 中心化への移行計画（重要度：高）

### 現状の方針（フェーズ1販売開始時）
- UI → Firestore 直接アクセス（Rules で守る）
- 一部だけ Functions（メール送信、LINE 送信、onCreate トリガー検証）

### 将来の方針（フェーズ販売前 or 販売後早期）
- UI → Cloud Functions（API）→ Firestore
- 予約作成、キャンセル、変更、スタンプ加算、決済処理などは callable Function 経由

### なぜ移行が必要か
- 決済（Stripe Webhook、サブスクリプション管理）が入った瞬間、UIから直接やれない
- LINE連携の webhook 処理は必然的にサーバ側
- クーポン適用、売上集計、競合防止（楽観ロック）は Firestore Rules だけでは限界
- Firestore Rules の複雑化を避けるため、検証ロジックを Functions に寄せる

### 段階移行のステップ
1. **Phase A 〜 G（販売開始まで）**：現状の UI → Firestore + Functions onCreate トリガー
2. **販売後すぐ**：予約作成だけ callable Function 化（`createAppointment`）
3. **決済導入時**：Stripe Webhook + サブスクリプション関連を Function 化
4. **LINE 連携導入時**：LINE webhook 全部 Function

---

## 2. Firestore Rules は最低限、複雑ロジックは Functions（重要度：最高だが本体に既出）

### Rules で「やること」
- 認証チェック（ログイン中か、所属サロンか）
- フィールド存在チェック
- 型チェック
- 単純な値域チェック（status が許可リストの値か）
- フィールドホワイトリスト（`keys().hasOnly([...])`）

### Rules で「やらないこと」（Functions の責任）
- 営業時間との整合性
- 他予約との重複
- 価格計算
- 複雑な状態遷移マシン
- スタッフ・設備の同時利用チェック
- メニュー所要時間と予約時間の一致

### なぜか
- Rules は「アプリコード」ではなく、複雑になると壊れやすい
- フィールド追加・nullable 変更で予想外に通る/落ちる
- デバッグが難しい
- 変更履歴を追いにくい

### 設計判断
Rules で過剰なロジックを書きたくなったら、その時点で **「これは Functions でやるべき」** と判断する。

---

## 3. createdAt をサーバ確定（重要度：高）

### 問題
顧客が `createdAt` を任意の値で書けると：
- 「予約は10分前にした」と偽装してキャンセル料を回避
- 並び順を操作
- 監査ログの信頼性が落ちる

### 対策
- 顧客は `createdAt` を送らない
- Cloud Functions `onAppointmentCreate` または callable Function 内で `admin.firestore.FieldValue.serverTimestamp()` をセット
- Firestoreルールでも `request.resource.data.createdAt == request.time` のような制約を入れる（補助的に）

---

## 4. customerId と customerAuthUid の統一（重要度：高）

### 現状の問題
予約ドキュメントに `customerId` と `customerAuthUid` の両方を持っていて、同じ値が入る設計。これは：
- 更新漏れ
- 比較ミス
- query 混乱

の原因になる。

### 対策
- `customerId` だけに統一
- 値は顧客の Auth UID
- Firestoreルールも `request.auth.uid == resource.data.customerId` でチェック
- 将来「Auth UID と顧客識別子を分離したい」というニーズが出てきたら、その時に分ければいい（YAGNI 原則）

---

## 5. dateKey + startAt/endAt 併用設計（重要度：高）

### 問題
予約ドキュメントの `date: "2026-05-14"` を string で持つと：
- timezone の扱いが曖昧
- 並び順の問題
- range query が文字列比較になる
- locale 問題
- 日跨ぎ予約（深夜サロンなど）が表現しにくい

### 対策
両方持つ：

```javascript
appointments/{id} {
  dateKey: "2026-05-14",      // 営業日ベース、検索・並び替え用
  startAt: <Timestamp>,        // 正確な開始時刻（JST）
  endAt: <Timestamp>,          // 正確な終了時刻（JST）
  ...
}
```

### 使い分け
- カレンダー検索：`where('dateKey', '==', '2026-05-14')` で高速
- 月別取得：`where('dateKey', '>=', '2026-05-01').where('dateKey', '<=', '2026-05-31')`
- 正確な時刻計算（重複チェック、duration検証）：`startAt` / `endAt` で行う
- timezone は startAt / endAt の Timestamp が吸収

### 注意
- `dateKey` と `startAt` の整合性は Cloud Functions で保つ（顧客が送るのは `dateKey` と `start: "10:00"` だけ、`startAt` はサーバで合成）

---

## 6. editingBy は箱だけ、ロック実装は据え置き（重要度：中）

### 設計書本体の方針
予約ドキュメントに `editingBy: null` フィールドを最初から持たせる。

### しかし注意
Firestore で `editingBy: uid` 方式の編集ロックは、以下の理由で壊れやすい：
- ロック解除忘れ（ブラウザ閉じる、タブ閉じ）
- 通信断
- iPad スリープ
- アプリクラッシュ

### 実装は据え置き
- フェーズ1では `editingBy` フィールドだけ存在、値は常に `null`
- フェーズ2でも、まず「警告だけ出す」レベル（編集中の人がいるなら警告ダイアログ）から始める
- 本格的なロック（タイムアウト + ハートビート + 強制解除）はフェーズ3以降

### 「これでロック完成」と思わない
複数人版でも、最初は「ロック」じゃなくて「最終更新時刻の競合検出（楽観ロック）」の方が現実的。

---

## 7. アーカイブは 18〜24ヶ月（重要度：中）

### 設計書本体の修正
「6ヶ月以上前 → archive」は早すぎ。小規模サロンなら数千件溜まっても Firestore は十分処理できる。

### 修正後の方針
- `appointments`（current）：直近 **18ヶ月** 以内の予約
- `appointments_archive`：18ヶ月以上前の予約
- 月次バッチ → **半年に1回** のバッチに変更（運用負荷を下げる）

### archive後の運用注意点
- 顧客履歴：current + archive 両方読む
- 売上集計：archive_summary（年月別事前集計）を使う
- 税務確認：archive 直読み（年単位）
- CSV エクスポート：current + archive 両方含める

つまり「archive 作った瞬間、全検索が二重化する」ことを忘れない。

---

## 8. status は将来肥大化する想定（重要度：中）

### 設計書本体の現状
- `confirmed` / `cancelled` / `no_show` / `completed` / `refunded`

### 将来追加されうる status
- `pending`（仮予約・確認待ち）
- `waiting`（キャンセル待ち登録）
- `checked_in`（来店受付済み）
- `in_service`（施術中）
- `partial_refund`（部分返金）
- `disputed`（顧客と揉めている）

### 対策
- 状態遷移マシンの一覧表を Phase 2 開始時に再設計する
- status を増やす際は、必ず Firestoreルールの遷移ルールも同時更新
- Functions 内で `validateStatusTransition(from, to, byWhom)` のような専用関数を持つ
- UI 側も `getStatusLabel(status, language)` で吸収

---

## 9. Auth UID = salonId 設計の限界（重要度：高、本体既出）

### 現状
サロンオーナーの Auth UID をそのまま salonId として使用。

### 将来詰まるケース
- サロン譲渡（オーナーが店を売却）
- オーナー変更（離婚、独立で代表者が変わる）
- 複数オーナー（共同経営）
- 法人化（個人事業 → 株式会社）

### 理想
```
salons/{自動採番ID}.ownerUid: '<Auth UID>'
salons/{自動採番ID}/staffs/{Auth UID}.role: 'owner'
```

### 移行タイミング
販売後にこの限界が見えてきたら、マイグレーションスクリプトで自動採番ID方式に切り替える。
今は「販売できる状態に早く到達する」が優先。

---

## 10. ES5 縛りの将来見直し（重要度：低）

### 現状
iPad + GitHub Web UI の制約で ES5 互換維持。`var`, `function`, `Promise.then` のみ。

### 将来
PC 環境が整ったら、Babel 変換工程（ES2020 → ES5）を導入することも検討。

### それまで
- ES5 で書く + 自動 lint チェック（`tools/es5_check.sh`）
- Claude / GPT に「ES5 で書いて」を必ず明示

---

## 11. 「直接Firestore書き込み」の脅威モデル（参考）

販売前に、必ず以下のテストを行う：

### テストシナリオ（悪意ある顧客）
1. Firebase Console から直接 `appointments` ドキュメントを書き込む
   - 別サロンの予約を作ろうとする → Rules で拒否されるか確認
   - `priceSnapshot: 0` で予約を作ろうとする → Rules で拒否されるか確認
   - `end` を極端に短くする → Rules で拒否されるか確認
   - `staffId` を別のスタッフに偽装 → Rules で拒否されるか確認

2. ブラウザ DevTools から `firebase.firestore().collection(...).add(...)` 直接実行
   - 顧客が自分の `stampCount` を書き換える → Rules で拒否されるか確認
   - 顧客が `customers/<別の顧客>` を読みに行く → Rules で拒否されるか確認

3. 別アカウントでログインして他サロンにアクセス
   - サロンBの顧客がサロンAの URL を直接叩く → Rules で拒否されるか確認

### テスト用に2つのサロンを用意
- Salon A（テスト用1）
- Salon B（テスト用2）

両者で予約・顧客データを作成し、相互に見えないこと、書き込めないことを確認。

---

## 付録メモの使い方

- 設計書本体（DESIGN.md）は **販売前に必ず守るべき** 内容
- 付録メモ（このファイル）は **実装中に参照する補足、将来検討事項、注意点**
- 実装中に「これは本体に昇格させるべき」と判断したら、両方を更新する
- 各 Phase 完了時に、付録メモも見直す
