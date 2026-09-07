// این فایل باید همیشه اولین چیزی باشد که سرور require می‌کند — قبل از express و بقیه‌ی پکیج‌ها.
// اگر SENTRY_DSN تنظیم نشده باشد، این بخش کاملاً بی‌اثر است و سرور بدون Sentry هم عادی کار می‌کند.
const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}

module.exports = Sentry;
