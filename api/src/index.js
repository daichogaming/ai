import KNOWLEDGE from "./knowledge.txt";
import DOC from "./knowledge3.txt";
import CATALOG from "./catalog.txt";

const BASE_PROMPT = `Bạn là trợ lý chăm sóc khách hàng thân thiện của Hanvico (chăn ga gối đệm).
Chỉ trả lời dựa trên thông tin công ty bên dưới. Trả lời ngắn gọn, rõ ràng, bằng tiếng Việt; nếu khách viết tiếng Anh thì trả lời bằng tiếng Anh.
Nếu thông tin không có, hãy nói bạn chưa có thông tin đó và mời khách liên hệ nhân viên Hanvico.
Không bịa giá, tính năng hay chính sách. Giá là giá niêm yết; không tự giảm giá hay hứa quà tặng, hãy mời khách liên hệ để biết ưu đãi hiện hành.
Không nói đệm chữa được bệnh; chỉ nói hỗ trợ nâng đỡ và khuyên hỏi bác sĩ khi có bệnh lý.
Khi báo giá, nêu rõ tên sản phẩm, kích thước và giá.

THÔNG TIN CÔNG TY:
${KNOWLEDGE}`;

// ---- text helpers: ignore accents so "dem lo xo" matches "đệm lò xo" ----
function norm(s) {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
}

function tokens(s) {
  const w = norm(s).match(/[\p{L}\p{N}]+/gu) || [];
  const out = [...w];
  for (let i = 0; i < w.length - 1; i++) out.push(w[i] + " " + w[i + 1]);
  return out;
}

// customers say "1m8", the price list says 180x200
const SIZE_ALIASES = {
  "1m2": "120x200 120x190", "1m4": "140x200", "1m5": "150x190", "1m6": "160x200",
  "1m8": "180x200", "2m2": "200x220", "1m": "100x200",
};
function expandQuery(q) {
  let extra = "";
  for (const t of norm(q).match(/[\p{L}\p{N}]+/gu) || []) if (SIZE_ALIASES[t]) extra += " " + SIZE_ALIASES[t];
  return q + extra;
}

// ---- split text into chunks (~180 words each) ----
// sep = how to split into blocks: blank lines for the document, one row per line for the catalog
function makeChunks(text, maxWords = 180, sep = /\n\s*\n/) {
  const paras = text.split(sep).map(p => p.trim()).filter(Boolean);
  const pieces = [];
  for (const p of paras) {
    const w = p.split(/\s+/);
    if (w.length > maxWords * 1.5) {
      for (let i = 0; i < w.length; i += maxWords) pieces.push(w.slice(i, i + maxWords).join(" "));
    } else pieces.push(p);
  }
  const chunks = [];
  let cur = [], count = 0;
  for (const p of pieces) {
    const n = p.split(/\s+/).length;
    if (count + n > maxWords && cur.length) { chunks.push(cur.join("\n")); cur = []; count = 0; }
    cur.push(p); count += n;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

// the catalog is smaller chunks (~90 words) so a price question gets the right rows, not a whole page
const CHUNKS = [...makeChunks(DOC), ...makeChunks(CATALOG, 90, /\n+/)];
const CHUNK_TOKENS = CHUNKS.map(c => new Set(tokens(c)));
const DF = new Map();
CHUNK_TOKENS.forEach(set => set.forEach(t => DF.set(t, (DF.get(t) || 0) + 1)));
const N = CHUNKS.length;

function search(query, k = 6) {
  const q = new Set(tokens(expandQuery(query)));
  return CHUNK_TOKENS
    .map((set, i) => {
      let score = 0;
      q.forEach(t => { if (set.has(t)) score += Math.log(1 + N / (DF.get(t) || 1)); });
      return { i, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => CHUNKS[s.i]);
}

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });

    const { messages } = await req.json();
    const safe = (messages || []).slice(-10).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).slice(0, 1000),
    }));

    // find the chunks that match the customer's last 2 questions
    const query = safe.filter(m => m.role === "user").slice(-2).map(m => m.content).join(" ");
    const found = search(query);
    const docPart = found.length
      ? "\n\nTHÔNG TIN LIÊN QUAN (tài liệu và bảng giá):\n" + found.join("\n---\n")
      : "";

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_KEY}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "system", content: BASE_PROMPT + docPart }, ...safe],
      }),
    });
    return new Response(await r.text(), { headers: { ...cors, "Content-Type": "application/json" } });
  },
};