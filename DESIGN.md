# TORITA 販売前提設計書 v6.1
作成日：2026/5/12（v6：GPTレビュー 12項目反映版）
最終改訂：2026/5/25（v6.1：claim不成立時の運用フロー方式を A方式（`needsMergeReview`フラグ）で確定）
方針：**ゼロから作り直し**（既存コードは参考、データは全消去）

---

## 改訂履歴

- **v6.1（2026/5/25）**：v8.1 文書 2-5「claim 失敗時の運用フロー方針」を A方式で確定。
  - 0-2 customers スキーマに `needsMergeReview` フィールド追加
  - 3-3 customers Firestoreルールの書き換え禁止リストに `needsMergeReview` 追加
  - 7 Phase A-step1-4 セキュリティ試験項目に `needsMergeReview` 書換拒否テスト追加
  - 詳細は `DESIGN_v8_1_customer_identity.md` 2-5 を参照
- **v6（2026/5/12）**：GPTレビュー12項目反映、v8系廃棄・v2系ゼロから構築方針確定

---

## 0. このアプリは何か

**TORITA は、エステ・美容サロン向けの予約管理 SaaS。**
1人〜数人で運営する小規模サロンのオーナーが、自分のサロンの予約・顧客・メニューを管理し、顧客はスマホから予約・変更・キャンセルできる。

**売り方**：月額制 SaaS として、複数のサロンオーナーが個別にアカウントを持って使う。

**現状**：実運用していないテスト段階。既存コード（v8系）は参考として残すが、販売できる完璧な形にするため、**新規ファイル名で1から作り直す**。Firestore データも全消去して空から始める。

### 0-1. 製品の段階展開（重要）

TORITA は2つの段階で展開する：

**フェーズ1：1人用版（=現在作っているもの）**
- サロンオーナー1名で運営する個人サロン向け
- 1サロン = 1アカウント = 1人のオーナー
- スタッフ管理機能なし

**フェーズ2：2〜10人用版（将来）**
- 小規模なスタッフチーム（2〜10人）で運営するサロン向け
- 1サロン = 1オーナーアカウント + 複数スタッフアカウント
- スタッフごとに担当顧客・担当予約・編集権限
- リアルタイム同期（`onSnapshot`）で複数端末の同時編集に対応
- スタッフ間の編集ロック（同じ予約を2人が同時に編集しない仕組み）

### 0-2. 1人用版を作る今、絶対に守る設計指針

**「1人用」として動けばOKではなく、フェーズ2に進む時にDBもコードも大改修にならない設計にする。**

#### 中核となる考え方：「予約 = 時間 × スタッフ × 設備」の3次元モデル

予約とは「店全体の時間を押さえるもの」ではなく、「**特定のスタッフと特定の設備を、特定の時間で押さえるもの**」として最初から設計する。

フェーズ1（1人用）では：
- スタッフ = オーナー1人だけ（`staffs/owner`）
- 設備 = デフォルト1個（`resources/default`）
- 予約画面・メニュー設定画面では「スタッフを選ぶ」「設備を選ぶ」UIを出さない（裏で自動的に紐付け）

フェーズ2（複数人用）になっても、**DB構造を変える必要はなく、UIを追加するだけで済む**。

#### 必要となる概念（フェーズ2で使う、フェーズ1でも箱だけ用意）

1. **スタッフ**（`salons/{salonId}/staffs/{staffId}`）
   - 名前、Auth UID、役職（オーナー/スタッフ）、有効/無効

2. **設備・スペース**（`salons/{salonId}/resources/{resourceId}`）
   - ベッド1、ベッド2、個室A、シャンプー台 など
   - 名前、種類、有効/無効

3. **メニュー**（`salons/{salonId}/menus/{menuId}`）
   - 名前、所要時間、料金、種類（メイン/オプション）、公開/非公開
   - このメニューを施術できるスタッフID配列 `eligibleStaffIds: ['owner']`
   - このメニューに必要な設備ID配列 `requiredResourceIds: ['default']`
   - インターバル（前後の片付け時間）

4. **スタッフのシフト**（`salons/{salonId}/shifts/{shiftId}`）
   - スタッフID、日付、開始時刻、終了時刻
   - フェーズ1ではオーナーの営業時間 = シフトとして自動扱い

5. **設備の空き状況**（予約ドキュメントから動的に計算）
   - その時間帯にその設備を使う予約があるか

6. **指名予約**（フェーズ2の機能）
   - 顧客が予約時に「このスタッフ希望」を指定できる

7. **同時施術不可チェック**
   - 同じスタッフが同じ時間に2つの予約を持てない
   - 同じ設備が同じ時間に2つの予約に使われない
   - メニューが要求する設備とスタッフが両方確保できる時間だけ予約可能

#### 予約ドキュメントの設計（最初からこの形）

```
salons/{salonId}/appointments/{appointmentId} {
  // === 顧客が書き込めるフィールド ===
  dateKey: "2026-05-14",                 // 営業日キー（並べ替え・日別取得用）
  start: "10:00",                        // 時刻ラベル（表示用）
  customerDocId: "cus_xxx",              // ★ v8.1: 採番された顧客ドキュメントID
  authUid: "<顧客Auth UID> or null",     // ★ v8.1: claim 済みなら Auth UID、未claimなら null
                                         //   サロン手動登録予約は最初 null、後で claim Function が後埋め
  menuId: "m1",                          // メインメニュー1つ
  optionMenuIds: ["m4"],                 // オプションメニュー（任意）

  // === サーバ側で確定するフィールド（顧客は書けない）===
  end: "11:00",                          // start + menu.duration から算出
  startAt: <Timestamp>,                  // 厳密な開始時刻（タイムゾーン安全）
  endAt: <Timestamp>,                    // 厳密な終了時刻
  staffId: "owner",                      // フェーズ1：'owner' 固定
  resourceIds: ["default"],              // フェーズ1：['default'] 固定
  status: "confirmed",                   // 予約の状態。値は下記5種類のみ
                                         //   'confirmed'  : 予約確定（未来 or 当日）
                                         //   'visited'    : 来店済み（任意：例外手動変更用）
                                         //   'cancelled'  : 顧客 or サロンがキャンセル
                                         //   'no_show'    : 無断キャンセル（来なかった）
                                         //   'pendingCreate' : 顧客アプリ予約の作成中
                                         //                     (Functions が検証して confirmed に書換)
                                         // ★ 2026/5/23 改訂：
                                         //   過去予約(endAt < 今)は自動で「来店済み」扱い
                                         //   （statusは confirmed のままで、表示時に判定する）
                                         //   明示的に 'visited' を入れる必要はない。
                                         //   ただし「無断キャンセルだった」「やっぱり来た」
                                         //   などの例外時はサロンが手動で status 変更可能。
  priceSnapshot: 12000,                  // menus.price から計算
  menuNameSnapshot: "フェイシャル",      // メニュー名のスナップショット（後でメニュー削除されても残る）
  source: "online",                      // 'online' = 顧客アプリ / 'manual' = サロン手動登録
  createdAt: <serverTimestamp>,          // serverTimestamp() で確定

  // === サロン側がカルテとして後から書き加えるフィールド（v8.1+ カルテ機能）===
  payment: 12000,                        // 実支払い金額（円・整数）。null=未入力
  visitMemo: "<施術内容・申し送り>",     // 来店ごとの訪問メモ（自動保存）
  photos: [                              // 施術前後の写真（最大3枚）
    { id: "p1", path: "salons/<salonId>/appointmentPhotos/<aid>/p1.jpg",
      url: "<download URL>", time: "<ISO8601>" }
  ],

  // === フェーズ2の箱（フェーズ1では null）===
  editingBy: null
}
```

**核心原則：顧客入力を信用するのは最小限のフィールドだけ**

顧客が送れるフィールド：`dateKey`, `start`, `customerDocId`, `menuId`, `optionMenuIds` のみ。
それ以外（`end`, `startAt`, `endAt`, `staffId`, `resourceIds`, `status`, `priceSnapshot`, `menuNameSnapshot`, `source`, `createdAt`）は **すべてサーバー側で確定**する。

`authUid` は **顧客アプリ経由の予約では Function が auth コンテキストから自動付与**し、サロン手動登録は最初 null（後で claim Function が同一メール検出時に後埋め）。

`payment` / `visitMemo` / `photos` は **サロンスタッフのみ書き込み可能**。顧客アプリからは書けない（ルールで拒否）。

**なぜ`end` も顧客に書かせないか**：
顧客が `start: "10:00", end: "10:05"` のように短く送って、本来90分のメニュー予約を5分で押さえる攻撃を防ぐため。サーバ側で `start + menu.duration + optionMenusのduration合計 + settings.intervalMin` から算出する（★ v8.1: インターバルはサロン共通設定 `settings.intervalMin` を使う。詳細は 0-2 メニュースキーマの注釈参照）。

**なぜ`priceSnapshot` をサーバ確定にするか**：
顧客が `priceSnapshot: 0` で送る改ざんを防ぐ。Cloud Functions が `menus/{menuId}.price + sum(optionMenuIds.price)` から計算してセット。過去予約は当時の価格が残る。

**なぜ`createdAt` をサーバ確定にするか**：
顧客が過去日・未来日の createdAt を入れて並べ替えやログを混乱させる攻撃を防ぐ。`serverTimestamp()` で確定。

**status の値域（許可リスト）**：
- `confirmed`：予約確定（初期値、サーバ側で必ずこの値）
- `cancelled`：顧客またはサロンによるキャンセル
- `no_show`：顧客が来店しなかった（サロンのみ設定可能）
- `completed`：施術完了（サロンのみ設定可能）
- `refunded`：返金処理済み（サロンのみ設定可能）

**status 変更の許可ルール**：
| 現状 | 変更可能 | 誰が |
|---|---|---|
| confirmed | cancelled | 顧客 or サロン |
| confirmed | no_show | サロンのみ |
| confirmed | completed | サロンのみ |
| completed | refunded | サロンのみ |
| その他の遷移 | 全て禁止 | - |

このルールは `shared_db_reservation.js` の専用関数 `customerCancelAppointment` / `salonMarkNoShow` / `salonMarkCompleted` 経由でのみ呼び出される。Firestoreルールでもこの遷移を強制する。

#### 顧客ドキュメントの設計（v8.1 顧客 identity モデル＝確定版）

> **この節は 2026/5/17 の顧客 identity 設計改訂（v7→v8→v8.1、Claude/GPT/
> いけさん 3者合意）で全面改訂された。詳細・背景・全リスク分析は
> `DESIGN_v8_1_customer_identity.md` を参照。本節はその要点を本体に反映
> したもの。両者が食い違う場合は v8.1 文書を正とする。**
>
> **2026/5/25 v6.1 改訂**：v8.1 2-5「claim 失敗時の運用フロー方針」を
> A方式（`needsMergeReview` フラグ）で確定。本節スキーマに該当
> フィールドを追加。

