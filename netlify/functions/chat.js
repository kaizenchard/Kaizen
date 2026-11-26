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

  // Models to try, in order. The first is your main model; the others are
  // fallbacks (Google's "latest" aliases) used when the main one is busy or gone.
  const models = [
    model,
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
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

  const deadline = Date.now() + 8000; // stop starting new attempts after ~8 seconds
  let lastStatus = 0;
  let lastDetail = "";
  let lastModel = model;

  try {
    for (let mi = 0; mi < models.length; mi++) {
      const m = models[mi];
      // Retry the main model twice (busy spikes), fallbacks once.
      const attempts = mi === 0 ? 2 : 1;

      for (let a = 0; a < attempts; a++) {
        if (Date.now() > deadline) break;
        lastModel = m;

        let res, data;
        try {
          res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body,
              signal: AbortSignal.timeout(8000),
            }
          );
          data = await res.json();
        } catch (e) {
          lastStatus = 0;
          lastDetail = "request timed out or failed";
          console.error("Gemini request failed:", m, String(e));
          continue; // try again / next model
        }

        if (res.ok) {
          const parts = data?.candidates?.[0]?.content?.parts || [];
          const reply = parts.map((p) => p.text || "").join("").trim();
          if (reply) return json(200, { reply });
          lastStatus = 200;
          lastDetail = "empty reply (the answer may have been blocked)";
          break; // move to next model
        }

        lastStatus = res.status;
        lastDetail = data?.error?.message || "unknown error";
        console.error("Gemini API error:", m, res.status, JSON.stringify(data));

        // Wrong key / bad request: other models won't help, stop now.
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          return json(502, {
            error: `The AI service rejected the request (${res.status}): ${lastDetail}`,
          });
        }

        // Model gone: skip straight to the next model.
        if (res.status === 404) break;

        // Busy / rate limited / server error: brief pause, then retry.
        if (a < attempts - 1) await sleep(800);
      }
    }

    if (lastStatus === 429 || lastStatus === 503 || lastStatus === 500) {
      return json(503, {
        error: "KAIZEN is very busy right now. Please try again in a moment.",
      });
    }
    return json(502, {
      error: `The AI service returned an error (${lastStatus}, model ${lastModel}): ${lastDetail}`,
    });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Something went wrong" });
  }
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
