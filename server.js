const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");

const app = express();

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY HARDENING
// ═══════════════════════════════════════════════════════════════════════════════

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',    'nosniff');
  res.setHeader('X-Frame-Options',           'DENY');
  res.setHeader('X-XSS-Protection',          '1; mode=block');
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// In-memory rate limiter — no extra package needed
const _rls = new Map();
const _cleanup = setInterval(() => { const c=Date.now()-600000; for(const [k,v] of _rls) if(v.start<c) _rls.delete(k); }, 600000);
const rateLimit = (max, windowMs) => (req, res, next) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const d   = _rls.get(key) || {count:0,start:now};
  if (now - d.start > windowMs) { d.count=0; d.start=now; }
  d.count++;
  _rls.set(key, d);
  if (d.count > max) return res.status(429).json({error:'Too many requests. Please slow down and try again.'});
  next();
};

// Input sanitization
const sanitize = (str, max=500) => {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0,max).replace(/<[^>]*>/g,'');
};
const isValidEmail = (e) => typeof e==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length<=254;


// ═══════════════════════════════════════════════════════════════════════════════
// USER PROFILE & GAMIFICATION — JSON file store + JWT auth
// ═══════════════════════════════════════════════════════════════════════════════
const JWT_SECRET = process.env.JWT_SECRET || "examace-secret-change-in-prod";
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, "data", "users.json");
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const readDB  = () => { try { return JSON.parse(fs.readFileSync(DB_PATH,"utf8")); } catch { return {users:{}}; } };
const writeDB = (d) => { try { fs.writeFileSync(DB_PATH, JSON.stringify(d,null,2)); } catch(e) { console.error("DB:",e.message); } };

const XP_RULES = {
  correct:10, wrong:2, quiz_done:25, cbt_done:60,
  streak_bonus:15, perfect_score:40, first_login:25,
};

const LEVELS = [
  {level:1, name:"JSS3 Student",    minXP:0,    badge:"🌱", color:"#22c55e"},
  {level:2, name:"SS1 Learner",     minXP:100,  badge:"📚", color:"#38bdf8"},
  {level:3, name:"SS2 Scholar",     minXP:300,  badge:"⭐", color:"#a855f7"},
  {level:4, name:"SS3 Candidate",   minXP:600,  badge:"🎯", color:"#f97316"},
  {level:5, name:"WAEC Ready",      minXP:1000, badge:"🏅", color:"#f5c842"},
  {level:6, name:"JAMB Champion",   minXP:1500, badge:"🏆", color:"#f5c842"},
  {level:7, name:"A1 Legend",       minXP:2500, badge:"👑", color:"#ef4444"},
  {level:8, name:"ExamAce Master",  minXP:4000, badge:"💎", color:"#a855f7"},
];

const ACHIEVEMENTS = [
  {id:"first_quiz",    name:"First Step",      desc:"Complete your first quiz",              icon:"🎯", xp:10 },
  {id:"streak_3",      name:"Hat Trick",        desc:"3-day study streak",                    icon:"🔥", xp:20 },
  {id:"streak_7",      name:"Week Warrior",     desc:"7-day study streak",                    icon:"⚡", xp:50 },
  {id:"streak_30",     name:"Iron Student",     desc:"30-day study streak",                   icon:"💪", xp:150},
  {id:"perfect_quiz",  name:"Perfectionist",    desc:"Score 100% on any quiz",               icon:"💯", xp:30 },
  {id:"cbt_first",     name:"CBT Debut",        desc:"Complete your first JAMB CBT mock",    icon:"🖥️", xp:50 },
  {id:"cbt_280",       name:"Uni Ready",        desc:"Score 280+ in JAMB CBT",               icon:"🎓", xp:80 },
  {id:"cbt_300",       name:"Admission Ready",  desc:"Score 300+ in JAMB CBT",               icon:"🏛️", xp:120},
  {id:"q100",          name:"Century Mark",     desc:"Answer 100 questions total",            icon:"💯", xp:40 },
  {id:"q500",          name:"Question Master",  desc:"Answer 500 questions total",            icon:"🌟", xp:100},
  {id:"q1000",         name:"Question Legend",  desc:"Answer 1,000 questions total",          icon:"🔱", xp:200},
  {id:"subjects_5",    name:"All-Rounder",      desc:"Practice 5 different subjects",         icon:"📚", xp:50 },
  {id:"waec_a1",       name:"A1 Achiever",      desc:"Score 75%+ on any WAEC quiz",          icon:"🏆", xp:60 },
  {id:"review_10",     name:"Disciplined",      desc:"Complete 10 spaced repetition reviews", icon:"🔁", xp:30 },
  {id:"review_50",     name:"Memory Master",    desc:"Complete 50 spaced repetition reviews", icon:"🧠", xp:80 },
];