**改訂の理由**：旧 v6 は「`customerId` = 顧客の Auth UID」を背骨にして
いたが、サロン側顧客登録（電話予約客をサロンが登録）を入れると、
Auth 未登録の顧客が普通に存在するためこの前提が壊れる。
→ **顧客ドキュメント ID（採番）と Auth UID を分離する。**

**ID 命名の完全分離（最重要・事故防止）**

| 用語 | 意味 |
|---|---|
| `customerDocId` | 顧客カルテのドキュメント ID（Firestore 自動採番）|
| `authUid` | 顧客の Firebase Auth UID（アプリ登録時のみ存在）|
| `salonId` | サロン ID（=オーナー Auth UID、不変）|

**禁止**：新コードで `customerId` という曖昧名を使わない。
v6 の `customerId` は全て `customerDocId` に改名する。

```
salons/{salonId}/customers/{customerDocId} {
  // customerDocId = Firestore 自動採番（Auth UID ではない）
  name: "山田 花子",
  phone: "090-1234-5678",
  email: "hanako@example.com",       // 任意（サロン登録時は空可）

  authUid: null,                     // キャッシュ。正規参照は authIndex
  createdSource: "salon",            // salon|self|import|line|admin|...
  notifyChannels: { email: true, line: false },

  memo: "敏感肌",                    // スタッフのみ（短い特記事項用・C-4 顧客管理で編集）
  karteNote: "<カルテ全体メモ>",     // ★ カルテ機能用：アレルギー・好み・性格・禁忌など
                                     //   顧客全体に紐づくメモ（来店毎ではない）
                                     //   スタッフのみ・C-9 カルテ画面で編集
  stampCount: 5,                     // スタッフのみ（merge は再計算が正）
  lastVisit: <Timestamp>,
  totalSpent: 84000,                 // スタッフのみ（merge は再計算が正）

  // merge 関連（soft delete）
  isMerged: false,
  mergedInto: null,
  mergedAt: null,
  mergedAliases: [],
  lockedByJob: null,                 // merge 処理中の jobId（排他制御）。
                                     // Function のみ書込・通常 null

  // ★ v6.1 追加（2026/5/25）：claim 不成立時の要統合フラグ
  needsMergeReview: false,           // claim Function が「同一メールの未claimカルテが
                                     // 複数あって自動 claim できなかった」時に
                                     // 候補カルテ全てに true を立てる。
                                     // サロン側 C-4 顧客管理画面で 🚩 として表示し、
                                     // スタッフが統合操作を完了したら false に戻す。
                                     // Function のみ書込・クライアント直接書換は禁止
                                     // （重複検知ロジックの正確性保証のため）

  lineUserId: null,                  // サーバ専用
  createdAt: <serverTimestamp>,
  updatedAt: <serverTimestamp>
}
```

**逆引きインデックス authIndex（速度対策・source of truth）**

```
salons/{salonId}/authIndex/{authUid} {
  customerDocId: "cus_a1b2c3"
}
```
- 顧客アプリは自分の `authUid` → `authIndex/{authUid}` を1回 get →
  `customerDocId` を得て `customers/{customerDocId}` を直 get
  （query 不要・index 不要・速い・安い）
- **`authIndex` が source of truth**。`customers.authUid` は
  キャッシュ（写し）。両者の更新は Cloud Function のみ。
  不一致時は authIndex を正とする

**予約ドキュメントへの影響**：`appointments` の `customerId` を
`customerDocId` に改名。`authUid`（予約者の Auth UID、あれば）と
`customerSnapshot: {name, phone}`（予約時点の顧客情報・不変）を持つ。
merge で customerDocId を付け替えても customerSnapshot は変えない。

**核心原則：顧客は自分のドキュメントを「自由には書けない」**

| カテゴリ | フィールド | 顧客本人 | サロンスタッフ | サーバ(Functions) |
|---|---|---|---|---|
| プロフィール | `name`, `phone` | ✅ | ✅ | ✅ |
| 通知 | `notifyChannels.email/line` | ✅ | ✅ | ✅ |
| サロン管理 | `memo`, `stampCount`, `lastVisit`, `totalSpent` | ❌ | ✅ | ✅ |
| identity | `authUid`, `createdSource` | ❌ | ❌ | ✅(Function) |
| merge | `isMerged`,`mergedInto`,`mergedAt`,`mergedAliases`,`lockedByJob` | ❌ | ❌ | ✅(Function) |
| 要統合フラグ | `needsMergeReview` | ❌ | ❌ | ✅(Function) |
| サーバ管理 | `lineUserId` | ❌ | ❌ | ✅ |
| メタ | `createdAt`, `updatedAt` | ❌ | ❌ | ✅ |

**サロン側顧客登録**：サロンが電話予約客等を登録（`authUid:null`,
`createdSource:"salon"`）。Auth アカウントは作らない。

**claim（顧客アプリ登録時に既存カルテへ紐付け）条件 B**：
顧客アプリ登録で `emailVerified==true` かつ 同一サロンに email 完全一致
する未 claim（authUid==null・isMerged==false）カルテがちょうど1件ある
時のみ、Function がそのカルテに authUid を付与＋authIndex を作成。
不成立なら新カルテ＋サロンに統合候補提示（人間が判断）。
電話番号 claim は本人証明できないため不採用。

**claim 不成立（複数該当）時の運用フロー（v6.1 確定：A方式）**：
同一メールの未 claim カルテが2件以上ある場合、claim Function は：
1. 新カルテを作成（`createdSource:"self"`, `authUid`=自分のuid）→ 顧客はアプリを使い始められる
2. **候補カルテ全て**（自動 claim 不可になった原因の元カルテ）の `needsMergeReview` を true にする
3. サロン側 C-4 顧客管理画面で 🚩 表示 → スタッフが手動で merge 実行 → merge 完了で `needsMergeReview` を false に戻す

詳細は `DESIGN_v8_1_customer_identity.md` 2-5 を参照。

**顧客統合（merge）**：callable Function のみ（クライアント batch 禁止）。
予約の customerDocId を付替（current+archive 両方）、stampCount/
totalSpent は履歴から再計算（単純合算は暫定）、統合元は物理削除せず
soft delete（isMerged/mergedInto/mergedAt）、mergedAliases に旧 ID。
排他制御：開始時トランザクションで src/dst を lockedByJob ロック、
mergeJobs でジョブ状態管理（pending/processing/completed/failed）。
詳細は v8.1 文書 3 章。

Firestoreルールでは `diff().affectedKeys().hasOnly([顧客許可リスト])` で
顧客の書き込みフィールドを制限する（詳細は 3-3）。



```
salons/{salonId}/menus/{menuId} {
  id: "m1",
  name: "フェイシャル",
  duration: 90,
  price: 12000,
  type: "main",                        // main / option
  public: true,                        // true: 顧客の予約画面に表示 / false: サロン内部用
  eligibleStaffIds: ["owner"],         // フェーズ1では常に ['owner']
  requiredResourceIds: ["default"]     // フェーズ1では常に ['default']
}
```

> ★ 2026/5/20 改訂：旧 v6 のメニュー単位 `intervalBefore` / `intervalAfter`
> は廃止。**インターバルはサロン共通設定 `settings.intervalMin` に1本化**
> （いけさん運営判断：「インターバルはAというメニューのためでなく、
> Aの後に続くメニューや予定のためにあるもの」「深夜・早朝・施術中など
> サロン側が管理できないタイミングで予約がピタピタ入らないよう自動付与」）。
> 予約 `end` 計算は `start + 全メニュー duration合計 + settings.intervalMin`。
> 将来「特殊メニューのみ個別インターバル」が必要になったら、その時に
> 上書きフィールドを追加する（YAGNI）。

**サロン共通設定スキーマ（営業時間・インターバル等）**：

```
salons/{salonId}/config/settings {
  openTime: "10:00",          // 開店時刻 HH:MM
  closeTime: "19:00",         // 閉店時刻 HH:MM
  intervalMin: 30,            // 全予約共通の施術後インターバル（分）
                              //   ★ メニュー単位ではなくここで管理
  intervalInClose: false,     // インターバルを閉店時間に含めるか
  slotMin: 30,                // 予約スロット刻み（5/10/15/30 分）
  closedDows: [2],            // 定休曜日 0=日…6=土
  weeklyClose: [],            // 毎週の定期クローズ [{dow,start,end}, ...]
  bookingWeeks: 8,            // 何週間先まで予約可
  lastMin: "same1h",          // 直前予約受付：1week/3days/1day/same3h/same1h/same30m
  deadline: "前日まで"        // 顧客キャンセル受付期限
}
```

**キャンセル規定スキーマ（cancelPolicy）**：

```
salons/{salonId}/config/cancelPolicy {
  text: "<キャンセル規定の本文>",  // 顧客画面に表示する規定文
  rates: [                          // キャンセル料の段階（自由に追加可）
    { label: "3日前から", percent: 30 },
    { label: "前日から",  percent: 50 },
    { label: "当日",      percent: 100 },
    { label: "無断キャンセル", percent: 100 }
  ],
  showOnBook: true,         // 予約時に規定を表示・同意を求める
  showOnCancel: true,       // キャンセル時に規定を表示
  qrUrl: "",                // 決済・振込用QR/リンク（PayPay/Square等）
  qrMsg: "",                // キャンセル料発生時の自動送信メッセージ
                            // 変数: {顧客名}{予約日時}{メニュー}
                            //       {キャンセル料}{QRリンク}
  updatedAt: <serverTimestamp>
}
```

★ キャンセル料は**自動引き落としではない**：規定に該当した場合、
QRコードURLを含むメッセージが顧客に自動送付される（フェーズ1）。
実際の支払いは顧客と店舗の間で行う。

**スタンプカードスキーマ（stampCard）**：

```
salons/{salonId}/config/stampCard {
  enabled: true,            // スタンプカード機能を使うか
  goal: 10,                 // ゴールスタンプ数（3〜50程度）
  reward: "次回施術10%OFF", // ゴール達成時の特典文
  bonusStamps: [            // 途中ボーナス（任意・複数可）
    { at: 5, reward: "オプション1品無料" }
  ],
  color: "#b5845a",         // スタンプカード色（hex）
  expiry: "none",           // 有効期限: '3m'|'6m'|'12m'|'none'
                            //   最初のスタンプ取得日から起算
  updatedAt: <serverTimestamp>
}
```

