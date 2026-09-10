# HS Plugin for PasarGuard

افزونه‌ی **HS Plugin** یک لایه‌ی افزونه‌ای مستقل برای [PasarGuard Panel](https://github.com/PasarGuard/panel) است. هدف پروژه این است که قابلیت‌های اضافه بدون تبدیل PasarGuard به یک fork دائمی، بدون migration در دیتابیس اصلی و با امکان بازاعمال خودکار integration بعد از آپدیت‌های upstream ارائه شوند.

> نسخه فعلی: **0.1.4** — قابلیت اول: **Host Usage Ratio**

## قابلیت اول: Host Usage Ratio

PasarGuard به‌صورت native برای Node گزینه‌ی `Usage Ratio` دارد. HS Plugin همین مفهوم را برای Host اضافه می‌کند:

- در modal ساخت/ویرایش Host، فیلد `Usage Ratio` با ظاهر خود PasarGuard اضافه می‌شود.
- مقدار Host در حالت عادی از `Usage Ratio` نود ارث می‌برد؛ اگر Node روی `2` باشد Host نیز `2` نشان می‌دهد.
- اگر Host را مثلاً روی `2.7` بگذارید، **ضریب نهایی همان Host برابر 2.7 است**؛ Node و Host در هم ضرب نمی‌شوند.
- بنابراین Node `2` + Host override `2.7` هرگز `5.4` نمی‌شود؛ ترافیک همان Host با ضریب نهایی `2.7` محاسبه می‌شود.
- اگر مقدار Host با مقدار ارث‌برده‌شده‌ی Node برابر باشد، override حذف می‌شود تا Host دوباره همراه تغییرات Node حرکت کند.
- قابلیت را می‌توان از تب HS Plugin روشن/خاموش کرد.
- عنوان `HS Plugin`، آیکن افزونه و برچسب `Usage Ratio` افکت طلایی ملایم دارند، اما layout و shell اصلی PasarGuard حفظ می‌شود.

فرمول حسابداری:

```text
بدون Host override:
charged usage = raw usage × actual Node Usage Ratio

با Host override:
charged usage = raw usage × Host Usage Ratio
```

یعنی `Host Usage Ratio` یک **Final Effective Ratio** است، نه یک multiplier دوم روی Node.

### هماهنگی با Node

PasarGuard برای Host یک foreign key مستقیم به Node نگه نمی‌دارد. HS Plugin برای مقدار نمایشی، در صورت امکان Node را از آدرس Host تشخیص می‌دهد؛ در نصب تک‌نودی یا زمانی که همه Nodeها یک ضریب دارند، مقدار ارثی نیز بدون ابهام مشخص است. خود accounting به این تشخیص نمایشی وابسته نیست: ترافیک عادی همیشه coefficient همان Node واقعی را می‌گیرد و فقط ترافیک Hostی که override دارد، coefficient نهایی Host را جایگزین می‌کند.

### نکته مهم درباره Hostهای دارای Inbound مشترک

Xray/PasarGuard در آمار فعلی، traffic کاربر را به شکل `user` ثبت می‌کند و Host address/SNI را در آمار user نگه نمی‌دارد. بنابراین دو Host که دقیقاً یک `inbound_tag` دارند از نظر accounting قابل تفکیک قطعی نیستند. HS Plugin برای جلوگیری از حساب اشتباه، **همه Hostهای دارای یک inbound مشترک را با یک Ratio مشترک** مدیریت می‌کند.

برای Hostهایی که inbound مستقل دارند، attribution مستقل است. افزونه برای این کار شناسه‌های آماری داخلی per-inbound می‌سازد، در زمان ثبت usage آن‌ها را دوباره به User ID اصلی برمی‌گرداند و Online/IP stats را نیز روی شناسه اصلی + aliasهای داخلی تجمیع می‌کند.

## نصب / بروزرسانی

```bash
curl -fsSL https://raw.githubusercontent.com/PEDIHS/HS-PG/main/install.sh | sudo bash -s -- --restart
```

یا برای بروزرسانی نصب موجود:

```bash
sudo hs-pg update
sudo hs-pg restart
```

اگر نمی‌خواهید installer هیچ سرویسی را restart کند:

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

بعد از recreate شدن image توسط یک آپدیت بزرگ PasarGuard، hookهای Python که روی container جدید بازاعمال شده‌اند از restart بعدی process فعال می‌شوند. `sudo hs-pg restart` این مرحله را صریح و کنترل‌شده انجام می‌دهد.

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

HS Plugin is an update-resistant extension layer for PasarGuard. v0.1.4 adds a Node-synced **per-Host/inbound Usage Ratio** whose value is the final effective accounting coefficient. Native Host traffic inherits the actual Node coefficient; an explicit Host override replaces that coefficient rather than multiplying it. The plugin keeps its state outside the core database and re-applies integration after upstream updates. Hosts sharing the same inbound necessarily share one effective ratio because upstream user traffic stats do not retain the originating Host/SNI.

## License

MIT
