const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const KETTEI_DB_ID = "360562954f43813f8594fbe03f95a8e8";
const URATORI_DB_ID = "367562954f4381ccbdc2de32ac92f2b5";
const SHIIRE_DB_ID = "3aa562954f4381f09834d037005aba3e"; // 仕入先DB（2026年7月新設）
const LOG_DB_ID = "58f7f7959c814310ae9a27d5b7fcc299"; // 🪵 AIツール_ログ
const HANSOKU_HOST = "www.hansoku-style.jp"; // 販促スタイル（自社ECサイト）。/hansoku/detailで受け取るURLはこのホストのみ許可する
const INDUSTRY_TAG_DB_ID = "a40b458220624bb3913ad77dbdfd0272"; // 取引先業界タグ付けDB（2026年8月新設）
const ATTR_KEYWORD_DICT_DB_ID = "fd4b20bcf025449b8f9e0585211ba347"; // 属性タグ判定キーワード辞書（2026年8月14日新設）
const SEARCH_WORD_DICT_DB_ID = "46e8fde65e8b4abdb8cc1d26cfe54415"; // 検索ワード変換辞書（2026年8月14日新設）

// 属性タグ16分類（決定商品DB・裏取りDB・両辞書DBのマルチセレクト選択肢と一致させること）
const ATTRIBUTE_TAGS = [
  "涼感・冷感", "ヘア関連", "身だしなみ", "リラックス", "キッチン・食卓", "文房具・ステーショナリー",
  "アパレル", "バッグ・ポーチ", "アウトドア・レジャー", "モバイル・PC", "ビジネス",
  "防寒・あったかグッズ", "雨具", "シール・ステッカー", "消耗品",
  "タオル・ハンカチ", "キーホルダー・チャーム・缶バッジ", "カード", "ペンライト", "うちわ",
  "アクリル", "ぬい・クッション", "ボイス", "マグネット",
];

// Notion APIは短時間に連続で叩くと429（レート制限）が返ることがあるため、
// 大量の逐次書き込みを行う処理（マスタ同期等）ではこのリトライ付きfetchを使う。
async function fetchNotionWithRetry(url, options) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get("Retry-After")) || 1;
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, (retryAfter * 1000) + 200));
  }
  return fetch(url, options);
}

// 業界タグ19分類（決定商品DB・取引先業界タグ付けDBのマルチセレクト選択肢と一致させること）
const INDUSTRY_TAGS = [
  "アニメ・キャラクターIP", "舞台・2.5次元", "ゲーム", "音楽・アーティスト・アイドル",
  "VTuber・配信者・オンラインサービス", "スポーツチーム", "テーマパーク", "アパレル・ファッション",
  "飲料・食品", "化粧品・薬品", "外食", "金融・カード・保険・不動産", "自動車・車関連品",
  "製造（エネルギー・機械・素材）", "鉄道・交通機関", "教育・医療", "流通・小売", "旅行・宿泊", "官公庁・団体",
  "趣味･スポーツ用品・一般消費材メーカー",
];

// 会社名だけ・会社形態だけのような、突合の手がかりにならない不完全なマスタ行を弾くための法人格トークン
const LEGAL_FORM_TOKENS = [
  "株式会社", "有限会社", "合同会社", "合資会社", "合名会社", "一般社団法人", "公益財団法人",
  "一般財団法人", "協同組合", "生活協同組合", "特定非営利活動法人", "Ｉｎｃ", "Inc", "Ｌｔｄ", "Ltd", "ＬＬＣ", "LLC", "Ｃｏ", "Co", "Corporation", "Corp",
];
const MIN_CORE_NAME_LEN = 3;

// 全角/半角の揺れ・空白・括弧書き（子取引先）などのノイズを除去し、突合しやすい形に正規化する
function normalizeCompanyName(s) {
  let n = String(s || "").normalize("NFKC").replace(/[　\s]/g, "");
  n = n.replace(/[（(].*?[）)]/g, "");
  n = n.replace(/[，,．.]/g, "");
  return n;
}

// 正規化済み文字列から法人格トークンを除いた「会社の核となる名称」を取り出す
function coreCompanyName(normalized) {
  let core = normalized;
  for (const token of LEGAL_FORM_TOKENS) core = core.split(token).join("");
  return core;
}

// 取引先業界タグ付けDBのマスタ一覧と、決定商品DB側の取引先名（部署名等が付与されていることが多い）を
// あいまい一致（正規化後の部分文字列マッチ）で突合する。マスタ側は核名称が短すぎる行を除外し、
// 複数マッチした場合は最も具体的（＝正規化後の文字列が長い）行を優先する。
function matchIndustryTag(masterList, decisionDbName) {
  const normalizedDecisionName = normalizeCompanyName(decisionDbName);
  let best = null;
  for (const m of masterList) {
    if (m.core.length < MIN_CORE_NAME_LEN) continue;
    if (!normalizedDecisionName.includes(m.norm)) continue;
    if (!best || m.norm.length > best.norm.length) best = m;
  }
  return best ? best.tag : null;
}

// 取引先業界タグ付けDBの全件を取得し、突合用に正規化した形で返す
async function fetchIndustryTagMaster(env) {
  const master = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${INDUSTRY_TAG_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.object === "error") throw new Error("取引先業界タグ付けDBの取得に失敗: " + JSON.stringify(data));
    for (const page of data.results || []) {
      const name = page.properties?.["取引先名"]?.title?.[0]?.plain_text || "";
      const tags = (page.properties?.["業界タグ"]?.multi_select || []).map((t) => t.name);
      if (!name || tags.length === 0) continue;
      const norm = normalizeCompanyName(name);
      master.push({ name, tag: tags[0], norm, core: coreCompanyName(norm) });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return master;
}

// 汎用のNotion DBページネーション取得ヘルパー（辞書DB取得で使い回す）
async function fetchAllPages(env, dbId) {
  const pages = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetchNotionWithRetry(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.object === "error") throw new Error("DB取得に失敗（" + dbId + "）: " + JSON.stringify(data));
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// 属性タグ判定キーワード辞書・検索ワード変換辞書はどちらも「キーワード（title）」「対応属性タグ（multi_select）」の同一構造
async function fetchKeywordDict(env, dbId) {
  const pages = await fetchAllPages(env, dbId);
  return pages
    .map((page) => ({
      keyword: page.properties?.["キーワード"]?.title?.[0]?.plain_text || "",
      tags: (page.properties?.["対応属性タグ"]?.multi_select || []).map((t) => t.name),
    }))
    .filter((r) => r.keyword && r.tags.length > 0);
}

// 商品名（決定商品DBの商材名・裏取りDBの商品名）に辞書のキーワードが部分一致するか調べ、
// マッチした全キーワードの属性タグを重複排除した配列で返す（属性タグは複数付与OK）。
function matchAttributeTags(dict, productName) {
  const name = String(productName || "");
  const tags = new Set();
  for (const entry of dict) {
    if (name.includes(entry.keyword)) {
      for (const t of entry.tags) tags.add(t);
    }
  }
  return [...tags];
}

// 販促スタイルの検索結果ページ（HTML）から商品カードを抜き出す
// サイト側の商品カードは <a href="https://www.hansoku-style.jp/products/detail/{ID}"> ... </a></li> という構造
function parseHansokuSearchResults(html) {
  const items = [];
  const cardRe = /<a href="https:\/\/www\.hansoku-style\.jp\/products\/detail\/(\d+)">([\s\S]*?)<\/a>\s*<\/li>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const id = m[1];
    const block = m[2];
    const nameMatch = block.match(/<h3>([^<]+)<\/h3>/);
    if (!nameMatch) continue;
    const imgMatch = block.match(/data-src="([^"]+)"/);
    const priceMatch = block.match(/無地品[\s\S]{0,150}?￥([\d,]+)/);
    const moqMatch = block.match(/最低ご注文数[\s\S]{0,60}?[：:]\s*([\d,]+)\s*個/);
    const descMatch = block.match(/<p class="text-line3">([^<]*)<\/p>/);
    items.push({
      id: id,
      name: nameMatch[1].trim(),
      imageUrl: imgMatch ? ("https://www.hansoku-style.jp" + imgMatch[1]) : "",
      price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, ""), 10) : null,
      moq: moqMatch ? parseInt(moqMatch[1].replace(/,/g, ""), 10) : null,
      description: descMatch ? descMatch[1].trim() : "",
      url: "https://www.hansoku-style.jp/products/detail/" + id,
    });
  }
  return items;
}