スタンプの**カウント自体**は顧客カルテの `customers.stampCount`
（サロン管理フィールド）で持つ。この `stampCard` ドキュメントは
「カードの仕様」（ゴール数・特典・色・有効期限）のみを保持する。

**クローズ時間スキーマ（closeBlocks）**：

```
salons/{salonId}/closeBlocks/{closeBlockId} {
  dateKey: "2026-05-24",    // 営業日キー YYYY-MM-DD
  start: "12:00",           // 開始時刻 HH:MM
  end: "13:00",             // 終了時刻 HH:MM（start < end 必須）
  reason: "ランチ休憩",      // 表示用ラベル（任意）
  createdAt: <serverTimestamp>
}
```

クローズ時間は「特定日の一時的な予約ブロック」用。営業時間設定(C-6)の
`weeklyClose` は曜日繰り返しの「毎週の定期クローズ」で別物。
クローズ時間中は顧客アプリの予約受付スロットから除外される
（重複チェックは Functions の責任）。

**メニューの読み取り権限ルール（重要）**：
- `public: true` のメニュー → 認証ユーザーなら誰でも読める（顧客の予約画面で表示するため）
- `public: false` のメニュー → サロンスタッフのみ読める（内部用メニュー、スタッフ研修用、開発中など）
- これにより、顧客アプリは「自分が来店するサロンの公開メニューだけ」見える状態を作る
- Firestoreルールで `public == true || isSalonStaff(salonId)` の条件で制御

#### フェーズ1での見せ方

- スタッフ登録画面：**作らない**（オーナー自身が裏で `staffs/owner` として自動登録される）
- 設備登録画面：**作らない**（裏で `resources/default` が自動作成される）
- シフト管理画面：**作らない**（営業時間 = オーナーのシフトとして扱う）
- メニュー設定画面：「施術可能スタッフ」「必要設備」のUIは**出さない**（自動で `['owner']` と `['default']` をセット）
- 予約画面：「スタッフを選ぶ」「設備を選ぶ」UIは**出さない**（自動で `owner` と `default` に割当）

#### フェーズ2で追加する画面

1. **スタッフ登録画面**：スタッフを追加・編集
2. **設備・スペース登録画面**：ベッドや施術室を追加・編集
3. **シフト管理画面**：誰がいつ出勤するか
4. **メニュー設定画面に追記**：施術可能スタッフ・必要設備を選ぶUI
5. **予約画面に追記**：顧客が「指名」できるUI

これらの画面追加だけで、フェーズ1のDB・コード・既存画面は**一切変えない**で済む。

#### 9つの設計ルール（フェーズ1の実装で必ず守る）

1. **データ構造を3次元予約モデルで固定**
   - 予約には常に `staffId`, `resourceIds`, `editingBy` を含める
   - メニューには常に `eligibleStaffIds`, `requiredResourceIds` を含める
   - フェーズ1では全部 `'owner'` や `['default']` で固定値が入る
   - ★ v8.1: インターバルはメニュー単位ではなく `settings.intervalMin`
     （サロン共通・後から変更可・全予約に自動付与）

2. **権限チェックを「サロン所属スタッフ」で抽象化**
   - Firestoreルールは「`staffs/{request.auth.uid}` が存在するか」で判定
   - フェーズ1では `staffs/owner` 1個だけ。フェーズ2でスタッフ追加してもルール変更不要

3. **DB アクセス層を抽象化**
   - 各画面は直接 Firestore を呼ばず、`shared_db.js` の API 経由で呼ぶ
   - 内部実装を `get()` から `onSnapshot()` に切り替えればリアルタイム化できる

4. **予約可能時間の計算ロジックを「スタッフ×設備の空き」で書く**
   - フェーズ1では `staffId='owner'` と `resourceIds=['default']` が固定だが、計算ロジック自体は3次元
   - フェーズ2でスタッフ・設備が増えても、ロジックは変えない

5. **インターバル（次の予約までの自動確保時間）はサロン共通設定**
   - ★ v8.1: `settings.intervalMin` 1箇所で管理。
     全予約に自動付与され、後から変更可能。
   - 深夜・早朝・施術中などサロン側が管理できないタイミングで
     予約がピタピタ入らないための「自動の余白」

6. **salonId 直書き禁止、必ず `getCurrentSalonId()` 経由（GPT指摘①）**
   - すべての DB アクセスで `salonId` を `getCurrentSalonId()` から取得
   - HTML ファイルに `salonId = 'Ej3Sdlce...'` のような直書きは絶対しない
   - 「ログイン中ユーザーの salonId しか読めない」を Firestoreルールで強制

7. **DB ルールをUIより先に作る（GPT指摘②）**
   - 各 Phase の最初のステップで、まず Firestoreルールを書く
   - ルール書く → テスト用2サロンで分離確認 → そのあとUI実装
   - 順番を逆にしない（UIから作ると、後でルールを当てた時に動かなくなる）

8. **1ファイル巨大化を避ける（GPT指摘③）**
   - 機能ごとにファイル分割：
     - `shared_auth.js` - 認証
     - `shared_db.js` - DB アクセス（読み書き API）
     - `shared_db_reservation.js` - 予約専用ロジック（予約可能時間計算など）
     - `shared_db_menu.js` - メニュー専用ロジック
     - `shared_db_calendar.js` - カレンダー専用ロジック
     - `shared_ui.js` - 共通UI（モーダル、トーストなど）
     - `shared_notify.js` - 通知（メール / LINE）
   - 1ファイル 1000行を超えたら分割を検討
   - HTML ファイル内に JavaScript を巨大に書かない（外部 .js に切り出す）

9. **顧客アプリと管理画面を完全分離（GPT指摘④）**
   - 顧客アプリ（`customer_*.html`）：予約することだけ
   - 管理画面（`salon_*.html`）：店舗運営のすべて
   - 共通の `shared_*.js` は読み込むが、画面 HTML とロジックは完全に分ける
   - 共通ファイルにも「顧客用」「サロン用」の境界を明確化
     - 例：`shared_db.js` 内で `dbCustomer*` / `dbSalon*` の関数命名で分離
   - 混ぜると後で崩壊しやすい（今回の v8 系の失敗もここに起因）

これらを守れば、**フェーズ1の動作には何も影響しない**が、フェーズ2への移行は「画面追加と表示UI解放」だけで済む。

#### 将来の検討事項（実装は据え置き、覚えておく）

**Auth UID = salonId 設計の限界**：
現状の設計では「サロンオーナーの Auth UID = salonId」としているが、これは以下のケースで詰まる：
- サロン譲渡（オーナーが店を売却して別の人がオーナーになる）
- オーナー変更（離婚や独立で代表者が変わる）
- 複数オーナー（共同経営）
- 法人化（個人事業 → 株式会社）

理想は `salons/{自動採番ID}.ownerUid: '<Auth UID>'` の分離設計。
ただし今すぐ変えるとPhase A の実装が複雑化するので**現状は据え置き**。
販売後にこの限界が見えてきたら、マイグレーションスクリプトで自動採番ID方式に切り替える。
今は「販売できる状態に早く到達する」が優先。

**ES5縛りの将来見直し**：
今は iPad + GitHub Web UI の制約で ES5 互換維持。
将来 PC 環境が整ったら、Babel 変換工程（ES2020 → ES5）を導入することも検討。
ただしビルドツール（npm, Webpack/Vite, Babel）を学ぶコストがあるので、それまでは ES5 で書く + 自動 lint チェックで運用。

#### Claude と GPT の役割分担（実装の進め方）

設計書を踏まえた実装フェーズでは、以下の役割分担を活用する：

- **Claude**：画面実装、UIのたたき台、素早いプロトタイプ、既存コードの修正
- **GPT**：設計レビュー、DB設計、セキュリティ、料金体系、仕様の矛盾チェック、将来拡張の地雷探し

実装は Claude が進め、各フェーズ完了時に GPT にレビューしてもらう。両者の指摘が一致したら本番反映する。

#### ES5 自動チェックツール

Phase A で `tools/es5_check.sh` を作成：

```bash
#!/bin/bash
# ES5 違反を検出するスクリプト
echo "=== ES5 互換性チェック ==="
FOUND=0
for FILE in *.html *.js; do
  if grep -nE "\b(const|let)\s|=>\s*[\{\(]|async\s+function|await\s|\?\." "$FILE" > /dev/null 2>&1; then
    echo "❌ $FILE に ES6+ 構文が含まれている可能性:"
    grep -nE "\b(const|let)\s|=>\s*[\{\(]|async\s+function|await\s|\?\." "$FILE"
    FOUND=1
  fi
done
[ $FOUND -eq 0 ] && echo "✅ 全ファイル ES5 互換"
exit $FOUND
```

各 Phase 完了時にこのスクリプトを必ず実行。違反があればその場で `var`/`function` に書き直す。

---

## 1. 絶対に守る前提（販売要件）

### 1-1. マルチサロン完全分離
- サロンAのデータは、サロンAのオーナーとサロンAの顧客しか見れない
- サロンBの顧客が URL を書き換えても、サロンAのデータには絶対アクセスできない
- これはコードのロジックではなく、**Firestore セキュリティルール**で強制する（=サーバー側で拒否する）

### 1-2. ログイン速度
- サロンオーナーのログイン：3秒以内
- 顧客アプリの初回表示：3秒以内
- 「60秒待ち」は販売ライン以下、絶対NG

### 1-3. iPad 編集の罠を回避
- いけさんは iPad + GitHub Web UI で作業
- iPad のスマートクォート自動変換が SyntaxError を起こす
- **対策：コードは必ず ZIP ファイルでやり取りする（コピペ禁止）**

### 1-4. 各サロンが自分のメール送信元を使える
- 今は EmailJS（いけさん個人アカウント）
- 販売後は各サロンが自分のドメイン or 共通の `torita-app.com` から送信
- Cloud Functions + Resend が既に deploy 済み → これを使う

---

## 2. システム構成（販売後の姿）

```
┌─────────────────────────────────────────────┐
│  サロンオーナー（複数）                          │
│  - 各自の Firebase Auth アカウントでログイン      │
│  - 自分のサロンの管理画面のみ操作可能              │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│  顧客(複数 × サロン分)                          │
│  - URL: customer_app.html?salon=<salonId>     │
│  - 自分のメール+認証コードでログイン               │
│  - そのサロンの予約のみ可能                       │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│  Firestore(データベース)                       │
│  salons/                                       │
│    {salonIdA}/                                 │
│      info: { name, email, ownerUid, ... }     │
│      menus/                                    │
│      customers/                                │
│      appointments/                             │
│      closeBlocks/                              │
│      config/ (settings, stampCard, cancelPolicy)│
│    {salonIdB}/  ← サロンAから絶対見えない        │
│      ...                                       │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│  Cloud Functions (asia-northeast1)             │
│  - sendBookingEmail: 予約/変更/キャンセル通知    │
│  - Bearer auth で認証済みユーザーのみ呼び出せる   │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│  Resend (メール配信)                            │
│  - from: noreply@torita-app.com                │
└─────────────────────────────────────────────┘
```

