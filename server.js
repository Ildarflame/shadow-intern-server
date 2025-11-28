// server.js — Shadow Intern STABLE VERSION (Use GPT-4.1-mini for ALL tweets)

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const OpenAI = require("openai");

const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3001;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const selectLicenseByKeyStmt = db.prepare("SELECT * FROM licenses WHERE license_key = ?");
const selectLicenseByIdStmt = db.prepare("SELECT * FROM licenses WHERE id = ?");
const insertLicenseStmt = db.prepare(`
  INSERT INTO licenses (
    license_key,
    active,
    limit_total,
    usage,
    created_at,
    updated_at,
    last_request_at
  ) VALUES (?, ?, ?, 0, ?, ?, NULL)
`);
const updateUsageStmt = db.prepare(`
  UPDATE licenses
  SET usage = usage + 1,
      updated_at = ?,
      last_request_at = ?
  WHERE id = ? AND usage < limit_total
`);
const insertUsageLogStmt = db.prepare(`
  INSERT INTO usage_logs (license_id, endpoint, created_at)
  VALUES (?, ?, ?)
`);
const selectAllLicensesStmt = db.prepare("SELECT * FROM licenses ORDER BY created_at DESC");
const totalRequestsStmt = db.prepare("SELECT COUNT(*) AS count FROM usage_logs");
const requestsPerKeyStmt = db.prepare(`
  SELECT l.license_key AS key, COUNT(u.id) AS count
  FROM usage_logs u
  INNER JOIN licenses l ON l.id = u.license_id
  GROUP BY l.license_key
`);
const requestsSinceStmt = db.prepare("SELECT COUNT(*) AS count FROM usage_logs WHERE created_at >= ?");
const lastActivityStmt = db.prepare("SELECT MAX(created_at) AS last FROM usage_logs");

function now() {
  return Date.now();
}

function getLicenseByKey(key) {
  if (!key) return null;
  return selectLicenseByKeyStmt.get(key);
}

function mapLicenseRow(row) {
  if (!row) return null;
  const remaining = Math.max(row.limit_total - row.usage, 0);
  return {
    key: row.license_key,
    active: !!row.active,
    limit: row.limit_total,
    usage: row.usage,
    remaining,
    lastRequest: row.last_request_at || null,
    created: row.created_at
  };
}

function getLicenseStatus(row) {
  if (!row) return null;
  return {
    active: !!row.active,
    limit: row.limit_total,
    usage: row.usage,
    remaining: Math.max(row.limit_total - row.usage, 0)
  };
}

function validateLicense(key) {
  const row = getLicenseByKey(key);
  if (!row) {
    return { valid: false, status: 401, message: "Invalid license key" };
  }

  if (!row.active) {
    return { valid: false, status: 403, message: "License disabled" };
  }

  if (row.usage >= row.limit_total) {
    return { valid: false, status: 403, message: "License limit exceeded" };
  }

  return { valid: true, license: row };
}

const incrementUsageAndLog = db.transaction((licenseId, endpoint) => {
  const timestamp = now();
  const result = updateUsageStmt.run(timestamp, timestamp, licenseId);

  if (result.changes === 0) {
    const error = new Error("LICENSE_LIMIT_REACHED");
    error.code = "LICENSE_LIMIT_REACHED";
    throw error;
  }

  insertUsageLogStmt.run(licenseId, endpoint, timestamp);
  return selectLicenseByIdStmt.get(licenseId);
});

