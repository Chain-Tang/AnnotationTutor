// Settings navigation and connection workspace copy, kept together so every
// supported language exposes the same settings structure.
const messages: Record<string, [string, string, string, string]> = {
  title: ["Tutor settings", "Tutor 设置", "Tutor 設定", "Tutor 設定"],
  search: ["Search Tutor settings…", "搜索 Tutor 设置…", "搜尋 Tutor 設定…", "Tutor の設定を検索…"],
  searchLabel: ["Search Tutor settings", "搜索 Tutor 设置", "搜尋 Tutor 設定", "Tutor の設定を検索"],
  searchClear: ["Clear search", "清除搜索", "清除搜尋", "検索をクリア"],
  "page.general": ["General", "常规", "一般", "一般"],
  "page.reading": ["Reading & annotations", "阅读与批注", "閱讀與批註", "読書と注釈"],
  "page.learning": ["Learning & memory", "学习与记忆", "學習與記憶", "学習と記憶"],
  "page.connections": ["AI connections", "AI 连接", "AI 連線", "AI 接続"],
  "page.collaboration": ["Collaboration", "协作", "協作", "共同作業"],
  "page.privacy": ["Data & privacy", "数据与隐私", "資料與隱私", "データとプライバシー"],
  "page.library": ["Library", "资料库", "資料庫", "ライブラリ"],
  "page.web": ["Web capture", "网页采集", "網頁擷取", "ウェブ取り込み"],
  connectionsTitle: ["Connections & models", "连接与模型", "連線與模型", "接続とモデル"],
  connectionsDesc: ["Configure your connections, then choose which one each feature uses.", "分别配置连接，再为各功能指定用途。", "分別設定連線，再指定各功能的用途。", "接続を設定してから、各機能で使う接続を選択します。"],
  configured: ["Configured", "已配置", "已設定", "設定済み"],
  unconfigured: ["Not configured", "未配置", "未設定", "未設定"],
  credentialEncrypted: ["System-encrypted on this device", "已在此设备上加密保存", "已在此裝置上加密儲存", "このデバイスで暗号化して保存"],
  credentialSessionOnly: ["Available for this session only", "仅当前会话可用", "僅目前工作階段可用", "このセッションのみ有効"],
  credentialUnavailable: ["Credential unavailable on this device", "此设备无法读取凭据", "此裝置無法讀取憑證", "このデバイスでは認証情報を読み込めません"],
  credentialAttention: ["Check credential storage status", "请检查凭据存储状态", "請檢查憑證儲存狀態", "認証情報の保存状態を確認してください"],
  untested: ["Not tested", "尚未测试", "尚未測試", "未テスト"],
  currentVault: ["All settings apply only to this vault.", "所有设置仅作用于当前库。", "所有設定僅套用至目前的庫。", "すべての設定は現在の保管庫にのみ適用されます。"],
  advanced: ["Advanced options", "高级选项", "進階選項", "詳細オプション"],
  routes: ["Feature routing", "功能路由", "功能路由", "機能ごとの接続"],
  routesDesc: ["Choose the connection and model for each feature.", "为不同功能指定使用的连接和模型。", "指定不同功能使用的連線與模型。", "各機能で使う接続とモデルを指定します。"],
  routeFeature: ["Feature", "功能", "功能", "機能"],
  routeConnection: ["Connection", "使用连接", "使用連線", "接続"],
  routeModel: ["Model or behavior", "模型或行为", "模型或行為", "モデル・動作"],
  searchEmpty: ["No matching settings. Try another keyword.", "没有找到匹配的设置，请尝试其他关键词。", "找不到符合的設定，請嘗試其他關鍵字。", "一致する設定がありません。別のキーワードをお試しください。"],
  noChanges: ["No pending changes", "没有待保存的更改", "沒有待儲存的變更", "未保存の変更はありません"],
  "connection.api": ["Direct API", "Direct API", "Direct API", "Direct API"],
  "connection.opencode": ["OpenCode", "OpenCode", "OpenCode", "OpenCode"],
  "connection.image": ["Image generation", "图像生成", "圖像生成", "画像生成"],
  "connection.board": ["Board tools", "画板工具", "畫板工具", "ボードツール"],
  "section.general": ["General", "常规", "一般", "一般"],
  "section.reading": ["Reading & annotations", "阅读与批注", "閱讀與批註", "読書と注釈"],
  "section.learning": ["Learning & memory", "学习与记忆", "學習與記憶", "学習と記憶"],
  "section.connections": ["Connections & models", "连接与模型", "連線與模型", "接続とモデル"],
  "section.collaboration": ["Collaboration", "协作", "協作", "共同作業"],
  "section.privacy": ["Data & privacy", "数据与隐私", "資料與隱私", "データとプライバシー"],
  "section.library": ["Library", "资料库", "資料庫", "ライブラリ"],
  "section.web": ["Web capture", "网页采集", "網頁擷取", "ウェブ取り込み"],
  "section.shortcuts": ["Keyboard shortcuts", "快捷键", "快捷鍵", "キーボードショートカット"],
  "section.permissions": ["Permissions", "权限", "權限", "権限"],
  "section.storage": ["Storage", "存储", "儲存", "保存先"],
  "section.tools": ["Tools", "工具", "工具", "ツール"],
  "section.appearance": ["Appearance", "外观", "外觀", "外観"]
};

export const settingsLocaleTables = Object.fromEntries(
  ["en", "zh-cn", "zh-tw", "ja"].map((locale, index) => [
    locale,
    Object.fromEntries(Object.entries(messages).map(([key, values]) => [`settings.design.${key}`, values[index]!]))
  ])
) as Record<"en" | "zh-cn" | "zh-tw" | "ja", Record<string, string>>;
