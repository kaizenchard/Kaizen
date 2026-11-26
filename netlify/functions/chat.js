// Netlify Function: receives chat messages from the page, calls the Gemini API,
// and returns the reply. The API key lives in a Netlify environment variable,
// so it is never exposed in the browser.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Server is missing GEMINI_API_KEY" });
  }

  // You can change the model in Netlify (env var GEMINI_MODEL) without editing code.
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  let messages;
  try {
    ({ messages } = JSON.parse(event.body || "{}"));
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: "No messages provided" });
  }

  // Keep only the last 20 turns, valid roles, and cap message length.
  // Gemini calls the AI's role "model" instead of "assistant".
  const contents = messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== ""
    )
    .slice(-20)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, 4000) }],
    }));

  if (contents.length === 0 || contents[0].role !== "user") {
    return json(400, { error: "Conversation must start with a user message" });
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [
              {
                text: "You are KAIZEN, a friendly, concise AI assistant inside a chat web page. Keep answers clear and plain text (no markdown).",
              },
            ],
          },
          contents,
        }),
      }
    );

    const data = await res.json();

    if (!res.ok) {
      console.error("Gemini API error:", JSON.stringify(data));
      if (res.status === 429) {
        return json(429, { error: "Too many requests right now. Try again in a minute." });
      }
      const detail = data?.error?.message || "unknown error";
      return json(502, {
        error: `The AI service returned an error (${res.status}, model ${model}): ${detail}`,
      });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const reply = parts
      .map((p) => p.text || "")
      .join("")
      .trim();

    return json(200, { reply: reply || "(no reply)" });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Something went wrong" });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
