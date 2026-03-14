const express = require("express");
const cors    = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ═══════════════════════════════════════════════════════════════════════════════
// ENV KEYS — set all in Render environment variables
// ═══════════════════════════════════════════════════════════════════════════════
const ALOC_TOKEN    = process.env.ALOC_ACCESS_TOKEN;   // e.g. ALOC-78bfe77b49fb3e407bf8
const GEMINI_KEY    = process.env.GEMINI_API_KEY;
const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY;
const GROQ_KEY      = process.env.GROQ_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ═══════════════════════════════════════════════════════════════════════════════
// ALOC SUBJECT & TYPE MAPS
// ALOC uses specific slug names — we map from human names to ALOC slugs
// ═══════════════════════════════════════════════════════════════════════════════
const ALOC_SUBJECT_MAP = {
  // human name          : aloc slug
  "mathematics"          : "mathematics",
  "further mathematics"  : "mathematics",      // ALOC has no "further maths" — use maths
  "english language"     : "english",
  "english"              : "english",
  "use of english"       : "english",
  "physics"              : "physics",
  "chemistry"            : "chemistry",
  "biology"              : "biology",
  "economics"            : "economics",
  "government"           : "government",
  "literature in english": "englishlit",
  "literature"           : "englishlit",
  "accounting"           : "accounting",
  "commerce"             : "commerce",
  "geography"            : "geography",
  "agricultural science" : "biology",          // ALOC has no agric — biology is closest
  "civic education"      : "civiledu",
  "christian religious studies": "crk",
  "crk"                  : "crk",
  "islamic studies"      : "irk",
  "irk"                  : "irk",
  "history"              : "history",
  "insurance"            : "insurance",
  "current affairs"      : "currentaffairs",
};

// ALOC exam type map
const ALOC_TYPE_MAP = {
  "jamb"   : "utme",
  "utme"   : "utme",
  "waec"   : "wassce",
  "wassce" : "wassce",
  "neco"   : "wassce",   // ALOC doesn't have a separate NECO type — wassce is closest
  "post-utme": "post-utme",
};

// Years ALOC has data for (2001–2020)
const ALOC_AVAILABLE_YEARS = [
  2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,
  2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,
];

// ═══════════════════════════════════════════════════════════════════════════════
// ALOC API CALLER
// Fetches REAL past questions from the ALOC database
// Docs: https://github.com/Seunope/aloc-endpoints/wiki/API-Parameters
//
// Endpoints:
//   GET /api/v2/q?subject=&year=&type=        → 1 question
//   GET /api/v2/m?subject=&year=&type=        → up to 40 questions
//   GET /api/v2/q/{n}?subject=&year=&type=    → n questions (max 40)
// ═══════════════════════════════════════════════════════════════════════════════
const ALOC_BASE = "https://questions.aloc.com.ng/api/v2";

const alocHeaders = () => ({
  "Accept":       "application/json",
  "Content-Type": "application/json",
  "AccessToken":  ALOC_TOKEN || "",
});

/**
 * Fetch real past questions from ALOC
 * @param {string} subject  - human-readable subject name
 * @param {string} examType - "waec" | "jamb" | "neco"
 * @param {number|string} year - e.g. 2018, or null for random
 * @param {number} count    - how many questions (max 40 per call)
 * @returns {Array} normalised question objects
 */
const fetchALOC = async (subject, examType, year, count = 20) => {
  if (!ALOC_TOKEN) throw new Error("ALOC token not configured");

  const alocSubject = ALOC_SUBJECT_MAP[subject?.toLowerCase()];
  if (!alocSubject) throw new Error(`Subject "${subject}" not available in ALOC`);

  const alocType    = ALOC_TYPE_MAP[examType?.toLowerCase()] || "utme";
  const alocYear    = ALOC_AVAILABLE_YEARS.includes(Number(year)) ? year : null;

  // Clamp to ALOC max of 40 per call
  const safeCount = Math.min(count, 40);

  // Build URL: use /m for max 40, or /q/{n} for a specific count
  let url;
  if (safeCount >= 40) {
    url = `${ALOC_BASE}/m?subject=${alocSubject}&type=${alocType}`;
  } else {
    url = `${ALOC_BASE}/q/${safeCount}?subject=${alocSubject}&type=${alocType}`;
  }
  if (alocYear) url += `&year=${alocYear}`;

  console.log(`📚 ALOC fetch: ${url}`);

  const res = await fetch(url, { headers: alocHeaders() });
  if (!res.ok) throw new Error(`ALOC HTTP ${res.status}`);

  const data = await res.json();

  // ALOC response can be wrapped in several ways depending on version:
  //   { data: [...] }  — most common
  //   { body: [...] }  — some endpoints
  //   [...]            — direct array
  //   { status, data: { data: [...] } }  — nested
  let raw = [];
  if (Array.isArray(data)) {
    raw = data;
  } else if (Array.isArray(data.data)) {
    raw = data.data;
  } else if (Array.isArray(data.body)) {
    raw = data.body;
  } else if (data.data && Array.isArray(data.data.data)) {
    raw = data.data.data;
  } else {
    // Log the actual shape so we can debug
    console.warn("ALOC unexpected response shape:", JSON.stringify(data).slice(0, 300));
    raw = [];
  }

  if (!raw.length) throw new Error("ALOC returned 0 questions");

  // Normalise and filter out any questions with missing data
  const normalised = raw
    .map(q => normaliseALOC(q, examType, subject))
    .filter(q => q !== null);   // normaliseALOC returns null for bad questions

  console.log(`📚 ALOC: ${raw.length} raw → ${normalised.length} valid questions`);

  if (!normalised.length) throw new Error("ALOC returned questions but all had empty options — check API response format");

  return normalised;
};

