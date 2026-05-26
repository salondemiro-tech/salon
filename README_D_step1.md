# D-step1 成果物（claim Function 実装）

作成日：2026/5/25
対応設計書：DESIGN_v8_1_customer_identity.md 2-4 / DESIGN.md 7章 Phase D-step1

---

## このZIPの中身

| ファイル | 配置先 | 変更内容 |
|---|---|---|
| `functions/index.js` | `functions/index.js` を上書き | **490行 → 847行**：末尾に `resolveOrClaimCustomer` callable Function を追加 + `import` に `onCall, HttpsError` 追加 |
| `firestore.rules` | `firestore.rules` を上書き | **422行 → 423行**：customers update 禁止リストに `needsMergeReview` 追加 |
| `debug_check_dstep1.html` | リポジトリ直下に新規追加 | claim Function テスト用デバッグページ |
| `TEST_PLAN_D_step1.md` | リポジトリ直下に新規追加 | 11項目のテスト手順書 |
| `README_D_step1.md` | （このファイル） | この説明 |

注：このZIP内のフォルダ構成について
- ZIPルートに index.js があるので、これを `functions/index.js` に
  上書きしてください（フォルダ名でなくファイル名でアップ）
- firestore.rules はリポジトリ直下のものを上書き
- debug_check_dstep1.html と TEST_PLAN_D_step1.md は新規ファイル

---

## GitHub アップロード手順

1. salondemiro-tech/salon を開く
2. `functions/index.js` を開く → ZIP内 `index.js` の中身で上書き
3. `firestore.rules` を開く → ZIP内 `firestore.rules` の中身で上書き
4. `debug_check_dstep1.html` を**新規ファイルとして追加**
5. `TEST_PLAN_D_step1.md` を**新規ファイルとして追加**
6. コミットメッセージ案：「D-step1: resolveOrClaimCustomer 実装 + needsMergeReview ルール強化」

---

## deploy 手順

GitHub にアップロード後、Firebase に deploy が必要：

### Functions のデプロイ
GitHub Actions で自動 deploy になっているならコミット直後に走る。
手動 deploy の場合は PC で：
```
firebase deploy --only functions
```
（iPad では現実的でない）

### Firestore Rules のデプロイ
これは Firebase Console から手動でも可能：
1. Firebase Console → Firestore Database → ルールタブ
2. GitHub の最新 firestore.rules の内容を貼り付け
3. 「公開」ボタン

PC環境がない場合は、まず Firebase Console でルール手動公開 →
Functions は IAM権限を再付与してCloud Build経由で実行できるか確認。
（メモリの過去事例で「IAM権限3つ付与済」とあるので、設定済みなら
自動 deploy が動くはず）

---

## deploy 完了の確認

1. Firebase Console → **Functions**
   - `resolveOrClaimCustomer` が `asia-northeast1` リージョンに表示
   - 「最新リビジョン」が今日の日付
   - エラーログがない

2. Firebase Console → **Firestore Database → Rules**
   - 225-237行付近に `needsMergeReview` が
     `.hasAny([...,'lockedByJob','needsMergeReview'])` の形で入っている
   - 最終公開日時が今日

---

## テスト実行

deploy 完了後、`TEST_PLAN_D_step1.md` を**上から順番に**実行。

`debug_check_dstep1.html` を以下のURLで開く（GitHub Pages 反映後）：
```
https://salondemiro-tech.github.io/salon/debug_check_dstep1.html?salon=<テストサロンのuid>
```

- **テストサロン**：torit.test@gmail.com の uid を使う
- **本番サロン**：hTWPrkP1nPebpmGcb6iguviLmEl2

全11項目 pass したら Claude に「全項目 pass」と報告 → D-step2 に進む。

---

## 重要な注意

- **メモリの「マルチサロン視点を最優先に」原則に従い、テストは
  必ず torit.test@gmail.com で実施**してから本番サロンで再確認
- claim Function は同期処理が長い（特に過去予約後埋め）。
  タイムアウト 60秒以内に収まるはずだが、もし発生したら報告
- テスト完了後、Authentication コンソールで test-* メールの
  Auth ユーザーを削除する（残骸を残さない）

---

## トラブル時の連絡

エラーや想定外の動作があったら、以下を Claude に共有：
1. どのTEST番号の何ステップで起きたか
2. debug_check_dstep1.html の「ログ」エリアのテキスト
3. Firebase Console → Functions → resolveOrClaimCustomer →
   ログタブのエラー出力（直近1分間）
4. Firestore Console で該当カルテ・authIndex のスクリーンショット