function generateLicenseKey() {
  return `shadow-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeLimit(value, fallback = 500) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.floor(num);
}

function normalizeActive(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "1" || normalized === "true") return true;
    if (normalized === "0" || normalized === "false") return false;
  }
  return null;
}

function createLicense({ key, limit, active } = {}) {
  const licenseKey =
    typeof key === "string" && key.trim() ? key.trim() : generateLicenseKey();
  const limitValue =
    typeof limit === "number" ? Math.max(0, Math.floor(limit)) : 500;
  const isActive = typeof active === "boolean" ? (active ? 1 : 0) : 1;
  const timestamp = now();

  try {
    insertLicenseStmt.run(licenseKey, isActive, limitValue, timestamp, timestamp);
  } catch (error) {
    if (
      error.code === "SQLITE_CONSTRAINT" ||
      error.code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      const duplicateError = new Error("License key already exists");
      duplicateError.code = "DUPLICATE_LICENSE_KEY";
      throw duplicateError;
    }
    throw error;
  }

  return mapLicenseRow(getLicenseByKey(licenseKey));
}

function updateLicenseRecord({ key, limit, active }) {
  const row = getLicenseByKey(key);
  if (!row) {
    return null;
  }

  const setClauses = [];
  const params = [];

  if (typeof limit === "number") {
    const limitValue = Math.max(0, Math.floor(limit));
    setClauses.push("limit_total = ?");
    params.push(limitValue);
  }

  if (typeof active === "boolean") {
    setClauses.push("active = ?");
    params.push(active ? 1 : 0);
  }

  setClauses.push("updated_at = ?");
  params.push(now());
  params.push(row.id);

  db.prepare(`UPDATE licenses SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

  return mapLicenseRow(getLicenseByKey(key));
}

function getAllLicenses() {
  return selectAllLicensesStmt.all().map(mapLicenseRow);
}

function getTodayMidnightTimestamp() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.getTime();
}

function getDashboardStats() {
  const keys = getAllLicenses();
  const totalKeys = keys.length;
  const activeKeys = keys.filter(key => key.active).length;
  const inactiveKeys = totalKeys - activeKeys;

  const totalRequests = totalRequestsStmt.get().count || 0;
  const requestsPerKey = {};
  for (const row of requestsPerKeyStmt.all()) {
    requestsPerKey[row.key] = row.count;
  }
  const requestsToday = requestsSinceStmt.get(getTodayMidnightTimestamp()).count || 0;
  const lastActivityRow = lastActivityStmt.get();

  return {
    totalKeys,
    activeKeys,
    inactiveKeys,
    keys,
    serverStats: {
      totalRequests,
      requestsPerKey,
      requestsToday,
      lastActivity: lastActivityRow?.last || null
    }
  };
}

function isLocalhostRequest(req) {
  const clientIp =
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "";

  const localhostValues = new Set([
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "localhost"
  ]);

  if (localhostValues.has(clientIp)) return true;
  if (localhostValues.has(req.hostname)) return true;

  return false;
}

function requireLocalhost(req, res, next) {
  if (!isLocalhostRequest(req)) {
    return res
      .status(403)
      .json({ error: "Admin endpoints only accessible from localhost" });
  }
  next();
}

function requireLicense(req, res, next) {
  const key = req.header("x-license-key");

  if (!key) {
    return res.status(401).json({ error: "License key missing" });
  }

  const validation = validateLicense(key);

  if (!validation.valid) {
    return res.status(validation.status).json({ error: validation.message });
  }

  req.license = { key, record: validation.license };
  next();
}

// ---------- SYSTEM PROMPT (English only) ----------

const BASE_SYSTEM_PROMPT = `
You are Shadow Intern — a sarcastic, sharp-tongued, crypto-degen CT reply machine.

Rules:
- ALWAYS respond ONLY in English.
- 1–2 punchy sentences max.
- Sarcastic, confident, a bit toxic (but platform-safe).
- Never explain, never disclaim, never mention AI.
- ALWAYS react to tweet text + image if provided.
`.trim();

const HUMANIZE_SYSTEM_PROMPT = `
You are Shadow Intern, writing casual Twitter replies.
Always write in English.
Use contractions (I'm, it's, don't), casual slang, and short broken phrases.
Keep punctuation loose: no semicolons, no fancy quotes, no markdown, no lists.
Never use long em dashes (—); if needed, use simple hyphens.
Make it feel like a quick human tweet, never an AI essay.
`.trim();

const TONE_PROMPTS = {
  neutral: "Balanced CT voice with subtle edge.",
  degen: "Full degen energy: cocky, chaotic, meme-heavy.",
  professional: "Polished, credible, but still sharp.",
  toxic: "Maximum spice without breaking platform rules."
};