/**
 * Normalise an ALOC question to our standard format.
 *
 * ALOC actual API response shape (from live inspection):
 * {
 *   id, question,
 *   a, b, c, d,           ← option fields are SINGLE LETTERS not "option_a"
 *   answer: "A"|"B"|"C"|"D"  OR full answer text,
 *   solution, year, examtype, subject
 * }
 *
 * Some older ALOC responses still use option_a/b/c/d — we handle both.
 */
const normaliseALOC = (q, examType, subject) => {
  // ── Extract option text — handle both field naming conventions ─────────────
  // New ALOC format: q.a, q.b, q.c, q.d
  // Old ALOC format: q.option_a, q.option_b, q.option_c, q.option_d
  const optA = String(q.a || q.option_a || q.optionA || q.OptionA || "").trim();
  const optB = String(q.b || q.option_b || q.optionB || q.OptionB || "").trim();
  const optC = String(q.c || q.option_c || q.optionC || q.OptionC || "").trim();
  const optD = String(q.d || q.option_d || q.optionD || q.OptionD || "").trim();

  // ── Extract question text ──────────────────────────────────────────────────
  const questionText = String(q.question || q.q || q.body || "").trim();

  // ── Normalise answer to letter A/B/C/D ────────────────────────────────────
  let answer = String(q.answer || q.correct || q.correct_answer || "A").trim();

  // If answer is longer than 1 char, it might be the full option text
  if (answer.length > 1) {
    // Try case-insensitive match against option texts
    const opts = [["A", optA], ["B", optB], ["C", optC], ["D", optD]];
    const match = opts.find(([, v]) => v && v.toLowerCase() === answer.toLowerCase());
    if (match) {
      answer = match[0];
    } else {
      // Try first-letter match: "A. Some text" → "A"
      const firstLetter = answer.charAt(0).toUpperCase();
      if (["A","B","C","D"].includes(firstLetter)) {
        answer = firstLetter;
      } else {
        // Last resort: default to A and log warning
        console.warn(`ALOC: could not determine answer letter for question ${q.id}, raw answer: "${answer}"`);
        answer = "A";
      }
    }
  } else {
    answer = answer.toUpperCase();
    if (!["A","B","C","D"].includes(answer)) answer = "A";
  }

  // ── Skip questions with empty options (data quality issue) ─────────────────
  const hasOptions = optA || optB || optC || optD;
  if (!hasOptions || !questionText) {
    console.warn(`ALOC: skipping question ${q.id} — missing question text or options`);
    return null;  // caller must filter out nulls
  }

  return {
    id:          q.id,
    q:           questionText,
    options: {
      A: optA,
      B: optB,
      C: optC,
      D: optD,
    },
    answer,
    explanation: String(q.solution || q.explanation || q.solutionNote || "See official marking scheme.").trim(),
    topic:       String(q.topic || q.section || subject || "").trim(),
    year:        q.year   || "Past",
    difficulty:  q.difficulty || "medium",
    source:      "ALOC",
    examType:    q.examtype || q.exam_type || examType,
  };
};

/**
 * Fetch many ALOC questions in batches (for CBT needing 60 questions)
 * ALOC max is 40 per call, so we call twice and merge/deduplicate for counts > 40
 */
