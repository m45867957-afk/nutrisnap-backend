// سرور بک‌اند برای مدیریت اشتراک با Stripe
// نسخه رایگان: هفته‌ای ۳ تحلیل، فقط کالری و قند.
// نسخه Premium: ۶.۹۹ دلار در ماه یا ۴۹.۹۹ دلار در سال — تحلیل نامحدود + جزئیات کامل + برنامه غذایی + تاریخچه.
//
// این سرور را روی یک هاست واقعی (مثل Railway, Render, یا Fly.io) دیپلوی کن.
//
// ⚠️ این نسخه از سرور از Redis برای ذخیره‌ی دائمی استفاده می‌کند (نه حافظه‌ی موقت داخل کد).
// قبل از دیپلوی، باید یک افزونه‌ی Redis به پروژه‌ی Railway‌ات اضافه کنی:
//   ۱. تو داشبورد Railway، روی پروژه‌ات کلیک کن → "+ New" → "Database" → "Add Redis"
//   ۲. Railway به‌صورت خودکار یک متغیر REDIS_URL می‌سازد و آن را به این سرویس هم وصل می‌کند
//   ۳. نیازی نیست خودت REDIS_URL را دستی تنظیم کنی، Railway این کار را انجام می‌دهد
//
// همچنین باید این دو پکیج را به package.json اضافه کنی:
//   npm install ioredis express-rate-limit

const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const Redis = require("ioredis");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
if (!redis) {
  console.warn("⚠️ REDIS_URL تنظیم نشده — داده‌ها موقتی هستند و با ری‌استارت پاک می‌شوند!");
}

const memoryFallback = new Map();

async function kvGet(key) {
  if (redis) {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  }
  return memoryFallback.get(key) ?? null;
}

async function kvSet(key, value, ttlSeconds) {
  if (redis) {
    if (ttlSeconds) {
      await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } else {
      await redis.set(key, JSON.stringify(value));
    }
    return;
  }
  memoryFallback.set(key, value);
}

async function kvDelete(key) {
  if (redis) {
    await redis.del(key);
    return;
  }
  memoryFallback.delete(key);
}

const app = express();
// فقط به دامنه‌ی فرانت‌اند خودت اجازه‌ی وصل شدن بده، نه به هر سایتی.
// اگه دامنه‌ی جدید (مثلاً بعد از خرید دامنه‌ی اختصاصی) گرفتی، آن را هم به این لیست اضافه کن.
const ALLOWED_ORIGINS = [
  "https://cactus-4e3aa9.netlify.app",
  process.env.FRONTEND_URL, // می‌توانی این متغیر را در Railway ست کنی تا نیازی به ویرایش کد نباشد
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // درخواست‌های بدون origin (مثل curl یا اپ موبایل native) را هم اجازه بده
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("این دامنه اجازه‌ی دسترسی ندارد (CORS)"));
      }
    },
  })
);
app.set("trust proxy", 1);

const FREE_WEEKLY_LIMIT = 3;

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function isPremium(userId) {
  const sub = await kvGet(`sub:${userId}`);
  return !!sub && sub.status === "active";
}

// یک سقف جداگانه و بازتر بر اساس IP، فقط برای جلوگیری از سوءاستفاده‌ی آشکار
// (مثلاً پاک کردن localStorage برای گرفتن اسکن رایگان نامحدود از یک دستگاه/شبکه).
// عمداً بازتره چون چند کاربر واقعی می‌توانند پشت یک IP مشترک باشند (وای‌فای خانه/شرکت).
const FREE_WEEKLY_LIMIT_PER_IP = 10;

async function consumeWeeklyCounter(key, limit) {
  const week = isoWeekKey();
  const entry = await kvGet(key);
  if (!entry || entry.week !== week) {
    await kvSet(key, { week, count: 1 }, 60 * 60 * 24 * 10);
    return { allowed: true, remaining: limit - 1 };
  }
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  await kvSet(key, entry, 60 * 60 * 24 * 10);
  return { allowed: true, remaining: limit - entry.count };
}

