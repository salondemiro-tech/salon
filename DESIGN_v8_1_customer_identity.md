# TORITA 設計書 改訂版 v8.1 — 顧客 Identity モデル（実運用堅牢化・確定版）

作成日：2026/5/17
位置づけ：v8 を GPT が最終レビュー → 「設計で止まるフェーズは抜けていい」
          と承認 → 残2点（① merge 排他制御 / ⑤ claim 失敗 UX 方針）を
          追記した**確定版**。GPT が対策案（トランザクションロック）まで
          提示済みのため、本 v8.1 は再レビュー不要で実装に進める。
          DESIGN.md / DESIGN_NOTES.md への**最終改訂**。
合意状態：大方針 1-C・GPT 初回7指摘・GPT v7レビュー6指摘・claim条件B
          いずれも Claude/GPT/いけさん間で合意。本 v8 本体のみ GPT 最終
          確認を残す（その後 DESIGN.md へ反映）。

---

## 0. v7 から v8 への変更点（GPT v7レビュー6指摘の反映）

| # | GPT v7 指摘 | v8 での対応 |
|---|---|---|
| ① | authIndex の唯一性が弱い（customers.authUid と二重真実）| **authIndex を source of truth に確定**（本書 1-5）|
| ② | merge 時の authIndex 更新が未記載 | **merge の authIndex 規則を明記**（本書 3-5）|
| ③ | 「登録で必ず新カルテ→merge」は危険、claim すべき | **claim 条件 B を採用**（本書 2-3）|
| ④ | merge の単純合算が二重加算事故 | **予約履歴から再計算を正、合算は暫定と明記**（3-2）|
| ⑤ | merge 失敗途中の rollback 戦略が弱い | **mergeStatus ジョブ方式を導入**（本書 3-6）|
| ⑥ | createdBy は将来増える | **createdSource に改名**（本書 1-2）|
| ⑦(良) | customerId 曖昧名の禁止は良い | v7 通り維持・強化 |

---

## 1. 確定 Identity モデル

### 1-1. ID 命名の完全分離（v7 から維持・GPT 一致で確定）

| 用語 | 意味 |
|---|---|
| `customerDocId` | 顧客カルテのドキュメント ID（Firestore 自動採番）|
| `authUid` | 顧客の Firebase Auth UID（アプリ登録時のみ存在）|
| `salonId` | サロン ID（=オーナー Auth UID、不変）|

**禁止**：新コードで `customerId` という曖昧名を使わない。
v6 の `customerId` は全て `customerDocId` に改名する。

### 1-2. 顧客カルテ構造（v8 確定）

```
salons/{salonId}/customers/{customerDocId} {
  name: "山田 花子",
  phone: "090-1234-5678",
  email: "hanako@example.com",       // 任意（サロン登録時は空可）

  authUid: null,                     // ★ キャッシュ。正規参照は authIndex
                                     //   (本書 1-5)。更新は Function のみ
  createdSource: "salon",            // ★ ⑥: salon|self|import|line|admin|
                                     //   migration|api …将来拡張可
  notifyChannels: { email: true, line: false },

  memo: "敏感肌",                    // スタッフのみ
  stampCount: 5,                     // スタッフのみ（merge は再計算が正）
  lastVisit: <Timestamp>,
  totalSpent: 84000,                 // スタッフのみ（merge は再計算が正）

  // merge 関連（soft delete）
  isMerged: false,
  mergedInto: null,
  mergedAt: null,
  mergedAliases: [],
  lockedByJob: null,                 // ★ v8.1: merge 処理中の jobId。
                                     //   排他制御用（本書 3-7）。
                                     //   Function のみ書込・通常 null

  lineUserId: null,                  // サーバ専用
  createdAt: <serverTimestamp>,
  updatedAt: <serverTimestamp>
}
```

### 1-3. 逆引きインデックス authIndex（v7 から確定）

```
salons/{salonId}/authIndex/{authUid} {
  customerDocId: "cus_a1b2c3"
}
```
顧客アプリは自分の `authUid` → `authIndex/{authUid}` を1回 get →
`customerDocId` を得て `customers/{customerDocId}` を直 get。
query 不要・index 不要・速い・安い。