---

## 3. 認証の設計（誰が何にアクセスできるか）

### 3-1. サロンオーナー
- Firebase Auth でメール+パスワード登録
- 登録時、Auth UID = salonId として `salons/{uid}/info` ドキュメントが作られる
- ログイン後、自分の `salonId` 配下のデータを読み書き可能

### 3-2. 顧客
- 顧客の認証は **Firebase Auth のメール+パスワード認証**（オーナーと同じ方式）
- フロー（新規登録）:
  1. 顧客が予約画面で「新規登録」を選ぶ
  2. 名前・メールアドレス・パスワードを入力
  3. Firebase が自動で認証メールを送信（`sendEmailVerification`）
  4. 顧客がメール内のリンクをタップ（=メール所有確認）
  5. リンクタップ後、顧客はログイン画面に戻る
  6. 登録したメールアドレスとパスワードを入力してログイン
  7. Firebase Auth が `emailVerified=true` を確認してログイン許可
- フロー（再ログイン）: メール+パスワード入力のみ
- 顧客にも Firebase Auth UID が発行される
- ★ v8.1 改訂：顧客ドキュメント ID は **Firestore 採番
  （`customerDocId`）**。Auth UID（`authUid`）とは分離。
  顧客アプリは `authIndex/{authUid}` 経由で自分のカルテを解決する
- ★ claim（既存カルテへの紐付け）条件 B：
  顧客アプリ登録で `emailVerified==true` かつ、同一サロンに
  email 完全一致の未 claim（`authUid==null`・`isMerged==false`）
  カルテがちょうど1件ある時のみ、Function がそのカルテに
  `authUid` を付与し `authIndex` を作成（既存カルテに紐付く）。
  不成立なら新カルテ作成（`createdSource:"self"`）＋サロンに
  統合候補を提示（v6.1：`needsMergeReview` フラグで提示）。
  電話番号 claim は本人証明できないため不採用。詳細は
  `DESIGN_v8_1_customer_identity.md` 2 章
- パスワード忘れた時：Firebase 標準の `sendPasswordResetEmail` を使う

### 3-3. Firestore セキュリティルール（最小限の関所）

**設計指針**：Firestoreルールは「**最小限の関所**」とし、複雑なロジックは Cloud Functions が担う。
Rules でやるのは「認証」「フィールド存在」「型」「単純な値域」「読み書きできる人」だけ。
営業時間チェック、重複検知、価格計算、複雑な状態遷移マシンなどは **Rules に書かない**(複雑化すると Phase 2 拡張時に壊れるため)。

「サロンに所属するスタッフ」概念を最初から用意することで、フェーズ1（1人用）でもフェーズ2（複数人用）でもルール構造を書き換えずに済む。
フェーズ1では `salons/{salonId}/staffs/owner` の1ドキュメントだけが存在し、その UID = salonId（オーナー本人）。

```
// ヘルパー関数
function isSignedIn() {
  return request.auth != null;
}
function isSalonStaff(salonId) {
  return isSignedIn() &&
         exists(/databases/$(database)/documents/salons/$(salonId)/staffs/$(request.auth.uid));
}
function isSalonOwner(salonId) {
  return isSignedIn() && request.auth.uid == salonId;
}

match /salons/{salonId} {
  // info: オーナーのみ書き込み、認証ユーザーは読み取り可（顧客アプリ用）
  allow read: if isSignedIn();
  allow write: if isSalonOwner(salonId);
  
  match /staffs/{staffId} {
    allow read: if isSalonOwner(salonId) || request.auth.uid == staffId;
    allow write: if isSalonOwner(salonId);
  }
  
  match /resources/{resourceId} {
    // 認証ユーザーは読み取り可（予約可能時間計算で必要）
    allow read: if isSignedIn();
    allow write: if isSalonOwner(salonId);
  }
  
  match /shifts/{shiftId} {
    allow read: if isSalonStaff(salonId);
    allow write: if isSalonOwner(salonId);
  }
  
  match /menus/{menuId} {
    // 公開メニューは認証ユーザー誰でも読める、非公開メニューはスタッフのみ
    allow read: if isSignedIn() && 
                  (resource.data.public == true || isSalonStaff(salonId));
    allow write: if isSalonStaff(salonId);
  }
  
  match /customers/{customerDocId} {
    // ★ v8.1 改訂：customerDocId は Firestore 採番。本人判定は
    //   resource.data.authUid == request.auth.uid（uid 直比較ではない）

    // 読み取り：サロンスタッフ全員 / 本人（authUid 一致）
    allow read: if isSalonStaff(salonId)
                || (isSignedIn() &&
                    resource.data.authUid == request.auth.uid);

    // 作成：(a) サロンが仮登録（authUid=null 必須） /
    //       (b) 顧客本人がアプリ登録（authUid==自分の uid 必須）
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

    // 更新：顧客本人は name/phone/notifyChannels のみ。
    //   サロンは memo/stampCount 等可。ただし authUid/merge系/
    //   createdSource/lockedByJob/lineUserId/needsMergeReview は
    //   クライアント不可（Function=admin のみ。
    //   source of truth・merge 排他制御・重複検知ロジックの要）
    //   ★ v6.1（2026/5/25）：needsMergeReview を禁止リストに追加
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
                   'lockedByJob','needsMergeReview']) );

    // 削除：物理削除はオーナーのみ（通常運用は soft delete）
    allow delete: if isSalonOwner(salonId);
  }

  // ★ v8.1 新規：逆引きインデックス（source of truth）
  match /authIndex/{authUid} {
    allow read:  if (isSignedIn() && authUid == request.auth.uid)
                 || isSalonStaff(salonId);
    // 作成・更新・削除はクライアント不可。claim/merge は
    // Function(admin) が行う＝source of truth を一元管理
    allow write: if false;
  }

  // ★ v8.1 新規：merge ジョブ（排他制御・進捗管理）
  match /mergeJobs/{jobId} {
    allow read:  if isSalonStaff(salonId);   // UIが進捗表示に使う
    allow write: if false;                   // Function(admin)のみ
  }
  
  match /appointments/{appointmentId} {
    // ★ v8.1 改訂：customerId→customerDocId 改名。
    //   予約本人判定は resource.data.authUid == request.auth.uid

    // 読み取り：サロンのスタッフ or 予約本人（authUid 一致）
    allow read: if isSalonStaff(salonId)
                || (isSignedIn() &&
                    resource.data.authUid == request.auth.uid);

    // 作成：(A) 顧客アプリ予約 / (B) サロン手動登録 の2経路
    //   ★ v8.1：customerDocId 必須。authUid は
    //     (A) 顧客アプリ予約 = 予約者の Auth UID
    //     (B) サロン手動登録 = 対象がサロン仮登録カルテなら null 可
    //   end/staffId/priceSnapshot/customerSnapshot/createdAt/status
    //   はサーバ確定（顧客経路）
    allow create: if
      // ── (A) 顧客アプリ予約（pendingCreate=true）──
      ( isSignedIn() &&
        request.resource.data.authUid == request.auth.uid &&
        request.resource.data.keys().hasOnly([
          'dateKey', 'start', 'customerDocId', 'authUid',
          'menuId', 'optionMenuIds', 'pendingCreate', 'source',
          'createdAt'
        ]) &&
        request.resource.data.keys().hasAll([
          'dateKey', 'start', 'customerDocId',
          'authUid', 'menuId', 'pendingCreate'
        ]) &&
        request.resource.data.pendingCreate == true &&
        request.resource.data.dateKey is string &&
        request.resource.data.dateKey.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}$') &&
        request.resource.data.start.matches('^[0-9]{2}:[0-9]{2}$') &&
        request.resource.data.menuId is string )
      ||
      // ── (B) サロン手動登録（電話・店頭予約。最初から confirmed）──
      //   対象顧客がサロン仮登録カルテ（authUid=null）の場合、
      //   この予約の authUid も null。後でその顧客がアプリ登録
      //   （claim）した時、claim Function が「その customerDocId を
      //   参照する過去予約の authUid を後埋めする」責務を負う
      //   （DESIGN_v8_1 2章 claim Function に明記）。
      ( isSalonStaff(salonId) &&
        request.resource.data.customerDocId is string &&
        request.resource.data.source == 'manual' &&
        request.resource.data.status == 'confirmed' &&
        request.resource.data.dateKey is string &&
        request.resource.data.dateKey.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}$') &&
        request.resource.data.start is string &&
        request.resource.data.start.matches('^[0-9]{2}:[0-9]{2}$') &&
        request.resource.data.menuId is string );

    // 更新：顧客は status を cancelled に変えるだけ。
    //   サロンスタッフは customerDocId / source 付替を禁止
    //   （merge は Function=admin のみ）。状態遷移は Functions が検証
    allow update: if (
      (isSignedIn() &&
       resource.data.authUid == request.auth.uid &&
       resource.data.status == 'confirmed' &&
       request.resource.data.status == 'cancelled' &&
       request.resource.data.diff(resource.data).affectedKeys()
         .hasOnly(['status', 'updatedAt']))
      ||
      (isSalonStaff(salonId) &&
       request.resource.data.customerDocId == resource.data.customerDocId &&
       request.resource.data.source == resource.data.source)
    );

    allow delete: if isSalonOwner(salonId);
  }

  // appointments_archive（作成・更新・削除は Functions のみ）
  match /appointments_archive/{appointmentId} {
    allow read: if isSalonStaff(salonId)
                || (isSignedIn() &&
                    resource.data.authUid == request.auth.uid);
    allow write: if false;
  }
}
```

**Rules で「やらない」こと（=Functions が責任を持つ）**：
- 営業時間内かどうかの判定
- 他予約との重複チェック
- メニューの所要時間と end の整合性
- 価格計算（`priceSnapshot`）
- 詳細な status 遷移ルール（`no_show`、`completed`、`refunded` の許可判定）
- スタッフ・設備の同時利用チェック
- インターバル時間の確保

これらを Rules に詰め込むと、Phase 2 でフィールド追加した時に予想外に通る/落ちる問題が起きる。Rules はあくまで「悪意ある書き込みを最低限ブロックする関所」にとどめる。


### 3-4. 予約作成の防御フロー（pendingCreate 方式）

**問題**：`onAppointmentCreate` トリガーで「作成後に検証→NGなら削除」だと、一瞬だけ不正予約が存在する。通知が誤送信される、UIに一瞬表示される、などの事故が起きうる。