async function checkAndConsumeFreeUsage(userId, ip) {
  const byUser = await consumeWeeklyCounter(`usage:${userId}`, FREE_WEEKLY_LIMIT);
  const byIp = ip ? await consumeWeeklyCounter(`usage_ip:${ip}`, FREE_WEEKLY_LIMIT_PER_IP) : { allowed: true, remaining: FREE_WEEKLY_LIMIT };
  // سخت‌گیرترین محدودیت تصمیم نهایی را می‌گیرد — یعنی پاک کردن userId به‌تنهایی کافی نیست.
  if (!byUser.allowed || !byIp.allowed) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: Math.min(byUser.remaining, byIp.remaining) };
}

async function getRemainingFreeUsage(userId) {
  const week = isoWeekKey();
  const entry = await kvGet(`usage:${userId}`);
  if (!entry || entry.week !== week) return FREE_WEEKLY_LIMIT;
  return Math.max(0, FREE_WEEKLY_LIMIT - entry.count);
}

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests", message: "درخواست‌های زیادی فرستادی، یک دقیقه صبر کن." },
});

const MAX_CONCURRENT_ANALYSES = 25;
let activeAnalyses = 0;

// ---------- احراز هویت با ایمیل + کد تأیید (OTP) ----------
// این بخش جای شناسه‌ی تصادفی localStorage را می‌گیرد؛ چون شناسه‌ی کاربر از ایمیل تأییدشده
// ساخته می‌شود (نه یک رشته‌ی تصادفی)، پاک کردن مرورگر دیگر باعث نمی‌شود کاربر
// بی‌نهایت بار از نسخه‌ی رایگان استفاده کند — او باید دوباره به ایمیل خودش دسترسی داشته باشد.

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// از خود ایمیل، همیشه یک شناسه‌ی یکسان و پایدار می‌سازد (بدون نیاز به ذخیره‌ی جدول ایمیل↔شناسه).
function userIdFromEmail(email) {
  const hash = crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return "u_" + hash.slice(0, 24);
}

