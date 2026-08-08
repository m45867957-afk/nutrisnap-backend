// سرور بک‌اند برای مدیریت اشتراک با Stripe
// نسخه رایگان: روزی ۳ تحلیل، فقط کالری و قند.
// نسخه Premium: ۳.۹۹ دلار در ماه یا ۲۹.۹۹ دلار در سال — تحلیل نامحدود + جزئیات کامل + برنامه غذایی + تاریخچه.
//
// این سرور را روی یک هاست واقعی (مثل Railway, Render, یا Fly.io) دیپلوی کن.
// نباید روی یک سرویس بدون سرور موقتی (مثل artifact) اجرا شود، چون به دیتابیس دائمی نیاز دارد.

const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

// اگر STRIPE_SECRET_KEY هنوز تنظیم نشده باشد، سرور کرش نمی‌کند —
// فقط قابلیت‌های مربوط به پرداخت (checkout و webhook) غیرفعال می‌مانند تا بعداً کلید را اضافه کنی.
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const app = express();
app.use(cors());

// ذخیره‌ی موقت و ساده در حافظه — فقط برای شروع کار.
// هشدار: با هر ری‌استارت سرور این اطلاعات پاک می‌شود.
// قبل از استفاده‌ی واقعی، این را با یک دیتابیس واقعی (Postgres, MongoDB, Supabase و ...) جایگزین کن.
const subscriptions = new Map(); // userId -> { status, customerId, plan }
const customerToUser = new Map(); // customerId -> userId
const dailyUsage = new Map(); // userId -> { date: "YYYY-MM-DD", count: number }

const FREE_DAILY_LIMIT = 3;

function isPremium(userId) {
  const sub = subscriptions.get(userId);
  return !!sub && sub.status === "active";
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// تعداد استفاده‌ی رایگان امروز را چک می‌کند و در صورت مجاز بودن، مصرف می‌کند
function checkAndConsumeFreeUsage(userId) {
  const today = todayStr();
  const entry = dailyUsage.get(userId);
  if (!entry || entry.date !== today) {
    dailyUsage.set(userId, { date: today, count: 1 });
    return { allowed: true, remaining: FREE_DAILY_LIMIT - 1 };
  }
  if (entry.count >= FREE_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: FREE_DAILY_LIMIT - entry.count };
}

function getRemainingFreeUsage(userId) {
  const today = todayStr();
  const entry = dailyUsage.get(userId);
  if (!entry || entry.date !== today) return FREE_DAILY_LIMIT;
  return Math.max(0, FREE_DAILY_LIMIT - entry.count);
}

// نکته: مسیر webhook باید body خام (raw) دریافت کند، پس قبل از express.json() تعریف می‌شود.
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

    // این رویدادها وضعیت اشتراک کاربر را نشان می‌دهند.
    // در اینجا باید وضعیت را در دیتابیس واقعی خودت (Postgres, MongoDB و ...) ذخیره کنی.
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const plan = session.metadata && session.metadata.plan;
        subscriptions.set(userId, { status: "active", customerId: session.customer, plan });
        customerToUser.set(session.customer, userId);
        console.log(`کاربر ${userId} اشتراک ${plan} را فعال کرد.`);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = customerToUser.get(subscription.customer);
        if (userId) {
          const prev = subscriptions.get(userId) || {};
          subscriptions.set(userId, { ...prev, status: subscription.status, customerId: subscription.customer });
        }
        console.log(`وضعیت اشتراک تغییر کرد: ${subscription.status}`);
        break;
      }
      case "invoice.payment_failed": {
        console.log("پرداخت ناموفق بود.");
        // اینجا می‌توانی به کاربر ایمیل بزنی یا دسترسی را قطع کنی.
        break;
      }
      default:
        break;
    }

    res.json({ received: true });
  }
);

app.use(express.json());