### 1-4. 予約ドキュメント（v7 から確定）

```
salons/{salonId}/appointments/{appointmentId} {
  customerDocId: "cus_a1b2c3",       // v6 の customerId を改名
  authUid: null,                     // 予約者の Auth UID（あれば）
  customerSnapshot: { name, phone },  // 予約時点の顧客情報（不変）
  // 以降 v6 確定フィールド（dateKey/start/end/startAt/endAt/staffId/
  //   resourceIds/status/priceSnapshot/durationSnapshot/
  //   menuNameSnapshot/editingBy/createdAt）
}
```
merge で `customerDocId` を付け替えても `customerSnapshot` は不変。

### 1-5. ★ source of truth の確定（GPT 指摘①）

**authIndex を唯一の正規参照（source of truth）とする。**

- `customers/{docId}.authUid` は**キャッシュ（高速化のための写し）**
- 正規の「この authUid はどのカルテか」は **`authIndex/{authUid}` だけ**が持つ
- `customers.authUid` と `authIndex` の更新は **Cloud Function のみ**
  （クライアントから両者を書けない＝二重真実のズレを根絶）
- 整合性監査：Function に「authIndex と customers.authUid の不一致を
  検出・修復するメンテナンス関数」を将来用意（DESIGN_NOTES 追記）
- 不一致が起きた場合の優先：**authIndex を正とし customers.authUid を直す**

---

## 2. サロン側顧客登録 ＋ claim（フェーズ1）

### 2-1. サロン側顧客登録フロー
1. サロンが顧客管理画面で「＋ 新規顧客」
2. 氏名（必須）・電話（必須）・メール（任意）入力
3. `customers` に自動採番 ID でカルテ作成
   （`authUid:null`, `createdSource:"salon"`, `isMerged:false`）
4. Auth アカウントは作らない

### 2-2. 顧客アプリ登録フロー（claim 判定込み）
1. 顧客がアプリで Auth 登録（メール＋パスワード）
2. Firebase 確認メール → 顧客がリンクをタップ（`emailVerified=true`）
3. ログイン時、Cloud Function が **claim 判定**（次節）
4. claim 成功 → 既存カルテに authUid 付与・authIndex 作成
   claim 不成立 → 新カルテ作成（`createdSource:"self"`）

### 2-3. ★ claim 条件（GPT 指摘③ ＋ いけさん判断＝B 採用）

**方針 B：メール一致 claim（emailVerified 必須）。
不成立時は新カルテ＋サロン手動 merge にフォールバック。**

claim を実行する条件（**すべて満たす時のみ**）：
1. 登録した顧客の `emailVerified == true`
   （＝そのメール受信箱を開ける本人と証明済み。乗っ取り防止の要）
2. 同一サロン内に、`email` が**完全一致**する既存カルテが存在
3. その既存カルテが `authUid == null`（未 claim）
4. その既存カルテが `isMerged == false`（無効カルテでない）
5. その `email` を持つ未 claim カルテが**ちょうど1件**
   （複数該当時は自動 claim せず新カルテ＋サロンへ要統合フラグ）

上記を満たせば：
- 既存カルテに `authUid` を付与（Function が書く）
- `authIndex/{authUid}` を作成し当該 `customerDocId` を指す
- `createdSource` は既存値（"salon" 等）を維持

満たさなければ：
- 新カルテ作成（`createdSource:"self"`, `authUid` は本人 uid）
- `authIndex/{authUid}` を新カルテに向ける
- （後でサロンが重複に気付けば手動 merge）

**電話番号一致 claim は採用しない**（SMS 認証が無く本人証明
できないため乗っ取りリスク。GPT・Claude 一致）。

### 2-4. claim は Cloud Function で実行
claim 判定・authUid 付与・authIndex 作成は admin 権限の
callable / トリガー Function で行う（クライアントに claim 権限を
与えない＝なりすまし防止）。関数名案：`resolveOrClaimCustomer`。