const getLevel = (xp=0) => {
  const lvl  = [...LEVELS].reverse().find(l => xp >= l.minXP) || LEVELS[0];
  const next = LEVELS.find(l => l.minXP > xp);
  return { ...lvl, nextXP: next?.minXP||null, xpToNext: next?next.minXP-xp:0,
    progress: next ? Math.round(((xp-lvl.minXP)/(next.minXP-lvl.minXP))*100) : 100 };
};

const awardXP = (profile, reason, amount) => {
  profile.xp = (profile.xp||0) + amount;
  if (!profile.xpLog) profile.xpLog = [];
  profile.xpLog = [{reason,amount,ts:Date.now()}, ...profile.xpLog].slice(0,100);
  return profile;
};

const checkAchievements = (profile, extras=[]) => {
  profile.achievements = profile.achievements || [];
  const s = profile.stats || {};
  const has = (id) => profile.achievements.includes(id);
  const newly = [];
  const maybe = (id, cond) => { if(!has(id) && cond) newly.push(id); };

  maybe("first_quiz",   (s.quizzesCompleted||0)>=1);
  maybe("streak_3",     (s.longestStreak||0)>=3);
  maybe("streak_7",     (s.longestStreak||0)>=7);
  maybe("streak_30",    (s.longestStreak||0)>=30);
  maybe("cbt_first",    (s.cbtCompleted||0)>=1);
  maybe("cbt_280",      (s.bestJAMB||0)>=280);
  maybe("cbt_300",      (s.bestJAMB||0)>=300);
  maybe("q100",         (s.totalAnswered||0)>=100);
  maybe("q500",         (s.totalAnswered||0)>=500);
  maybe("q1000",        (s.totalAnswered||0)>=1000);
  maybe("subjects_5",   Object.keys(s.subjectsPracticed||{}).length>=5);
  maybe("review_10",    (s.reviewsCompleted||0)>=10);
  maybe("review_50",    (s.reviewsCompleted||0)>=50);
  extras.forEach(id => maybe(id, true));

  const earned = [];
  newly.forEach(id => {
    const a = ACHIEVEMENTS.find(x => x.id===id);
    if(a){ profile.achievements.push(id); awardXP(profile,`Achievement: ${a.name}`,a.xp); earned.push(a); }
  });
  return { profile, earned };
};

// Update streak logic
const updateStreak = (profile) => {
  const today = new Date().toDateString();
  const yest  = new Date(Date.now()-86400000).toDateString();
  if (profile.lastStudyDate === today) return { profile, bonus: false };
  const continued = profile.lastStudyDate === yest;
  profile.currentStreak = continued ? (profile.currentStreak||0)+1 : 1;
  profile.longestStreak = Math.max(profile.longestStreak||0, profile.currentStreak);
  profile.lastStudyDate = today;
  profile.stats = profile.stats || {};
  profile.stats.longestStreak = profile.longestStreak;
  profile.totalStudyDays = (profile.totalStudyDays||0)+1;
  awardXP(profile, "Daily study streak", XP_RULES.streak_bonus);
  return { profile, bonus: true };
};

// Auth middleware
const auth = (req, res, next) => {
  const token = (req.headers.authorization||"").replace("Bearer ","");
  if(!token) return res.status(401).json({error:"Login required"});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({error:"Session expired — please log in again"}); }
};