function clampMaxChars(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 220;
  return Math.max(50, Math.min(500, Math.round(num)));
}

function estimateTokenLimit(maxChars) {
  return Math.max(32, Math.ceil(maxChars / 4));
}

function sanitizeHumanize(value) {
  if (typeof value === "boolean") return value;
  if (value === "false") return false;
  if (value === "true") return true;
  return true;
}

function sanitizeGenerationSettings(mode, rawSettings = {}) {
  const tone = TONE_PROMPTS[rawSettings.tone] ? rawSettings.tone : "neutral";
  return {
    modeId: rawSettings.modeId || mode,
    modeLabel: (rawSettings.modeLabel || "").trim() || mode,
    promptTemplate: (rawSettings.promptTemplate || "").trim(),
    tone,
    toneHint: TONE_PROMPTS[tone],
    maxChars: clampMaxChars(rawSettings.maxChars),
    humanize: sanitizeHumanize(rawSettings.humanize)
  };
}

function buildSystemPrompt(generation) {
  if (generation.humanize) {
    return `${BASE_SYSTEM_PROMPT}\n\n${HUMANIZE_SYSTEM_PROMPT}`;
  }
  return BASE_SYSTEM_PROMPT;
}

function preparePrompt(mode, tweetText, imageUrls, rawSettings) {
  const generation = sanitizeGenerationSettings(mode, rawSettings);
  const text = tweetText?.trim() || "";
  const systemMessage = buildSystemPrompt(generation);
  const lengthInstruction = `Write a reply no longer than ${generation.maxChars} characters. Stop early if needed.`;

  const promptSections = [
    `Mode: ${generation.modeLabel}`,
    `Tone: ${generation.tone.toUpperCase()} — ${generation.toneHint}`,
    generation.promptTemplate
      ? `Prompt template:\n${generation.promptTemplate}`
      : "Prompt template:\nLean into the core vibe of the selected mode.",
    `Constraints:
- Reply ONLY in English.
- ${lengthInstruction}
- Make it contextual to the tweet text and any provided media.`.trim()
  ];

  const content = [
    {
      type: "text",
      text: [
        promptSections.join("\n\n"),
        `Tweet text:\n${text || "(no text, image-only tweet)"}`
      ].join("\n\n")
    }
  ];

  for (const url of imageUrls || []) {
    content.push({
      type: "image_url",
      image_url: { url }
    });
  }

  return {
    generation,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content }
    ]
  };
}

// ---------- MAIN ROUTE ----------

app.post("/api/xallower-reply", async (req, res) => {
  try {
    const { mode, tweetText, imageUrls = [], settings } = req.body;

    console.log("=== SHADOW INTERN CALL ===");
    console.log("TEXT:", tweetText);
    console.log("IMAGES:", imageUrls);

    const { messages, generation } = preparePrompt(mode, tweetText, imageUrls, settings);
    const tokenLimit = estimateTokenLimit(generation.maxChars);
    const temperature =
      typeof settings?.temperature === "number" ? settings.temperature : 0.9;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      temperature,
      max_tokens: tokenLimit
    });

    let reply =
      response.choices?.[0]?.message?.content?.trim() ||
      "Shadow Intern failed to respond.";

    if (reply.length > generation.maxChars) {
      reply = reply.slice(0, generation.maxChars).trim();
    }

    res.json({ reply });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ error: "OpenAI error" });
  }
});

app.post("/license/validate", (req, res) => {
  const { key } = req.body || {};

  if (!key) {
    return res.status(400).json({ error: "License key required" });
  }

  const validation = validateLicense(key);

  if (!validation.valid) {
    return res
      .status(validation.status)
      .json({ error: validation.message });
  }

  const status = getLicenseStatus(validation.license);
  res.json({ ok: true, license: { ...status } });
});

