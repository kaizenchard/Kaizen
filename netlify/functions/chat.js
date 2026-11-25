// Netlify Function: receives chat messages from the page, calls the Claude API,
// and returns the reply. The API key lives in a Netlify environment variable,
// so it is never exposed in the browser.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Server is missing ANTHROPIC_API_KEY" });
  }

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
  const cleaned = messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== ""
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (cleaned.length === 0 || cleaned[0].role !== "user") {
    return json(400, { error: "Conversation must start with a user message" });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 1024,
        system:
          "You are KAIZEN, a friendly, concise AI assistant inside a chat web page. Keep answers clear and plain text (no markdown).",
        messages: cleaned,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Claude API error:", data);
      return json(502, { error: "The AI service returned an error" });
    }

    const reply = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

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