**対策（フェーズ1）**：
顧客が直接書き込めるのは `pendingCreate: true` フラグ付きの予約ドキュメントのみ。
このフラグが付いている予約は「**まだ確定していない予約**」として扱う。
Cloud Functions onCreate トリガーが検証して、OK なら `pendingCreate` を削除して `status: 'confirmed'` 等を確定する。NG なら予約自体を削除。

```
顧客が予約画面で確定ボタン
  ↓
[UI検証] shared_db_reservation.js でフロント検証
  ↓
[書き込み] appointments/{id} に { dateKey, start, menuId, ..., pendingCreate: true } を書き込み
  ↓
[Firestoreルール] フィールドホワイトリスト、形式チェック
  ↓
書き込み成功（pendingCreate=true なので「未確定」扱い）
  ↓
[Cloud Functions onCreate] サーバ側で全検証
  - 営業時間内か
  - 過去日でないか  
  - 他予約と衝突しないか
  - スタッフ・設備が確保できるか
  - メニューが存在するか
  ↓
OK の場合:
  - end, startAt, endAt, staffId, resourceIds を確定
  - priceSnapshot を menus から計算してセット
  - status を 'confirmed' に
  - pendingCreate フィールドを削除
  - 通知メール送信
NG の場合:
  - 予約ドキュメントを削除
  - notificationLogs にエラー記録
  - 顧客に「予約失敗」を返す
```

**UI 側の表示ルール**：
- カレンダー・予約一覧・通知は `pendingCreate: true` の予約を **表示しない**
- これにより「一瞬だけ不正予約が見える」事故を回避

**Firestoreルールでも `pendingCreate: true` の予約は読めない人を制限**：
- 顧客本人（書いた本人）と Functions のみ読める
- スタッフのカレンダーには表示されない

**将来移行（販売後のセキュリティ強化）**：
- 顧客が `appointments` に直接書き込むのを **完全に禁止**
- 予約作成は Cloud Functions の **callable Function** 経由のみ
  - `createAppointment({dateKey, start, menuId, optionMenuIds})` を呼ぶ
  - Functions 内で全検証 → Firestore に書き込み → 結果を返す
- これにより「Firestore に直接書き込む経路」が消える = 最も安全
- Phase G（販売準備）の前後で段階的に移行

**Phase 2 以降の検討**：
- 楽観ロック（バージョン番号 or `updatedAt` チェック）
- 競合予約防止（同じ時間枠を別の顧客が同時に押した場合の処理）



---

## 4. 速度設計（3秒以内）

### 4-1. ログイン時の処理
**現状（NG）**: 8コレクションをシリアル取得 → 合計60秒

**新設計**: 
- ログイン後、必要最小限のデータだけ取得（例：サロン名、settings）
- 各画面に遷移したタイミングで、その画面に必要なデータのみ取得
- カレンダー画面なら appointments + closeBlocks、メニュー設定画面なら menus、など
- すべて並列取得（Promise.all 相当）

### 4-2. 顧客アプリの初回表示
**現状（NG）**: ログイン前に loadAllData で全部読み込み

**新設計**:
- 起動時：settings + menus + cancelPolicy のみ（メニュー選択画面に必要なもの）→ 並列で1〜2秒
- 日時選択画面に進む時：appointments + closeBlocks を追加取得
- 顧客ログイン時：その顧客のデータのみ
- 全部並列、シリアル禁止

### 4-3. キャッシュ戦略
- 一度取得したデータはセッション中はメモリに保持
- 「最新を見たい」時だけ強制再取得（ボタンで明示）
- **リアルタイム同期（`onSnapshot`）は製品フェーズ2（複数人版）で導入**
- ただし shared_db.js の API 設計は `onSnapshot` への差し替えを見越して抽象化しておく（セクション0-2の指針に従う）

---

## 5. コード構造の設計（保守しやすさ）

### 5-1. ファイル構成（販売版）
```
shared_db.js      ← Firestore アクセス層。グローバル関数の数を最小化
shared_auth.js    ← 認証層（サロンオーナー用 + 顧客匿名認証）
shared_ui.js      ← 共通UI（モーダル、トースト、エラー表示）

salon_*.html      ← サロン管理画面（既存維持）
customer_app_v8.html ← 顧客アプリ（既存維持、ただし冒頭スクリプトを整理）

functions/index.js ← Cloud Functions（既存維持）
```

### 5-2. salonId 取得の単一ルール
- **`shared_db.js` だけが `getCurrentSalonId()` を定義する**
- どの HTML ファイルもこの関数を上書きしない
- URL パラメータ `?salon=xxx` は `shared_db.js` が冒頭で自動取得
- サロン管理画面は Auth UID を salonId として使う（`shared_db.js` 内で吸収）

### 5-3. データ取得 API の統一
- 各画面が必要なデータをまとめて取得できる API を `shared_db.js` に用意
  - `dbLoadForCustomerHome(cb)` → 顧客アプリのホーム画面用
  - `dbLoadForSalonCalendar(cb)` → サロンカレンダー用
  - `dbLoadForMenuSettings(cb)` → メニュー設定用
- 中で並列取得し、すべて揃ったら一度だけコールバック
- これで「画面ごとに必要なものだけ、並列で、速く」が実現

### 5-4. ES5 互換維持
- いけさんの環境が iPad の古い Safari なので ES5 互換
- `var`, `function`, `Promise.then` のみ。`const`/`let`/アロー関数禁止
- これは設計書に明記して守る

### 5-5. iPad 編集事故防止
- 全ファイルは ZIP で受け渡し（コピペ禁止）
- GitHub への上書きアップロードのみ
- スマートクォート混入の自動チェックを定期的に実施

---

## 6. 通知の設計（メール + LINE）

予約・変更・キャンセル時の顧客への通知は、**メール**と**LINE**の両方をサポートする。顧客が登録時にどちらか（または両方）を選べる。

### 6-1. メール送信の現状と移行

**現状**: EmailJS（いけさん個人アカウント）で送信中。他サロンに販売したら、いけさんのEmailJS残量が他サロンに食われる → NG。

**販売版**:
- Cloud Functions `sendBookingEmail` を使用（既に deploy 済み）
- 送信元：`noreply@torita-app.com`（共通）
- 送信元の表示名：各サロンの名前（"Salon de Miro <noreply@torita-app.com>"）
- 顧客は Firebase Auth → Bearer トークン → Functions 呼び出し → Resend → 配信

**移行ステップ**:
1. 顧客アプリで Functions fetch を実装、EmailJS と並走（旧 v8 系で着手済み、v2 系で正式実装）
2. 数日 Functions の安定確認
3. EmailJS の呼び出しを削除
4. EmailJS アカウント解約

### 6-2. LINE 連携（将来追加、設計だけ最初から組み込む）

販売前提として、サロン顧客は **メールよりLINEを使う人が多い**。LINE通知を提供できることは販売上の大きな強みになる。

**実装は後（PC環境が整ってから）だが、設計は最初から組み込む。**

#### 6-2-1. LINE連携の方式（LINE Messaging API + 公式アカウント）

- 各サロンが自分の LINE 公式アカウントを作成（または TORITA 共通の公式アカウントを使う、後述）
- 顧客は LINE で公式アカウントを友だち追加 → LINE User ID が TORITA に登録される
- 予約・変更・キャンセル時に、サロンの公式アカウント名で顧客の LINE にメッセージが届く

**2つのモデル**:

**モデルA: 各サロンが自分の LINE 公式アカウントを持つ（販売プランの上位プラン向け）**
- 各サロンが LINE Developers で公式アカウント作成 + Messaging API 設定
- TORITA に LINE Channel Access Token を登録
- メッセージはそのサロンの公式アカウント名で届く
- ブランディング◎、設定がやや複雑

**モデルB: TORITA 共通の公式アカウント1つを使う（販売プランの下位プラン向け）**
- TORITA が「TORITA予約」のような公式アカウントを運営
- 全サロンの顧客がこの公式アカウントを友だち追加
- メッセージは「【Salon de Miro】予約のご確認」のようにサロン名をテキストに含める
- 設定が簡単、サロンごとの LINE 設定不要
- 顧客から見ると複数サロン使う時に1つの公式アカウントで済む（メリット）

販売開始時は **モデルB から始める**のが現実的（サロン側の設定負担ゼロ）。
将来モデルAも選択肢として追加する。

#### 6-2-2. 顧客の通知設定

顧客ドキュメントに通知チャネル設定を持つ：

```
customers/{customerDocId} {
  ...
  notifyChannels: {
    email: true,           // メール通知ON
    line: false,           // LINE通知ON
    lineUserId: null       // LINE User ID（友だち追加時に取得）
  }
}
```

顧客はマイページで「メール通知ON/OFF」「LINE通知ON/OFF」を切り替えられる。

#### 6-2-3. 通知送信の共通API

`shared_notify.js` に統一APIを用意し、メールと LINE の違いを吸収する：

```javascript
// 予約完了通知を送る（顧客の設定に応じてメール・LINE両方 or 片方）
sendBookingNotification(customerDocId, appointment, cb);

// キャンセル通知
sendCancelNotification(customerDocId, appointment, cb);

// 変更通知
sendChangeNotification(customerDocId, oldAppointment, newAppointment, cb);
```

各画面はこれを呼ぶだけ。内部で顧客の `notifyChannels` を見て、メールなら Functions、LINE なら別の Functions（後述）に振り分ける。

#### 6-2-4. LINE 用の Cloud Function

メール送信と同じ構造で、LINE 用の Function を追加する：

- `sendBookingLine` Function を作成（`asia-northeast1`）
- 環境変数に LINE Channel Access Token を Secret として登録
- Bearer auth + CORS（メール送信と同じ）
- 引数：`lineUserId`, `salonName`, `messageType`, `data...`
- LINE Messaging API の push message を呼ぶ

#### 6-2-5. 友だち追加フロー（顧客が LINE通知を有効にする）

1. 顧客がマイページで「LINE通知ON」をタップ
2. TORITA が QR コード or 友だち追加リンクを表示
3. 顧客が公式アカウントを友だち追加
4. LINE Webhook（Functions）が `follow` イベントを受信
5. Webhook が顧客に「ご登録ありがとうございます。メールアドレスを入力してください」と返答
6. 顧客がメールアドレスを入力
7. Webhook が `customers` から該当顧客を探して、`lineUserId` を保存

これで友だち追加と顧客紐付けが完了する。

#### 6-2-6. フェーズ1での扱い