**★ claim Function の追加責務（過去予約の authUid 後埋め）**：
サロン手動登録（DESIGN.md 3-3 appointments 作成(B)）で作られた予約は、
対象がサロン仮登録カルテ（`authUid:null`）の場合、予約の `authUid`
も `null` で作られている。その顧客が後でアプリ登録して claim が
成立した時、claim Function は以下も実行する：
- claim 対象 `customerDocId` を参照する `appointments` および
  `appointments_archive` のうち `authUid==null` のものに、
  確定した顧客の `authUid` を後埋めする
- これをやらないと、claim 後に顧客がアプリで「自分の過去予約」を
  見られない（読み取りルールが `resource.data.authUid ==
  request.auth.uid` のため）
- 大量予約に備え、merge と同様に分割バッチ・進捗管理で行う
  （件数が多い顧客でも安全に。失敗時リトライ可能にする）

### 2-5. claim 失敗時の運用フロー方針（GPT v8レビュー指摘⑤）

claim が不成立になるケースは実運用で**普通に起きる**：
- 仮カルテにメール未登録（電話だけ予約客）
- メール不一致（顧客が別アドレスでアプリ登録）
- 同一メールの未 claim カルテが2件以上（自動 claim 不可）
- 既に別 authUid と紐付くカルテしかない

この時の方針（DB 設計は本書 2-3 で確定済み。ここは**運用 UI の指針**）：
1. claim 不成立 → 新カルテを作成（顧客はアプリを普通に使える＝
   顧客体験を止めない）
2. 同時に、サロン側に**「統合候補あり」フラグ**を立てる
   （例：customers に `needsMergeReview: true`、または
   サロンのダッシュボードに通知。実装時に方式確定）
3. サロンスタッフが顧客管理画面で「統合候補」を確認
   → 同一人物と判断したら本書 3 の merge を実行
4. 「既に別カルテと紐付いています」等の状態は、スタッフに
   分かる文言で提示（顧客には技術的詳細を見せない）

**この運用 UI（統合候補の提示・スタッフ確認フロー）は
C-4 顧客管理画面 / 顧客統合機能の実装時に具体化する。**
v8.1 時点では「claim 失敗は顧客体験を止めず、サロンに統合候補を
提示して人間が判断する」方針のみ確定。詳細画面は実装フェーズで設計。

---

## 3. 顧客統合（merge）— Function・soft delete・ジョブ方式

### 3-1. 方式（v7 から確定）
- `mergeCustomers({srcDocId, dstDocId, mergedFields})` callable Function
- クライアント batch 禁止
- 成功/失敗を確実に返す（旧 TORITA の「失敗を成功表示」欠陥を根絶）

### 3-2. ★ 合算でなく再計算（GPT 指摘④）
統合先の `stampCount` / `totalSpent` は：
- **正：統合後の全予約履歴から再計算する**
  （重複予約・CSV インポート・手動修正による二重加算を防ぐ）
- 暫定実装として単純合算を使う場合は、コードと設計書に
  **「単純合算は暫定。正は履歴再計算」**と明記する
- 再計算の元データ：current + archive の有効予約
  （`status` が cancelled/no_show を除く、要件は実装時に確定）

### 3-3. 予約付け替え（v7 から確定）
- `src` を参照する予約の `customerDocId` を `dst` に付け替え
- `appointments`（current）と `appointments_archive`（B-8）**両方**
- `customerSnapshot` は書き換えない（予約時点の事実を保存）

### 3-4. soft delete（GPT 指摘③・v7 から確定）
統合元は物理削除しない：
- `isMerged:true`, `mergedInto:dstDocId`, `mergedAt:serverTimestamp()`
- 統合先の `mergedAliases` に `srcDocId` を追加（旧 ID 追跡）
- 一覧表示は `isMerged==true` を除外
- 理由：誤統合 rollback・監査・税務・履歴

### 3-5. ★ merge 時の authIndex 規則（GPT 指摘②）

**不変条件：1つの `authUid` は 1つの `customerDocId` にしか紐付かない。**

merge の src/dst の authUid 状態別の扱い：

| src.authUid | dst.authUid | 処理 |
|---|---|---|
| null | null | authIndex 変更なし |
| あり | null | `authIndex/{src.authUid}` を dst に向け直す。dst.authUid に src.authUid をセット |
| null | あり | authIndex 変更なし（dst が既に正）|
| あり | あり（別値）| **自動 merge 禁止**。二重 Auth 登録の事故ケース。サロンに警告し、どちらの authUid を残すか人間が選択 → 選ばれなかった authUid は無効化（その Auth アカウントは将来ログイン時に新カルテ作成 or 再 claim）|
| あり | あり（同値）| 異常データ。Function はエラーを返し merge 中止（要調査）|