async function sendOtpEmail(email, code) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("⚠️ RESEND_API_KEY تنظیم نشده — ایمیل واقعی ارسال نمی‌شود.");
    console.log(`[DEV ONLY] کد تأیید برای ${email}: ${code}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || "NutriSnap <onboarding@resend.dev>",
      to: [email],
      subject: `${code} — کد تأیید NutriSnap`,
      html: `<div style="font-family:sans-serif;font-size:16px;">
        <p>کد تأیید شما:</p>
        <p style="font-size:32px;font-weight:800;letter-spacing:4px;">${code}</p>
        <p style="color:#888;font-size:13px;">این کد تا ۱۰ دقیقه معتبر است.</p>
      </div>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend error: ${res.status} ${text}`);
  }
}

const authSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5, // حداکثر ۵ بار درخواست کد در هر ۱۰ دقیقه برای هر IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests", message: "درخواست‌های زیادی فرستادی، چند دقیقه صبر کن." },
});

const authVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15, // جلوگیری از حدس‌زدن کد با تلاش‌های زیاد
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests", message: "تلاش‌های زیادی انجام شد، چند دقیقه صبر کن." },
});

app.post("/auth/send-code", authSendLimiter, express.json(), async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "invalid_email", message: "ایمیل معتبر نیست." });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000)); // کد ۶ رقمی
    await kvSet(`otp:${email}`, { code, attempts: 0 }, 600); // ۱۰ دقیقه اعتبار
    await sendOtpEmail(email, code);
    res.json({ sent: true });
  } catch (err) {
    console.error("خطای ارسال کد تأیید:", err);
    res.status(500).json({ error: "send_failed", message: "ارسال کد ناموفق بود." });
  }
});

app.post("/auth/verify-code", authVerifyLimiter, express.json(), async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const code = (req.body.code || "").trim();
    if (!isValidEmail(email) || !code) {
      return res.status(400).json({ error: "invalid_input" });
    }
    const entry = await kvGet(`otp:${email}`);
    if (!entry) {
      return res.status(400).json({ error: "code_expired", message: "کد منقضی شده، دوباره درخواست بده." });
    }
    if (entry.attempts >= 8) {
      await kvDelete(`otp:${email}`);
      return res.status(400).json({ error: "too_many_attempts", message: "تلاش‌های زیادی انجام شد، دوباره کد بگیر." });
    }
    if (entry.code !== code) {
      entry.attempts = (entry.attempts || 0) + 1;
      await kvSet(`otp:${email}`, entry, 600);
      return res.status(400).json({ error: "wrong_code", message: "کد اشتباه است." });
    }
    await kvDelete(`otp:${email}`);
    const userId = userIdFromEmail(email);
    res.json({ userId, email });
  } catch (err) {
    console.error("خطای تأیید کد:", err);
    res.status(500).json({ error: "verify_failed" });
  }
});

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) {
      return res.status(503).send("Stripe not configured yet");
    }
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("خطای تایید امضای webhook:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const plan = session.metadata && session.metadata.plan;
        await kvSet(`sub:${userId}`, { status: "active", customerId: session.customer, plan });
        await kvSet(`cust2user:${session.customer}`, userId);
        console.log(`کاربر ${userId} اشتراک ${plan} را فعال کرد.`);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = await kvGet(`cust2user:${subscription.customer}`);
        if (userId) {
          const prev = (await kvGet(`sub:${userId}`)) || {};
          await kvSet(`sub:${userId}`, { ...prev, status: subscription.status, customerId: subscription.customer });
        }
        console.log(`وضعیت اشتراک تغییر کرد: ${subscription.status}`);
        break;
      }
      case "invoice.payment_failed": {
        console.log("پرداخت ناموفق بود.");
        break;
      }
      default:
        break;
    }

    res.json({ received: true });
  }
);

app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Stripe not configured yet" });
  }
  try {
    const { userId, plan, successUrl, cancelUrl } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "userId لازم است" });
    }
    const priceId =
      plan === "yearly" ? process.env.STRIPE_PRICE_ID_YEARLY : process.env.STRIPE_PRICE_ID_MONTHLY;

    if (!priceId) {
      return res.status(500).json({ error: "Price ID not configured for this plan" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: userId,
      metadata: { plan: plan || "monthly" },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ساخت جلسه‌ی پرداخت ناموفق بود" });
  }
});

app.get("/subscription-status/:userId", async (req, res) => {
  const sub = await kvGet(`sub:${req.params.userId}`);
  const premium = await isPremium(req.params.userId);
  res.json({
    status: sub ? sub.status : "none",
    plan: sub ? sub.plan : null,
    isPremium: premium,
    freeRemaining: premium ? null : await getRemainingFreeUsage(req.params.userId),
    freeLimit: FREE_WEEKLY_LIMIT,
  });
});

app.get("/usage/:userId", async (req, res) => {
  const premium = await isPremium(req.params.userId);
  res.json({
    isPremium: premium,
    remaining: premium ? null : await getRemainingFreeUsage(req.params.userId),
    limit: FREE_WEEKLY_LIMIT,
  });
});

app.get("/admin/grant-premium", async (req, res) => {
  const { userId, secret } = req.query;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "دسترسی مجاز نیست" });
  }
  if (!userId) {
    return res.status(400).json({ error: "userId لازم است" });
  }
  await kvSet(`sub:${userId}`, { status: "active", plan: "test", customerId: null });
  res.json({ message: `کاربر ${userId} حالا Premium شد.`, status: "active" });
});

app.get("/admin/revoke-premium", async (req, res) => {
  const { userId, secret } = req.query;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "دسترسی مجاز نیست" });
  }
  if (!userId) {
    return res.status(400).json({ error: "userId لازم است" });
  }
  await kvDelete(`sub:${userId}`);
  res.json({ message: `کاربر ${userId} به حالت رایگان برگشت.` });
});

const USDA_API_KEY = process.env.USDA_API_KEY || "DEMO_KEY";

async function lookupUSDA(searchTerm, weightGrams) {
  if (!searchTerm) return null;
  try {
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_API_KEY}&query=${encodeURIComponent(
      searchTerm
    )}&pageSize=1&dataType=Foundation,SR%20Legacy`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const food = data.foods && data.foods[0];
    if (!food) return null;

    const nutrientMap = {};
    for (const n of food.foodNutrients || []) {
      nutrientMap[n.nutrientName] = n.value;
    }
    const factor = (weightGrams || 100) / 100;
    const get = (name) =>
      nutrientMap[name] != null ? Math.round(nutrientMap[name] * factor * 10) / 10 : null;

    const result = {
      calories: get("Energy"),
      protein: get("Protein"),
      fat: get("Total lipid (fat)"),
      sugar: get("Sugars, total including NLEA") ?? get("Sugars, total"),
      fiber: get("Fiber, total dietary"),
      calcium: get("Calcium, Ca"),
      iron: get("Iron, Fe"),
      potassium: get("Potassium, K"),
      vitaminC: get("Vitamin C, total ascorbic acid"),
      vitaminA: get("Vitamin A, RAE"),
    };
    if (result.calories == null) return null;
    return result;
  } catch {
    return null;
  }
}

