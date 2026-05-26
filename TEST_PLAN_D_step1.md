# D-step1 テスト手順書（claim Function `resolveOrClaimCustomer`）

作成日：2026/5/25
対応設計書：DESIGN_v8_1_customer_identity.md 2-4 / 6章
対応コード：functions/index.js `resolveOrClaimCustomer` + firestore.rules

---

## このドキュメントの使い方

deploy 後、iPad の Firebase Console と Firestore データを使って
**書いてある通りの順番で**操作し、期待される結果と照合する。

不一致があったらその時点で**作業を止めて Claude に報告**。
全部 pass したら D-step2（identity 関連セキュリティ試験）→
D-step3（shared_db.js dbCustomer* v8.1 化）に進む。

---

## 事前準備

### 1. deploy

```
ZIP内のファイルを GitHub にアップロード:
  - functions/index.js（490行 → 847行）
  - firestore.rules（422行 → 423行）

GitHub Actions が自動 deploy する場合はそれを待つ。
手動 deploy の場合は別途実行（PC 必要）。
```

deploy 完了の確認：
- Firebase Console → Functions で `resolveOrClaimCustomer` が
  asia-northeast1 リージョンに「稼働中」として表示される
- Firebase Console → Firestore → Rules で `needsMergeReview` が
  禁止リストに入っている（225-237行付近）

### 2. テスト環境

- **テストサロン**：torit.test@gmail.com（マルチサロン確認用）
- **本番サロン**：salondemiro@gmail.com（既存）
- 両方で確認する（メモリの「マルチサロン視点を最優先に」原則）

### 3. テストを呼び出す手段（重要）

`resolveOrClaimCustomer` は callable Function なので、Firebase Console
からは直接実行できない。**呼び出すには JS コードが必要**。

最も簡単な方法は、debug_check.html を一時的に拡張して呼び出しボタン
を作ること。Claude が次のメッセージで debug_check_dstep1.html を
別途用意するので、それを使って各テストを実行する。

---

## テスト項目（全 11項目）

### TEST-1: 既存顧客カルテへの claim 成立（4-A 経路）

**目的**：サロン手動登録した既存カルテに、顧客アプリ登録で claim が
成立することを確認。

**事前データ作成**：
- テストサロン (torit.test) の C-4 顧客管理画面で新規顧客を登録：
  - 名前: テスト花子A
  - 電話: 090-1111-1111
  - メール: **test-claim-a@example.com**
- Firestore で確認：customers サブコレクションに新カルテができている
  - `authUid: null`
  - `createdSource: 'salon'`
  - `isMerged: false`
  - `needsMergeReview: false`（または無し）

**実行手順**：
1. ブラウザの**シークレットモード**で debug_check_dstep1.html を開く
2. テストサロンの URL（`?salon=<テストサロンの uid>`）付きで開く
3. メールアドレス `test-claim-a@example.com` で**新規登録**
4. Firebase が確認メールを送信 → メールのリンクをタップ
5. 戻ってきたらログイン
6. 「claim 実行」ボタンをタップ（debug_check_dstep1.html 上）

**期待される結果**：
- ボタン押下後、画面に表示されるレスポンス：
  ```json
  {
    "result": "claimed",
    "customerDocId": "<さっき作った既存カルテのID>",
    "claimedAppointmentCount": 0
  }
  ```
- Firestore で確認：
  - 既存カルテの `authUid` がログイン中の Auth UID で埋まっている
  - `salons/{salonId}/authIndex/{authUid}` ドキュメントが新規作成され、
    `customerDocId` が既存カルテIDを指している
  - 新カルテは作成されていない（カルテは1枚のまま）

**もし失敗したら止める観点**：
- `result: 'created_new'` が返る → claim ロジック失敗。新カルテができてる。
- `result: 'already_resolved'` が返る → 冪等性が予期せず効いている（前回のテスト残骸？）

---

### TEST-2: 0件ヒット → 新カルテ作成（4-B 経路）

**目的**：同一メールの既存カルテが無い時、新カルテが作成されることを確認。

**事前条件**：
- テストサロンに `test-newuser-b@example.com` というメールのカルテが
  **存在しない**ことを確認（C-4 で検索）

**実行手順**：
1. シークレットモードで debug_check_dstep1.html を開く（テストサロン）
2. `test-newuser-b@example.com` で新規登録
3. メール確認 → ログイン
4. 「claim 実行」ボタンをタップ
   - name に「テスト B」、phone に「090-2222-2222」を入れる

**期待される結果**：
- レスポンス：
  ```json
  {
    "result": "created_new",
    "customerDocId": "<新採番ID>"
  }
  ```