const fetchALOCBatch = async (subject, examType, year, totalCount) => {
  const results = [];
  const seenIds = new Set();

  const batchSize = 40;
  const batches   = Math.ceil(totalCount / batchSize);

  for (let i = 0; i < batches; i++) {
    try {
      const qs = await fetchALOC(subject, examType, year, batchSize);
      for (const q of qs) {
        if (!seenIds.has(q.id) && q.q) {
          seenIds.add(q.id);
          results.push(q);
        }
        if (results.length >= totalCount) break;
      }
    } catch (e) {
      console.warn(`ALOC batch ${i+1} failed:`, e.message);
      break;
    }
    if (results.length >= totalCount) break;
  }

  return results.slice(0, totalCount);
};

// ═══════════════════════════════════════════════════════════════════════════════
// AI FALLBACK CALLERS (4-tier)
// Used when ALOC doesn't have enough questions for a subject/year
// ═══════════════════════════════════════════════════════════════════════════════
const NG_CONTEXT = `NIGERIA CURRICULUM RULES:
- All questions MUST follow Nigerian WAEC/NECO/JAMB SSCE syllabus exactly
- Use Nigerian examples: ₦ Naira, Lagos/Abuja/Kano not London/New York
- Nigerian history: independence 1960, civil war 1967-70, 1999 Constitution
- Biology: Nigerian flora/fauna (oil palm, tilapia, agama lizard)
- Economics: CBN, OPEC, ECOWAS, Niger Delta, Nigerian petroleum sector
- Geography: Sahel, Guinea Savanna, River Niger, River Benue, Jos Plateau
- Government: NASS, INEC, State Governors, LGAs
- All monetary values in Naira (₦)`;

const getLastMsg = (messages) => {
  if (typeof messages === "string") return messages;
  if (Array.isArray(messages)) return messages[messages.length - 1]?.content || "";
  return "";
};

// Gemini
const callGemini = async (messages, system, imgData) => {
  const parts = [];
  if (system) parts.push({ text: `${system}\n\n` });
  if (imgData) parts.push({ inline_data: { mime_type: imgData.type, data: imgData.data } });
  parts.push({ text: getLastMsg(messages) });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ contents:[{parts}], generationConfig:{maxOutputTokens:1500,temperature:0.3} }) }
  );
  const d = await res.json();
  if (d.error) throw new Error(`Gemini: ${d.error.message}`);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
};

// DeepSeek
const callDeepSeek = async (messages, system) => {
  const msgs = [...(system?[{role:"system",content:system}]:[]),{role:"user",content:getLastMsg(messages)}];
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${DEEPSEEK_KEY}`},
    body:JSON.stringify({ model:"deepseek-chat", max_tokens:1500, temperature:0.3, messages:msgs })
  });
  const d = await res.json();
  if (d.error) throw new Error(`DeepSeek: ${d.error.message}`);
  return d.choices?.[0]?.message?.content || "";
};

// Groq
const callGroq = async (messages, system) => {
  const msgs = [...(system?[{role:"system",content:system}]:[]),{role:"user",content:getLastMsg(messages)}];
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${GROQ_KEY}`},
    body:JSON.stringify({ model:"llama-3.3-70b-versatile", max_tokens:1500, temperature:0.3, messages:msgs })
  });
  const d = await res.json();
  if (d.error) throw new Error(`Groq: ${d.error.message}`);
  return d.choices?.[0]?.message?.content || "";
};

// Claude
const callClaude = async (messages, system, imgData) => {
  let msgs = messages;
  if (imgData) {
    msgs = [{ role:"user", content:[{type:"image",source:{type:"base64",media_type:imgData.type,data:imgData.data}},{type:"text",text:getLastMsg(messages)}] }];
  } else if (typeof messages === "string") {
    msgs = [{ role:"user", content:messages }];
  }
  const body = { model:"claude-sonnet-4-20250514", max_tokens:1500, messages:msgs };
  if (system) body.system = system;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"},
    body:JSON.stringify(body)
  });
  const d = await res.json();
  if (d.error) throw new Error(`Claude: ${d.error.message}`);
  return d.content?.find(b => b.type==="text")?.text || "";
};

// Quality check
const isAnswerSufficient = (text) => {
  if (!text || text.trim().length < 150) return false;
  const l = text.toLowerCase();
  return !l.includes("i'm not sure") && !l.includes("i cannot") && !l.includes("i don't know") && !l.includes("i am unable");
};

// Clarification triggers
const CLARIFICATION_TRIGGERS = [
  "i don't understand","i dont understand","not clear","confusing","confused",
  "explain better","explain again","can you clarify","clarify","what do you mean",
  "please explain","still don't get","still dont get","make it simpler",
  "simpler explanation","break it down","can you simplify","rephrase",
  "i'm lost","im lost","not getting it","elaborate","more detail",
];
const needsClarification = (text) => {
  const l = (text || "").toLowerCase();
  return CLARIFICATION_TRIGGERS.some(t => l.includes(t));
};