- `customers/{customerDocId}` に `notifyChannels` フィールドを**最初から持たせる**（デフォルト `email: true, line: false`）
- 顧客マイページに「LINE通知」のチェックボックスを**置かない**（フェーズ1では表示しない）
- `shared_notify.js` の `sendBookingNotification` は実装するが、内部では LINE 分岐をスキップしてメールだけ送る
- LINE Function はまだ作らない

これにより、PC環境が整って LINE 実装する時には、**画面UIに「LINE通知」を表示する**ことと **LINE Function を作る**だけで、既存コードを変えずに済む。

### 6-3. 通知の信頼性

- Cloud Functions が失敗した場合、Firestore の `notificationLogs/{logId}` にエラーを記録
- 管理画面で「通知失敗」が見える
- 顧客に「メールが届かない」と言われた時に、ログから原因特定可能

---

## 7. 実装フェーズ（ゼロから作り直し）

**前提**：このアプリはまだ実運用していない。既存のコード資産（HTML/JS）は **参考として残すが、新規実装は別ファイル名で1から書く**。Firestore の既存データ（テスト用サロン、テスト顧客）は **全削除して空から始める**。
これにより、移行処理や互換性維持の複雑さがゼロになり、最初から販売できる完璧な設計を作れる。

### Phase A：基盤ファイル新規作成

**Phase A は2ステップ構成**：
- A-step1：**Firestoreセキュリティルールを先に書く**（GPT指摘②）
- A-step2：そのルール下で動く基盤 JS ファイルを実装

#### A-step1：Firestoreセキュリティルール＋インデックス＋サーバ側関数（最初に作る）
- A-step1-1. 本設計書 3-3 のルールを Firebase 公式記法で書き起こす
  - フィールドホワイトリスト、status 遷移、フィールドレベル検証を全部入れる
- A-step1-2. **Firestore 複合インデックスを最初に作成**（B-7 参照）
  - `(date)`、`(staffId, date)`、`(customerAuthUid, date desc)`、`(status, date)`
  - 後付けはトラブルが起きやすいので先に
- A-step1-3. **Cloud Functions `onAppointmentCreate` トリガーを作成**
  - 予約作成時に自動実行
  - サーバ側で全検証（営業時間、過去日、重複、メニュー整合性）
  - `priceSnapshot` を `menus/{menuId}.price + sum(optionMenuIds.price)` で確定
  - 検証 NG なら予約を即削除 + サロンに通知メール + `notificationLogs` に記録
- A-step1-4. テスト用サロン2つ（A, B）を作って、以下を確認：
  - AからBが見えないこと
  - 顧客が `price`, `priceSnapshot`, `status` を改ざんできないこと（Firestoreコンソールから直接書き込みテスト）
  - 顧客が `customerAuthUid` を偽装できないこと
  - 顧客が `status` を `cancelled` 以外に変えられないこと
  - ★ v8.1 identity 関連（`DESIGN_v8_1_customer_identity.md` 6章）：
    - サロンAがサロンBの customers/authIndex/mergeJobs に読み書き → 拒否
    - サロンが作成カルテに `authUid` を入れて作成 → 拒否
      （createdSource:'salon' は authUid=null 必須）
    - 顧客本人が他人の authUid でカルテ作成 → 拒否
    - クライアントから customers の `authUid`/`isMerged`/`mergedInto`/
      `mergedAliases`/`createdSource`/`lockedByJob` を直接書換 → 拒否
    - ★ v6.1（2026/5/25）追加：クライアントから customers の
      `needsMergeReview` を直接書換 → 拒否
      （Function 専用。重複検知ロジックの正確性保証のため）
    - クライアントから authIndex を作成・更新・削除 → 全て拒否
    - クライアントから予約の `customerDocId` を付替 → 拒否
    - emailVerified=false の顧客が claim 発動を試みる → claim されない
    - 同一メール未claimカルテ2件時、自動claimされず要統合フラグ
      （`needsMergeReview=true` が候補全件に立つこと）
    - 同一カルテを src/dst に含む merge を2件同時実行 → 2件目は
      ロック取得失敗で弾かれDB破壊しない
- A-step1-5. このルール＋関数を先に本番反映してから、JSの実装に入る
- これにより「動いてるけどルール緩い」状態を防ぐ

#### A-step2：基盤 JS ファイル作成（GPT指摘③：1ファイル巨大化禁止）
- A-1. `shared_db.js` を新規作成（DB アクセス層、関数200個まで）
  - `getCurrentSalonId()` の単一定義
  - 「URLパラメータ ?salon → Auth UID → null」の優先順位
  - 旧 localStorage 機能・固定ID完全廃止
  - 全 HTML ファイルが上書きしないルールを徹底
  - 各データの基本 CRUD：`dbGetMenus`, `dbAddMenu`, `dbGetAppointments`, ...
  - 内部実装を `get()` から `onSnapshot()` に切り替えられる抽象化
  - 顧客用 / サロン用 の関数命名で分離（`dbCustomer*` / `dbSalon*`）

- A-2. `shared_db_reservation.js` を新規作成（予約専用ロジック）
  - 予約可能時間の3次元計算（時間×スタッフ×設備）
  - 予約の重複チェック
  - インターバル計算
  - 予約 CRUD の上位ラッパー（バリデーション込み）

- A-3. `shared_db_menu.js` を新規作成（メニュー専用ロジック）
  - メニュー CRUD
  - メニューの並べ替え、公開/非公開切り替え

- A-4. `shared_db_calendar.js` を新規作成（カレンダー専用ロジック）
  - 月別予約取得、closeBlocks 取得
  - 営業時間と組み合わせた表示用データ生成

- A-5. `shared_auth.js` を新規作成（認証）
  - サロンオーナー認証（メール+パスワード+メール確認）
  - 顧客認証（同じくメール+パスワード+メール確認）
  - `requireSalonStaff` / `requireCustomerAuth` ヘルパー
  - **オーナー登録時、`salons/{uid}/staffs/owner` ドキュメントを自動作成**

- A-6. `shared_ui.js` を新規作成（共通UI）
  - 共通モーダル、トースト、エラー表示、ローディング表示
  - 全画面で同じ見た目になる

- A-7. `shared_notify.js` を新規作成（通知）
  - `sendBookingNotification`, `sendCancelNotification`, `sendChangeNotification`
  - 内部でメール / LINE を顧客設定に応じて振り分け
  - フェーズ1ではメールのみ（LINE分岐はスケルトンだけ）

- A-8. **データ構造の初期化スクリプト**
  - サロン新規登録時、以下を一括作成：
    - `salons/{uid}/info` （サロン基本情報）
    - `salons/{uid}/staffs/owner` （オーナー自身を単一スタッフとして）
    - `salons/{uid}/resources/default` （デフォルト設備1個）
    - `salons/{uid}/config/settings` （営業時間など）
    - `salons/{uid}/config/cancelPolicy`
    - `salons/{uid}/config/stampCard`
  - 予約ドキュメントには `staffId: 'owner'`, `resourceIds: ['default']`, `editingBy: null` を最初から含める
  - メニュー作成時は `eligibleStaffIds: ['owner']`, `requiredResourceIds: ['default']` を自動付与（★ v8.1: メニュー単位の interval は廃止。`settings.intervalMin` に1本化）
  - 顧客作成時は `notifyChannels: {email: true, line: false, lineUserId: null}` および `needsMergeReview: false` を最初から含める

### Phase B：速度設計＋3次元予約計算ロジック＋Firestoreコスト最適化
- B-1. `shared_db.js` に画面別の並列取得 API を実装
  - `dbLoadSalonDashboard(cb)` → サロンのトップ画面
  - `dbLoadSalonCalendar(weekStartKey, cb)` → カレンダー画面（**指定週の appointments + closeBlocks のみ**）
    ★ 2026/5/22 改訂：週ビュー化により月単位 → 週単位（7日分）取得に変更。
      旧仕様は `dbLoadSalonCalendar(monthStr, cb)` で月単位だったが、
      C-3 のUI を「7日×時間軸の週グリッド」に作り替えたため、
      取得範囲もそれに合わせて削減。月内の予約件数だけ確認したい場合は
      別途 `dbLoadSalonMonthCounts(monthStr, cb)` を用意（後述）。
  - `dbLoadSalonCustomers(cb)` → 顧客管理画面
  - `dbLoadSalonMenus(cb)` → メニュー設定（menus + staffs + resources）
  - `dbLoadSalonSettings(cb)` → 営業時間など
  - `dbLoadCustomerHome(cb)` → 顧客アプリ初期表示
  - `dbLoadCustomerBooking(dateStr, cb)` → 予約日時選択用（**指定日の appointments のみ**）
  - `dbLoadCustomerHistory(cb)` → 顧客の予約履歴（current + archive 両方）
- B-2. 各 API は内部で並列取得（Promise.all 相当のコールバック合成）
- B-3. 必要最小限のフィールドだけ取得（無駄なデータを引かない）
- B-4. ログイン時は **最小限のサロン情報だけ**取得、画面遷移時に追加取得
- B-5. **予約可能時間の計算ロジックを 3次元（時間×スタッフ×設備）で実装**
  - 入力：メニューID、日付、現在の予約一覧、スタッフ一覧、設備一覧、シフト
  - 出力：予約可能な時間枠リスト
  - ロジック：
    1. メニューの `eligibleStaffIds` から候補スタッフを抽出
    2. メニューの `requiredResourceIds` から必要設備を抽出
    3. 各時間枠について：
       - 候補スタッフのうち、その時間に予約が入っていないスタッフがいるか
       - 必要設備のうち、その時間に予約が入っていない設備が確保できるか
       - スタッフのシフト内か
       - インターバル時間も加味
    4. 両方OKな時間枠だけ返す
  - フェーズ1では候補スタッフ=`['owner']`、必要設備=`['default']` だが、ロジックは3次元のまま動く

- B-6. **Firestore クエリ絞り込みでコスト最適化**
  - カレンダー：`where('dateKey', '>=', weekStart).where('dateKey', '<=', weekEnd)` で1週間分のみ取得（★ v8.1: 週ビュー化により月単位→週単位に短縮）
  - 予約画面：`where('dateKey', '==', selectedDate)` でその日だけ取得
  - 顧客履歴：`where('authUid', '==', myUid).orderBy('dateKey', 'desc').limit(20)` で最近20件
  - 全件取得は禁止（`appointments` を `get()` で全取得しない）