// 商品詳細ページ（HTML）から商品情報を抜き出す
// JSON-LD（ProductGroup）と、EC-CUBEが埋め込むeccube.classCategories（数量別価格）の両方を使う
function parseHansokuDetail(html, url) {
  const result = {
    url: url,
    name: "",
    description: "",
    imageUrl: "",
    category: "",
    material: "",
    price: null,
    moq: null,
  };

  // JSON-LD（ProductGroup）
  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let ldMatch;
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(ldMatch[1]);
      if (data["@type"] === "ProductGroup") {
        result.name = data.name || "";
        result.description = data.description || "";
        result.imageUrl = data.image || "";
        result.category = (data.category || "").replace(/&gt;/g, ">");
        result.material = data.material || "";
      }
    } catch (e) {
      // JSON-LDのパース失敗は無視して次を試す
    }
  }

  // 数量別価格（eccube.classCategories）の最初のバリエーションから税込単価を取得
  const priceBlockMatch = html.match(/eccube\.classCategories\s*=\s*(\{[\s\S]*?\});/);
  if (priceBlockMatch) {
    try {
      const classCategories = JSON.parse(priceBlockMatch[1]);
      outer:
      for (const k1 in classCategories) {
        for (const k2 in classCategories[k1]) {
          const entry = classCategories[k1][k2];
          if (entry && entry.price01_inc_tax) {
            result.price = parseInt(String(entry.price01_inc_tax).replace(/,/g, ""), 10);
            break outer;
          }
        }
      }
    } catch (e) {
      // 価格データのパース失敗は無視（priceはnullのまま）
    }
  }

  // 最低ご注文数
  const moqMatch = html.match(/最低ご注文数[\s\S]{0,60}?[：:]\s*([\d,]+)\s*個/);
  if (moqMatch) result.moq = parseInt(moqMatch[1].replace(/,/g, ""), 10);

  return result;
}

// 商品詳細ページ（HTML）から、見積フォームに必要な選択肢（CSRFトークン・バリエーション・
// 印刷位置ごとの印刷方法一覧）を抜き出す
function parseHansokuOptions(html) {
  const result = { token: "", productClasses: [], positions: [] };

  const tokenMatch = html.match(/id="_token" name="_token" value="([^"]+)"/);
  if (tokenMatch) result.token = tokenMatch[1];

  // カラー等のバリエーション（ProductClass）
  const classRe = /<input id="class_category_(\d+)"[^>]*name="ProductClass\[\]" value="(\d+)"[^>]*>[\s\S]{0,500}?<span name="colorname1"[^>]*>\s*([^<]+?)\s*<\/span>/g;
  let classMatch;
  while ((classMatch = classRe.exec(html)) !== null) {
    result.productClasses.push({ id: classMatch[2], name: classMatch[3].trim() });
  }

  // 印刷位置・印刷方法（eccube.processingMethod）。バリエーションが複数あっても構成は基本共通のため、最初の1件を使う
  const pmMatch = html.match(/eccube\.processingMethod\s*=\s*(\{[\s\S]*?\});/);
  if (pmMatch) {
    try {
      const data = JSON.parse(pmMatch[1]);
      const firstKey = Object.keys(data)[0];
      if (firstKey) {
        const positionsObj = data[firstKey];
        for (const posKey in positionsObj) {
          const pos = positionsObj[posKey];
          const methods = [];
          for (const methodKey in (pos.print_method || {})) {
            const method = pos.print_method[methodKey];
            methods.push({ id: method.method_id, name: method.type_name });
          }
          result.positions.push({ id: pos.position_id, name: pos.position_name, methods: methods });
        }
      }
    } catch (e) {
      // パース失敗時はpositionsを空のまま返す（フロント側で「選択肢を取得できません」表示になる）
    }
  }

  return result;
}

// fetchのレスポンスから複数のSet-Cookieヘッダーを name=value 形式でまとめて取り出す
// （後続の見積APIリクエストにセッションCookieとして渡すため）
function extractSetCookies(response) {
  const cookies = [];
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") {
      cookies.push(value.split(";")[0]);
    }
  }
  return cookies.join("; ");
}

// ArrayBufferをBase64に変換する（大きな画像でもスタックオーバーフローしないようチャンク処理）
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Notionのログ用DBに1件書き込む。失敗してもアプリ本体の処理は止めない（ベストエフォート）。
async function logToNotion(env, type, feature, message, detail) {
  try {
    const safeMessage = String(message || "").slice(0, 1900);
    const safeDetail = String(detail || "").slice(0, 1900);
    const title = `[${type}] ${feature} - ${safeMessage}`.slice(0, 200);

    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: LOG_DB_ID },
        properties: {
          "Name": { title: [{ text: { content: title } }] },
          "種別": { select: { name: type } },
          "機能": { select: { name: feature } },
          "メッセージ": { rich_text: [{ text: { content: safeMessage } }] },
          "詳細": { rich_text: [{ text: { content: safeDetail } }] },
        },
      }),
    });
  } catch (e) {
    // ログ書き込みの失敗自体はどこにも記録しない（無限ループ防止）
  }
}

// Gemini APIの応答が実質的に失敗（フォールバック文言）かどうかを判定
function isGeminiFailure(answer) {
  return !answer || answer === "回答を取得できませんでした";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini APIを呼び出す。503（混雑）・429（レート制限）は一時的なエラーのことが多いため、
// 短い待機を挟んで最大2回まで自動リトライする。
async function callGemini(env, contents) {
  const MAX_RETRIES = 2;
  let data = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents }),
      }
    );
    data = await res.json();
    const errorCode = data?.error?.code;
    const isRetryable = errorCode === 503 || errorCode === 429;
    if (!isRetryable) return data;
    if (attempt < MAX_RETRIES) await sleep(800 * (attempt + 1));
  }
  return data;
}

// 業界タグ機能：本実装（バックフィル／Cronで共通利用するロジック本体）。
// 決定商品DBの「業界タグ処理済み」がOFFの商品を1バッチ分取得し、取引先名ベースでタグを解決して書き込む。
// 1. マスタDBと突合（対応表）→一致すればそれを採用
// 2. マスタに無い社名だけ、Geminiに社名のみ渡してバッチ判定（分からなければ空欄）
// 3. AI判定した社名はマスタDBに追記（次回以降は対応表として再利用できる）
// 4. バッチ内の全商品ページに業界タグを書き込み、業界タグ処理済み=trueにする（空欄でも処理済みにする）
async function runIndustryTagBatch(env, ctx, batchSize) {
  const master = await fetchIndustryTagMaster(env);

  const queryBody = {
    page_size: batchSize,
    filter: { property: "業界タグ処理済み", checkbox: { equals: false } },
  };
  const listRes = await fetchNotionWithRetry(`https://api.notion.com/v1/databases/${KETTEI_DB_ID}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queryBody),
  });
  const listData = await listRes.json();
  if (listData.object === "error") throw new Error("決定商品DBの取得に失敗: " + JSON.stringify(listData));

  const targets = (listData.results || []).map((page) => ({
    pageId: page.id,
    name: page.properties?.["取引先名"]?.rich_text?.[0]?.plain_text || "",
  }));

  if (targets.length === 0) {
    return { done: true, processed: 0, tagged: 0, empty: 0, failed: 0, ai_new_master_entries: 0 };
  }

  // このバッチ内でのユニーク社名だけ解決する（同名商品が複数あっても1回で済ませる）
  const nameToTag = new Map(); // name -> tag（nullは「判定したが該当なし」）
  const uniqueNames = [...new Set(targets.map((t) => t.name).filter(Boolean))];
  const unresolvedNames = [];
  for (const name of uniqueNames) {
    const tag = matchIndustryTag(master, name);
    if (tag) nameToTag.set(name, tag);
    else unresolvedNames.push(name);
  }

  let aiNewMasterEntries = 0;
  if (unresolvedNames.length > 0) {
    const prompt = `以下は法人・団体名のリストです。それぞれについて、次の20分類のうち最も近いものを1つ選んでください。\n` +
      `【重要】判断材料は会社名・団体名そのものだけです。商品の内容や業種の一般知識から推測してよいですが、Web検索は行わず、あなたの既存知識のみで判断してください。\n` +
      `会社名から業界が明確に判断できない場合は、無理に推測せず tag を空文字("")にしてください（厳しめに判定すること）。\n\n` +
      `【20分類】\n${INDUSTRY_TAGS.join("、")}\n\n` +
      `【出力形式】他の説明文は一切含めず、以下のJSON配列のみを出力してください。\n` +
      `[{"name":"元の会社名","tag":"分類名またはtagが不明な場合は空文字"}]\n\n` +
      `【対象リスト】\n${unresolvedNames.map((n) => "・" + n).join("\n")}`;

    const geminiData = await callGemini(env, [{ role: "user", parts: [{ text: prompt }] }]);
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let aiResults = [];
    try {
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      aiResults = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      ctx.waitUntil(logToNotion(env, "エラー", "業界タグ", "Gemini判定結果のJSON解析に失敗", rawText.slice(0, 500)));
    }
    const aiTagByName = new Map(aiResults.filter((r) => r && r.name).map((r) => [r.name, INDUSTRY_TAGS.includes(r.tag) ? r.tag : null]));

    for (const name of unresolvedNames) {
      const tag = aiTagByName.has(name) ? aiTagByName.get(name) : null;
      nameToTag.set(name, tag);
      // 判定できた（空欄でない）分だけマスタに追記し、次回以降は対応表で即決定できるようにする
      if (tag) {
        try {
          await fetchNotionWithRetry("https://api.notion.com/v1/pages", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.NOTION_TOKEN}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              parent: { database_id: INDUSTRY_TAG_DB_ID },
              properties: {
                "取引先名": { title: [{ text: { content: name } }] },
                "業界タグ": { multi_select: [{ name: tag }] },
                "判定方法": { select: { name: "AI判定" } },
              },
            }),
          });
          aiNewMasterEntries++;
        } catch (e) { /* マスタ追記の失敗は致命的ではないためベストエフォート */ }
      }
    }
  }

  let tagged = 0, empty = 0, failed = 0;
  for (const target of targets) {
    const tag = target.name ? nameToTag.get(target.name) : null;
    try {
      const properties = { "業界タグ処理済み": { checkbox: true } };
      if (tag) properties["業界タグ"] = { multi_select: [{ name: tag }] };
      const res = await fetchNotionWithRetry(`https://api.notion.com/v1/pages/${target.pageId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties }),
      });
      const data = await res.json();
      if (data.object === "error") throw new Error(JSON.stringify(data));
      if (tag) tagged++; else empty++;
    } catch (e) {
      failed++;
      ctx.waitUntil(logToNotion(env, "エラー", "業界タグ", "商品への書き込みに失敗: " + target.name, e.message.slice(0, 500)));
    }
  }

  ctx.waitUntil(logToNotion(env, "検索", "業界タグ", "バックフィル実行", `処理:${targets.length} タグ付:${tagged} 空欄:${empty} 失敗:${failed} 新規マスタ:${aiNewMasterEntries}`));

  return { done: false, processed: targets.length, tagged, empty, failed, ai_new_master_entries: aiNewMasterEntries };
}

