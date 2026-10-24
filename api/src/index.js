import KNOWLEDGE from "./knowledge.txt";
import KNOWLEDGE2 from "./knowledge2.txt";

const SYSTEM_PROMPT = `You are a friendly customer service assistant for [YOUR COMPANY].
Answer ONLY using the company information below. Keep replies short and clear.
If the answer is not in the information, say you don't know and offer to connect the customer with a human agent.
Never invent prices, features, or policies.

COMPANY INFORMATION:
${KNOWLEDGE}

${KNOWLEDGE2}`;
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

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_KEY}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...safe],
      }),
    });
    return new Response(await r.text(), { headers: { ...cors, "Content-Type": "application/json" } });
  },
};