- B-7. **Firestore 複合インデックス設計（Phase A-step1 で作成）**
  - `(dateKey)` 単一インデックス：カレンダー用（自動）
  - `(staffId, dateKey)` 複合：将来スタッフ別カレンダー用
  - `(authUid, dateKey desc)` 複合：顧客本人の履歴用
  - `(customerDocId, dateKey desc)` 複合：**サロン側カルテ画面の顧客履歴用**
    ★ 2026/5/24 追記：本番運用で「カルテに来店履歴が出ない」事故が発生。
      原因はこの複合インデックスが未作成だったため。
      暫定対応：shared_db.js dbSalonGetCustomerHistory の orderBy を外し、
      クライアントソートに変更（インデックス不要にした）。
      販売前に必ず復活させ、(customerDocId Asc, dateKey Desc) の複合
      インデックスを appointments / appointments_archive 両方の
      サブコレクションに明示作成すること。
  - `(status, dateKey)` 複合：「未完了予約のみ」絞り込み用
  - 後付けは順序が不安定になるので、最初にまとめて作る

- B-8. **アーカイブ戦略（appointments の肥大化対策）**
  - `appointments`（current）：直近6ヶ月以内の予約
  - `appointments_archive`：6ヶ月以上前の予約
  - Cloud Functions Scheduler で月次バッチ実行（毎月1日 03:00）：
    - 6ヶ月超過した予約を `appointments` → `appointments_archive` に移動
    - サロンごとに `appointments_archive_summary` も生成（年月別の予約件数・売上集計）
  - **顧客履歴 / 顧客詳細画面**は `appointments`（current）と `appointments_archive` の両方を読みに行く（`dbLoadCustomerHistory` 内で統合）
  - **カレンダー / 予約画面 / ダッシュボード**は `appointments`（current）のみ読む
  - Phase A-step1 で `appointments_archive` のFirestoreルールも書く（current と同じ権限ルール）

### Phase C：サロン管理画面の作り直し（v2）
- C-1. `salon_auth_v2_new.html` 新規登録/ログイン画面
- C-2. `salon_dashboard_v1.html` ダッシュボード（新規追加）
- C-3. `salon_calendar_v8.html` カレンダー
       ★ 2026/5/22 大改修：週ビュー型に作り直し（旧版v7踏襲）
         旧版の月グリッド+日詳細リスト方式から、縦軸=時間・横軸=曜日7日の
         週タイムラインに変更。理由：インターバル時間や時間配分の視認性が
         圧倒的に向上し、1人サロンの日々の運営に最適化される。
         構成：
         - 上部：◀ 今日+6日先 ▶ の週移動 + 表示範囲（例: 5/23〜5/29）
           ★ 2026/5/23 改訂：日曜始まりではなく「今日始まりローリング」を採用。
             起動時は本日〜+6日先を表示。「次へ」で表示中の最終日翌日から7日進む。
             「前へ」で表示中の開始日から7日前。
             「今日」ボタンで本日始まり7日に戻す。
             理由：1人サロンは「今日から先」を見ることが運営の中心。
                   過去予約は C-9 カルテで顧客別履歴を参照する。
         - 中段：[+予約][+クローズ]ボタン
         - メイン：7列×時間軸グリッド
           * 列：日〜土
           * 行：settings.openTime〜closeTime を 1時間刻みで表示
             （settings 未設定時は 9:00〜21:00 をフォールバック）
           * 定休日列：weeklyClose の曜日は灰色表示+「定休日」ラベル
           * 予約ブロック：top/height を分単位 px 計算で配置
           * インターバルブロック：予約直後に settings.intervalMin 分の
             半透明帯（「準備 XX分」）
           * クローズブロック：別色（赤系）+ 「クローズ」+ 理由表示
         - 予約タップ：詳細モーダル（顧客名/メニュー/料金/メモ
           + [カルテへ][編集][キャンセル] ボタン）
         - クローズタップ：削除確認モーダル
         ★ 2026/5/23 追加：手動予約・クローズ登録時の重複チェック仕様
           クライアント側で以下をチェックし、衝突があればエラーで登録不可：
           1. 既存予約との時間重複（同じ日・時間帯が1分でも被ったらNG）
              - 予約 vs 予約：完全な禁止（同時施術不可）
              - 予約 vs インターバル：予約の前後 settings.intervalMin 分も
                予約不可（準備時間確保）
              - クローズ vs 予約：クローズ時間中に予約 / 予約中にクローズ
                どちらも禁止
              - クローズ vs クローズ：完全な禁止
           2. 定休日チェック
              - settings.weeklyClose の曜日と被る日付に予約/クローズを
                登録しようとしたら禁止
              - 「定休日には予約できません」エラー
           3. 営業時間外チェック
              - 予約終了時刻が settings.closeTime を超える場合は禁止
              - 予約開始時刻が settings.openTime より前は禁止
           ※ 重複チェックの完全な競合制御は Cloud Functions の
             トランザクションが理想だが、フェーズ1ではサロンオーナー1人
             運用なのでクライアント側チェックで実質十分。
             Phase D 以降で顧客アプリ予約が増えたら Function 側にも
             同等のチェックを実装する。
- C-4. `salon_customers_v1.html` 顧客管理
       ★ v6.1（2026/5/25）追加：claim 不成立カルテの 🚩 表示
         `needsMergeReview == true` のカルテに🚩マークを表示し、
         一覧で「要統合」フィルタで絞り込み可能にする。
         スタッフが merge 操作を実行すると、merge Function 内で
         `needsMergeReview` を false に戻す（候補全件）。
- C-5. `salon_menus_v1.html` メニュー設定
- C-6. `salon_hours_v1.html` 営業時間
- C-7. `salon_cancel_v1.html` キャンセル規定
- C-8. `salon_stamp_v1.html` スタンプ設定
- C-9. `salon_karte_v1.html` 顧客メモ（カルテ・施術履歴）
       ★ 2026/5/21 追加：顧客管理(C-4)から「カルテを開く」、
         ダッシュボードからも独立カードで入れる（C案：両方の入口+互いにリンク）
         機能：顧客選択 → 来店履歴 / 各回の支払い・訪問メモ・写真（最大3枚） /
              全体メモ(karteNote) / 統計(来店回数・累計・平均)
       ★ 2026/5/23 改訂：「自動 visited 判定」+ 「今後の予約」セクション分離
         予約の分類ルール（status と endAt から計算）:
           A. 「今後の予約」セクション
              - status = 'confirmed' かつ endAt >= 今 (未来予約)
              - 統計の対象外（来店していないため）
           B. 「来店履歴」セクション
              - status = 'confirmed' かつ endAt < 今 (過去の confirmed = 自動visited)
              - status = 'visited' (例外手動変更で visited 化されたもの)
              - 統計（来店回数・累計支払い・平均単価）の対象
           C. 表示しない
              - status = 'cancelled' (キャンセル)
              - status = 'no_show' (無断キャンセル)
              - status = 'pendingCreate' (作成中)
         例外手動変更：
           - C-3 予約詳細モーダルから「無断キャンセル」「来店済みに変更」
             「予定に戻す」を選べる（dbSalonUpdateAppointmentStatus 関数）
- 全画面が `shared_db.js` / `shared_db_*.js` / `shared_auth.js` / `shared_ui.js` を読み込む
- 各画面が独立して必要なデータだけ取得する
- HTML ファイル内の JavaScript は最小限（イベントハンドラと画面固有のロジックだけ）、複雑な処理は `shared_*.js` に切り出す

### Phase D：顧客アプリの作り直し（v2）
- D-1. `customer_app.html` を新規作成（v8 とは別ファイル名）
- D-2. 起動時：URL `?salon=xxx` を読み込み、サロン名と settings だけ取得（瞬時表示）
- D-3. メニュー選択画面：menus 取得（このタイミングで初）
- D-4. ログイン/新規登録：Firebase メール+パスワード+メール確認
- D-5. 日時選択画面：appointments + closeBlocks（このタイミングで初）
- D-6. 予約確定：appointment 追加 + `shared_notify.js` 経由で通知送信
- D-7. 履歴画面：自分の予約のみ取得（Firestoreルールで保証）
- D-8. 顧客マイページ：プロフィール表示・パスワード変更・LINE通知設定（フェーズ1では LINE 部分は非表示）
- 管理画面 HTML とロジックを完全分離（GPT指摘④）

★ Phase D 着手前の事前タスク（claim Function 基盤）：
  Phase D は claim Function なしでは shared_db.js の dbCustomer* も
  customer_app.html も書けない（顧客の identity 解決が claim Function
  の責務）。以下を D-1 より前に実施する：

  - D-step1. **claim Function `resolveOrClaimCustomer` 実装**
    （functions/index.js への追加）
    - 入力：認証コンテキスト（uid, email, emailVerified）, salonId,
            初期プロフィール（name, phone）
    - 処理：
      1. emailVerified==true 必須（false なら拒否してエラー返却）
      2. authIndex/{authUid} 存在確認 → 既存なら customerDocId 返却（冪等）
      3. 同一サロン内で email 完全一致のカルテ検索
         （WHERE email == myEmail）
      4. 該当カルテを authUid==null かつ isMerged==false でフィルタ
      5. 件数判定：
         - 1件 → claim 成立：
           * トランザクションでカルテに authUid 付与 + authIndex 作成
           * そのカルテ参照の appointments/appointments_archive で
             authUid==null のものに authUid 後埋め（分割バッチ）
           * 返却：{result:"claimed", customerDocId, claimedAppointmentCount}
         - 0件 → 新カルテ作成：
           * customers 自動採番で作成（authUid=自分のuid,
             createdSource:"self", needsMergeReview:false, ...）
           * authIndex 作成
           * 返却：{result:"created_new", customerDocId}
         - 2件以上 → claim 不成立・要統合（v6.1 A方式）：
           * 新カルテ作成（上記と同じ）
           * 候補カルテ全件の needsMergeReview を true に更新
             （トランザクション内で）
           * 返却：{result:"needs_merge_review", customerDocId,
                   candidateCount:N}
    - 必須要件：
      * トランザクション（authIndex作成と customers.authUid 付与の不可分性）
      * 冪等性（同じユーザーが2回呼んでも安全）
      * 過去予約 authUid 後埋め（v8.1 2-4）
      * emailVerified=false 拒否（v8.1 A-step1-4 テスト項目）

  - D-step2. **A-step1-4 identity 関連テストの先行実施**
    claim Function を作った直後、v8.1 文書 6章の identity 関連テスト
    だけ先に実施（残りの A-step1-4 は Phase F で）：
    - サロンA→サロンB の customers/authIndex/mergeJobs 読み書き → 拒否
    - サロンが authUid 入りでカルテ作成 → 拒否
    - 顧客本人が他人 authUid でカルテ作成 → 拒否
    - クライアントから authUid/merge系/createdSource/lockedByJob/
      needsMergeReview を直接書換 → 拒否
    - クライアントから authIndex 書込 → 拒否
    - emailVerified=false の顧客が claim 発動 → claim されない
    - 同一メール未claimカルテ2件時、自動claimされず needsMergeReview
      が候補全件に立つこと

  - D-step3. **shared_db.js の dbCustomer* を v8.1 化**【2026/5/28 完了】
    - 旧 customerId → customerDocId / authUid 命名統一
      （dbCustomerListMyAppointments・dbLoadCustomerHistory は
       where('authUid','==',uid) に変更）
    - dbCustomerResolveMyCard(cb) （authIndex 経由・既存を活用）
    - dbCustomerClaimMyCard(data, cb) 新設
      （resolveOrClaimCustomer Function 呼び出しラッパー。
       カルテ作成 / claim の唯一の正規ルート）
    - dbCustomerCreateMyProfile は廃止（呼ばれたらエラー返却＝地雷不発化。
       deprecated コメントだけでは「呼べてしまう地雷」が残るため）
    - dbCustomerCreateAppointment は customerDocId + authUid:uid を送る方式に
      （rules appointments create A経路の必須/許可フィールドと 1対1 照合済み）
    - **_safeCb は「全棚卸し」ではなく可変長引数対応に改修して解決**
      （GPTレビュー 2026/5/28 採用。案A=125箇所棚卸しより
       案B=_safeCb 1関数のみ改良が後戻り少なく再発防止力も高い）
        function _safeCb(cb /*, ...args */) {
          if (typeof cb === 'function') {
            var args = Array.prototype.slice.call(arguments, 1);
            try { cb.apply(null, args); }
            catch (e) { console.error('[shared_db] cb error', e); }
          }
        }
      ・既存の 1 引数呼び出しは後方互換で無傷
      ・新規コードは Node 流儀 cb(err, value) に寄せる
      ・upload/auth/transaction 等の重要関数は必要に応じ
        ローカル callCb を併用可（_safeCb=インフラ、callCb=業務ロジック専用）
      ・C-9 写真機能事故（2026/5/24）の根本原因（2引数以降の欠落）を構造的に解消
    - 【依存】dbCustomerClaimMyCard は Functions を呼ぶため、呼び出し画面に
      <script src="firebase-functions-compat.js"> が必要（D-step4 で対応）
    - 【後続】authUid+dateKey 複合インデックス作成が新たに必要
      （D-step4 顧客アプリ実動時に「index 必要」エラー→ Console リンクから作成。
       販売前チェックリスト & A-step1-4 とセット実施）

  - D-step4. **customer_app.html v2 作成（D-1〜D-8）**

