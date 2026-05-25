# 設計書改訂サマリ：2026/5/25

## このZIPの目的

Phase D（顧客アプリ v2 作り直し）着手前に、claim Function 仕様の
最終確定と、claim 不成立時の運用 UX 方針確定を反映した設計書改訂。

## 変更ファイル

| ファイル | 旧版 | 新版 | 状態 |
|---|---|---|---|
| DESIGN.md | v6（2026/5/12） | **v6.1**（2026/5/25） | 改訂 |
| DESIGN_v8_1_customer_identity.md | 初版（2026/5/17） | 改訂版（2026/5/25） | 改訂 |

## GitHub アップロード手順

1. salondemiro-tech/salon リポジトリを開く
2. `DESIGN.md` を開いて編集 → ZIPの `DESIGN.md` の内容で**丸ごと上書き**
3. `DESIGN_v8_1_customer_identity.md` を開いて編集 → ZIPの同名ファイルの
   内容で**丸ごと上書き**
4. コミットメッセージ例：「設計書改訂 v6→v6.1：claim Function 仕様確定 +
   needsMergeReview フラグ追加」

## 主な改訂点

### 1. claim 不成立（2件以上）時の運用 UX を A方式で確定

これまで v8.1 2-5 に「実装時に方式確定」として保留されていた箇所。
今回いけさん判断で **A方式（`needsMergeReview` フラグ）** で確定。

**A方式の動き**：
- claim Function が「同一メールの未claimカルテが2件以上」を検出
- 候補カルテ全件（+ 新カルテ自身）の `needsMergeReview` を true に
- C-4 顧客管理画面で 🚩 表示 → スタッフが手動 merge
- merge 完了時、Function が候補全件の `needsMergeReview` を false に戻す

**選定理由**：シンプル・気づきやすい・後から拡張可能。
販売開始時の最小機能（DESIGN.md 9-3）原則に合致。

### 2. customers スキーマに needsMergeReview フィールド追加

DESIGN.md 0-2 / DESIGN_v8_1 1-2 のスキーマ定義に追加：

```
needsMergeReview: false,   // Function のみ書込
                           // C-4 で 🚩 表示
                           // merge 完了で false に戻す
```

### 3. Firestoreルール改訂

customers の update 禁止リストに `needsMergeReview` を追加：
- DESIGN.md 3-3
- DESIGN_v8_1 4-1

```
.hasAny([
  'lineUserId','authUid','isMerged','mergedInto',
  'mergedAt','mergedAliases','createdSource',
  'lockedByJob',
  'needsMergeReview'   // ★ 追加
])
```

### 4. claim Function 仕様を実装可能粒度まで具体化

DESIGN_v8_1 2-4 を書き直し。以下を明文化：
- 関数名：`resolveOrClaimCustomer`
- 入力（callable コンテキスト）
- 処理フロー（冪等性チェック → メール一致検索 → 件数判定 4-A/4-B/4-C）
- 必須要件5項目（トランザクション・冪等性・emailVerified拒否・
  過去予約authUid後埋め・エラー時の挙動）

### 5. Phase D を step1-4 構成に明示化

DESIGN.md 7章 Phase D に「事前タスク」セクションを追加：
- D-step1：claim Function 実装
- D-step2：A-step1-4 identity 関連テスト先行実施
- D-step3：shared_db.js dbCustomer* v8.1 化（+ _safeCb 全棚卸し同時実施）
- D-step4：customer_app.html v2 作成

理由：claim Function なしでは shared_db.js も customer_app.html も
書けない（顧客の identity 解決が claim Function の責務）ため。

### 6. A-step1-4 セキュリティ試験項目追加

DESIGN.md 7章 / DESIGN_v8_1 6章に追加：
- 「クライアントから customers の `needsMergeReview` を直接書換 → 拒否」
- 「同一メール未claimカルテ2件時、候補全件の `needsMergeReview==true` を確認」

### 7. C-4 顧客管理画面に 🚩 表示機能を追記

DESIGN.md 7章 C-4 / DESIGN_v8_1 5章に明記：
- `needsMergeReview==true` のカルテに🚩マーク表示
- 「要統合のみ表示」フィルタで絞り込み可能
- スタッフが merge 操作を実行すると、Function 内で false に戻す

### 8. 販売開始時の最小機能リスト更新

DESIGN.md 9-3 オーナー側機能リストに追加：
- 「顧客管理（一覧・詳細・★ v8.1 サロン側顧客登録・
   ★ v6.1 `needsMergeReview` 🚩 表示）」

## アップロード後の次ステップ

設計書を GitHub に反映したら、次は **D-step1：claim Function 実装**
（functions/index.js への `resolveOrClaimCustomer` 追加）に進む。
別チャットで作業する場合は、このZIPの内容（DESIGN.md と
v8.1文書）を必ず添付してから着手する。