const STEM_SUBJECTS = ["mathematics","further mathematics","math","maths","physics","chemistry","biology","agricultural science","statistics","calculus"];
const isSTEM = (text) => { const l=(text||"").toLowerCase(); return STEM_SUBJECTS.some(s=>l.includes(s)); };

// 4-tier AI chat router (for /api/chat — general questions, not question generation)
const smartAnswer = async (messages, system, imgData) => {
  const lastMsg = getLastMsg(messages);
  const context = `${system||""} ${lastMsg}`;
  const clarification = needsClarification(lastMsg);
  const stem = isSTEM(context);

  if (imgData) {
    let ans = "";
    try { ans = await callGemini(messages, system, imgData); if(isAnswerSufficient(ans)) return {answer:ans,source:"Gemini"}; } catch(e){console.error("Gemini img:",e.message);}
    if (ANTHROPIC_KEY) {
      try { ans = await callClaude(messages, system, imgData); if(ans) return {answer:ans,source:"Claude"}; } catch(e){console.error("Claude img:",e.message);}
    }
    return { answer: ans || "⚠️ Could not read image. Please try again.", source:"Error" };
  }

  if (clarification && ANTHROPIC_KEY) {
    try { const a = await callClaude(messages, system); if(a) return {answer:a,source:"Claude"}; } catch(e){console.error("Claude clarify:",e.message);}
  }

  const chain = stem
    ? [{name:"Gemini",key:GEMINI_KEY,fn:()=>callGemini(messages,system)},{name:"DeepSeek",key:DEEPSEEK_KEY,fn:()=>callDeepSeek(messages,system)},{name:"Groq",key:GROQ_KEY,fn:()=>callGroq(messages,system)},{name:"Claude",key:ANTHROPIC_KEY,fn:()=>callClaude(messages,system)}]
    : [{name:"Gemini",key:GEMINI_KEY,fn:()=>callGemini(messages,system)},{name:"Groq",key:GROQ_KEY,fn:()=>callGroq(messages,system)},{name:"DeepSeek",key:DEEPSEEK_KEY,fn:()=>callDeepSeek(messages,system)},{name:"Claude",key:ANTHROPIC_KEY,fn:()=>callClaude(messages,system)}];

  let lastAnswer = "";
  for (const {name,key,fn} of chain) {
    if (!key) { console.log(`⏭️  Skip ${name} — no key`); continue; }
    try {
      console.log(`🤖 Trying ${name}...`);
      const a = await fn();
      if (isAnswerSufficient(a)) { console.log(`✅ ${name} (${a.length} chars)`); return {answer:a,source:name}; }
      console.log(`⚠️  ${name} weak (${a?.length||0} chars)`);
      lastAnswer = a || lastAnswer;
    } catch(e) { console.error(`❌ ${name}:`, e.message); }
  }
  return { answer: lastAnswer || "⚠️ Service temporarily unavailable. Please try again.", source:"Error" };
};

// ═══════════════════════════════════════════════════════════════════════════════
// AI QUESTION GENERATOR (fallback when ALOC has insufficient questions)
// Generates questions in ExamAce internal format
// ═══════════════════════════════════════════════════════════════════════════════
const buildQGenPrompt = (subject, examType, year, count, hotTopics="") => {
  const examLabel = examType?.toUpperCase() || "WAEC";
  return `Generate exactly ${count} authentic ${examLabel}${year?" "+year:""} past-question style MCQs for "${subject}".

${NG_CONTEXT}

RULES:
1. Follow official Nigerian ${examLabel} syllabus strictly
2. Use real ${examLabel} examination language and style (${year?"year "+year:"mixed years 2010-2024"})
3. ${hotTopics?"Prioritise these high-frequency topics: "+hotTopics:"Cover topics evenly across the syllabus"}
4. Mix difficulty: 40% easy, 40% medium, 20% hard
5. Each question MUST have exactly 4 options (A,B,C,D), one correct answer
6. All monetary values in Naira (₦), use Nigerian names/places/context

Return ONLY this JSON array — no markdown, no preamble, no trailing text:
[{"q":"question text","options":{"A":"","B":"","C":"","D":""},"answer":"A","explanation":"brief marking-scheme explanation","topic":"syllabus topic","year":"${year||"20XX"}","difficulty":"easy|medium|hard","source":"AI"}]`;
};

