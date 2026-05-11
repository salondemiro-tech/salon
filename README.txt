TORITA shared_db.js 修正ファイル

目的：サロン管理画面で requireSalonAuth が未定義になり、管理画面が初期化できない問題の修正。

アップロード方法：
1. GitHub の salon リポジトリを開く
2. shared_db.js を開く
3. 既存の shared_db.js をこのファイルで丸ごと置き換える
4. Commit changes
5. 以下のURLで確認
   https://salondemiro-tech.github.io/salon/salon_auth_v2.html?v=20260512b

今回の修正範囲：
- shared_db.js だけ
- customer_app_v8.html は触っていません
- Firestoreルールは触っていません
- React化・DB大改修はしていません

確認ポイント：
- salondemiro@gmail.com でログインできるか
- salon_calendar_v7.html に遷移できるか
- カレンダー、顧客、メニュー、営業時間、キャンセル規定、スタンプ設定が読めるか