src.authUid != null かつ dst.authUid != null（別値）の自動禁止が
GPT 指摘②の核心。ここを Function でガードする。

### 3-6. ★ merge ジョブ方式（GPT 指摘⑤：rollback 戦略）

大量予約付け替えの中断耐性のため、merge を**ジョブ**として扱う：

```
salons/{salonId}/mergeJobs/{jobId} {
  srcDocId, dstDocId,
  status: "pending" | "processing" | "completed" | "failed",
  progress: { appointmentsDone, appointmentsTotal,
              archiveDone, archiveTotal },
  startedAt, finishedAt, error
}
```

- Function は jobId を作り `processing` に → 分割バッチで付け替え
  （Firestore バッチ 500件上限対策。1バッチ≦500、進捗を更新）
- 全工程完了で `completed`、その時点で初めて src を soft delete
- 途中失敗 → `failed` ＋ どこまで進んだか progress に記録
  - **完了するまで src を soft delete しない**ので、failed でも
    src カルテは生きており、再実行（リトライ）または手動対応が可能
  - authIndex の付け替えは「全予約付け替え完了後」に行う
    （順序：予約付替 → 完了確認 → authIndex 更新 → src soft delete）
- UI は jobStatus を見て「統合中…」「完了」「失敗（リトライ）」を
  正直に表示（旧 TORITA の嘘成功表示を構造的に不可能にする）

### 3-7. ★ merge 排他制御（GPT v8レビュー指摘①：DB破壊防止・必須）

**問題**：複数スタッフ（または同一スタッフの二重操作）が同時に
merge を開始すると競合が起きる。例：
- スタッフ A が `A→B` を統合中
- スタッフ B が同時に `B→C` を統合開始
→ B が src でも dst でもある状態が並行し、authIndex・予約付け替えが
  交錯して **DB が壊れる**（GPT 指摘①）。

**対策：merge 開始時に Firestore トランザクションでロックを取得する。**

merge Function は処理開始前に、**1つのトランザクション内で**以下を
確認・確定する（確認と確保を不可分にするのが要点）：

1. `srcDocId` のカルテが
   - `isMerged == false`（既に統合済みでない）
   - `lockedByJob == null`（他 merge ジョブに掴まれていない）
2. `dstDocId` のカルテが同上（`isMerged==false` かつ `lockedByJob==null`）
3. src/dst いずれかが、進行中（status: pending/processing）の
   他 `mergeJobs` の src または dst になっていないこと
4. 上記を全て満たせば、同一トランザクションで：
   - `mergeJobs/{jobId}` を作成（status: processing）
   - `customers/{srcDocId}.lockedByJob = jobId`
   - `customers/{dstDocId}.lockedByJob = jobId`
   をアトミックに書く（チェックと確保が分離不能＝競合不可）

カルテに追加するフィールド（本書 1-2 に追加）：
```
lockedByJob: null   // merge 処理中はその jobId。完了/失敗で null に戻す
```

**ロック解放**：
- merge 完了（completed）→ dst の `lockedByJob` を null に。
  src は soft delete 済み（`isMerged:true`）なので実質ロック不要だが
  整合のため `lockedByJob` も null にする
- merge 失敗（failed）→ src/dst 両方の `lockedByJob` を null に戻す
  （src は生存しているのでリトライ可能な状態へ）
- 解放も Function（admin）のみが行う。クライアントは触れない

**ロック規則の Firestore ルール反映**（本書 4-1 customers に追加）：
- クライアントの update では `lockedByJob` を触れない
  （`affectedKeys().hasAny(['lockedByJob'])` を禁止対象に追加）
- `lockedByJob != null` のカルテは、サロンスタッフの通常 update も
  原則ブロック（merge 中の編集競合を防ぐ）。実装時に厳密化。