app.post("/analyze", analyzeLimiter, async (req, res) => {
  if (activeAnalyses >= MAX_CONCURRENT_ANALYSES) {
    return res.status(503).json({
      error: "server_busy",
      message: "سرور الان شلوغه، چند ثانیه دیگه دوباره امتحان کن.",
    });
  }
  activeAnalyses += 1;
  try {
    const { userId, base64, mediaType, lang } = req.body;
    if (!userId || !base64) {
      return res.status(400).json({ error: "userId و base64 لازم است" });
    }

    const premium = await isPremium(userId);
    let usageInfo = null;
    if (!premium) {
      const usage = await checkAndConsumeFreeUsage(userId, req.ip);
      if (!usage.allowed) {
        return res.status(403).json({
          error: "weekly_limit_reached",
          message:
            lang === "en"
              ? "You've used all 3 free analyses this week. Upgrade to Premium for unlimited access."
              : "تحلیل‌های رایگان این هفته‌ت تموم شد. برای دسترسی نامحدود، Premium رو فعال کن.",
        });
      }
      usageInfo = usage;
    }

    const promptText =
      lang === "en"
        ? `This photo shows a food item (fruit, vegetable, or meal) — it may be an Iranian/Persian dish. Look very carefully before naming it — accuracy matters a lot, a wrong identification ruins all the nutrition numbers. If you are not fully sure, pick the closest common food and lower your confidencePercent instead of guessing wildly. Identify it, give a simple common English name for database lookup (e.g. "banana", "grilled chicken breast", "white rice cooked"), estimate its visible weight in grams from the image, and calculate nutrition values for that ESTIMATED weight (not a generic serving). Also rate its suitability for three groups, write one short overall verdict line, one practical actionable tip with real numbers (like a portion-control or swap suggestion), one healthier alternative food, and suggest one short related recipe or meal idea. Return ONLY a raw JSON object, no explanation or Markdown, exactly in this shape:
{"name": "food name", "searchTerm": "simple common English food name", "confidence": "high" or "medium" or "low", "confidencePercent": number from 0 to 100, "weightGrams": number, "serving": "e.g. ~150g piece",
"calories": number, "protein": number, "sugar": number, "fiber": number, "fat": number, "calcium": number, "iron": number, "potassium": number, "vitaminC": number, "vitaminA": number,
"aiAdvice": "one short verdict sentence under 8 words, e.g. 'Great for weight loss.' or 'Enjoy in moderation.'",
"smartTip": "one practical, actionable tip with real numbers about portion size or a healthier swap, 1-2 sentences, e.g. 'Eating half this burger gives you 280 kcal and still 20g protein.'",
"healthierAlternative": "one short sentence naming a healthier alternative food or swap",
"diabetic": {"suitable": true or false, "note": "short reason, under 12 words"},
"athlete": {"suitable": true or false, "note": "short reason, under 12 words"},
"weightLoss": {"suitable": true or false, "note": "short reason, under 12 words"},
"recipe": "one short recipe or diet suggestion using this food, 1-2 sentences"}`
        : `این عکس یک ماده‌ی خوراکی (میوه، سبزی یا غذا) است — ممکن است یک غذای ایرانی باشد. قبل از نام‌گذاری با دقت زیاد نگاه کن — دقت خیلی مهم است، چون تشخیص اشتباه کل اعداد تغذیه‌ای را بی‌اعتبار می‌کند. اگر کاملاً مطمئن نیستی، نزدیک‌ترین غذای رایج را انتخاب کن و مقدار confidencePercent را پایین‌تر بگذار، نه اینکه حدس تصادفی بزنی. آن را شناسایی کن، یک نام ساده و رایج انگلیسی برای جستجو در دیتابیس بده، وزن قابل مشاهده در تصویر را به گرم تخمین بزن، و مقادیر تغذیه‌ای را برای همان وزن تخمینی محاسبه کن. همچنین مناسب بودنش را برای سه گروه ارزیابی کن، یک جمع‌بندی کوتاه یک‌خطی بنویس، یک پیشنهاد عملی و کاربردی با عدد واقعی بده، یک جایگزین سالم‌تر پیشنهاد بده، و یک پیشنهاد کوتاه دستور غذا یا رژیم مرتبط هم بده. فقط یک شیء JSON خام برگردان، بدون هیچ توضیح یا Markdown، دقیقاً با این ساختار:
{"name": "نام فارسی ماده خوراکی", "searchTerm": "نام ساده انگلیسی ماده غذایی", "confidence": "high" یا "medium" یا "low", "confidencePercent": عددی بین ۰ تا ۱۰۰, "weightGrams": عدد, "serving": "مثلاً یک عدد متوسط تقریباً ۱۵۰ گرم",
"calories": عدد, "protein": عدد, "sugar": عدد, "fiber": عدد, "fat": عدد, "calcium": عدد, "iron": عدد, "potassium": عدد, "vitaminC": عدد, "vitaminA": عدد,
"aiAdvice": "یک جمع‌بندی کوتاه زیر ۸ کلمه، مثلاً 'برای کاهش وزن عالیه.' یا 'در حد اعتدال مصرف کن.'",
"smartTip": "یک پیشنهاد عملی و کاربردی با عدد واقعی درباره‌ی حجم وعده یا جایگزینی سالم‌تر، در ۱ تا ۲ جمله",
"healthierAlternative": "یک جمله‌ی کوتاه با نام یک جایگزین سالم‌تر یا یک تعویض ساده",
"diabetic": {"suitable": true یا false, "note": "دلیل کوتاه، زیر ۱۲ کلمه"},
"athlete": {"suitable": true یا false, "note": "دلیل کوتاه، زیر ۱۲ کلمه"},
"weightLoss": {"suitable": true یا false, "note": "دلیل کوتاه، زیر ۱۲ کلمه"},
"recipe": "یک پیشنهاد کوتاه دستور غذا یا رژیم با این ماده، در ۱ تا ۲ جمله"}`;

    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: promptText },
            ],
          },
        ],
      }),
    });

    const data = await aiResponse.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("no text block");
    const clean = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    const dbResult = await lookupUSDA(parsed.searchTerm || parsed.name, parsed.weightGrams);
    let merged = dbResult
      ? { ...parsed, ...dbResult, dataSource: "usda" }
      : { ...parsed, dataSource: "ai_estimate" };

    if (premium) {
      merged.tier = "premium";
    } else {
      merged = {
        name: merged.name,
        weightGrams: merged.weightGrams,
        serving: merged.serving,
        calories: merged.calories,
        sugar: merged.sugar,
        dataSource: merged.dataSource,
        confidence: merged.confidence,
        confidencePercent: merged.confidencePercent,
        aiAdvice: merged.aiAdvice,
        tier: "free",
        usage: { remaining: usageInfo.remaining, limit: FREE_WEEKLY_LIMIT },
      };
    }

    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تحلیل تصویر ناموفق بود" });
  } finally {
    activeAnalyses -= 1;
  }
});