// ═══════════════════════════════════════════════════════════════════════════════
// ENGLISH LANGUAGE SPECIALIST GENERATOR
// ALOC has no comprehension passages — AI generates full passage + linked questions
// English is split: 60% AI (comprehension+summary), 40% ALOC (lexis+oral+vocab)
// ═══════════════════════════════════════════════════════════════════════════════
const ENGLISH_SUBJECTS = ["english", "english language", "use of english"];
const isEnglish = (subject) => ENGLISH_SUBJECTS.includes((subject||"").toLowerCase());

const generateEnglishComprehension = async (examType, year, count) => {
  const examLabel = examType === "utme" ? "JAMB" : "WAEC";
  const passageCount = Math.ceil(count / 5); // one passage per ~5 questions

  const prompt = `Generate ${passageCount} English comprehension passage(s) with questions for ${examLabel}${year?" "+year:""} exam.

${NG_CONTEXT}

For EACH passage:
1. Write a 150-200 word passage on a Nigerian topic (education, culture, environment, economy, governance)
2. Generate 4-6 MCQ questions directly based on the passage
3. Include: 2 factual recall, 2 inference/interpretation, 1 vocabulary-in-context, 1 summary question

Also generate these standalone question types (no passage needed):
- ${Math.floor(count * 0.2)} Lexis & Structure questions (fill-in-the-gap, sentence completion)
- ${Math.floor(count * 0.1)} Oral English questions (vowel sounds, consonants, rhymes, stress patterns)
- ${Math.floor(count * 0.1)} Vocabulary questions (synonyms, antonyms, word usage)

IMPORTANT: For passage questions, include a "passage" field with the full text.
Questions referencing a passage MUST include the passage text in each question object.

Return ONLY this JSON array:
[{
  "q": "question text (for comprehension: include instruction like 'According to the passage, ...')",
  "passage": "full passage text here (only for comprehension questions, omit for standalone)",
  "options": {"A": "", "B": "", "C": "", "D": ""},
  "answer": "A",
  "explanation": "explanation referencing the passage or rule",
  "topic": "Comprehension|Lexis & Structure|Oral English|Vocabulary",
  "year": "${year||"20XX"}",
  "difficulty": "easy|medium|hard",
  "source": "AI"
}]`;

  const system = `You are a ${examLabel} English Language examiner. Follow the official ${examLabel} English syllabus. ${NG_CONTEXT}`;

  const chain = [
    {name:"Gemini",   key:GEMINI_KEY,    fn:()=>callGemini(prompt,system)},
    {name:"Claude",   key:ANTHROPIC_KEY, fn:()=>callClaude(prompt,system)},
    {name:"Groq",     key:GROQ_KEY,      fn:()=>callGroq(prompt,system)},
    {name:"DeepSeek", key:DEEPSEEK_KEY,  fn:()=>callDeepSeek(prompt,system)},
  ];

  for (const {name,key,fn} of chain) {
    if (!key) continue;
    try {
      console.log(`📖 English comprehension gen via ${name} (${count} Qs)`);
      const text = await fn();
      const clean = text.replace(/```json|```/g,"").trim();
      const start = clean.indexOf("["), end = clean.lastIndexOf("]");
      if (start === -1 || end === -1) throw new Error("No JSON array");
      const parsed = JSON.parse(clean.slice(start, end+1));
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`✅ ${name} generated ${parsed.length} English questions with passages`);
        return parsed.slice(0, count).map(q => ({...q, source:"AI", aiModel:name}));
      }
    } catch(e) { console.error(`❌ ${name} English gen:`, e.message); }
  }
  return [];
};

const generateQuestionsAI = async (subject, examType, year, count) => {
  const system = `You are a professional Nigerian ${examType?.toUpperCase()||"WAEC"} examiner. Generate authentic past-question style MCQs. ${NG_CONTEXT}`;
  const prompt = buildQGenPrompt(subject, examType, year, count);

  // Try STEM chain (Gemini → DeepSeek → Groq → Claude) or general chain
  const stem = isSTEM(subject);
  const chain = stem
    ? [{name:"Gemini",key:GEMINI_KEY,fn:()=>callGemini(prompt,system)},{name:"DeepSeek",key:DEEPSEEK_KEY,fn:()=>callDeepSeek(prompt,system)},{name:"Groq",key:GROQ_KEY,fn:()=>callGroq(prompt,system)},{name:"Claude",key:ANTHROPIC_KEY,fn:()=>callClaude(prompt,system)}]
    : [{name:"Gemini",key:GEMINI_KEY,fn:()=>callGemini(prompt,system)},{name:"Groq",key:GROQ_KEY,fn:()=>callGroq(prompt,system)},{name:"DeepSeek",key:DEEPSEEK_KEY,fn:()=>callDeepSeek(prompt,system)},{name:"Claude",key:ANTHROPIC_KEY,fn:()=>callClaude(prompt,system)}];

  for (const {name,key,fn} of chain) {
    if (!key) continue;
    try {
      console.log(`🤖 AI question gen via ${name}: ${subject} (${count} Qs)`);
      const text = await fn();
      const clean = text.replace(/```json|```/g,"").trim();
      const start = clean.indexOf("["), end = clean.lastIndexOf("]");
      if (start === -1 || end === -1) throw new Error("No JSON array");
      const parsed = JSON.parse(clean.slice(start, end+1));
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`✅ ${name} generated ${parsed.length} questions`);
        return { questions: parsed.slice(0,count).map(q=>({...q,source:"AI",aiModel:name})), source:name };
      }
    } catch(e) { console.error(`❌ ${name} qgen:`, e.message); }
  }
  throw new Error("All AI question generators failed");
};