- Firestore で確認：
  - 新カルテが作成されている
    - `name: 'テスト B'`
    - `phone: '090-2222-2222'`
    - `email: 'test-newuser-b@example.com'`
    - `authUid: <自分のuid>`
    - `createdSource: 'self'`
    - `notifyChannels: { email: true, line: false }`
    - `isMerged: false`
    - `needsMergeReview: false`
    - `stampCount: 0, totalSpent: 0`
  - `authIndex/{authUid}` が新カルテIDを指している

---

### TEST-3: 2件以上ヒット → needsMergeReview フラグ立て（4-C 経路）

**目的**：同一メールの未claimカルテが2件以上ある時、新カルテ作成 +
候補全件に `needsMergeReview=true` が立つことを確認（v6.1 A方式）。

**事前データ作成**：
- テストサロンの C-4 で、同じメールアドレスのカルテを**2枚作る**：
  - カルテ1: 名前「テストC-1」、メール `test-dup-c@example.com`
  - カルテ2: 名前「テストC-2」、メール `test-dup-c@example.com`
- 両方とも `authUid: null`, `needsMergeReview: false`

**実行手順**：
1. シークレットモードで debug_check_dstep1.html を開く
2. `test-dup-c@example.com` で新規登録 → メール確認 → ログイン
3. 「claim 実行」ボタンをタップ（name: 「テスト C本人」、phone: 「090-3333-3333」）

**期待される結果**：
- レスポンス：
  ```json
  {
    "result": "needs_merge_review",
    "customerDocId": "<新採番ID>",
    "candidateCount": 2
  }
  ```
- Firestore で確認：
  - **新カルテ**が作成されている（自分の authUid 付き、`needsMergeReview: true`）
  - **既存カルテ1**：`needsMergeReview: true` に更新されている
  - **既存カルテ2**：`needsMergeReview: true` に更新されている
  - `authIndex` は新カルテIDを指している
  - **既存カルテ1/2 の authUid は null のまま**（claim していない）
  - **isMerged は全カルテで false のまま**（merge ではない）

**確認ポイント**：合計3枚のカルテ全てに🚩フラグが立っている。
C-4 顧客管理画面（実装時）でフィルタすれば3件出るはず。

---

### TEST-4: 冪等性確認（同じユーザーが2回呼ぶ）

**目的**：claim 後に同じユーザーがもう1回 `resolveOrClaimCustomer` を
呼んでも、新カルテが作られず、既存の結果が返ることを確認。

**事前条件**：TEST-1 または TEST-2 のどちらか実行後の状態。

**実行手順**：
1. TEST-1 完了直後の同じセッションで、もう一度「claim 実行」ボタン
   をタップ

**期待される結果**：
- レスポンス：
  ```json
  {
    "result": "already_resolved",
    "customerDocId": "<前回と同じID>"
  }
  ```
- Firestore で確認：
  - 新カルテが作られていない（カルテ数が増えていない）
  - 既存カルテに変更なし

---

### TEST-5: emailVerified=false 拒否

**目的**：メール確認をしていない状態で claim を呼ぶと拒否されることを確認。

**実行手順**：
1. シークレットモードで debug_check_dstep1.html を開く
2. 新しいメールアドレス `test-unverified-d@example.com` で新規登録
3. **メールのリンクをタップせず**にログインを試みる
   - Firebase Auth は emailVerified=false でもログインは可能
4. 「claim 実行」ボタンをタップ

**期待される結果**：
- エラーレスポンス（Firebase Functions HttpsError）：
  ```
  code: 'failed-precondition'
  message: 'メール確認が完了していません。メールのリンクをタップしてから再度お試しください。'
  ```
- Firestore で確認：
  - カルテが作成されていない
  - authIndex も作成されていない

**追加確認**：
- その後メール確認リンクをタップ → 再度ログイン → claim 実行
  → 今度は `created_new` が返るはず（同じユーザーで新規作成OK）

---

### TEST-6: 未認証拒否

**目的**：ログインしていない状態で claim を呼ぶと拒否されることを確認。

**実行手順**：
1. シークレットモードで debug_check_dstep1.html を開く
2. **ログインせず**に「claim 実行」ボタンをタップ

**期待される結果**：
- エラーレスポンス：
  ```
  code: 'unauthenticated'
  message: 'ログインが必要です'
  ```

---

### TEST-7: salonId 未指定拒否

**目的**：入力バリデーションが効くことを確認。

**実行手順**：
1. ログイン後、debug_check_dstep1.html で「salonId なしで claim 実行」
   ボタン（Claude が用意）をタップ

**期待される結果**：
- エラーレスポンス：
  ```
  code: 'invalid-argument'
  message: 'salonId が指定されていません'
  ```

