const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const KETTEI_DB_ID = "360562954f43813f8594fbe03f95a8e8";
const URATORI_DB_ID = "367562954f4381ccbdc2de32ac92f2b5";
const SHIIRE_DB_ID = "3aa562954f4381f09834d037005aba3e"; // 仕入先DB（2026年7月新設）
const LOG_DB_ID = "58f7f7959c814310ae9a27d5b7fcc299"; // 🪵 AIツール_ログ

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

export default {
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

      if (path === "/notion/search" && request.method === "POST") {
        const body = await request.json();
        const dbId = body.database_id;
        const keyword = body.keyword || "";
        const costMin = body.cost_min ?? null;
        const costMax = body.cost_max ?? null;
        const qtyMin = body.qty_min ?? null;
        const qtyMax = body.qty_max ?? null;

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