// ═══════════════════════════════════════════════════════════════════════════════
// HYBRID QUESTION FETCHER
// Strategy:
//   ENGLISH (special case):
//     - 40% from ALOC → standalone lexis, vocabulary, oral English (no passage needed)
//     - 60% from AI   → comprehension passages + linked questions, summary
//     - Do NOT shuffle — keep comprehension groups together
//
//   ALL OTHER SUBJECTS:
//     1. Try ALOC first → real past questions
//     2. Fill gap with AI if ALOC returns fewer than requested
//     3. Shuffle combined results
// ═══════════════════════════════════════════════════════════════════════════════
const fetchHybridQuestions = async (subject, examType, year, count) => {
  let alocQuestions = [];
  let aiQuestions   = [];
  let alocError     = null;

  // ── ENGLISH: special hybrid split ──────────────────────────────────────────
  if (isEnglish(subject)) {
    const alocTarget = Math.floor(count * 0.4);   // 40% standalone from ALOC
    const aiTarget   = count - alocTarget;         // 60% comprehension from AI

    console.log(`📖 English hybrid: ${alocTarget} ALOC standalone + ${aiTarget} AI comprehension`);

    // Fetch standalone English from ALOC (lexis, vocab, oral)
    try {
      alocQuestions = await fetchALOCBatch(subject, examType, year, alocTarget);
      // Filter out comprehension questions from ALOC (they lack passages)
      // Keep only clearly standalone: short questions without "passage" indicators
      alocQuestions = alocQuestions.filter(q => {
        const text = q.q.toLowerCase();
        const looksLikeComprehension =
          text.includes("according to") ||
          text.includes("the passage") ||
          text.includes("the writer") ||
          text.includes("the author") ||
          text.includes("the extract") ||
          text.includes("paragraph");
        return !looksLikeComprehension;
      });
      console.log(`✅ ALOC English: ${alocQuestions.length} standalone questions`);
    } catch(e) {
      alocError = e.message;
      console.warn(`⚠️  ALOC English failed: ${e.message}`);
    }

    // Generate comprehension + other sections with AI
    try {
      const comprehensionQs = await generateEnglishComprehension(examType, year, aiTarget);
      aiQuestions = comprehensionQs;
      console.log(`✅ AI generated ${aiQuestions.length} English questions with passages`);
    } catch(e) {
      console.error("❌ English comprehension AI gen failed:", e.message);
    }

    // For English: put comprehension questions FIRST (grouped), then standalone
    // This mirrors real JAMB/WAEC paper structure
    const ordered = [...aiQuestions, ...alocQuestions];

    if (!ordered.length) {
      throw new Error("No English questions available from any source");
    }

    return {
      questions: ordered.slice(0, count),
      alocCount: alocQuestions.length,
      aiCount:   aiQuestions.length,
      total:     ordered.length,
      alocError,
      englishMode: true,
    };
  }

  // ── ALL OTHER SUBJECTS: standard ALOC → AI fallback ────────────────────────
  try {
    console.log(`📚 ALOC: Fetching ${count} questions for ${subject} (${examType} ${year||"any"})`);
    alocQuestions = await fetchALOCBatch(subject, examType, year, count);
    console.log(`✅ ALOC returned ${alocQuestions.length} real questions`);
  } catch(e) {
    alocError = e.message;
    console.warn(`⚠️  ALOC failed: ${e.message}`);
  }

  const gap = count - alocQuestions.length;
  if (gap > 0) {
    console.log(`🤖 Gap: ${gap} questions missing → generating with AI`);
    try {
      const { questions, source } = await generateQuestionsAI(subject, examType, year, gap);
      aiQuestions = questions;
      console.log(`✅ AI (${source}) generated ${aiQuestions.length} questions`);
    } catch(e) {
      console.error("❌ AI question generation failed:", e.message);
    }
  }

  const combined = [...alocQuestions, ...aiQuestions];
  if (!combined.length) {
    throw new Error(`No questions available for ${subject} ${examType} ${year||""}`);
  }

  // Shuffle non-English subjects
  for (let i = combined.length-1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }

  return {
    questions: combined.slice(0, count),
    alocCount: alocQuestions.length,
    aiCount:   aiQuestions.length,
    total:     combined.length,
    alocError,
  };
};

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET QUESTIONS (hybrid ALOC + AI) ─────────────────────────────────────────
// Used by frontend Quiz and JAMB CBT components
// Query params: subject, exam (waec|jamb|neco), year, count
app.get("/api/questions", async (req, res) => {
  const { subject, exam, year, count } = req.query;

  if (!subject) return res.status(400).json({ error: "subject is required" });

  const requestedCount = Math.min(parseInt(count)||20, 60); // cap at 60 per request
  const examType = exam || "utme";

  console.log(`📥 Questions request: ${subject} | ${examType} | ${year||"any"} | ${requestedCount} Qs`);

  try {
    const result = await fetchHybridQuestions(subject, examType, year, requestedCount);

    console.log(`📤 Serving ${result.questions.length} questions (ALOC: ${result.alocCount}, AI: ${result.aiCount})`);

    res.json({
      questions:  result.questions,
      meta: {
        total:      result.questions.length,
        alocCount:  result.alocCount,
        aiCount:    result.aiCount,
        subject,
        examType,
        year:       year || "mixed",
        alocError:  result.alocError || null,
      }
    });
  } catch(err) {
    console.error("❌ Questions endpoint:", err.message);
    res.status(500).json({ error: err.message, questions: [] });
  }
});

