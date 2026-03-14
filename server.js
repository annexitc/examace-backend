const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ── API KEYS (set these in Render environment variables) ──────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;

// ── SUBJECT ROUTING ───────────────────────────────────────────────────────────
// Subjects where we query BOTH AIs and pick the best
const DUAL_AI_SUBJECTS = [
  "biology", "chemistry", "physics", "mathematics",
  "further mathematics", "agricultural science"
];

// Subjects where Claude is clearly better
const CLAUDE_SUBJECTS = [
  "english", "literature", "government", "economics",
  "commerce", "accounting", "history", "geography",
  "civic", "christian", "islamic"
];

const shouldUseDualAI = (text) => {
  const lower = (text || "").toLowerCase();
  return DUAL_AI_SUBJECTS.some(s => lower.includes(s));
};

// ── CALL CLAUDE ───────────────────────────────────────────────────────────────
const callClaude = async (messages, system, imgData) => {
  let msgs = messages;

  if (imgData) {
    const txt = typeof messages === "string" ? messages
      : Array.isArray(messages) ? (messages[messages.length - 1]?.content || "") : "";
    msgs = [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: imgData.type, data: imgData.data } },
        { type: "text", text: txt }
      ]
    }];
  } else if (typeof messages === "string") {
    msgs = [{ role: "user", content: messages }];
  }

  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: msgs
  };
  if (system) body.system = system;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Claude error: ${data.error.message}`);
  return data.content?.find(b => b.type === "text")?.text || "";
};

// ── CALL GEMINI ───────────────────────────────────────────────────────────────
const callGemini = async (messages, system, imgData) => {
  const parts = [];

  // Add system context as first text part
  if (system) {
    parts.push({ text: `Context: ${system}\n\n` });
  }

  // Add image if present
  if (imgData) {
    parts.push({
      inline_data: {
        mime_type: imgData.type,
        data: imgData.data
      }
    });
  }

  // Add the actual message
  const lastMsg = typeof messages === "string" ? messages
    : Array.isArray(messages) ? (messages[messages.length - 1]?.content || "") : "";
  parts.push({ text: lastMsg });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      maxOutputTokens: 1000,
      temperature: 0.3,
    }
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
};

// ── PICK BEST ANSWER ──────────────────────────────────────────────────────────
// Simple scoring: longer, more structured answer wins
// Both answers are shown if very different, otherwise best one returned
const scorAnswer = (text) => {
  if (!text) return 0;
  let score = text.length;
  // Bonus for structured content
  if (text.includes("Step")) score += 500;
  if (text.includes("**")) score += 300;
  if (text.includes("•") || text.includes("-")) score += 200;
  if (text.includes("Example")) score += 400;
  if (text.includes("Formula") || text.includes("formula")) score += 400;
  if (text.includes("Tip") || text.includes("tip")) score += 200;
  // Penalise very short answers
  if (text.length < 200) score -= 1000;
  return score;
};

const pickBestAnswer = (claudeAnswer, geminiAnswer, subject) => {
  const claudeScore = scorAnswer(claudeAnswer);
  const geminiScore = scorAnswer(geminiAnswer);

  console.log(`📊 Claude score: ${claudeScore} | Gemini score: ${geminiScore}`);

  // If one failed, use the other
  if (!claudeAnswer && geminiAnswer) return { answer: geminiAnswer, source: "Gemini" };
  if (!geminiAnswer && claudeAnswer) return { answer: claudeAnswer, source: "Claude" };
  if (!claudeAnswer && !geminiAnswer) return { answer: "Both AIs failed to respond. Please try again.", source: "Error" };

  // If scores are close (within 20%), combine insights
  const diff = Math.abs(claudeScore - geminiScore);
  const avg = (claudeScore + geminiScore) / 2;

  if (diff / avg < 0.2 && claudeAnswer.length > 300 && geminiAnswer.length > 300) {
    // Both gave good answers — combine them
    const combined = `${claudeAnswer}\n\n━━━━━━━━━━━━\n💡 **Additional insight from Gemini AI:**\n${geminiAnswer.slice(0, 400)}...`;
    return { answer: combined, source: "Claude + Gemini" };
  }

  // Otherwise return the higher scoring one
  if (claudeScore >= geminiScore) {
    return { answer: claudeAnswer, source: "Claude" };
  } else {
    return { answer: geminiAnswer, source: "Gemini" };
  }
};

// ── MAIN CHAT ENDPOINT ────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  console.log("📨 Request received:", JSON.stringify(req.body).slice(0, 120));

  const { messages, system, imgData: bodyImgData } = req.body;

  // Detect subject from system prompt or messages
  const context = `${system || ""} ${JSON.stringify(messages || "")}`.toLowerCase();
  const useDual = shouldUseDualAI(context);

  console.log(`🧠 AI Mode: ${useDual ? "Claude + Gemini (Dual)" : "Claude only"}`);

  try {
    let answer, source;

    if (useDual && GEMINI_KEY) {
      // Query BOTH AIs in parallel for speed
      const [claudeResult, geminiResult] = await Promise.allSettled([
        callClaude(messages, system, bodyImgData),
        callGemini(messages, system, bodyImgData)
      ]);

      const claudeAnswer = claudeResult.status === "fulfilled" ? claudeResult.value : "";
      const geminiAnswer = geminiResult.status === "fulfilled" ? geminiResult.value : "";

      if (claudeResult.status === "rejected") console.error("❌ Claude failed:", claudeResult.reason?.message);
      if (geminiResult.status === "rejected") console.error("❌ Gemini failed:", geminiResult.reason?.message);

      const best = pickBestAnswer(claudeAnswer, geminiAnswer, context);
      answer = best.answer;
      source = best.source;
    } else {
      // Claude only for non-science subjects
      answer = await callClaude(messages, system, bodyImgData);
      source = "Claude";
    }

    console.log(`✅ Response from: ${source} (${answer.length} chars)`);

    // Return in Anthropic format so frontend works without changes
    res.json({
      content: [{ type: "text", text: answer }],
      source: source
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({
      content: [{ type: "text", text: "⚠️ Service temporarily unavailable. Please try again." }],
      error: err.message
    });
  }
});

// ── WHATSAPP WEBHOOK (Twilio) ─────────────────────────────────────────────────
app.post("/whatsapp", async (req, res) => {
  const { Body, From, MediaUrl0, MediaContentType0 } = req.body;
  const userMsg = (Body || "").trim();

  console.log(`📱 WhatsApp from ${From}: ${userMsg.slice(0, 80)}`);

  const SYSTEM = `You are ExamAce AI — Nigeria's #1 WAEC/NECO/JAMB exam tutor.
