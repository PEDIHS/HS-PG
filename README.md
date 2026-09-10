# HS Plugin for PasarGuard

افزونه‌ی **HS Plugin** یک لایه‌ی افزونه‌ای مستقل برای [PasarGuard Panel](https://github.com/PasarGuard/panel) است. هدف پروژه این است که قابلیت‌های اضافه بدون تبدیل PasarGuard به یک fork دائمی، بدون migration در دیتابیس اصلی و با امکان بازاعمال خودکار integration بعد از آپدیت‌های upstream ارائه شوند.

> نسخه فعلی: **0.1.0** — قابلیت اول: **Host Usage Ratio**

## قابلیت اول: Host Usage Ratio

PasarGuard به‌صورت native برای Node گزینه‌ی `Usage Ratio` دارد. HS Plugin همین مفهوم را برای Host اضافه می‌کند:

- در پنل **HS Plugin** می‌توان ضریب هر Host را تنظیم کرد.
- در modal ساخت/ویرایش Host، بلافاصله زیر Inbound فیلد `Usage Ratio` اضافه می‌شود.
- عنوان `HS Plugin` و برچسب `Usage Ratio` افکت طلایی بسیار ملایم دارند تا مشخص باشد این قسمت‌ها توسط افزونه اضافه شده‌اند؛ رنگ‌ها و layout اصلی PasarGuard حفظ می‌شوند.
- قابلیت را می‌توان از تب HS Plugin روشن/خاموش کرد.
- محاسبه‌ی نهایی به این شکل است:

```text
charged usage = raw usage × Host Usage Ratio × native Node Usage Ratio
```

### نکته مهم درباره Hostهای دارای Inbound مشترک

Xray/PasarGuard در آمار فعلی، traffic کاربر را به شکل `user` ثبت می‌کند و Host address/SNI را در آمار user نگه نمی‌دارد. بنابراین دو Host که دقیقاً یک `inbound_tag` دارند از نظر accounting قابل تفکیک قطعی نیستند. HS Plugin برای جلوگیری از حساب اشتباه، **همه Hostهای دارای یک inbound مشترک را با یک Ratio مشترک** مدیریت می‌کند و این موضوع را در UI نمایش می‌دهد.

برای Hostهایی که inbound مستقل دارند، attribution مستقل است. افزونه برای این کار شناسه‌های آماری داخلی per-inbound می‌سازد، در زمان ثبت usage آن‌ها را دوباره به User ID اصلی برمی‌گرداند و Online/IP stats را نیز روی شناسه اصلی + aliasهای داخلی تجمیع می‌کند.

## نصب

دستور پیشنهادی (بدون وابستگی به `/dev/fd` یا process substitution):

```bash
curl -fsSL https://raw.githubusercontent.com/PEDIHS/HS-PG/main/install.sh | sudo bash -s -- --restart
```

`--restart` فقط در نصب اول برای load شدن hookهای Python لازم است و PasarGuard را یک بار restart می‌کند. اگر نمی‌خواهید installer هیچ سرویسی را restart کند:

```bash
curl -fsSL https://raw.githubusercontent.com/PEDIHS/HS-PG/main/install.sh | sudo bash
```

سپس در زمان مناسب:

```bash
sudo hs-pg restart
```

## مدیریت

```bash
sudo hs-pg status
sudo hs-pg apply
sudo hs-pg restart
sudo hs-pg update
```

## چرا با آپدیت PasarGuard حذف نمی‌شود؟

فایل‌های اصلی افزونه خارج از tree هسته نگهداری می‌شوند:

```text
/opt/hs-pg/                         # code
/var/lib/pasarguard/hs-plugin/      # persistent state
```

یک `systemd path + timer` integration را بررسی می‌کند. اگر dashboard/container در آپدیت upstream جایگزین شود، loader و hookهای سازگار دوباره اعمال می‌شوند. patcher قبل از هر تغییر تمام anchorهای مورد انتظار را validate و فایل Python نهایی را compile می‌کند؛ اگر ساختار نسخه جدید PasarGuard ناسازگار شده باشد، **fail-closed** می‌شود و فایل ناشناخته را کورکورانه patch نمی‌کند.

توجه: بعد از recreate شدن image توسط یک آپدیت بزرگ PasarGuard، hookهای Python که روی container جدید بازاعمال شده‌اند از restart بعدی process فعال می‌شوند. `sudo hs-pg restart` این مرحله را صریح و کنترل‌شده انجام می‌دهد.

## ساختار پروژه

```text
backend/hs_plugin_api.py          Owner-only API + state management
backend/hs_plugin_runtime.py      attribution / alias / ratio runtime
plugin/hs-plugin.js               PasarGuard UI integration
plugin/patch_pasarguard.py        idempotent fail-closed source patcher
plugin/integrate-dashboard.sh     host/Docker integration guard
systemd/                          update-survival guard
cli/hs-pg                         management CLI
```

## اصول ایمنی integration

HS Plugin عمداً جدول یا column جدیدی به دیتابیس PasarGuard اضافه نمی‌کند. state افزونه فایل مستقل با write اتمیک و lock است. Native Host save در صورت خطای follow-up افزونه fail نمی‌شود. patcher نیز تنها روی anchorهای نسخه‌ای که می‌شناسد عمل می‌کند.

## English

HS Plugin is an update-resistant extension layer for PasarGuard. v0.1.0 adds **per-Host/inbound Usage Ratio**, applies it before PasarGuard's native Node Usage Ratio, keeps plugin state outside the core database, and re-applies integration after upstream updates. Hosts sharing the same inbound necessarily share one effective ratio because upstream user traffic stats do not retain the originating Host/SNI.

## License

MIT