// CORS — allow requests from your frontend Render domain (and localhost for dev)
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  // Add your actual frontend Render URL below:
  "https://examace-ai.onrender.com",   // ← change this to your frontend URL
  // If you have a custom domain, add it too:
  // "https://www.examace.ng",
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman, WhatsApp webhook)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return callback(null, true);
    console.warn(`CORS blocked: ${origin}`);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

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
// QUESTION CACHE — in-memory cache to avoid repeated ALOC API calls
// Key: "subject|examType|year"  Value: { questions, ts }
// TTL: 24 hours — ALOC data is static so we can cache aggressively
// ═══════════════════════════════════════════════════════════════════════════════
const questionCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

const cacheKey  = (subject, examType, year) => `${subject}|${examType}|${year||"any"}`;
const cacheGet  = (key) => {
  const entry = questionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { questionCache.delete(key); return null; }
  return entry.questions;
};
const cacheSet  = (key, questions) => questionCache.set(key, { questions, ts: Date.now() });
const cacheStats = () => ({
  entries: questionCache.size,
  keys: [...questionCache.keys()],
  totalQuestions: [...questionCache.values()].reduce((s,e)=>s+e.questions.length, 0),
});

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
  const key = cacheKey(subject, examType, year);

  // Check cache first
  const cached = cacheGet(key);
  if (cached && cached.length >= totalCount) {
    console.log(`💾 Cache hit: ${key} (${cached.length} questions)`);
    // Return a random sample so students don't see the same order
    const shuffled = [...cached].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, totalCount);
  }

  const results = [];
  const seenIds = new Set();
  // Pre-fill seenIds from cache to avoid duplicates
  if (cached) cached.forEach(q => { seenIds.add(q.id); results.push(q); });

  const batchSize = 40;
  const needed    = totalCount - results.length;
  const batches   = Math.ceil(needed / batchSize);

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

  // Cache whatever we got (even if less than requested — prevents hammering API)
  if (results.length > 0) {
    cacheSet(key, results);
    console.log(`💾 Cached ${results.length} questions for ${key}`);
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
// ═══════════════════════════════════════════════════════════════════════════════
// SMART AI QUALITY SCORING & ROUTING
// ═══════════════════════════════════════════════════════════════════════════════

// Quality indicators — educational Nigerian exam context
const QUALITY_INDICATORS = {
  positive: [
    /step\s*\d+/i, /\*\*[^*]+\*\*/,        // structured steps, bold terms
    /example/i, /formula/i, /note:/i,        // educational markers
    /waec|neco|jamb/i,                        // exam context awareness
    /therefore|hence|because|since/i,         // reasoning words
    /₦|naira/i, /nigeria/i,                   // Nigerian context
    /\d+\s*%|\d+\/\d+/,                       // numbers/fractions in answers
  ],
  negative: [
    /i'm not sure/i, /i cannot/i, /i don't know/i, /i am unable/i,
    /as an ai/i, /i apologize/i, /unfortunately/i,
    /i cannot provide/i, /i'm unable to/i,
  ],
};

const scoreAnswer = (text) => {
  if (!text || text.trim().length < 100) return 0;
  let score = Math.min(text.length / 10, 200); // length score, capped at 200

  // Quality bonuses
  for (const rx of QUALITY_INDICATORS.positive) {
    if (rx.test(text)) score += 20;
  }
  // Quality penalties
  for (const rx of QUALITY_INDICATORS.negative) {
    if (rx.test(text)) score -= 80;
  }
  // Structural bonuses
  if (text.includes("
"))       score += 15;  // has line breaks = structured
  if (text.split("
").length>4) score += 20;  // multi-paragraph
  if (/\d/.test(text))           score += 10;  // contains numbers

  return Math.max(score, 0);
};

const isAnswerSufficient = (text) => {
  if (!text || text.trim().length < 150) return false;
  return scoreAnswer(text) >= 80; // must clear quality threshold
};

// Clarification triggers → always go to Claude for best plain-English explanation
const CLARIFICATION_TRIGGERS = [
  "i don't understand","i dont understand","not clear","confusing","confused",
  "explain better","explain again","can you clarify","clarify","what do you mean",
  "please explain","still don't get","still dont get","make it simpler",
  "simpler explanation","break it down","can you simplify","rephrase",
  "i'm lost","im lost","not getting it","elaborate","more detail",
  "show me how","how do i","walk me through","demonstrate",
];
const needsClarification = (text) => {
  const l = (text || "").toLowerCase();
  return CLARIFICATION_TRIGGERS.some(t => l.includes(t));
};

// "Show me how" trigger → Claude gives step-by-step visual explanation
const SHOW_ME_TRIGGERS = [
  "show me how", "show me", "demonstrate", "walk me through",
  "step by step", "how do i solve", "how to solve", "work it out",
  "full working", "full solution", "solve for me",
];
const needsShowMe = (text) => {
  const l = (text || "").toLowerCase();
  return SHOW_ME_TRIGGERS.some(t => l.includes(t));
};

const STEM_SUBJECTS = ["mathematics","further mathematics","math","maths","physics","chemistry","biology","agricultural science","statistics","calculus"];
const isSTEM = (text) => { const l=(text||"").toLowerCase(); return STEM_SUBJECTS.some(s=>l.includes(s)); };

// ── SMART 4-TIER ROUTER ───────────────────────────────────────────────────────
// Strategy:
//   Images        → Gemini (vision) → Claude (vision fallback)
//   "Show me how" → Claude directly (best step-by-step visual explainer)
//   Clarification → Claude directly (best plain-language explainer)
//   STEM          → Gemini & DeepSeek race → best quality wins → Groq → Claude
//   General       → Gemini first → Groq → DeepSeek → Claude
//   Claude is LAST RESORT except for show-me/clarification requests
const smartAnswer = async (messages, system, imgData) => {
  const lastMsg = getLastMsg(messages);
  const context = `${system||""} ${lastMsg}`;
  const stem    = isSTEM(context);
  const showMe  = needsShowMe(lastMsg);
  const clarify = needsClarification(lastMsg);

  // ── Images: Gemini → Claude ───────────────────────────────────────────────
  if (imgData) {
    let ans = "";
    try {
      ans = await callGemini(messages, system, imgData);
      if (isAnswerSufficient(ans)) return { answer:ans, source:"Gemini" };
    } catch(e) { console.error("Gemini img:", e.message); }
    if (ANTHROPIC_KEY) {
      try {
        ans = await callClaude(messages, system, imgData);
        if (ans) return { answer:ans, source:"Claude" };
      } catch(e) { console.error("Claude img:", e.message); }
    }
    return { answer: ans || "⚠️ Could not read image. Please try again.", source:"Error" };
  }

  // ── "Show me how" → Claude with rich step-by-step prompt ─────────────────
  if (showMe && ANTHROPIC_KEY) {
    console.log("🎓 Show-me request → Claude step-by-step");
    const showMeSystem = (system||"") + `

IMPORTANT: The student wants a STEP-BY-STEP visual explanation. 
Format your answer with:
**Step 1:** [action] → [result]
**Step 2:** [action] → [result]
[continue for all steps]
**✅ Final Answer:** [answer with units]
**📌 Key Formula:** [formula used]
**💡 Memory Tip:** [how to remember this for WAEC/JAMB]
Use bold, clear numbered steps. Show ALL working. Nigerian exam context throughout.`;
    try {
      const a = await callClaude(messages, showMeSystem);
      if (a) return { answer:a, source:"Claude" };
    } catch(e) { console.error("Claude show-me:", e.message); }
    // Fall through to normal chain if Claude fails
  }

  // ── Clarification → Claude ────────────────────────────────────────────────
  if (clarify && ANTHROPIC_KEY) {
    console.log("🔄 Clarification → Claude");
    try {
      const a = await callClaude(messages, system);
      if (a) return { answer:a, source:"Claude" };
    } catch(e) { console.error("Claude clarify:", e.message); }
  }

  // ── STEM: Race Gemini + DeepSeek in parallel, pick best quality ───────────
  if (stem && GEMINI_KEY && DEEPSEEK_KEY) {
    console.log("🔬 STEM: Racing Gemini vs DeepSeek for quality...");
    const [gResult, dResult] = await Promise.allSettled([
      GEMINI_KEY   ? callGemini(messages, system)   : Promise.reject("no key"),
      DEEPSEEK_KEY ? callDeepSeek(messages, system) : Promise.reject("no key"),
    ]);
    const gAns = gResult.status === "fulfilled" ? gResult.value : "";
    const dAns = dResult.status === "fulfilled" ? dResult.value : "";
    const gScore = scoreAnswer(gAns);
    const dScore = scoreAnswer(dAns);
    console.log(`📊 Gemini: ${gScore} pts | DeepSeek: ${dScore} pts`);

    const best = gScore >= dScore ? { answer:gAns, score:gScore, source:"Gemini" }
                                  : { answer:dAns, score:dScore, source:"DeepSeek" };

    if (best.score >= 80) {
      console.log(`✅ Best STEM answer: ${best.source} (${best.score} pts)`);
      return { answer:best.answer, source:best.source };
    }
    // Neither was good enough — fall through to sequential chain
    console.log("⚠️  Both STEM parallel answers weak — trying sequential chain");
  }

  // ── Sequential fallback chain ─────────────────────────────────────────────
  // STEM: Gemini → DeepSeek → Groq → Claude
  // General: Gemini → Groq → DeepSeek → Claude
  const chain = stem
    ? [
        {name:"Gemini",   key:GEMINI_KEY,    fn:()=>callGemini(messages,system)},
        {name:"DeepSeek", key:DEEPSEEK_KEY,  fn:()=>callDeepSeek(messages,system)},
        {name:"Groq",     key:GROQ_KEY,      fn:()=>callGroq(messages,system)},
        {name:"Claude",   key:ANTHROPIC_KEY, fn:()=>callClaude(messages,system)},
      ]
    : [
        {name:"Gemini",   key:GEMINI_KEY,    fn:()=>callGemini(messages,system)},
        {name:"Groq",     key:GROQ_KEY,      fn:()=>callGroq(messages,system)},
        {name:"DeepSeek", key:DEEPSEEK_KEY,  fn:()=>callDeepSeek(messages,system)},
        {name:"Claude",   key:ANTHROPIC_KEY, fn:()=>callClaude(messages,system)},
      ];

  let bestAnswer = "";
  let bestScore  = 0;
  let bestSource = "";

  for (const {name,key,fn} of chain) {
    if (!key) continue;
    try {
      console.log(`🤖 ${name}...`);
      const a = await fn();
      const s = scoreAnswer(a);
      console.log(`   Score: ${s} pts (${a?.length||0} chars)`);

      // Accept immediately if clearly good
      if (s >= 120) {
        console.log(`✅ ${name} accepted (${s} pts)`);
        return { answer:a, source:name };
      }
      // Keep as best so far if better than previous
      if (s > bestScore) { bestAnswer=a; bestScore=s; bestSource=name; }

    } catch(e) { console.error(`❌ ${name}:`, e.message); }
  }

  // Return best answer found, even if below ideal threshold
  if (bestAnswer) {
    console.log(`📤 Best available: ${bestSource} (${bestScore} pts)`);
    return { answer:bestAnswer, source:bestSource };
  }

  return { answer:"⚠️ Service temporarily unavailable. Please try again.", source:"Error" };
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
app.get("/api/questions", rateLimit(30, 60*1000), async (req, res) => {
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
app.post("/api/chat", rateLimit(60, 60*1000), async (req, res) => {
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

// ── STREAMING CHAT ENDPOINT (token-by-token via SSE) ─────────────────────────
// Frontend connects with EventSource, answers stream word-by-word
app.post("/api/chat/stream", rateLimit(30, 60*1000), async (req, res) => {
  const { messages, system, imgData } = req.body;

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Try Gemini streaming first (cheapest)
    if (GEMINI_KEY && !imgData) {
      try {
        const lastMsg = typeof messages === "string" ? messages
          : Array.isArray(messages) ? (messages[messages.length-1]?.content||"") : "";
        const parts = [];
        if (system) parts.push({ text: system + "\n\n" });
        parts.push({ text: lastMsg });

        const gemRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`,
          { method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ contents:[{parts}], generationConfig:{maxOutputTokens:1500,temperature:0.3} }) }
        );

        if (gemRes.ok) {
          const reader = gemRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const chunk = JSON.parse(line.slice(6));
                  const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (text) send({ type:"token", text, source:"Gemini" });
                } catch {}
              }
            }
          }
          send({ type:"done", source:"Gemini" });
          return res.end();
        }
      } catch(e) { console.warn("Gemini stream failed, falling back:", e.message); }
    }

    // Fallback: call smartAnswer normally and stream result in one chunk
    const { answer, source } = await smartAnswer(messages, system, imgData);
    // Simulate streaming by chunking the response into ~10-word pieces
    const words = answer.split(" ");
    const chunkSize = 8;
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join(" ") + (i + chunkSize < words.length ? " " : "");
      send({ type:"token", text: chunk, source });
      await new Promise(r => setTimeout(r, 25)); // small delay for streaming feel
    }
    send({ type:"done", source });
    res.end();
  } catch(err) {
    send({ type:"error", text:"⚠️ Service temporarily unavailable." });
    res.end();
  }
});

// ── ALOC QUESTION REPORT (students flag bad questions) ────────────────────────
// Body: { questionId, subject, type, message }
// type: 1=question, 2=optA, 3=optB, 4=optC, 5=optD, 6=answer, 7=solution
app.post("/api/report-question", async (req, res) => {
  const { questionId, subject, type=1, message="" } = req.body;
  if (!questionId || !subject) return res.status(400).json({ error:"questionId and subject required" });

  const alocSubject = ALOC_SUBJECT_MAP[subject?.toLowerCase()] || subject;

  try {
    const r = await fetch("https://questions.aloc.com.ng/api/r", {
      method: "POST",
      headers: { ...alocHeaders(), "Content-Type":"application/json" },
      body: JSON.stringify({ subject: alocSubject, question_id: questionId, type, message }),
    });
    const data = await r.json();
    console.log(`🚩 Question ${questionId} reported: type=${type}`);
    res.json({ success: true, data });
  } catch(e) {
    console.error("Report question failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CACHE STATS ────────────────────────────────────────────────────────────────
app.get("/cache-stats", (req, res) => {
  res.json({ status:"✅", cache: cacheStats() });
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

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── REGISTER ─────────────────────────────────────────────────────────────────
app.post("/api/auth/register", rateLimit(5, 15*60*1000), async (req, res) => {
  const rawName  = sanitize(req.body.name,    100);
  const rawEmail = sanitize(req.body.email,   254).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password.slice(0,128) : "";
  const exam     = sanitize(req.body.exam,     20) || "WAEC";
  const state    = sanitize(req.body.state,    60);
  const subjects = Array.isArray(req.body.subjects) ? req.body.subjects.map(s=>sanitize(s,60)).slice(0,12) : [];

  const name = rawName, email = rawEmail;
  if(!name||!email||!password) return res.status(400).json({error:"Name, email and password required"});
  if(!isValidEmail(email))     return res.status(400).json({error:"Invalid email address"});
  if(password.length < 6)      return res.status(400).json({error:"Password must be at least 6 characters"});

  const db = readDB();
  if(db.users[email.toLowerCase()]) return res.status(409).json({error:"Email already registered"});

  const hash = await bcrypt.hash(password, 10);
  const userId = `u_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const profile = {
    userId, name, email:email.toLowerCase(), hash,
    exam: exam||"WAEC", subjects, state,
    xp:25, xpLog:[{reason:"Welcome bonus",amount:25,ts:Date.now()}],
    achievements:[],
    currentStreak:0, longestStreak:0, lastStudyDate:null, totalStudyDays:0,
    stats:{
      quizzesCompleted:0, cbtCompleted:0, totalAnswered:0,
      totalCorrect:0, bestJAMB:0, subjectsPracticed:{},
      longestStreak:0, reviewsCompleted:0,
    },
    history:[],
    createdAt: new Date().toISOString(),
  };
  db.users[email.toLowerCase()] = profile;
  writeDB(db);

  const token = jwt.sign({userId, email:email.toLowerCase(), name}, JWT_SECRET, {expiresIn:"30d"});
  const levelInfo = getLevel(25);
  res.json({
    token, user:{ userId, name, email:email.toLowerCase(), exam, subjects, state,
      xp:25, level:levelInfo, achievements:[], currentStreak:0, longestStreak:0,
      stats:profile.stats, createdAt:profile.createdAt },
    newlyEarned: [],
    message:`Welcome to ExamAce AI, ${name}! 🎉 +25 XP welcome bonus`,
  });
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post("/api/auth/login", rateLimit(10, 15*60*1000), async (req, res) => {
  const email    = sanitize(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password.slice(0,128) : "";
  if(!email||!password) return res.status(400).json({error:"Email and password required"});
  if(!isValidEmail(email)) return res.status(400).json({error:"Invalid email address"});

  const db = readDB();
  const profile = db.users[email.toLowerCase()];
  if(!profile) return res.status(401).json({error:"Email not found"});

  const ok = await bcrypt.compare(password, profile.hash);
  if(!ok) return res.status(401).json({error:"Wrong password"});

  // Update streak on login
  const { profile: updated, bonus } = updateStreak(profile);
  const { profile: withAch, earned } = checkAchievements(updated);
  db.users[email.toLowerCase()] = withAch;
  writeDB(db);

  const token = jwt.sign({userId:profile.userId, email:email.toLowerCase(), name:profile.name}, JWT_SECRET, {expiresIn:"30d"});
  const levelInfo = getLevel(withAch.xp);

  res.json({
    token,
    user:{ userId:profile.userId, name:profile.name, email:email.toLowerCase(),
      exam:profile.exam, subjects:profile.subjects||[], state:profile.state||"",
      xp:withAch.xp, level:levelInfo, achievements:withAch.achievements,
      currentStreak:withAch.currentStreak, longestStreak:withAch.longestStreak,
      lastStudyDate:withAch.lastStudyDate, totalStudyDays:withAch.totalStudyDays,
      stats:withAch.stats, createdAt:profile.createdAt },
    newlyEarned: earned,
    streakBonus: bonus,
  });
});

// ── GET PROFILE ───────────────────────────────────────────────────────────────
app.get("/api/profile", auth, (req, res) => {
  const db = readDB();
  const profile = db.users[req.user.email];
  if(!profile) return res.status(404).json({error:"Profile not found"});
  const levelInfo = getLevel(profile.xp||0);
  res.json({
    userId:profile.userId, name:profile.name, email:profile.email,
    exam:profile.exam, subjects:profile.subjects||[], state:profile.state||"",
    xp:profile.xp||0, level:levelInfo, achievements:profile.achievements||[],
    currentStreak:profile.currentStreak||0, longestStreak:profile.longestStreak||0,
    lastStudyDate:profile.lastStudyDate, totalStudyDays:profile.totalStudyDays||0,
    stats:profile.stats||{}, createdAt:profile.createdAt,
    xpLog:(profile.xpLog||[]).slice(0,20),
  });
});

// ── UPDATE PROFILE ────────────────────────────────────────────────────────────
app.put("/api/profile", auth, (req, res) => {
  const { name, exam, subjects, state } = req.body;
  const db = readDB();
  const profile = db.users[req.user.email];
  if(!profile) return res.status(404).json({error:"Profile not found"});
  if(name) profile.name = name;
  if(exam) profile.exam = exam;
  if(subjects) profile.subjects = subjects;
  if(state !== undefined) profile.state = state;
  db.users[req.user.email] = profile;
  writeDB(db);
  res.json({success:true, message:"Profile updated"});
});

// ═══════════════════════════════════════════════════════════════════════════════
// STUDY HISTORY & PROGRESS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── SAVE QUIZ/CBT RESULT ──────────────────────────────────────────────────────
app.post("/api/progress/save", auth, (req, res) => {
  const { type, exam, subject, year, score, total, pct, jambScore,
          subjectBreakdown, qtype, wrongQuestions=[] } = req.body;

  const db = readDB();
  const profile = db.users[req.user.email];
  if(!profile) return res.status(404).json({error:"Profile not found"});

  // Update streak
  const { profile: p1 } = updateStreak(profile);

  // Award XP
  const xpGained = [];
  p1.stats = p1.stats || {};
  const extras = [];

  if(type === "quiz") {
    const correct = Math.round((pct/100)*total);
    p1.stats.quizzesCompleted = (p1.stats.quizzesCompleted||0)+1;
    p1.stats.totalAnswered    = (p1.stats.totalAnswered||0)+total;
    p1.stats.totalCorrect     = (p1.stats.totalCorrect||0)+correct;
    if(subject) p1.stats.subjectsPracticed = {...(p1.stats.subjectsPracticed||{}), [subject]: (p1.stats.subjectsPracticed?.[subject]||0)+1};

    // XP awards
    awardXP(p1, `Quiz: ${subject||""}`, (correct*XP_RULES.correct) + ((total-correct)*XP_RULES.wrong));
    awardXP(p1, "Quiz completed", XP_RULES.quiz_done);
    if(pct===100){ awardXP(p1,"Perfect score!",XP_RULES.perfect_score); extras.push("perfect_quiz"); }
    if(pct>=75)   extras.push("waec_a1");

  } else if(type === "cbt") {
    p1.stats.cbtCompleted  = (p1.stats.cbtCompleted||0)+1;
    p1.stats.bestJAMB      = Math.max(p1.stats.bestJAMB||0, jambScore||0);
    const totalQ  = subjectBreakdown?.reduce((s,x)=>s+x.total,0)||0;
    const totalC  = subjectBreakdown?.reduce((s,x)=>s+x.correct,0)||0;
    p1.stats.totalAnswered = (p1.stats.totalAnswered||0)+totalQ;
    p1.stats.totalCorrect  = (p1.stats.totalCorrect||0)+totalC;
    (subjectBreakdown||[]).forEach(sb => {
      if(sb.name) p1.stats.subjectsPracticed = {...(p1.stats.subjectsPracticed||{}), [sb.name]: (p1.stats.subjectsPracticed?.[sb.name]||0)+1};
    });
    awardXP(p1, `JAMB CBT: ${jambScore}/400`, (totalC*XP_RULES.correct)+((totalQ-totalC)*XP_RULES.wrong));
    awardXP(p1, "CBT completed", XP_RULES.cbt_done);
    if(jambScore>=280) extras.push("cbt_280");
    if(jambScore>=300) extras.push("cbt_300");
  }

  p1.stats.longestStreak = p1.longestStreak||0;

  // Check achievements
  const { profile: p2, earned } = checkAchievements(p1, extras);

  // Save to history (keep last 200 sessions)
  const historyEntry = {
    id:`h_${Date.now()}`, type, exam, subject, year, score, total, pct,
    jambScore, subjectBreakdown, qtype, wrongQuestions,
    xpEarned: (p2.xpLog||[]).slice(0,5).reduce((s,x)=>s+x.amount,0),
    ts: Date.now(),
  };
  p2.history = [historyEntry, ...(p2.history||[])].slice(0,200);

  db.users[req.user.email] = p2;
  writeDB(db);

  const levelInfo = getLevel(p2.xp||0);
  const prevLevel = getLevel((p2.xp||0) - (p2.xpLog?.[0]?.amount||0));
  const levelUp   = levelInfo.level > prevLevel.level;

  res.json({
    success:true,
    xp: p2.xp,
    level: levelInfo,
    levelUp,
    newlyEarned: earned,
    currentStreak: p2.currentStreak,
    longestStreak: p2.longestStreak,
  });
});

// ── GET HISTORY ───────────────────────────────────────────────────────────────
app.get("/api/progress/history", auth, (req, res) => {
  const { limit=50, type } = req.query;
  const db = readDB();
  const profile = db.users[req.user.email];
  if(!profile) return res.status(404).json({error:"Profile not found"});

  let history = profile.history||[];
  if(type) history = history.filter(h => h.type===type);
  history = history.slice(0, parseInt(limit));

  res.json({ history, total: (profile.history||[]).length });
});

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
app.get("/api/leaderboard", (req, res) => {
  const { limit=20 } = req.query;
  const db = readDB();
  const board = Object.values(db.users)
    .map(u => ({
      name: u.name,
      xp: u.xp||0,
      level: getLevel(u.xp||0),
      currentStreak: u.currentStreak||0,
      stats: { quizzesCompleted: u.stats?.quizzesCompleted||0, bestJAMB: u.stats?.bestJAMB||0, totalAnswered: u.stats?.totalAnswered||0 },
      joinedAt: u.createdAt,
    }))
    .sort((a,b) => b.xp - a.xp)
    .slice(0, parseInt(limit));
  res.json({ board });
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