// ── BATCH QUESTIONS (for JAMB CBT — fetches all 4 subjects at once) ───────────
// Body: { subjects: [{name, exam, year, count}] }
app.post("/api/questions/batch", async (req, res) => {
  const { subjects } = req.body;
  if (!Array.isArray(subjects) || !subjects.length) {
    return res.status(400).json({ error: "subjects array required" });
  }

  console.log(`📥 Batch questions: ${subjects.map(s=>s.name).join(", ")}`);

  const results = {};
  const meta    = {};

  // Fetch all subjects in parallel for speed
  await Promise.allSettled(
    subjects.map(async ({ name, exam, year, count }) => {
      try {
        const result = await fetchHybridQuestions(name, exam, year, count || 40);
        results[name] = result.questions;
        meta[name]    = { alocCount: result.alocCount, aiCount: result.aiCount, total: result.questions.length };
        console.log(`✅ ${name}: ${result.alocCount} real + ${result.aiCount} AI = ${result.questions.length}`);
      } catch(e) {
        console.error(`❌ ${name} batch failed:`, e.message);
        results[name] = [];
        meta[name]    = { alocCount:0, aiCount:0, total:0, error: e.message };
      }
    })
  );

  const totalReal  = Object.values(meta).reduce((s,m)=>s+(m.alocCount||0),0);
  const totalAI    = Object.values(meta).reduce((s,m)=>s+(m.aiCount||0),0);

  res.json({ results, meta, summary: { totalReal, totalAI, totalQuestions: totalReal+totalAI } });
});

// ── CHAT ENDPOINT (4-tier AI router for explanations/conversations) ───────────
app.post("/api/chat", async (req, res) => {
  console.log("📨 Chat:", JSON.stringify(req.body).slice(0,120));
  const { messages, system, imgData } = req.body;
  try {
    const { answer, source } = await smartAnswer(messages, system, imgData);
    console.log(`📤 Chat response from ${source} (${answer.length} chars)`);
    res.json({ content:[{type:"text",text:answer}], source });
  } catch(err) {
    console.error("❌ Chat:", err.message);
    res.status(500).json({ content:[{type:"text",text:"⚠️ Service temporarily unavailable."}], error:err.message });
  }
});

