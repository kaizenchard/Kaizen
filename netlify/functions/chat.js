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

  // Main model. Change it in Netlify with the GEMINI_MODEL variable (or delete
  // that variable to use the default below).
  const mainModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";

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

  // Models to use, in order. If one is slow, failing or busy, the next one is
  // started alongside it and whichever answers first wins.
  const models = [
    mainModel,
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);

  const body = JSON.stringify({
    system_instruction: {
      parts: [
        {
          text: "You are KAIZEN, a friendly, concise AI assistant inside a chat web page. Keep answers clear and plain text (no markdown).",
        },
      ],
    },
    contents,
  });

  async function callModel(m) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body,
          signal: AbortSignal.timeout(8500),
        }
      );
      const data = await res.json();
      if (res.ok) {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const reply = parts.map((p) => p.text || "").join("").trim();
        if (reply) return { ok: true, reply };
        return { ok: false, status: 200, model: m, detail: "empty reply (the answer may have been blocked)" };
      }
      console.error("Gemini API error:", m, res.status, JSON.stringify(data));
      return {
        ok: false,
        status: res.status,
        model: m,
        detail: data?.error?.message || "unknown error",
        // Wrong key / bad request: other models won't help.
        fatal: res.status === 400 || res.status === 401 || res.status === 403,
      };
    } catch (e) {
      console.error("Gemini request failed:", m, String(e));
      return { ok: false, status: 0, model: m, detail: `request failed or timed out (${e.name || "error"})` };
    }
  }

  // Start the first model now; start the next one after 3 seconds (or at once
  // if the previous one fails). First good answer wins.
  const result = await new Promise((resolve) => {
    let next = 0;
    let pending = 0;
    let done = false;
    let last = null;
    const timers = [];

    const finish = (r) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      resolve(r);
    };

    const launch = () => {
      if (done || next >= models.length) return;
      const m = models[next++];
      pending++;
      callModel(m).then((r) => {
        pending--;
        if (r.ok) return finish(r);
        last = r;
        if (r.fatal) return finish(r);
        if (next < models.length) launch();
        else if (pending === 0) finish(last);
      });
      if (next < models.length) timers.push(setTimeout(launch, 3000));
    };

    launch();
    // Stop before Netlify's own time limit cuts the function off.
    timers.push(
      setTimeout(
        () => finish(last || { ok: false, status: 0, model: mainModel, detail: "timed out" }),
        9000
      )
    );
  });

  if (result.ok) {
    return json(200, { reply: result.reply });
  }

  if (result.status === 429 || result.status === 500 || result.status === 503) {
    return json(503, { error: "KAIZEN is very busy right now. Please try again in a moment." });
  }

  return json(502, {
    error: `The AI service returned an error (${result.status}, model ${result.model}): ${result.detail}`,
  });
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