// این endpoint را از فرانت‌اند صدا بزن تا کاربر به صفحه‌ی پرداخت Stripe هدایت شود.
// plan باید "monthly" یا "yearly" باشد.
app.post("/create-checkout-session", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Stripe not configured yet" });
  }
  try {
    const { userId, plan, successUrl, cancelUrl } = req.body;
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

// این endpoint را برای چک کردن وضعیت اشتراک کاربر در اپ صدا بزن.
app.get("/subscription-status/:userId", async (req, res) => {
  const sub = subscriptions.get(req.params.userId);
  const premium = isPremium(req.params.userId);
  res.json({
    status: sub ? sub.status : "none",
    plan: sub ? sub.plan : null,
    isPremium: premium,
    freeRemaining: premium ? null : getRemainingFreeUsage(req.params.userId),
    freeLimit: FREE_DAILY_LIMIT,
  });
});

// وضعیت مصرف رایگان امروز را بدون انجام تحلیل برمی‌گرداند (برای نمایش در رابط کاربری)
app.get("/usage/:userId", async (req, res) => {
  const premium = isPremium(req.params.userId);
  res.json({
    isPremium: premium,
    remaining: premium ? null : getRemainingFreeUsage(req.params.userId),
    limit: FREE_DAILY_LIMIT,
  });
});

// راه میانبر فقط برای تست: با یه رمز مخفی (ADMIN_SECRET) می‌تونی حساب یه کاربر رو
// دستی Premium کنی، بدون نیاز به پرداخت واقعی. این را فقط خودت استفاده کن، جایی منتشرش نکن.
// نمونه‌ی استفاده (توی نوار آدرس مرورگر): 
// https://آدرس-سرورت/admin/grant-premium?userId=SHENASE-KHODAT&secret=RAMZ-MAKHFI
app.get("/admin/grant-premium", async (req, res) => {
  const { userId, secret } = req.query;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "دسترسی مجاز نیست" });
  }
  if (!userId) {
    return res.status(400).json({ error: "userId لازم است" });
  }
  subscriptions.set(userId, { status: "active", plan: "test", customerId: null });
  res.json({ message: `کاربر ${userId} حالا Premium شد.`, status: "active" });
});

// همینطور برای برگردوندن به حالت رایگان (تست دوباره‌ی نسخه‌ی رایگان)
app.get("/admin/revoke-premium", async (req, res) => {
  const { userId, secret } = req.query;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "دسترسی مجاز نیست" });
  }
  if (!userId) {
    return res.status(400).json({ error: "userId لازم است" });
  }
  subscriptions.delete(userId);
  res.json({ message: `کاربر ${userId} به حالت رایگان برگشت.` });
});

// تحلیل عکس خوراکی: ابتدا هوش مصنوعی ماده‌ی غذایی را تشخیص می‌دهد، سپس مقادیر تغذیه‌ای
// در صورت امکان از دیتابیس رسمی USDA (وزارت کشاورزی آمریکا) گرفته می‌شود — نه فقط حدس هوش مصنوعی.
// کاربران رایگان روزی ۳ تحلیل و فقط اطلاعات پایه (کالری و قند) دریافت می‌کنند.
// کلید API آنتروپیک فقط اینجا (روی سرور) استفاده می‌شود، هرگز نباید داخل کد فرانت‌اند/مرورگر قرار بگیرد.

const USDA_API_KEY = process.env.USDA_API_KEY || "DEMO_KEY";

// جستجو در دیتابیس رسمی USDA برای مقادیر تغذیه‌ای واقعی و معتبر
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
      nutrientMap[n.nutrientName] = n.value; // مقادیر USDA به‌ازای هر ۱۰۰ گرم است
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
    // اگر حتی کالری هم پیدا نشد، این نتیجه قابل اعتماد نیست
    if (result.calories == null) return null;
    return result;
  } catch {
    return null;
  }
}