// ── WHATSAPP WEBHOOK (Twilio) ─────────────────────────────────────────────────
app.post("/whatsapp", async (req, res) => {
  const { Body, From, MediaUrl0, MediaContentType0 } = req.body;
  const userMsg = (Body || "").trim();
  console.log(`📱 WhatsApp from ${From}: ${userMsg.slice(0,80)}`);

  const SYSTEM = `You are ExamAce AI — Nigeria's #1 WAEC/NECO/JAMB exam tutor.
${NG_CONTEXT}
Format for WhatsApp: **bold** key terms, emojis, short paragraphs, max 250 words.
Always end with a relevant exam tip or next action.`;

  let messages, imgData;
  if (MediaUrl0) {
    try {
      const imgRes = await fetch(MediaUrl0, {
        headers: { Authorization:`Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}` }
      });
      const buf = await imgRes.arrayBuffer();
      imgData  = { data: Buffer.from(buf).toString("base64"), type: MediaContentType0||"image/jpeg" };
      messages = userMsg || "Read and solve ALL question(s) in this image. Give complete step-by-step solution with WAEC/JAMB marking scheme.";
    } catch(e) { console.error("WA img:", e.message); messages = userMsg || "Help me."; }
  } else {
    messages = [{ role:"user", content:userMsg }];
  }

  try {
    const { answer, source } = await smartAnswer(messages, SYSTEM, imgData);
    const reply = answer.slice(0,1550) + (answer.length>1550?"\n\n_[Reply MORE for rest]_":"");
    console.log(`✅ WhatsApp via ${source} → ${From}`);
    res.set("Content-Type","text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</Message></Response>`);
  } catch(err) {
    res.set("Content-Type","text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>⚠️ Service unavailable. Please try again!</Message></Response>`);
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "✅ ExamAce AI Backend Running",
    question_sources: {
      "Primary":   ALOC_TOKEN    ? "✅ ALOC API (Real Past Questions)" : "❌ ALOC token missing — add ALOC_ACCESS_TOKEN",
      "Fallback":  "AI-Generated (same 4-tier chain)",
    },
    ai_tiers: {
      "Tier 1":  GEMINI_KEY    ? "✅ Gemini 2.0 Flash"     : "❌ Missing GEMINI_API_KEY",
      "Tier 2":  DEEPSEEK_KEY  ? "✅ DeepSeek V3"          : "❌ Missing DEEPSEEK_API_KEY",
      "Tier 3":  GROQ_KEY      ? "✅ Groq (Llama 3.3 70B)" : "❌ Missing GROQ_API_KEY",
      "Tier 4":  ANTHROPIC_KEY ? "✅ Claude Sonnet"         : "❌ Missing ANTHROPIC_API_KEY",
    },
    endpoints: {
      "GET  /api/questions":       "Fetch hybrid questions (ALOC + AI fallback)",
      "POST /api/questions/batch": "Fetch all JAMB CBT subjects at once",
      "POST /api/chat":            "AI chat/explanation (4-tier router)",
      "POST /whatsapp":            "Twilio WhatsApp webhook",
    },
    aloc_subjects: Object.keys(ALOC_SUBJECT_MAP),
    aloc_years:    "2001 – 2020",
    aloc_types:    "utme (JAMB), wassce (WAEC/NECO)",
  });
});

// ── TEST ALOC CONNECTIVITY ────────────────────────────────────────────────────
app.get("/test-aloc", async (req, res) => {
  try {
    const qs = await fetchALOC("mathematics", "utme", null, 3);
    res.json({ status:"✅ ALOC connected", sample: qs.slice(0,2), count: qs.length });
  } catch(e) {
    res.status(500).json({ status:"❌ ALOC failed", error: e.message });
  }
});

// ── DEBUG: See raw ALOC response (use this to diagnose field name issues) ─────
// Visit: /debug-aloc?subject=english&type=utme
app.get("/debug-aloc", async (req, res) => {
  const subject = req.query.subject || "mathematics";
  const type    = req.query.type    || "utme";
  const alocSubject = ALOC_SUBJECT_MAP[subject.toLowerCase()] || subject;
  const alocType    = ALOC_TYPE_MAP[type.toLowerCase()]       || type;

  try {
    const url = `${ALOC_BASE}/q/3?subject=${alocSubject}&type=${alocType}`;
    console.log("Debug ALOC fetch:", url);
    const r = await fetch(url, { headers: alocHeaders() });
    const raw = await r.json();

    // Show first question's keys so we know the field names
    let firstQ = null;
    if (Array.isArray(raw) && raw.length)          firstQ = raw[0];
    else if (Array.isArray(raw?.data) && raw.data.length) firstQ = raw.data[0];
    else if (Array.isArray(raw?.body) && raw.body.length) firstQ = raw.body[0];

    res.json({
      status: "✅ Raw ALOC response",
      url,
      responseType: Array.isArray(raw) ? "direct array" : `object with keys: ${Object.keys(raw||{}).join(", ")}`,
      firstQuestionKeys: firstQ ? Object.keys(firstQ) : "no questions found",
      firstQuestion: firstQ,
      rawSample: raw,
    });
  } catch(e) {
    res.status(500).json({ status:"❌ Debug failed", error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ ExamAce AI backend running on port ${PORT}`));