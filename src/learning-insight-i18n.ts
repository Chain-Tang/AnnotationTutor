const messages:Record<string,[string,string,string,string]>={
  title:["Background learning observations","后台学习观察","背景學習觀察","バックグラウンド学習観察"],
  enabled:["Automatically track thinking during learning","自动跟踪学习中的思维方式","自動追蹤學習中的思考方式","学習中の考え方を自動追跡"],
  enabledDesc:["Analyze saved ordinary Tutor dialogue in this vault using its configured model. Observations stay in Markdown; teaching adapts silently. Private and unsaved conversations are excluded.","使用本库已配置的模型分析已保存的普通 Tutor 学习对话；观察保存在 Markdown 中，通过解释和练习调整教学，不主动展示画像。私有关怀和不记录的对话不参与。","使用本庫已設定的模型分析已儲存的一般 Tutor 學習對話；觀察儲存在 Markdown，透過解釋和練習調整教學，不主動顯示畫像。私密關懷和不記錄的對話不參與。","この保管庫の保存済みの通常学習対話を設定中のモデルで分析します。観察は Markdown に保存され、説明や練習を調整します。非公開・未保存の対話は除外します。"],
  exclusions:["Excluded learning sources","排除的学习来源","排除的學習來源","分析から除外する学習資料"],
  exclusionsDesc:["One annotation/chat ID, exact file path, or folder prefix per line. Existing dependent observations are removed.","每行填写一个批注或聊天 ID、完整库内文件路径或文件夹前缀。已有的相关观察也会移除。","每行填寫一個批註或聊天 ID、完整庫內檔案路徑或資料夾前綴。已有的相關觀察亦會移除。","1 行に 1 つの対話 ID、保管庫内のファイルパス、またはフォルダーを入力します。関連する既存の観察も削除されます。"],
  manage:["Inspect and manage saved observations","查看与管理已保存的观察","檢視與管理已儲存的觀察","保存した観察を確認・管理"],
  empty:["No saved observations yet.","目前尚无已保存的观察。","目前尚無已儲存的觀察。","保存した観察はまだありません。"],
  open:["Open Markdown","打开 Markdown","開啟 Markdown","Markdown を開く"],
  correction:["Your correction","你的纠正","你的更正","観察を訂正"],
  correctionDesc:["This replaces the earlier inference in teaching context. Keep observations you disagree with from being repeated.","教学背景将优先使用你的纠正，避免继续引用你不同意的推断。","教學背景將優先使用你的更正，避免繼續引用你不同意的推斷。","教える際は訂正を優先し、同意しない推論を繰り返しません。"],
  save:["Save correction","保存纠正","儲存更正","訂正を保存"],
  delete:["Delete this observation","删除此项观察","刪除此項觀察","この観察を削除"],
  source:["Source: {path}","来源：{path}","來源：{path}","資料: {path}"],
};
export const learningInsightLocaleTables=Object.fromEntries(["en","zh-cn","zh-tw","ja"].map((locale,index)=>[locale,Object.fromEntries(Object.entries(messages).map(([key,values])=>[`insight.${key}`,values[index]!]))])) as Record<"en"|"zh-cn"|"zh-tw"|"ja",Record<string,string>>;