app.post("/analyze", async (req, res) => {
  try {
    const { userId, base64, mediaType, lang } = req.body;

    const premium = isPremium(userId);
    let usageInfo = null;
    if (!premium) {
      const usage = checkAndConsumeFreeUsage(userId);
      if (!usage.allowed) {
        return res.status(403).json({
          error: "daily_limit_reached",
          message:
            lang === "en"
              ? "You've used all 3 free analyses today. Upgrade to Premium for unlimited access."
              : "امروز هر ۳ تحلیل رایگانت رو استفاده کردی. برای دسترسی نامحدود، Premium رو فعال کن.",
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
        : `این عکس یک ماده‌ی خوراکی (میوه، سبزی یا غذا) است — ممکن است یک غذای ایرانی باشد. قبل از نام‌گذاری با دقت زیاد نگاه کن — دقت خیلی مهم است، چون تشخیص اشتباه کل اعداد تغذیه‌ای را بی‌اعتبار می‌کند. اگر کاملاً مطمئن نیستی، نزدیک‌ترین غذای رایج را انتخاب کن و مقدار confidencePercent را پایین‌تر بگذار، نه اینکه حدس تصادفی بزنی. آن را شناسایی کن، یک نام ساده و رایج انگلیسی برای جستجو در دیتابیس بده (مثلاً "banana"، "grilled chicken breast"، "white rice cooked")، وزن قابل مشاهده در تصویر را به گرم تخمین بزن، و مقادیر تغذیه‌ای را برای همان وزن تخمینی (نه یک وعده‌ی عمومی) محاسبه کن. همچنین مناسب بودنش را برای سه گروه ارزیابی کن، یک جمع‌بندی کوتاه یک‌خطی بنویس، یک پیشنهاد عملی و کاربردی با عدد واقعی (مثل کنترل حجم وعده یا جایگزینی) بده، یک جایگزین سالم‌تر پیشنهاد بده، و یک پیشنهاد کوتاه دستور غذا یا رژیم مرتبط هم بده. فقط یک شیء JSON خام برگردان، بدون هیچ توضیح یا Markdown، دقیقاً با این ساختار:
{"name": "نام فارسی ماده خوراکی", "searchTerm": "نام ساده انگلیسی ماده غذایی", "confidence": "high" یا "medium" یا "low", "confidencePercent": عددی بین ۰ تا ۱۰۰, "weightGrams": عدد, "serving": "مثلاً یک عدد متوسط تقریباً ۱۵۰ گرم",
"calories": عدد, "protein": عدد, "sugar": عدد, "fiber": عدد, "fat": عدد, "calcium": عدد, "iron": عدد, "potassium": عدد, "vitaminC": عدد, "vitaminA": عدد,
"aiAdvice": "یک جمع‌بندی کوتاه زیر ۸ کلمه، مثلاً 'برای کاهش وزن عالیه.' یا 'در حد اعتدال مصرف کن.'",
"smartTip": "یک پیشنهاد عملی و کاربردی با عدد واقعی درباره‌ی حجم وعده یا جایگزینی سالم‌تر، در ۱ تا ۲ جمله، مثلاً 'اگه نصف این همبرگر رو بخوری، ۲۸۰ کالری دریافت می‌کنی و همچنان ۲۰ گرم پروتئین خواهی داشت.'",
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
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text: promptText,
              },
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

    // تلاش برای گرفتن مقادیر واقعی از دیتابیس رسمی USDA؛ در صورت موفقیت، جایگزین حدس هوش مصنوعی می‌شود
    const dbResult = await lookupUSDA(parsed.searchTerm || parsed.name, parsed.weightGrams);
    let merged = dbResult
      ? { ...parsed, ...dbResult, dataSource: "usda" }
      : { ...parsed, dataSource: "ai_estimate" };

    if (premium) {
      merged.tier = "premium";
    } else {
      // کاربران رایگان اطلاعات پایه + یک جمع‌بندی کوتاه می‌بینند (برای اعتمادسازی)،
      // ولی پیشنهادهای عملی و جزئیات کامل مخصوص Premium می‌مانند.
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
        usage: { remaining: usageInfo.remaining, limit: FREE_DAILY_LIMIT },
      };
    }

    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تحلیل تصویر ناموفق بود" });
  }
});

// برنامه غذایی شخصی (فقط Premium) — بر اساس تاریخچه‌ی اسکن‌های اخیر کاربر یک برنامه‌ی کوتاه پیشنهاد می‌دهد.
app.post("/meal-plan", async (req, res) => {
  try {
    const { userId, recentFoods, lang } = req.body;

    if (!isPremium(userId)) {
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
        ? `Based on these recently scanned foods: ${foodsList || "no data yet"}, suggest a short, practical one-day personal meal plan (breakfast, lunch, dinner, one snack) that fits the person's apparent eating pattern. Keep it concise — a few lines per meal, no long essay. Respond in plain text, no JSON, no Markdown headers.`
        : `بر اساس این غذاهای اسکن‌شده‌ی اخیر: ${foodsList || "هنوز داده‌ای نیست"}، یک برنامه‌ی غذایی شخصی کوتاه و عملی برای یک روز (صبحانه، ناهار، شام، یک میان‌وعده) پیشنهاد بده که با الگوی غذایی این شخص هماهنگ باشد. کوتاه و خلاصه بنویس — چند خط برای هر وعده، نه یک مقاله‌ی طولانی. به‌صورت متن ساده جواب بده، بدون JSON و بدون هدر Markdown.`;

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
