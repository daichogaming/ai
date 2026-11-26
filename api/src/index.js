import KNOWLEDGE from "./knowledge.txt";
import DOC from "./knowledge3.txt";
import CATALOG from "./catalog.txt";

// ===== CẤU HÌNH =====
// Chỉ các trang này được gọi chatbot (thêm tên miền riêng của bạn nếu có)
const ALLOWED_ORIGINS = [
  "https://daichogaming.github.io",
  "http://127.0.0.1:5500", // Live Server khi test trên máy
  "http://localhost:5500",
];
// Hotline / Zalo / email để bot đưa cho khách khi cần gặp nhân viên. Để trống nếu chưa có.
const CONTACT = "";

const BASE_PROMPT = `Bạn là trợ lý chăm sóc khách hàng thân thiện của Hanvico (chăn ga gối đệm).
Chỉ trả lời dựa trên thông tin công ty bên dưới. Trả lời ngắn gọn, rõ ràng, bằng tiếng Việt; nếu khách viết tiếng Anh thì trả lời bằng tiếng Anh.
Chỉ viết văn bản thuần: không dùng Markdown (không **, không #, không bảng |). Muốn liệt kê thì mỗi ý một dòng, bắt đầu bằng dấu "-".
Nếu thông tin không có, hãy nói bạn chưa có thông tin đó và mời khách liên hệ nhân viên Hanvico.${CONTACT ? "\nKhi khách cần gặp nhân viên hoặc muốn mua hàng, hướng dẫn khách liên hệ: " + CONTACT : ""}
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

// ---- split text into chunks ----
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

// remove leftover Markdown so the chat shows clean text
const clean = t => t
  .replace(/\*\*(.+?)\*\*/gs, "$1")
  .replace(/^#{1,6}\s*/gm, "")
  .replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, "")
  .trim();

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...(origin ? corsHeaders(origin) : {}), "Content-Type": "application/json" },
  });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const originOk = ALLOWED_ORIGINS.includes(origin);

    if (req.method === "OPTIONS") {
      return originOk ? new Response(null, { headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
    }
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    if (!originOk) return json({ error: "forbidden" }, 403, null);

    // optional per-visitor limit (needs the "ratelimits" binding in wrangler.jsonc)
    if (env.RATE_LIMITER) {
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: "rate_limited" }, 429, origin);
    }

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400, origin); }
    const safe = (Array.isArray(body?.messages) ? body.messages : [])
      .filter(m => m && typeof m.content === "string" && m.content.trim())
      .slice(-10)
      .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.slice(0, 1000) }));
    if (!safe.length || safe[safe.length - 1].role !== "user") return json({ error: "bad_request" }, 400, origin);

    // find the chunks that match the customer's last 2 questions
    const query = safe.filter(m => m.role === "user").slice(-2).map(m => m.content).join(" ");
    const found = search(query);
    const docPart = found.length
      ? "\n\nTHÔNG TIN LIÊN QUAN (tài liệu và bảng giá):\n" + found.join("\n---\n")
      : "";

    let r;
    try {
      r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_KEY}` },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages: [{ role: "system", content: BASE_PROMPT + docPart }, ...safe],
        }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      console.error("groq request failed:", e);
      return json({ error: "upstream_timeout" }, 504, origin);
    }
    if (!r.ok) {
      console.error("groq error", r.status, (await r.text()).slice(0, 300));
      return json({ error: "upstream_error" }, r.status === 429 ? 429 : 502, origin);
    }
    const data = await r.json();
    const reply = clean(data?.choices?.[0]?.message?.content || "");
    if (!reply) return json({ error: "empty_reply" }, 502, origin);
    return json({ reply }, 200, origin);
  },
};