Be helpful, encouraging, Nigeria-context aware.
Format responses for WhatsApp: **bold** key terms, emojis, short paragraphs, max 250 words.
Always end with a relevant exam tip or next action.`;

  let messages, imgData;

  if (MediaUrl0) {
    // Student sent a photo of a question
    try {
      const imgRes = await fetch(MediaUrl0, {
        headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}` }
      });
      const imgBuffer = await imgRes.arrayBuffer();
      const base64 = Buffer.from(imgBuffer).toString("base64");
      imgData = { data: base64, type: MediaContentType0 || "image/jpeg" };
      messages = userMsg || "Read and solve ALL question(s) in this image. Give complete step-by-step solution with WAEC/JAMB marking scheme.";
    } catch (e) {
      console.error("Image fetch error:", e.message);
      messages = userMsg || "Help me with this question";
    }
  } else {
    messages = [{ role: "user", content: userMsg }];
  }

  try {
    const context = `${SYSTEM} ${userMsg}`.toLowerCase();
    const useDual = shouldUseDualAI(context);
    let answer, source;

    if (useDual && GEMINI_KEY) {
      const [claudeResult, geminiResult] = await Promise.allSettled([
        callClaude(messages, SYSTEM, imgData),
        callGemini(messages, SYSTEM, imgData)
      ]);
      const claudeAnswer = claudeResult.status === "fulfilled" ? claudeResult.value : "";
      const geminiAnswer = geminiResult.status === "fulfilled" ? geminiResult.value : "";
      const best = pickBestAnswer(claudeAnswer, geminiAnswer, context);
      answer = best.answer;
      source = best.source;
    } else {
      answer = await callClaude(messages, SYSTEM, imgData);
      source = "Claude";
    }

    // WhatsApp has 1600 char limit
    const reply = answer.slice(0, 1550) + (answer.length > 1550 ? "\n\n_[Reply MORE for rest]_" : "");

    console.log(`✅ WhatsApp reply via ${source} sent to ${From}`);

    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${reply.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</Message>
</Response>`);

  } catch (err) {
    console.error("WhatsApp error:", err.message);
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>⚠️ Service temporarily unavailable. Please try again in a moment!</Message>
</Response>`);
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "✅ ExamAce AI Backend Running",
    ai: {
      claude: ANTHROPIC_KEY ? "✅ Connected" : "❌ Missing API key",
      gemini: GEMINI_KEY    ? "✅ Connected" : "❌ Missing API key",
    },
    routing: {
      science: "Claude + Gemini (dual AI, best answer picked)",
      humanities: "Claude only"
    }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ ExamAce AI backend running on port ${PORT}`));