app.post("/meal-plan", async (req, res) => {
  try {
    const { userId, recentFoods, lang } = req.body;

    if (!(await isPremium(userId))) {
      return res.status(403).json({
        error: "premium_required",
        message:
          lang === "en"
            ? "Personal meal plans are a Premium feature."
            : "برنامه‌ی غذایی شخصی یک ویژگی Premium است.",
      });
    }

    const foodsList = (recentFoods || []).slice(0, 15).join(lang === "en" ? ", " : "، ");
    const promptText =
      lang === "en"
        ? `Based on these recently scanned foods: ${foodsList || "no data yet"}, suggest a short, practical one-day personal meal plan (breakfast, lunch, dinner, one snack). Keep it concise. Respond in plain text, no JSON, no Markdown headers.`
        : `بر اساس این غذاهای اسکن‌شده‌ی اخیر: ${foodsList || "هنوز داده‌ای نیست"}، یک برنامه‌ی غذایی شخصی کوتاه و عملی برای یک روز (صبحانه، ناهار، شام، یک میان‌وعده) پیشنهاد بده. کوتاه و خلاصه بنویس. به‌صورت متن ساده جواب بده، بدون JSON و بدون هدر Markdown.`;

    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        messages: [{ role: "user", content: promptText }],
      }),
    });

    const data = await aiResponse.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("no text block");

    res.json({ plan: textBlock.text.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ساخت برنامه‌ی غذایی ناموفق بود" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`سرور روی پورت ${PORT} در حال اجراست`));