**スタック対策**：Function が processing 中にクラッシュして
`lockedByJob` が残った場合に備え、`mergeJobs` に `startedAt` を持ち、
一定時間（例：15分）超過した processing ジョブは「stale」と判定して
管理 Function が安全に解放できる仕組みを将来用意（NOTES 追記）。

---

## 4. Firestore ルール改訂（DESIGN.md 3-3 を上書き）

### 4-1. customers
```
match /customers/{customerDocId} {
  allow read: if isSalonStaff(salonId)
              || (isSignedIn() &&
                  resource.data.authUid == request.auth.uid);

  allow create: if
    ( isSalonStaff(salonId) &&
      request.resource.data.authUid == null &&
      request.resource.data.createdSource == 'salon' &&
      request.resource.data.keys().hasOnly([
        'name','phone','email','authUid','createdSource',
        'notifyChannels','isMerged','mergedInto','mergedAt',
        'mergedAliases','createdAt'
      ]) )
    ||
    ( isSignedIn() &&
      request.resource.data.authUid == request.auth.uid &&
      request.resource.data.createdSource == 'self' &&
      request.resource.data.keys().hasOnly([
        'name','phone','email','authUid','createdSource',
        'notifyChannels','isMerged','mergedInto','mergedAt',
        'mergedAliases','createdAt'
      ]) );

  allow update: if
    ( isSignedIn() &&
      resource.data.authUid == request.auth.uid &&
      request.resource.data.diff(resource.data).affectedKeys()
        .hasOnly(['name','phone','notifyChannels','updatedAt']) )
    ||
    ( isSalonStaff(salonId) &&
      !request.resource.data.diff(resource.data).affectedKeys()
        .hasAny(['lineUserId','authUid','isMerged','mergedInto',
                 'mergedAt','mergedAliases','createdSource',
                 'lockedByJob']) );

  allow delete: if isSalonOwner(salonId);   // 通常運用は soft delete
}
```
※ `authUid`・merge系・`createdSource`・`lockedByJob` はクライアント
  更新不可（Function=admin のみ）。これが source of truth と
  merge 排他制御（本書 3-7）の保証の要。

### 4-2. authIndex
```
match /authIndex/{authUid} {
  allow read:   if (isSignedIn() && authUid == request.auth.uid)
                || isSalonStaff(salonId);
  // 作成も含めクライアント書き込み不可。claim/merge は
  // Function(admin) が行う＝source of truth を一元管理
  allow write:  if false;
}
```
※ v7 では本人 create を許可していたが、v8 で **authIndex は
  Function 専用書き込みに格上げ**（GPT 指摘①「正規参照は
  authIndex・更新は Function のみ」を厳密化）。

### 4-3. appointments
v6 3-3 の `customerId` を全て `customerDocId` に改名。
顧客本人判定は `resource.data.authUid == request.auth.uid`。
クライアントの update では `customerDocId` 変更を禁止
（merge による付け替えは Function=admin のみ）。

### 4-4. mergeJobs
```
match /mergeJobs/{jobId} {
  allow read:  if isSalonStaff(salonId);   // UIが進捗表示に使う
  allow write: if false;                   // Function(admin)のみ
}
```

### 4-5. Rules に書かないこと
claim 判定・merge 実行・再計算・authIndex 整合は全て Function。
Rules は「クライアントが触れてはいけないフィールドを触れない」
ことだけ保証する（DESIGN.md 3-3 方針「複雑ロジックは Functions」）。

---

## 5. DESIGN.md / DESIGN_NOTES.md への反映指示

1. **0-2**：顧客ドキュメント設計を本書 1-2 で置換
2. **3-2**：顧客認証フローに本書 2-2/2-3（claim 条件 B）を追記
3. **3-3**：customers/appointments を本書 4 で置換、
   authIndex・mergeJobs ルールを新規追加
4. **7 A-step1-4**：悪意書き込みテストに本書 6 を追加
5. **9-3**：販売開始時の最小機能（オーナー側）に「顧客登録」追加
6. **DESIGN_NOTES.md 4**：「customerId 統一」を
   「customerDocId と authUid は意図的に分離。**authIndex が
   source of truth、customers.authUid はキャッシュ**」に改訂
