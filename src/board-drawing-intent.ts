/** Explicit user requests only; never infer executable instructions from source prose. */
export function requestsDrawing(text: string): boolean {
  const forbidden = /(?:不要|别|不用|无需|do not|don't)\s*(?:画|绘|生成|输出|展示|draw|paint|generate|create|show)/i;
  if (forbidden.test(text)) return text.split(/[，,。;；]/).filter(part => !forbidden.test(part)).some(requestsDrawing);
  if (/(?:生成|输出|展示|放置|create|generate|show).{0,60}(?:角色|形象|鲸鱼娘|鯨魚娘|character|portrait)/i.test(text)) return true;
  return /(?:画|畫|绘|繪|表情|颜文字|顏文字|示意|插画|插畫|\b(?:draw|sketch|paint|illustrat\w*|diagram|doodle|emoji|sticker|canvas|board)\b)/i.test(text);
}

/**
 * A conservative, local fast path for learner-authored drawing commands.
 *
 * `requestsDrawing` intentionally stays broad because the board agent also uses
 * it to validate model output. Routing needs a narrower question: did the
 * learner actually ask Tutor to act? A sentence such as “这幅画是什么意思？”
 * mentions a drawing but must remain an ordinary chat question.
 */
export function explicitlyRequestsDrawing(text: string): boolean {
  const clauses = text.split(/[。！？!?；;\n]+/).map(part => part.trim()).filter(Boolean);
  return clauses.some(clause => {
    if (/(?:不要|别|不用|无需|不必|do not|don't|without)\s*(?:画|绘|生成|输出|展示|draw|paint|generate|create|show)/i.test(clause)) return false;
    if (/^(?:怎么|如何|为何|为什么|什么是|介绍|解释|分析|评价|how\b|why\b|what\b).{0,48}(?:画|绘画|图画|插画|示意图|draw|paint|diagram|illustration)/i.test(clause)) return false;

    return /^(?:(?:请|請)(?:你)?|麻烦(?:你)?|能否|可不可以|可以(?:帮我)?|帮我|幫我|给我|給我)?\s*(?:画|畫|绘制|繪製|绘出|繪出|勾勒|涂鸦|塗鴉|可视化|視覺化)/i.test(clause)
      || /^(?:(?:请|請)(?:你)?|麻烦(?:你)?|帮我|幫我)?\s*(?:把|将|將).{1,100}(?:画成|畫成|绘成|繪成|做成|转成|轉成|可视化为|視覺化為)/i.test(clause)
      || /^(?:我想(?:要)?|我希望|我要|希望|想要).{0,48}(?:画|畫|绘|繪|插画|插畫|示意图|示意圖|流程图|流程圖|思维导图|思維導圖|表情|画板|畫板|可视化|視覺化)/i.test(clause)
      || /(?:请|請|麻烦|能否|可不可以|可以帮我|可以幫我|帮我|幫我|给我|給我).{0,48}(?:画|畫|绘制|繪製|生成.{0,10}(?:图|圖|图片|圖片|插画|插畫|形象)|做.{0,6}(?:示意图|示意圖|流程图|流程圖|思维导图|思維導圖|表情))/i.test(clause)
      || /^(?:来|來|做|给|給)(?:我)?(?:一|个|個|张|張|幅|点|點|些|个小|個小)*\s*(?:图|圖|画|畫|示意图|示意圖|流程图|流程圖|思维导图|思維導圖|插画|插畫|表情|贴纸|貼紙)/i.test(clause)
      || /^(?:修改|编辑|編輯|调整|調整|改).{0,48}(?:图|圖|画|畫|示意|插画|插畫|表情|贴纸|貼紙|画板|畫板)/i.test(clause)
      || /(?:用|以).{0,24}(?:图|圖|画|畫|视觉|視覺|示意).{0,28}(?:表示|表现|表現|展示|说明|說明)(?:出来|出來)?/i.test(clause)
      || /^(?:(?:please|can you|could you|would you)\s+)?(?:draw|sketch|paint|illustrate|doodle|visuali[sz]e|create\s+(?:a|an)\s+(?:diagram|picture|illustration|sketch)|show.{0,48}(?:visually|as\s+(?:a\s+)?(?:picture|diagram))|edit.{0,32}(?:diagram|drawing|illustration|canvas))\b/i.test(clause);
  });
}
export function requestsReferencePainting(text: string): boolean {
  return !/(?:不要生成图片|不要生图|不用生图|直接用画笔|原生笔触|without image generation)/i.test(text) && requestsDrawing(text) && /(?:角色|形象|人物|鲸鱼娘|鯨魚娘|二次元|吉卜力|吉ト力|插画|插畫|参考图|參考圖|先.*生[成图]|\b(?:character|portrait|anime|ghibli|illustration|reference image)\b)/i.test(text)
    && !/(?:简笔|簡筆|示意图|示意圖|\b(?:diagram|stick figure)\b)/i.test(text);
}

/** Only explicit requests typed by the learner on the board are auto-submitted. */
export function requestsBoardTextDrawing(text: string): boolean {
  return requestsDrawing(text) && /^(?:(?:请|請)(?:你)?\s*)?(?:(?:帮我|幫我|给我|給我)\s*)?(?:画|畫|绘制|繪製|生成|输出|展示)|^(?:(?:please|can you|could you)\s+)?(?:draw|paint|sketch|generate|create)\b/i.test(text.trim());
}