---

### TEST-8: マルチサロン分離確認

**目的**：サロンA の顧客カルテとサロンB の顧客カルテが混ざらないこと。

**事前データ作成**：
- **テストサロン (torit.test)** に `test-multi@example.com` のカルテを作成
- **本番サロン (salondemiro)** には `test-multi@example.com` のカルテを
  作らない

**実行手順**：
1. シークレットモードで debug_check_dstep1.html を**本番サロン**の URL
   （`?salon=hTWPrkP1nPebpmGcb6iguviLmEl2`）で開く
2. `test-multi@example.com` で新規登録 → メール確認 → ログイン
3. claim 実行

**期待される結果**：
- レスポンス：`result: 'created_new'`（テストサロンのカルテは見えていない）
- Firestore で確認：
  - 本番サロン配下に新カルテが作成されている
  - テストサロン配下のカルテは変更されていない（authUid: null のまま）

**重要**：同じメールアドレスでも、サロンが違えば別の identity として
扱われる。これがマルチサロン分離の核心。

---

### TEST-9: needsMergeReview のクライアント直書換拒否（A-step1-4 該当）

**目的**：firestore.rules が `needsMergeReview` の直接書換を拒否すること。

**実行手順**：
1. テストサロンの C-4 でログイン
2. ブラウザの DevTools コンソールから直接 Firestore に書き込み試行：
   ```javascript
   firebase.firestore()
     .collection('salons').doc('<salonId>')
     .collection('customers').doc('<任意のカルテID>')
     .update({ needsMergeReview: true })
   ```

**期待される結果**：
- Firestore からエラー：`PERMISSION_DENIED: Missing or insufficient permissions.`
- カルテに変更なし

---

### TEST-10: authIndex のクライアント直書込拒否

**目的**：firestore.rules が authIndex の書込を完全拒否すること。

**実行手順**：
1. ログイン状態で DevTools コンソールから：
   ```javascript
   firebase.firestore()
     .collection('salons').doc('<salonId>')
     .collection('authIndex').doc('<自分のuid>')
     .set({ customerDocId: 'fake_id' })
   ```

**期待される結果**：
- エラー：`PERMISSION_DENIED`

---

### TEST-11: claim 成立時の過去予約 authUid 後埋め

**目的**：サロン手動登録した予約が、claim 後に顧客アプリで「自分の予約」
として見える状態に後埋めされることを確認。

**事前データ作成**：
- TEST-1 の事前準備（カルテ `test-claim-a@example.com` 作成）と同じ
- そのカルテに対して、サロン側で**手動予約を2件作成**
  （salon_calendar_v8.html の +予約 から）：
  - 予約1: 来週月曜 10:00 〜
  - 予約2: 再来週月曜 14:00 〜
- 両方とも `authUid: null` で作成される（C-3 手動予約は authUid を
  入れないので）

**実行手順**：
1. TEST-1 と同じ流れで claim 実行

**期待される結果**：
- レスポンス：
  ```json
  {
    "result": "claimed",
    "customerDocId": "<既存カルテID>",
    "claimedAppointmentCount": 2
  }
  ```
- Firestore で確認：
  - 予約1 の `authUid` が claim ユーザーの uid で埋まっている
  - 予約2 の `authUid` も同じく埋まっている

---

## テスト完了後の片付け

全 11項目 pass したら：
1. テスト用に作成したカルテ・予約・Auth ユーザーを Firestore Console
   で削除（残骸を残さない）
2. Authentication コンソールで test-* メールのユーザーを削除
3. Claude に「全項目 pass」と報告 → D-step2（残りの identity 関連
   セキュリティ試験）に進む

---

## トラブルシューティング

### Function 呼び出しがタイムアウトする
- Functions の region が `asia-northeast1` になっているか確認
- クライアント側で `firebase.functions('asia-northeast1')` を指定しているか

### 「Function not found」エラー
- deploy が完了していない可能性。Firebase Console で関数一覧を確認
- 関数名のスペルチェック：`resolveOrClaimCustomer`（大文字小文字）

### Firestore index エラー
- 「インデックスが必要」と出たらコンソールから作成
- 想定外なら止めて Claude に報告

---

## このテストで「網羅できていないこと」（D-step2 で実施）

- 同一カルテを src/dst に含む merge を2件同時実行 → ロック取得失敗確認
  （これは merge Function 未実装なので後回し）
- 予約の customerDocId 付替がクライアントから不可
  （rules の appointments update 部分のテスト）
- 顧客本人が他人の authUid でカルテ作成 → 拒否
  （rules の create 部分のテスト）

これらは Phase D 後半 / Phase F の総合テストで実施する。