### Phase E：通知統一（メール経路の完成）
- E-1. `shared_notify.js` を新規作成
  - `sendBookingNotification(customerDocId, appointment, cb)` などの統一API
  - 内部で顧客の `notifyChannels.email` を見て Functions 経由でメール送信
  - LINE 分岐は最初から実装するが、フェーズ1ではスキップする条件で動かす
- E-2. 顧客アプリの予約/変更/キャンセル通知を `shared_notify.js` 経由に
- E-3. EmailJS 呼び出しコードを完全削除（※customer_app.html v2 は
  最初から Functions 経由で実装するため、旧 v8 系の EmailJS コードを
  整理・廃棄するだけ）
- E-4. EmailJS アカウント解約
- E-5. `notificationLogs/{logId}` への失敗記録機能を実装

### Phase F：Firestoreセキュリティルール最終確認
- Phase A-step1 + Phase D-step2 でルール基本形は完成しているはず
- 全機能実装後、Phase F で総合テスト：
  - F-1. テスト用サロン2つ（A, B）でフル機能動作確認
  - F-2. サロンAの顧客がURL書き換えてサロンBにアクセス→拒否されること
  - F-3. サロンAのスタッフがサロンBのデータ読もうとして→拒否されること
  - F-4. 顧客が他の顧客の予約を読もうとして→拒否されること
  - F-5. 認証なしユーザーが Firestore に直接アクセス→拒否されること
  - F-6. 複合インデックス全棚卸し（B-7 のリスト全項目が
    Firebase Console に存在することを確認、特に
    `(customerDocId, dateKey desc)` の復活）
  - F-7. Firestore 初回遅延対処（カレンダー過去月初回・
    カルテ初回開封・C-4↔C-9 遷移・C-8 編集→キャンセルなど）
- 必要に応じてルールを微調整

### Phase G：販売準備
- G-1. サロン新規登録の入り口（ランディング → 登録）
- G-2. 利用規約・プライバシーポリシー
- G-3. 決済（Stripe Subscriptions など）
- G-4. ランディングページ
- G-5. サポート体制（問い合わせフォーム）

### Phase H：LINE連携追加（販売後、PC環境が整ってから）
- H-1. TORITA 共通の LINE 公式アカウントを作成（モデルB方式）
- H-2. LINE Messaging API の設定、Channel Access Token を Functions の Secret に登録
- H-3. `sendBookingLine` Cloud Function を作成（メール用と同じ構造）
- H-4. LINE Webhook Function を作成（友だち追加 → メール照合 → `lineUserId` 保存）
- H-5. `shared_notify.js` の LINE 分岐を有効化
- H-6. 顧客マイページに「LINE通知」設定UIを追加
- H-7. 顧客アプリのマイページに「公式アカウントを友だち追加」QRコード表示
- 所要：PC借りた後、1〜2週間程度の追加実装
- ※フェーズ1のDB・既存コードは一切変更不要（設計書通り箱は最初から用意されている）

### Phase I：複数人版（フェーズ2）追加
- I-1. スタッフ登録画面
- I-2. 設備登録画面
- I-3. シフト管理画面
- I-4. メニュー画面に「施術可能スタッフ」「必要設備」UI追加
- I-5. 予約画面に「指名」UI追加
- I-6. 予約可能時間計算ロジックを3次元化（フェーズ1で既に実装済みなら不要）
- I-7. リアルタイム同期（`onSnapshot`）導入
- I-8. 編集ロック機能の実装

### 旧ファイルの扱い
- Phase D 完了時点で、旧ファイル（`customer_app_v8.html`, `shared_db.js`, `salon_*_v6/v7.html`）を `legacy/` フォルダに退避
- GitHub Pages からのリンクも v2 系に切り替え
- 旧ファイルは数週間残してから削除

---

## 8. 進め方

| フェーズ | 内容 | 完了基準 |
|---|---|---|
| A | 基盤ファイル新規作成 | shared_*_v2.js 3ファイルが完成し、単体動作確認OK |
| B | 速度設計実装 | 全 dbLoad* API が3秒以内に完了 |
| C | サロン管理画面 v2 | 全画面でログイン→操作→保存が動く |
| D | 顧客アプリ v2 | 起動3秒、予約完了まで一通り動く |
| E | 通知統一（メール経路） | EmailJS 完全撤去、shared_notify.js 完成 |
| F | セキュリティルール最終確認 | テスト2サロンで分離確認、全機能でルール動作OK |
| G | 販売準備 | ランディング・決済・規約 |
| H | LINE連携追加（販売後） | LINE Function deploy、shared_notify.js の LINE 経路有効化 |
| I | 複数人版（フェーズ2） | スタッフ・設備・シフト・指名予約・リアルタイム同期 |

各フェーズ完了時に：
1. **Firestoreデータを空にしてゼロから動作確認**（既存データ依存を排除）
2. **テスト用サロン2つで分離テスト**
3. **ZIP でいけさんに渡す → GitHub アップロード → 動作確認 → 次フェーズ**

---

## 9. 注意事項

### 9-1. 優先順位の鉄則
**機能量より、データ構造・権限・分離の方が100倍重要。**
販売後にデータ混線・他サロン情報漏洩が起きたら、信用は二度と戻らない。
だから機能を減らしてでも、土台を正しく作る。「見た目がショボくても壊れない」を優先する。

### 9-2. 守る作業ルール
1. **どんなに焦っても、設計書を変えずに実装はしない**。今夜の Claude の失敗（タイムアウト追加）は、設計書なしで応急処置したのが原因。

2. **iPad での編集はもう絶対にしない**。ZIP でファイル渡し、GitHub Web UI ではアップロードだけ。スマートクォート混入で動かなくなる事故が起きる。

3. **Claude も完璧じゃない**。設計書をレビューする時、GPT にも見てもらって、3者で合意してから実装するのが安全。

4. **Phase ごとに動作確認**。1 Phase 終わるごとに「動くかテスト」してから次へ。

5. **DB ルールはコードより先**（GPT指摘）。各 Phase の最初のステップで Firestoreルールを書く・確認する。UIだけ作って後で当てるのは禁止。

6. **「全部入りを最初から目指さない」**（GPT指摘）。販売開始時の最小機能で完璧に動くことが、機能たくさんで不安定よりずっと価値がある。

7. **v8.1 整合性チェック（2026/5/23 実施）**：Phase C 完了時に全ファイルで古い識別子・スキーマ用語の残存を grep で網羅チェック。発見した問題と対応：
   - `closeBlock.date` 参照バグ → `dateKey` に修正（shared_db_calendar.js:667）
   - サロン側 `dbSalonListAppointments` で `customerId` フィルタ → `customerDocId` に修正
   - サロン側 `dbSalonUpdateAppointment` で `customerId` 保護 → `customerDocId` + `authUid` 保護に修正
   - 顧客側関数（dbCustomer*）は旧 `customerId` のまま残し、Phase D 着手時に claim/merge Function とセットで全面書き換え予定。セクション先頭に大型警告コメントを記載済み。
   - 旧 `customerId` コメント記述を `customerDocId` に修正
   - 完全に v8.1 統一済みと確認した項目: `menuName→menuNameSnapshot`, `intervalBefore/intervalAfter→settings.intervalMin`, `requireSalonAuth→requireSalonStaff`, `localStorage→Firestore`

### 9-3. 販売開始時の最小機能（参考）

**オーナー側**
- ログイン
- 自店舗だけ閲覧可能
- メニュー登録
- 営業時間設定
- 予約一覧（カレンダー）
- 顧客管理（一覧・詳細・★ v8.1 サロン側顧客登録・
  ★ v6.1 `needsMergeReview` 🚩 表示）
  ※ 顧客統合（merge）はフェーズ1後半。UI の箱だけ先に置く

**顧客側**
- 店舗URLアクセス
- 新規登録 / ログイン
- メニュー選択
- 日時選択
- 予約確定
- 予約履歴

これだけで販売開始できる。LINE 連携・スタッフ管理・設備管理・指名予約・スタンプカードなどは「追加機能」として後から差し込める設計にしておく。

---

## 10. 設計書の使い方

このファイルは GitHub に `DESIGN.md` として置く。
今後、コードを変える時は必ずこの設計書を参照する。
設計書と矛盾する変更は、設計書を先に直してから実装する。
