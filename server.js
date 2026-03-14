const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const API_KEY = process.env.ANTHROPIC_API_KEY;

app.post("/api/chat", async (req, res) => {
  console.log("📨 Request received:", JSON.stringify(req.body).slice(0, 100));
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const text = await response.text();
    console.log("📬 Anthropic status:", response.status);
    console.log("📬 Anthropic response:", text.slice(0, 200));

    const data = JSON.parse(text);
    res.json(data);
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ExamAce Backend Running ✅" }));

app.listen(3001, () => console.log("✅ ExamAce backend on http://localhost:3001"));