7. **DESIGN_NOTES.md 追記**：
   - 顧客統合は callable Function。クライアント batch 禁止
   - 統合の失敗を成功表示しない（旧 TORITA 欠陥・再発禁止）
   - 統合は soft delete（物理削除しない）
   - merge は mergeJobs ジョブ方式・分割バッチ・順序厳守
     （予約付替→完了確認→authIndex更新→src soft delete）
   - stampCount/totalSpent は merge 時「履歴再計算が正、
     単純合算は暫定」
   - claim 条件 B（emailVerified 必須メール一致・電話番号不可）
   - authIndex/customers.authUid 整合監査 Function を将来用意
   - **merge 排他制御（本書 3-7）：開始時トランザクションで
     src/dst を lockedByJob ロック。完了/失敗で解放。stale ジョブ
     （15分超 processing）の安全解放 Function を将来用意**
   - **claim 失敗時は顧客体験を止めず、サロンに統合候補を提示して
     人間が判断（本書 2-5）。詳細 UI は C-4 実装で具体化**

---

## 6. A-step1-4（悪意書き込みテスト）追加項目

- サロン A がサロン B の customers / authIndex / mergeJobs に
  読み書き → 全て拒否
- サロンが作成カルテに `authUid` を入れて作成 → 拒否
  （createdSource:'salon' は authUid=null 必須）
- 顧客本人が他人の authUid でカルテ作成 → 拒否
- クライアントから customers の `authUid`/`isMerged`/`mergedInto`/
  `mergedAliases`/`createdSource` を直接書換 → 拒否
- クライアントから authIndex を作成・更新・削除 → 全て拒否
  （Function 専用）
- クライアントから予約の `customerDocId` を付替 → 拒否
- emailVerified=false の顧客が claim 発動を試みる → claim されない
  （Function 側ロジックのテスト：未確認メールでは既存カルテに
   紐付かないこと）
- 同一メールの未 claim カルテが2件ある時、自動 claim されず
  サロンに要統合フラグが立つこと
- クライアントから customers の `lockedByJob` を直接書換 → 拒否
  （Function 専用）
- 同一カルテを src/dst に含む merge を2件同時実行 → 2件目は
  ロック取得に失敗して弾かれること（Function 側 3-7 ロジックの
  テスト：DB が壊れないこと）

---

## 7. 実装順序（v8.1 確定 → 実装フェーズ）

GPT が v8 を承認し残2点も本 v8.1 で反映済み。設計フェーズ完了。
以下の順で実装に進む：

1. 本 v8.1 を DESIGN.md / DESIGN_NOTES.md に反映（GitHub コミット、
   DESIGN.md を v8.1 相当に）
2. **A-step1 ルール改訂**：本書 4 を firestore.rules に反映
   （C-4 より先。DESIGN.md 9-2 / ルール7「DBルールはUIより先」）
3. **shared_db.js 改修**：
   - `customerId` → `customerDocId` 命名統一
   - `dbSalonCreateCustomer(name, phone, email, cb)` 追加
   - `dbCustomerResolveMyCard(cb)` 追加（authIndex 経由）
4. **C-4 顧客管理画面**実装（一覧・詳細・サロン側登録）。
   「統合」は UI の箱だけ置き、Function 実装後に有効化
5. claim Function `resolveOrClaimCustomer`・merge Function
   `mergeCustomers`（ジョブ方式・3-7 排他制御込み）は
   フェーズ1後半で実装

---

## 8. 合意状態の記録

- 大方針 1-C：3者合意・確定
- GPT 初回7指摘：v7 で反映・確定
- GPT v7レビュー6指摘：Claude 全同意・v8 で反映・確定
- claim 条件：いけさん判断で **B 採用**・確定
- GPT v8レビュー：「設計で止まるフェーズは抜けていい」と承認。
  残2点（① merge 排他制御 / ⑤ claim 失敗 UX 方針）を本 v8.1 で反映
- GPT が①の対策（トランザクションロック）まで提示済みのため
  v8.1 は再レビュー不要 → **設計フェーズ完了・実装へ**
- 本 v8.1 をもって顧客 identity 設計は確定。以降は実装品質・
  Functions 実装・テスト・migration・UI 事故防止の段階
  （GPT 総評：「実装フェーズに進むべき」）