// 属性タグ機能：本実装（バックフィル／Cronで共通利用するロジック本体）。
// dbId・titlePropを渡すことで決定商品DB（商材名）・裏取りDB（商品名）どちらにも使える。
// 1. 属性タグ判定キーワード辞書と商品名を部分一致で照合→マッチした分だけ確定（AI不要・複数タグ可）
// 2. マッチしなかった商品のみ、Geminiに商品名だけ渡してバッチ判定（厳しめ基準・分からなければ空欄）
// 3. 属性タグ・属性タグ処理済みを書き込む
async function runAttributeTagBatch(env, ctx, dbId, titleProp, batchSize) {
  const dict = await fetchKeywordDict(env, ATTR_KEYWORD_DICT_DB_ID);

  const queryBody = {
    page_size: batchSize,
    filter: { property: "属性タグ処理済み", checkbox: { equals: false } },
  };
  const listRes = await fetchNotionWithRetry(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queryBody),
  });
  const listData = await listRes.json();
  if (listData.object === "error") throw new Error("DB取得に失敗（" + dbId + "）: " + JSON.stringify(listData));

  const targets = (listData.results || []).map((page) => ({
    pageId: page.id,
    name: page.properties?.[titleProp]?.title?.[0]?.plain_text || "",
  }));

  if (targets.length === 0) {
    return { done: true, processed: 0, rule_based: 0, ai_judged: 0, empty: 0, failed: 0 };
  }

  // このバッチ内のユニーク商品名だけ解決する
  const nameToTags = new Map(); // name -> string[]（空配列は「判定したが該当なし」）
  const uniqueNames = [...new Set(targets.map((t) => t.name).filter(Boolean))];
  const unresolvedNames = [];
  for (const name of uniqueNames) {
    const tags = matchAttributeTags(dict, name);
    if (tags.length > 0) nameToTags.set(name, tags);
    else unresolvedNames.push(name);
  }
  const ruleBasedCount = uniqueNames.length - unresolvedNames.length;

  if (unresolvedNames.length > 0) {
    const prompt = `以下は商品名のリストです。それぞれについて、次の16分類のうち該当するものを選んでください（複数該当してもよい・0個でもよい）。\n` +
      `【重要】判断材料は商品名そのものだけです。あなたの既存知識のみで判断し、Web検索は行わないでください。\n` +
      `商品名から機能・用途が明確に判断できない場合は、無理に推測せずtagsを空配列にしてください（厳しめに判定すること）。\n\n` +
      `【16分類】\n${ATTRIBUTE_TAGS.join("、")}\n\n` +
      `【出力形式】他の説明文は一切含めず、以下のJSON配列のみを出力してください。\n` +
      `[{"name":"元の商品名","tags":["分類名", ...]}]\n\n` +
      `【対象リスト】\n${unresolvedNames.map((n) => "・" + n).join("\n")}`;

    const geminiData = await callGemini(env, [{ role: "user", parts: [{ text: prompt }] }]);
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let aiResults = [];
    try {
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      aiResults = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      ctx.waitUntil(logToNotion(env, "エラー", "属性タグ", "Gemini判定結果のJSON解析に失敗", rawText.slice(0, 500)));
    }
    const aiTagsByName = new Map(
      aiResults.filter((r) => r && r.name).map((r) => [r.name, (Array.isArray(r.tags) ? r.tags : []).filter((t) => ATTRIBUTE_TAGS.includes(t))])
    );
    for (const name of unresolvedNames) {
      nameToTags.set(name, aiTagsByName.get(name) || []);
    }
  }

  let tagged = 0, empty = 0, failed = 0;
  for (const target of targets) {
    const tags = target.name ? (nameToTags.get(target.name) || []) : [];
    try {
      const properties = { "属性タグ処理済み": { checkbox: true } };
      if (tags.length > 0) properties["属性タグ"] = { multi_select: tags.map((t) => ({ name: t })) };
      const res = await fetchNotionWithRetry(`https://api.notion.com/v1/pages/${target.pageId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties }),
      });
      const data = await res.json();
      if (data.object === "error") throw new Error(JSON.stringify(data));
      if (tags.length > 0) tagged++; else empty++;
    } catch (e) {
      failed++;
      ctx.waitUntil(logToNotion(env, "エラー", "属性タグ", "商品への書き込みに失敗: " + target.name, e.message.slice(0, 500)));
    }
  }

  ctx.waitUntil(logToNotion(env, "検索", "属性タグ", "バックフィル実行（" + dbId + "）", `処理:${targets.length} ルールベース確定:${ruleBasedCount} タグ付:${tagged} 空欄:${empty} 失敗:${failed}`));

  return { done: false, processed: targets.length, rule_based: ruleBasedCount, tagged, empty, failed };
}

export default {
  // Cloudflare Workers Cron Triggers用（ダッシュボードのTriggers設定で毎日1回スケジュールすること）。
  // 新規登録された商品（業界タグ／属性タグ処理済み=OFF）を検出し、上限に達するかキューが尽きるまでバッチ処理を繰り返す。
  async scheduled(event, env, ctx) {
    const MAX_BATCHES = 10; // 1回のCron実行あたりの上限（日次の新規登録数はごく少数の想定のため十分）
    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await runIndustryTagBatch(env, ctx, 50);
      if (result.done || result.processed === 0) break;
    }
    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await runAttributeTagBatch(env, ctx, KETTEI_DB_ID, "商材名", 50);
      if (result.done || result.processed === 0) break;
    }
    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await runAttributeTagBatch(env, ctx, URATORI_DB_ID, "商品名", 50);
      if (result.done || result.processed === 0) break;
    }
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // フロントエンド（index.html）からのログ送信専用エンドポイント
      // 資料生成の成功・失敗などWorkerから見えないイベントを記録する
      if (path === "/log" && request.method === "POST") {
        const { type, feature, message, detail } = await request.json();
        ctx.waitUntil(logToNotion(env, type || "エラー", feature || "システム", message, detail));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      // 商品画像の取得プロキシ（ブラウザから直接NotionのURLを読むとCORSで失敗するため、Worker経由で取得する）
      if (path === "/pptx/image" && request.method === "POST") {
        const { url: imageUrl } = await request.json();
        try {
          const imgRes = await fetch(imageUrl);
          if (!imgRes.ok) throw new Error("画像取得に失敗しました（status:" + imgRes.status + "）");
          const contentType = imgRes.headers.get("content-type") || "image/jpeg";
          const buf = await imgRes.arrayBuffer();
          const base64 = arrayBufferToBase64(buf);
          return new Response(JSON.stringify({ base64, contentType }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "資料作成", "商品画像の取得に失敗", e.message + " url:" + imageUrl));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 販促スタイル：キーワード・価格帯で商品検索
      if (path === "/hansoku/search" && request.method === "POST") {
        const { keyword, priceMin, priceMax } = await request.json();
        try {
          const listUrl = new URL("https://" + HANSOKU_HOST + "/products/list");
          if (keyword) listUrl.searchParams.set("name", keyword);
          if (priceMin) listUrl.searchParams.set("price_from", String(priceMin));
          if (priceMax) listUrl.searchParams.set("price_to", String(priceMax));

          const res = await fetch(listUrl.toString());
          if (!res.ok) throw new Error("販促スタイルの検索に失敗しました（status:" + res.status + "）");
          const html = await res.text();
          const items = parseHansokuSearchResults(html).slice(0, 20);

          ctx.waitUntil(logToNotion(env, "検索", "販促スタイル", "キーワード:" + (keyword || "（指定なし）"), "件数:" + items.length));
          return new Response(JSON.stringify({ items }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "販促スタイル", "検索に失敗", e.message));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 販促スタイル：商品詳細URLを指定して1件分の情報を取得
      if (path === "/hansoku/detail" && request.method === "POST") {
        const { url: productUrl } = await request.json();
        try {
          let parsedUrl;
          try {
            parsedUrl = new URL(productUrl);
          } catch (e) {
            throw new Error("URLの形式が正しくありません");
          }
          if (parsedUrl.hostname !== HANSOKU_HOST || parsedUrl.protocol !== "https:") {
            throw new Error("hansoku-style.jpの商品ページURLのみ対応しています");
          }

          const res = await fetch(parsedUrl.toString());
          if (!res.ok) throw new Error("商品ページの取得に失敗しました（status:" + res.status + "）");
          const html = await res.text();
          const item = parseHansokuDetail(html, parsedUrl.toString());
          if (!item.name) throw new Error("商品情報を読み取れませんでした（ページ構造が変わった可能性があります）");

          ctx.waitUntil(logToNotion(env, "検索", "販促スタイル", "URL指定：" + item.name, productUrl));
          return new Response(JSON.stringify({ item }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "販促スタイル", "URL指定の取得に失敗", e.message + " url:" + productUrl));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 販促スタイル：見積フォームの選択肢（カラー等のバリエーション・印刷位置ごとの印刷方法）を取得
      if (path === "/hansoku/options" && request.method === "POST") {
        const { url: productUrl } = await request.json();
        try {
          let parsedUrl;
          try {
            parsedUrl = new URL(productUrl);
          } catch (e) {
            throw new Error("URLの形式が正しくありません");
          }
          if (parsedUrl.hostname !== HANSOKU_HOST || parsedUrl.protocol !== "https:") {
            throw new Error("hansoku-style.jpの商品ページURLのみ対応しています");
          }

          const res = await fetch(parsedUrl.toString());
          if (!res.ok) throw new Error("商品ページの取得に失敗しました（status:" + res.status + "）");
          const html = await res.text();
          const detail = parseHansokuDetail(html, parsedUrl.toString());
          const options = parseHansokuOptions(html);
          if (!detail.name) throw new Error("商品情報を読み取れませんでした（ページ構造が変わった可能性があります）");

          return new Response(JSON.stringify({ detail, options }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "販促スタイル", "選択肢の取得に失敗", e.message + " url:" + productUrl));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 販促スタイル：選択された印刷位置・印刷方法・数量をもとに、サイトの見積APIで実際の価格を計算する
      if (path === "/hansoku/quote" && request.method === "POST") {
        const { url: productUrl, productId, productClassId, quantity, selections } = await request.json();
        try {
          let parsedUrl;
          try {
            parsedUrl = new URL(productUrl);
          } catch (e) {
            throw new Error("URLの形式が正しくありません");
          }
          if (parsedUrl.hostname !== HANSOKU_HOST || parsedUrl.protocol !== "https:") {
            throw new Error("hansoku-style.jpの商品ページURLのみ対応しています");
          }
          if (!productClassId || !quantity || !Array.isArray(selections) || selections.length === 0) {
            throw new Error("商品バリエーション・数量・印刷位置/方法の指定が不足しています");
          }

          // 見積APIの呼び出しにはCSRFトークンとセッションCookieが必要なため、まず商品ページに
          // 改めてアクセスして新鮮なものを取得する（トークンはページ読み込みごとに変わるため）
          const pageRes = await fetch(parsedUrl.toString());
          if (!pageRes.ok) throw new Error("商品ページの取得に失敗しました（status:" + pageRes.status + "）");
          const html = await pageRes.text();
          const options = parseHansokuOptions(html);
          if (!options.token) throw new Error("見積フォームのトークンを取得できませんでした");
          const cookie = extractSetCookies(pageRes);

          const today = new Date();
          const scheduled = today.getFullYear() + "/" + String(today.getMonth() + 1).padStart(2, "0") + "/" + String(today.getDate()).padStart(2, "0");

          const form = new URLSearchParams();
          form.set("is_download", "0");
          form.set("processing", "1");
          form.set("is_sample", "0");
          form.append("ProductClass[]", String(productClassId));
          form.set("quantity[" + productClassId + "]", String(quantity));
          form.set("total_quantity", String(quantity));
          selections.forEach(function (sel) {
            form.append("position[]", String(sel.positionId));
            form.set("method[" + sel.positionId + "]", String(sel.methodId));
          });
          form.set("change_color_type", "0");
          form.set("proofreading", "0");
          form.set("proofreading_scheduled", "1");
          form.set("quick_print", "0");
          form.set("scheduled", scheduled);
          form.set("_token", options.token);
          form.set("product_id", String(productId));
          form.set("hasDesign", "0");

          const quoteRes = await fetch("https://" + HANSOKU_HOST + "/product/easy_quote", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Cookie": cookie,
            },
            body: form.toString(),
          });
          const quoteData = await quoteRes.json();

          if (quoteData.status === "error") {
            const messages = Object.values(quoteData.data && quoteData.data.errors || {}).map(function (er) { return er.message; }).join(" / ");
            throw new Error(messages || "見積の計算に失敗しました");
          }

          ctx.waitUntil(logToNotion(env, "検索", "販促スタイル", "見積計算：" + productUrl, JSON.stringify({ productClassId: productClassId, quantity: quantity, selections: selections })));
          return new Response(JSON.stringify({ quote: quoteData.data }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "販促スタイル", "見積計算に失敗", e.message + " url:" + productUrl));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/notion/search" && request.method === "POST") {
        const body = await request.json();
        const dbId = body.database_id;
        const keyword = body.keyword || "";
        const costMin = body.cost_min ?? null;
        const costMax = body.cost_max ?? null;
        const qtyMin = body.qty_min ?? null;
        const qtyMax = body.qty_max ?? null;
        const industryTags = Array.isArray(body.industry_tags) ? body.industry_tags.filter(Boolean) : [];
        const attributeTags = Array.isArray(body.attribute_tags) ? body.attribute_tags.filter(Boolean) : [];

        // 仕入先DB（決定商品DB・裏取りDBとはフィールド構成が全く異なるため専用ロジック）
        if (dbId === SHIIRE_DB_ID) {
          const shiireFilters = [];
          if (keyword) {
            shiireFilters.push({ or: [
              { property: "仕入先名", title: { contains: keyword } },
              { property: "商品分類", rich_text: { contains: keyword } },
              { property: "商品種別（集計用）", rich_text: { contains: keyword } },
              { property: "商品詳細", rich_text: { contains: keyword } },
            ]});
          }
          // 要注意仕入先はサーバー側でも除外を試みる（プロパティ型が想定と違えば下のcatchでフォールバック）
          const excludeFlagged = { property: "要注意仕入先", select: { equals: "該当なし" } };
          const shiireQueryBody = {
            page_size: 50,
            filter: shiireFilters.length > 0 ? { and: [...shiireFilters, excludeFlagged] } : excludeFlagged,
          };

          let shiireRes = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.NOTION_TOKEN}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(shiireQueryBody),
          });
          let shiireData = await shiireRes.json();

          // 「要注意仕入先」の型が想定と違う等でエラーになった場合、その条件を外してリトライする
          // （除外自体はフロント側の変換処理でも二重に行うため安全）
          if (shiireData.object === "error") {
            ctx.waitUntil(logToNotion(env, "エラー", "システム", "仕入先DB検索でフィルターエラー（要注意仕入先の型を要確認）", JSON.stringify(shiireData)));
            const fallbackBody = { page_size: 50 };
            if (shiireFilters.length > 0) fallbackBody.filter = shiireFilters[0];
            shiireRes = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(fallbackBody),
            });
            shiireData = await shiireRes.json();
          }

          return new Response(JSON.stringify(shiireData), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        // 💡 用語メモ：
        // 裏取りDB → 仕入単価(number)・数量(number)
        // 決定商品DB → 仕入単価(number)・売単価(number)・数量(number)
        // → 両DBとも「仕入単価」フィールドで統一してフィルターする
        const isUratori = dbId === "367562954f4381ccbdc2de32ac92f2b5";
        const costField = "仕入単価";

        let queryBody = { page_size: 100 };

        // フィルター条件を配列で組み立てる
        const filters = [];

        // キーワードフィルター（商品名 or 仕入先）
        if (keyword) {
          if (isUratori) {
            filters.push({ or: [
              { property: "商品名", title: { contains: keyword } },
              { property: "仕入先", rich_text: { contains: keyword } },
            ]});
          } else {
            filters.push({ or: [
              { property: "商材名", title: { contains: keyword } },
              { property: "仕入先", rich_text: { contains: keyword } },
            ]});
          }
        }

        // 金額フィルター
        if (costMin !== null) filters.push({ property: costField, number: { greater_than_or_equal_to: costMin } });
        if (costMax !== null) filters.push({ property: costField, number: { less_than_or_equal_to: costMax } });

        // 数量フィルター
        if (qtyMin !== null) filters.push({ property: "数量", number: { greater_than_or_equal_to: qtyMin } });
        if (qtyMax !== null) filters.push({ property: "数量", number: { less_than_or_equal_to: qtyMax } });

        // 業界タグフィルター（複数選択時はOR条件・決定商品DBのみ有効なプロパティ）
        if (!isUratori && industryTags.length > 0) {
          filters.push({ or: industryTags.map((tag) => ({ property: "業界タグ", multi_select: { contains: tag } })) });
        }

        // 属性タグフィルター（複数選択時はOR条件・決定商品DB・裏取りDB両方で有効）
        if (attributeTags.length > 0) {
          filters.push({ or: attributeTags.map((tag) => ({ property: "属性タグ", multi_select: { contains: tag } })) });
        }

        // フィルターをandで結合
        if (filters.length === 1) {
          queryBody.filter = filters[0];
        } else if (filters.length > 1) {
          queryBody.filter = { and: filters };
        }

        const notionRes = await fetch(
          `https://api.notion.com/v1/databases/${dbId}/query`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.NOTION_TOKEN}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(queryBody),
          }
        );
        const data = await notionRes.json();
        if (data.object === "error") {
          ctx.waitUntil(logToNotion(env, "エラー", "システム", `Notion検索失敗（${isUratori ? "裏取りDB" : "決定商品DB"}）`, JSON.stringify(data)));
        }
        return new Response(JSON.stringify(data), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }





      // 業界タグ機能：対応表CSV（取引先名,業界タグ）を取引先業界タグ付けDBへ反映する。
      // 既存ページと同名なら業界タグを上書き（判定方法は"対応表"に統一）、無ければ新規作成。
      // prune:true の場合、渡された名前一覧に含まれない既存ページの業界タグを空にして無効化する
      // （削除ツールが無いため、突合ロジック側で無視されるようにするだけ。行自体は残る）。
      if (path === "/industry-tag/master-sync" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const prune = !!body.prune;
        // prune比較には「今回の全対象名」（allNamesがあればそちら、無ければrowsの名前）を使う。
        // バッチ分割してアップサートする場合、最終バッチでallNamesに全件の名前一覧を渡すこと。
        const pruneKeepNames = new Set(Array.isArray(body.allNames) && body.allNames.length > 0
          ? body.allNames.map((n) => String(n).trim())
          : rows.map((r) => String(r.name || "").trim()));
        try {
          const existing = new Map(); // normalizeCompanyName(name) -> {pageId, name, tag}
          let cursor = undefined;
          do {
            const qBody = { page_size: 100 };
            if (cursor) qBody.start_cursor = cursor;
            const res = await fetchNotionWithRetry(`https://api.notion.com/v1/databases/${INDUSTRY_TAG_DB_ID}/query`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(qBody),
            });
            const data = await res.json();
            if (data.object === "error") throw new Error("マスタDB取得に失敗: " + JSON.stringify(data));
            for (const page of data.results || []) {
              const name = page.properties?.["取引先名"]?.title?.[0]?.plain_text || "";
              if (!name) continue;
              const tags = (page.properties?.["業界タグ"]?.multi_select || []).map((t) => t.name);
              existing.set(name, { pageId: page.id, name, tag: tags[0] || null });
            }
            cursor = data.has_more ? data.next_cursor : undefined;
          } while (cursor);

          let created = 0, updated = 0, unchanged = 0, pruned = 0, failed = 0;

          for (const row of rows) {
            const name = String(row.name || "").trim();
            const tag = String(row.tag || "").trim();
            if (!name || !tag || !INDUSTRY_TAGS.includes(tag)) { failed++; continue; }
            const hit = existing.get(name);
            try {
              if (!hit) {
                const res = await fetchNotionWithRetry("https://api.notion.com/v1/pages", {
                  method: "POST",
                  headers: {
                    "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                    "Notion-Version": "2022-06-28",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    parent: { database_id: INDUSTRY_TAG_DB_ID },
                    properties: {
                      "取引先名": { title: [{ text: { content: name } }] },
                      "業界タグ": { multi_select: [{ name: tag }] },
                      "判定方法": { select: { name: "対応表" } },
                    },
                  }),
                });
                const created_data = await res.json();
                if (created_data.object === "error") throw new Error(JSON.stringify(created_data));
                created++;
              } else if (hit.tag !== tag) {
                const res = await fetchNotionWithRetry(`https://api.notion.com/v1/pages/${hit.pageId}`, {
                  method: "PATCH",
                  headers: {
                    "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                    "Notion-Version": "2022-06-28",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    properties: {
                      "業界タグ": { multi_select: [{ name: tag }] },
                      "判定方法": { select: { name: "対応表" } },
                    },
                  }),
                });
                const updated_data = await res.json();
                if (updated_data.object === "error") throw new Error(JSON.stringify(updated_data));
                updated++;
              } else {
                unchanged++;
              }
            } catch (e) {
              failed++;
              ctx.waitUntil(logToNotion(env, "エラー", "業界タグ", "マスタ同期の1件書き込みに失敗: " + name, e.message.slice(0, 500)));
            }
          }

          if (prune) {
            for (const [name, info] of existing) {
              if (pruneKeepNames.has(name) || !info.tag) continue;
              try {
                await fetchNotionWithRetry(`https://api.notion.com/v1/pages/${info.pageId}`, {
                  method: "PATCH",
                  headers: {
                    "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                    "Notion-Version": "2022-06-28",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ properties: { "業界タグ": { multi_select: [] } } }),
                });
                pruned++;
              } catch (e) { /* ベストエフォート */ }
            }
          }

          ctx.waitUntil(logToNotion(env, "検索", "業界タグ", "マスタ同期実行", `新規:${created} 更新:${updated} 変更なし:${unchanged} 無効化:${pruned} 失敗:${failed}`));

          return new Response(JSON.stringify({ created, updated, unchanged, pruned, failed, existing_total: existing.size }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "業界タグ", "マスタ同期に失敗", e.message));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 業界タグ機能：本実装（Cron）前の精度確認用。決定商品DBの未処理取引先名をサンプル抽出し、
      // マスタDB（取引先業界タグ付けDB）との突合→未マッチ分のみGeminiに社名だけ渡して判定。
      // Notionへの書き込みは一切行わず、結果を返すだけ（沖さんの目視チェック用）。
      if (path === "/industry-tag/backfill-sample" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const sampleSize = Math.min(Math.max(Number(body.sampleSize) || 30, 1), 100);
        try {
          const master = await fetchIndustryTagMaster(env);

          // 決定商品DBから「業界タグ処理済み」がOFFの商品を取得し、ユニークな取引先名を集める。
          // サンプル確認用のため、十分な数のユニーク社名が集まるまで数ページだけ辿る（全件は辿らない）。
          const uniqueNames = [];
          const seen = new Set();
          let cursor = undefined;
          let pagesFetched = 0;
          const MAX_PAGES = 10; // 100件×10ページ＝最大1000商品まで確認すれば十分な社数が集まる想定
          while (uniqueNames.length < sampleSize * 3 && pagesFetched < MAX_PAGES) {
            const queryBody = {
              page_size: 100,
              filter: { property: "業界タグ処理済み", checkbox: { equals: false } },
            };
            if (cursor) queryBody.start_cursor = cursor;
            const res = await fetch(`https://api.notion.com/v1/databases/${KETTEI_DB_ID}/query`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(queryBody),
            });
            const data = await res.json();
            if (data.object === "error") throw new Error("決定商品DBの取得に失敗: " + JSON.stringify(data));
            pagesFetched++;
            for (const page of data.results || []) {
              const name = page.properties?.["取引先名"]?.rich_text?.[0]?.plain_text || "";
              if (name && !seen.has(name)) { seen.add(name); uniqueNames.push(name); }
            }
            cursor = data.has_more ? data.next_cursor : undefined;
            if (!cursor) break;
          }

          const matched = [];
          const unmatched = [];
          for (const name of uniqueNames) {
            const tag = matchIndustryTag(master, name);
            if (tag) matched.push({ name, tag, method: "対応表" });
            else unmatched.push(name);
          }

          const aiSample = unmatched.slice(0, sampleSize);
          let aiJudged = [];
          if (aiSample.length > 0) {
            const prompt = `以下は法人・団体名のリストです。それぞれについて、次の19分類のうち最も近いものを1つ選んでください。\n` +
              `【重要】判断材料は会社名・団体名そのものだけです。商品の内容や業種の一般知識から推測してよいですが、Web検索は行わず、あなたの既存知識のみで判断してください。\n` +
              `会社名から業界が明確に判断できない場合は、無理に推測せず tag を空文字("")にしてください（厳しめに判定すること）。\n\n` +
              `【19分類】\n${INDUSTRY_TAGS.join("、")}\n\n` +
              `【出力形式】他の説明文は一切含めず、以下のJSON配列のみを出力してください。\n` +
              `[{"name":"元の会社名","tag":"分類名またはtagが不明な場合は空文字"}]\n\n` +
              `【対象リスト】\n${aiSample.map((n) => "・" + n).join("\n")}`;

            const geminiData = await callGemini(env, [{ role: "user", parts: [{ text: prompt }] }]);
            const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            try {
              const jsonMatch = rawText.match(/\[[\s\S]*\]/);
              const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
              aiJudged = parsed
                .filter((r) => r && r.name)
                .map((r) => ({ name: r.name, tag: INDUSTRY_TAGS.includes(r.tag) ? r.tag : null, method: "AI判定" }));
            } catch (e) {
              ctx.waitUntil(logToNotion(env, "エラー", "業界タグ", "Gemini判定結果のJSON解析に失敗", rawText.slice(0, 500)));
            }
          }

          ctx.waitUntil(logToNotion(env, "検索", "業界タグ", "サンプルテスト実行", `対象:${uniqueNames.length} 対応表一致:${matched.length} AI判定:${aiJudged.length}`));

          return new Response(JSON.stringify({
            master_count: master.length,
            checked_supplier_count: uniqueNames.length,
            matched_by_master: matched,
            ai_judged_sample: aiJudged,
            unmatched_not_sampled: unmatched.slice(sampleSize),
          }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "業界タグ", "サンプルテストに失敗", e.message));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 業界タグ機能：業界タグが空欄のまま処理済みになっている商品の「業界タグ処理済み」をOFFに戻す。
      // Gemini側のレート制限等で空欄になったものを、/industry-tag/backfill-apply で再判定させるための下準備。
      if (path === "/industry-tag/reset-empty" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 100);
        try {
          const queryBody = {
            page_size: limit,
            filter: {
              and: [
                { property: "業界タグ処理済み", checkbox: { equals: true } },
                { property: "業界タグ", multi_select: { is_empty: true } },
              ],
            },
          };
          const res = await fetchNotionWithRetry(`https://api.notion.com/v1/databases/${KETTEI_DB_ID}/query`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.NOTION_TOKEN}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(queryBody),
          });
          const data = await res.json();
          if (data.object === "error") throw new Error("空欄商品の取得に失敗: " + JSON.stringify(data));

          let reset = 0, failed = 0;
          for (const page of data.results || []) {
            try {
              const r = await fetchNotionWithRetry(`https://api.notion.com/v1/pages/${page.id}`, {
                method: "PATCH",
                headers: {
                  "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                  "Notion-Version": "2022-06-28",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ properties: { "業界タグ処理済み": { checkbox: false } } }),
              });
              const rData = await r.json();
              if (rData.object === "error") throw new Error(JSON.stringify(rData));
              reset++;
            } catch (e) { failed++; }
          }

          return new Response(JSON.stringify({ reset, failed, remaining_checked: (data.results || []).length }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 業界タグ機能：本実装（バックフィル／Cron共通ロジック本体は runIndustryTagBatch に集約）。
      // 1回の呼び出しでbatchSize件（既定50）だけ処理する。全件終わるまで繰り返し呼び出す想定。
      if (path === "/industry-tag/backfill-apply" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const batchSize = Math.min(Math.max(Number(body.batchSize) || 50, 1), 100);
        try {
          const result = await runIndustryTagBatch(env, ctx, batchSize);
          return new Response(JSON.stringify(result), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "業界タグ", "バックフィル実行に失敗", e.message));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 属性タグ機能：本実装（バックフィル／Cron共通ロジック本体は runAttributeTagBatch に集約）。
      // body.target で "kettei"（決定商品DB・商材名）または "uratori"（裏取りDB・商品名）を指定する。
      if (path === "/attribute-tag/backfill-apply" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const batchSize = Math.min(Math.max(Number(body.batchSize) || 50, 1), 100);
        const target = body.target === "uratori" ? "uratori" : "kettei";
        const dbId = target === "uratori" ? URATORI_DB_ID : KETTEI_DB_ID;
        const titleProp = target === "uratori" ? "商品名" : "商材名";
        try {
          const result = await runAttributeTagBatch(env, ctx, dbId, titleProp, batchSize);
          return new Response(JSON.stringify(result), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "属性タグ", "バックフィル実行に失敗", e.message));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 属性タグ機能：本実装（Cron）前の精度確認用。決定商品DB／裏取りDBの未処理商品をサンプル抽出し、
      // キーワード辞書との一致→未マッチ分のみGeminiに商品名だけ渡して判定。Notionへの書き込みは行わない。
      if (path === "/attribute-tag/backfill-sample" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const sampleSize = Math.min(Math.max(Number(body.sampleSize) || 30, 1), 100);
        const target = body.target === "uratori" ? "uratori" : "kettei";
        const dbId = target === "uratori" ? URATORI_DB_ID : KETTEI_DB_ID;
        const titleProp = target === "uratori" ? "商品名" : "商材名";
        try {
          const dict = await fetchKeywordDict(env, ATTR_KEYWORD_DICT_DB_ID);

          const uniqueNames = [];
          const seen = new Set();
          let cursor = undefined;
          let pagesFetched = 0;
          const MAX_PAGES = 10;
          while (uniqueNames.length < sampleSize * 3 && pagesFetched < MAX_PAGES) {
            const queryBody = {
              page_size: 100,
              filter: { property: "属性タグ処理済み", checkbox: { equals: false } },
            };
            if (cursor) queryBody.start_cursor = cursor;
            const res = await fetchNotionWithRetry(`https://api.notion.com/v1/databases/${dbId}/query`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(queryBody),
            });
            const data = await res.json();
            if (data.object === "error") throw new Error("DB取得に失敗: " + JSON.stringify(data));
            pagesFetched++;
            for (const page of data.results || []) {
              const name = page.properties?.[titleProp]?.title?.[0]?.plain_text || "";
              if (name && !seen.has(name)) { seen.add(name); uniqueNames.push(name); }
            }
            cursor = data.has_more ? data.next_cursor : undefined;
            if (!cursor) break;
          }

          const matched = [];
          const unmatched = [];
          for (const name of uniqueNames) {
            const tags = matchAttributeTags(dict, name);
            if (tags.length > 0) matched.push({ name, tags, method: "ルールベース" });
            else unmatched.push(name);
          }

          const aiSample = unmatched.slice(0, sampleSize);
          let aiJudged = [];
          if (aiSample.length > 0) {
            const prompt = `以下は商品名のリストです。それぞれについて、次の16分類のうち該当するものを選んでください（複数該当してもよい・0個でもよい）。\n` +
              `【重要】判断材料は商品名そのものだけです。あなたの既存知識のみで判断し、Web検索は行わないでください。\n` +
              `商品名から機能・用途が明確に判断できない場合は、無理に推測せずtagsを空配列にしてください（厳しめに判定すること）。\n\n` +
              `【16分類】\n${ATTRIBUTE_TAGS.join("、")}\n\n` +
              `【出力形式】他の説明文は一切含めず、以下のJSON配列のみを出力してください。\n` +
              `[{"name":"元の商品名","tags":["分類名", ...]}]\n\n` +
              `【対象リスト】\n${aiSample.map((n) => "・" + n).join("\n")}`;

            const geminiData = await callGemini(env, [{ role: "user", parts: [{ text: prompt }] }]);
            const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            try {
              const jsonMatch = rawText.match(/\[[\s\S]*\]/);
              const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
              aiJudged = parsed
                .filter((r) => r && r.name)
                .map((r) => ({ name: r.name, tags: (Array.isArray(r.tags) ? r.tags : []).filter((t) => ATTRIBUTE_TAGS.includes(t)), method: "AI判定" }));
            } catch (e) {
              ctx.waitUntil(logToNotion(env, "エラー", "属性タグ", "Gemini判定結果のJSON解析に失敗", rawText.slice(0, 500)));
            }
          }

          ctx.waitUntil(logToNotion(env, "検索", "属性タグ", "サンプルテスト実行（" + target + "）", `対象:${uniqueNames.length} ルールベース一致:${matched.length} AI判定:${aiJudged.length}`));

          return new Response(JSON.stringify({
            dict_count: dict.length,
            checked_count: uniqueNames.length,
            matched_by_rule: matched,
            ai_judged_sample: aiJudged,
            unmatched_not_sampled: unmatched.slice(sampleSize),
          }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        } catch (e) {
          ctx.waitUntil(logToNotion(env, "エラー", "属性タグ", "サンプルテストに失敗", e.message));
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 属性タグ機能：フリーワードを「検索ワード変換辞書」で属性タグに変換する（AIを使わず辞書引きのみ・決定論的）。
      // ①アイテム提案・③一問一答などで、検索前にこの結果を使ってNotion側のattribute_tagsフィルターに渡す想定。
      if (path === "/attribute-tag/interpret-theme" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const theme = String(body.theme || "");
        try {
          const dict = await fetchKeywordDict(env, SEARCH_WORD_DICT_DB_ID);
          const tags = matchAttributeTags(dict, theme);
          return new Response(JSON.stringify({ tags }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      // 属性タグ機能：辞書を大幅改修した際などに、全件を再判定させるための一括リセット。
      // 「属性タグ処理済み」=ONの商品を対象に、属性タグ・属性タグ処理済みの両方をクリアする。
      // 1回の呼び出しでlimit件（既定100）だけ処理する。全件終わるまで繰り返し呼び出す想定。
      if (path === "/attribute-tag/reset-all" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 100);
        const target = body.target === "uratori" ? "uratori" : "kettei";
        const dbId = target === "uratori" ? URATORI_DB_ID : KETTEI_DB_ID;
        try {
          const queryBody = {
            page_size: limit,
            filter: { property: "属性タグ処理済み", checkbox: { equals: true } },
          };
          const res = await fetchNotionWithRetry(`https://api.notion.com/v1/databases/${dbId}/query`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.NOTION_TOKEN}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(queryBody),
          });
          const data = await res.json();
          if (data.object === "error") throw new Error("対象商品の取得に失敗: " + JSON.stringify(data));

          let reset = 0, failed = 0;
          for (const page of data.results || []) {
            try {
              const r = await fetchNotionWithRetry(`https://api.notion.com/v1/pages/${page.id}`, {
                method: "PATCH",
                headers: {
                  "Authorization": `Bearer ${env.NOTION_TOKEN}`,
                  "Notion-Version": "2022-06-28",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ properties: { "属性タグ処理済み": { checkbox: false }, "属性タグ": { multi_select: [] } } }),
              });
              const rData = await r.json();
              if (rData.object === "error") throw new Error(JSON.stringify(rData));
              reset++;
            } catch (e) { failed++; }
          }

          return new Response(JSON.stringify({ reset, failed, remaining_checked: (data.results || []).length }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/pptx/memo" && request.method === "POST") {
        // memoのGemini生成のみ担当（FMTはindex.html側に埋め込み）
        const { items, memoDirection } = await request.json();

        const memoPrompt = `あなたはTR大阪（ノベルティ・販促グッズの営業会社）の営業支援AIです。
以下の商品それぞれについて、提案書のmemo欄に入れる推しポイントを生成してください。

【方向性】${memoDirection}

【商品リスト】
${items.map((item, i) => `No.${i+1}: ${item.name}（仕入単価:${item.cost}円、数量:${item.qty}個）`).join('\n')}

【ルール】
・各商品について50〜80文字程度で推しポイントを書く
・指定された方向性を意識した内容にする
・マークダウン記号は使わない
・以下のJSON形式のみで返す（前後の説明文不要）：
{"memos": ["商品1の推しポイント", "商品2の推しポイント"]}`;

        const geminiData = await callGemini(env, [{ role: "user", parts: [{ text: memoPrompt }] }]);
        const geminiText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"memos":[]}';
        let memoTexts = [];
        try {
          const clean = geminiText.replace(/```json|```/g, '').trim();
          memoTexts = JSON.parse(clean).memos || [];
        } catch(e) {
          memoTexts = items.map(() => '');
          ctx.waitUntil(logToNotion(env, "エラー", "資料作成", "memo生成のJSON解析に失敗", JSON.stringify(geminiData)));
        }

        return new Response(JSON.stringify({ memoTexts }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }


      if (path === "/gemini/report" && request.method === "POST") {
        const { conditions, notionContext, includeNG = false } = await request.json();

        const prompt = `あなたはTR大阪（ノベルティ・販促グッズの営業会社）の営業支援AIです。
過去の受注実績を調べるお手伝いをします。

【検索条件】
${conditions}
転載不可商品を含める：${includeNG ? 'はい（すべて表示）' : 'いいえ（転載OKのみ表示）'}

【決定商品DBの検索結果】
${notionContext}

【回答ルール】
・マークダウン記号（**や*や#）は絶対に使わない
・転載不可商品を含めない設定の場合、「転載可否」フィールドが転載NGの商品は表示しない
・条件に合う実績を最大20件リストで提示する
・各実績は以下のフォーマットで書く：

No.1 商品名
・仕入単価：○○円　数量：○○個　粗利率：○○%
・仕入先：○○
・納期：○○

No.2 ...

・データにない項目は「不明」と書く
・件数サマリは書かない`;

        const data = await callGemini(env, [{ role: "user", parts: [{ text: prompt }] }]);
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "回答を取得できませんでした";
        if (isGeminiFailure(answer)) {
          ctx.waitUntil(logToNotion(env, "エラー", "実績を調べる", "Gemini応答取得失敗", JSON.stringify(data)));
        } else if (conditions !== "追加表示") {
          // 資料作成まで進んだかどうかの導線分析用に、検索実行だけを軽量に記録する（結果本文は記録しない）
          ctx.waitUntil(logToNotion(env, "検索", "実績を調べる", conditions, ""));
        }
        return new Response(JSON.stringify({ answer }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      if (path === "/gemini/suggest" && request.method === "POST") {
        const { conditions, notionContext, mode } = await request.json();

        // モードによってプロンプトを切り替え
        const isSearchMode = mode === 'search';

        const searchPrompt = `あなたはTR大阪（ノベルティ・販促グッズの営業会社）の営業支援AIです。

【検索条件】
${conditions}

【DBの検索結果】
${notionContext}

【回答ルール】
・マークダウン記号（**や*や#）は絶対に使わない
・条件に合う商品をDBから最大20件リストで出す
・DBにない商品は出さない
・各商品は以下のフォーマットで書く（うんちく不要・情報だけ）：

No.1 商品名（ソース：裏取りDB or 決定商品DB）
・仕入単価：○○円　数量：○○個　仕入先：○○

No.2 ...

最後に件数を一行で：「条件に合う商品を○件表示しています。」`;

        const ideaPrompt = `あなたはTR大阪（ノベルティ・販促グッズの営業会社）の営業支援AIです。
クライアントへの提案商品を一緒に考えます。

【検索条件】
${conditions}

【DBの検索結果（重複排除済み）】
${notionContext}

【回答ルール】
・マークダウン記号（**や*や#）は絶対に使わない
・テーマや条件に本当に合う商品だけを厳選して10件提案する
・こじつけや無理やりな提案は絶対にしない
・テーマに合わない商品は除外する（例：ビジネスマン向けにぬいぐるみは出さない）
・条件やテーマに「○○業界向け」「○○業界の実績」など業界を指す言葉が含まれる場合、決定商品DBの各行にある「業界タグ」（取引先の業種）も判断材料にする。ただし業界タグは厳密なフィルターではなく参考情報なので、タグが無い（不明）商品でも他の条件に合えば除外しない
・DBから10件に満たない場合は「○件確認しましたが条件に合う商品が不足しています。追加で検索しますか？DB以外で検索しますか？」と確認する
・各候補は以下のフォーマットで書く：

No.1 商品名
・情報ソース：裏取りDB or 決定商品DB
・仕入単価：○○円　数量：○○個　仕入先：○○（不明な場合は「要確認」）
・選定理由：（テーマや条件に合う具体的な理由を一言・こじつけ不可）

No.2 ...

最後に一言：「気になる商品があれば、仕入先検索や一問一答タブで詳細を調べられます。」`;

        const prompt = isSearchMode ? searchPrompt : ideaPrompt;

        const data = await callGemini(env, [{ role: "user", parts: [{ text: prompt }] }]);
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "回答を取得できませんでした";
        if (isGeminiFailure(answer)) {
          ctx.waitUntil(logToNotion(env, "エラー", "アイテム提案", "Gemini応答取得失敗", JSON.stringify(data)));
        } else if (conditions !== "追加表示") {
          // 資料作成まで進んだかどうかの導線分析用に、検索実行だけを軽量に記録する（結果本文は記録しない）
          ctx.waitUntil(logToNotion(env, "検索", "アイテム提案", (isSearchMode ? "条件絞り込み：" : "アイデア出し：") + conditions, ""));
        }
        return new Response(JSON.stringify({ answer }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      if (path === "/gemini/supplier" && request.method === "POST") {
        const { question, notionContext, history = [] } = await request.json();

        const systemPrompt = `あなたはTR大阪（ノベルティ・販促グッズの営業会社）の仕入先調査AIです。
裏取りDB・仕入先DBの情報をもとに、仕入先候補と仕様・コスト情報を案内してください。

【検索結果（裏取りDB・仕入先DB）】
${notionContext}

【情報源の優先順位】
・裏取りDB（実際の仕入実績データ）を最優先で使う
・裏取りDBに情報がない、または仕入先の候補を広げたい場合に仕入先DBの情報を補足として使う

【仕入先DBの扱い方】
・仕入先DBは「その仕入先がどんな商材を取り扱えるか」（業種・商品分類・商品種別・商品詳細）の情報。質問された商品を取り扱えそうな仕入先を探す時に使う
・要注意仕入先に該当する仕入先（取引停止・反社・情報開示不可など）は絶対に紹介しない
・仕入先候補のリストには、どのデータ元から出てきた候補か（裏取りDB／仕入先DB／決定商品DB）を必ず明記する。仕入先DB由来の候補で、コスト表有無が「あり」の場合は「コスト表あり」も併記する
・コスト表の詳細（更新日・格納先アドレス）は、初回の回答では書かない。ユーザーがコスト表の詳細を求めてきた時だけ、更新日と格納先アドレスを共有する
・仕入先の連絡先（担当者・メール・電話）は、初回の回答では書かず「連絡先が必要であればコメントください」と一言添える程度に留める。ユーザーが連絡先を求めてきた時だけ、以下のフォーマットで共有する（担当者①のメール・電話は必ず担当者①の情報、担当者②のメール・電話は必ず担当者②の情報とセットで書く。担当者を取り違えないこと）：

・仕入先名：○○
・担当者：○○（①） ／ メール：○○ ／ 電話：○○
・担当者：○○（②） ／ メール：○○ ／ 電話：○○　※担当者②がいる場合のみ
・備考：注意事項があれば記載（なければ省略）

【回答ルール】
・マークダウン記号（**や*や#）は絶対に使わない
・箇条書きは「・」と「→」を使う
・必ず最初の1行にサマリを書く（社数は数えて言わない。例：「靴下の仕入先候補をご案内します。」）
・数量の質問（「○個以下」「○個以上」「○個程度」）は範囲で解釈すること
  例：「1000個以下」と聞かれたら500個や300個のデータも該当する
  例：「500個程度」と聞かれたら300〜1000個程度のデータも参考として提示する
・フォーマットは以下を使う：

仕入先候補：
・仕入先名A（裏取りDB）
・仕入先名B（仕入先DB／コスト表あり）

詳細情報：

＜仕入先名A＞
・商品名 ／ サイズ・仕様 ／ 数量 ／ 仕入単価
・商品名 ／ サイズ・仕様 ／ 数量 ／ 仕入単価
（1社につき最大3件）

＜仕入先名B＞
・取扱商材：業種／商品分類／商品種別・商品詳細の要約

・データにない項目は「不明」と書く
・前の会話の内容も踏まえて回答する`;

        const contents = [];
        for (const msg of history) {
          contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
          });
        }
        if (contents.length === 0) {
          contents.push({ role: 'user', parts: [{ text: systemPrompt + '\n\n【質問】\n' + question }] });
        } else {
          contents.push({ role: 'user', parts: [{ text: '【最新の検索データ】\n' + notionContext + '\n\n【質問】\n' + question }] });
        }

        const data = await callGemini(env, contents);
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "回答を取得できませんでした";
        if (isGeminiFailure(answer)) {
          ctx.waitUntil(logToNotion(env, "エラー", "仕入先検索", "Gemini応答取得失敗", JSON.stringify(data)));
        }
        return new Response(JSON.stringify({ answer }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      if (path === "/gemini/ask" && request.method === "POST") {
        const { question, notionContext, history = [] } = await request.json();

        // システムプロンプト（AIへの役割指示）
        const systemPrompt = `あなたはTR大阪（ノベルティ・販促グッズの営業会社）の営業支援AIです。
以下のデータベースの情報をもとに質問に答えてください。

・決定商品DB：過去に受注・納品した商品の実績データ（商材名、売単価、数量、粗利率、仕入先、納期など）
・裏取りDB：仕入先ごとの商品コスト情報（商品名、仕入先会社名、仕入単価・数量ごとの単価など）
・仕入先DB：仕入先ごとの取扱商材情報（業種、商品分類、商品種別、商品詳細）や連絡先・コスト表の有無

【今回の検索で取得したデータ】
${notionContext}

【共通ルール】
・マークダウン記号（**や*や#）は絶対に使わない
・箇条書きは「・」と「→」を使う
・金額は必ず「仕入単価」「売単価」「数量○個時」など文脈を明示する
・前の会話の内容も踏まえて回答する

【仕入先・仕入コストを聞かれた場合の情報源の優先順位】
・裏取りDB（実際の仕入実績）を最優先
・次に仕入先DB（業種・商品分類・商品種別・商品詳細から取扱可否を判断した候補）を補足として使う
・決定商品DBの実績はその次（このデータに含まれている場合のみ）
・要注意仕入先に該当する仕入先（取引停止・反社・情報開示不可など）は絶対に紹介しない
・仕入先DBのコスト表は、候補リストでは有無だけ（コスト表あり／なし）を明記し、更新日や格納先は書かない。ユーザーがコスト表の詳細を求めてきた時だけ、更新日と格納先アドレスを共有する
・仕入先DBの連絡先（担当者・メール・電話）は、初回の回答では書かず「連絡先が必要であればコメントください」と一言添える程度に留める。ユーザーが連絡先を求めてきた時だけ、以下のフォーマットで共有する（担当者①のメール・電話は必ず担当者①の情報、担当者②のメール・電話は必ず担当者②の情報とセットで書く。担当者を取り違えないこと）：

・仕入先名：○○
・担当者：○○（①） ／ メール：○○ ／ 電話：○○
・担当者：○○（②） ／ メール：○○ ／ 電話：○○　※担当者②がいる場合のみ
・備考：注意事項があれば記載（なければ省略）

【仕入先・仕入コストを聞かれた場合の回答フォーマット】

1行目：サマリ（例：アクリル製品の仕入先候補をご案内します。※件数は数えて言わないこと）

・裏取りDBからの候補
  ・仕入先名A
  ・仕入先名B
  ・仕入先名C（最大3社）
・仕入先DBからの候補（取扱商材が合致するもの。あれば。コスト表がある場合は「コスト表あり」も併記）
  ・仕入先名（1〜2社）
・決定商品DBからの候補
  ・仕入先名（1〜2社。なければ「記録なし」）

詳細情報は以下の通りです。

＜裏取りDB＞
・仕入先名
  → 商品名 ／ サイズ・仕様 ／ 数量 ／ 仕入単価
  → 商品名 ／ サイズ・仕様 ／ 数量 ／ 仕入単価
  （1社につき2〜3件まで）
・仕入先名
  → ...

＜仕入先DB＞
・仕入先名
  → 取扱商材：業種／商品分類／商品種別・商品詳細の要約
  （1〜2社まで）

＜決定商品DB＞
・仕入先名
  → 商品名 ／ 顧客名 ／ 納品日 ／ 数量 ／ 売単価
  （1社につき1〜2件まで）

【仕入先・仕入コスト以外を聞かれた場合】
・最初に1〜2行のサマリを書く
・箇条書きで簡潔にまとめる
・情報は絞って読み手の負担を減らす

【数量の解釈ルール】
・「○個以下」と聞かれたら、その数量以下のデータを該当として扱う
  例：「1000個以下の情報は？」→500個や300個のデータも「あります」と答える
・「○個程度」と聞かれたら、その前後の数量データも参考として提示する
・データの数量フィールドの値を正確に確認してから「ない」と判断すること

【回答の最後に必ず1行追加するルール】
・ユーザーが「ほかの情報も」「もっと詳しく」など曖味な追加質問をした場合、質問の意図を勝手に解釈して質問の仕方をアドバイスするのではなく、今のデータの中で答えられる範囲を答えること
・全ての回答の最後に、次の一文を必ず添える：
　「（さらに知りたい場合は『もっと見せて』『ほかの仕様も教えて』『納期は？』のように聞いてください）」
・ただしこの文言は誘導文であり、ユーザーの質問に対する回答そのものではない。質問への回答を済ませた後に付け加えること`;

        // 会話履歴をGemini形式に変換
        // ※ 最初のターンにシステムプロンプトを含める
        const contents = [];

        // 過去の会話履歴を追加
        for (const msg of history) {
          contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
          });
        }

        // 今回の質問を追加（システムプロンプトと一緒に）
        if (contents.length === 0) {
          // 初回：システムプロンプトと質問をまとめて送る
          contents.push({
            role: 'user',
            parts: [{ text: systemPrompt + '\n\n【質問】\n' + question }]
          });
        } else {
          // 2回目以降：データを更新して質問を送る
          contents.push({
            role: 'user',
            parts: [{ text: `【最新の検索データ】\n${notionContext}\n\n【質問】\n${question}` }]
          });
        }

        const data = await callGemini(env, contents);
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "回答を取得できませんでした";
        if (isGeminiFailure(answer)) {
          ctx.waitUntil(logToNotion(env, "エラー", "一問一答", "Gemini応答取得失敗", JSON.stringify(data)));
        }
        return new Response(JSON.stringify({ answer }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ status: "tr-notion-proxy is running" }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });

    } catch (e) {
      ctx.waitUntil(logToNotion(env, "エラー", "システム", e.message, e.stack || ""));
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  },
};