app.post("/shadow/generate", requireLicense, async (req, res) => {
  try {
    const { mode, tweetText, imageUrls = [], settings } = req.body;
    const licenseKey = req.license?.key;
    const licenseRecord = req.license?.record;

    console.log("=== SHADOW INTERN LICENSED CALL ===");
    console.log("LICENSE:", licenseKey);
    console.log("TEXT:", tweetText);
    console.log("IMAGES:", imageUrls);

    const { messages, generation } = preparePrompt(mode, tweetText, imageUrls, settings);
    const tokenLimit = estimateTokenLimit(generation.maxChars);
    const temperature =
      typeof settings?.temperature === "number" ? settings.temperature : 0.9;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      temperature,
      max_tokens: tokenLimit
    });

    let reply =
      response.choices?.[0]?.message?.content?.trim() ||
      "Shadow Intern failed to respond.";

    if (reply.length > generation.maxChars) {
      reply = reply.slice(0, generation.maxChars).trim();
    }

    if (!licenseRecord?.id) {
      console.error("LICENSE RECORD MISSING FOR", licenseKey);
      return res.status(500).json({ error: "License state unavailable" });
    }

    try {
      incrementUsageAndLog(licenseRecord.id, "/shadow/generate");
    } catch (usageError) {
      if (usageError.code === "LICENSE_LIMIT_REACHED") {
        return res.status(403).json({ error: "License limit exceeded" });
      }
      throw usageError;
    }

    res.json({ reply });
  } catch (err) {
    console.error("LICENSED SERVER ERROR:", err);
    res.status(500).json({ error: "OpenAI error" });
  }
});

// ---------- ADMIN ROUTES ----------

app.use("/admin", requireLocalhost);

app.post("/admin/license/create", (req, res) => {
  const { key, limit, active } = req.body || {};
  const normalizedLimit = normalizeLimit(limit, undefined);
  if (limit !== undefined && normalizedLimit === null) {
    return res
      .status(400)
      .json({ error: "Limit must be a non-negative number" });
  }

  const normalizedActive = normalizeActive(active);
  if (active !== undefined && normalizedActive === null) {
    return res.status(400).json({ error: "Active must be a boolean" });
  }

  try {
    const license = createLicense({
      key,
      limit: normalizedLimit ?? undefined,
      active: normalizedActive
    });

    res.json({
      key: license.key,
      active: license.active,
      limit: license.limit,
      usage: license.usage,
      remaining: license.remaining,
      created: license.created
    });
  } catch (error) {
    if (error.code === "DUPLICATE_LICENSE_KEY") {
      return res.status(409).json({ error: "License key already exists" });
    }
    console.error("ADMIN CREATE ERROR:", error);
    res.status(500).json({ error: "Failed to create license" });
  }
});

app.post("/admin/license/update", (req, res) => {
  const { key, limit, active } = req.body || {};

  if (!key) {
    return res.status(400).json({ error: "License key required" });
  }

  let limitValue;
  if (limit !== undefined) {
    const normalizedLimit = normalizeLimit(limit, undefined);
    if (normalizedLimit === null) {
      return res
        .status(400)
        .json({ error: "Limit must be a non-negative number" });
    }
    limitValue = normalizedLimit;
  }

  let activeValue;
  if (active !== undefined) {
    const normalizedActive = normalizeActive(active);
    if (normalizedActive === null) {
      return res.status(400).json({ error: "Active must be a boolean" });
    }
    activeValue = normalizedActive;
  }

  const updated = updateLicenseRecord({
    key,
    limit: limitValue,
    active: activeValue
  });

  if (!updated) {
    return res.status(404).json({ error: "License not found" });
  }

  res.json({
    key: updated.key,
    active: updated.active,
    limit: updated.limit,
    usage: updated.usage,
    remaining: updated.remaining,
    lastRequest: updated.lastRequest,
    created: updated.created
  });
});

app.get("/admin/licenses", (req, res) => {
  res.json(getAllLicenses());
});

app.get("/admin/dashboard", (req, res) => {
  const stats = getDashboardStats();
  res.json(stats);
});

// ---------- START ----------

app.listen(port, () => {
  console.log("🚀 Shadow Intern server listening on port", port);
});