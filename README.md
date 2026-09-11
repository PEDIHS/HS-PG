# HS Plugin for PasarGuard

افزونه‌ی **HS Plugin** یک لایه‌ی افزونه‌ای مستقل برای [PasarGuard Panel](https://github.com/PasarGuard/panel) است. هدف پروژه این است که قابلیت‌های اضافه بدون تبدیل PasarGuard به یک fork دائمی، بدون migration در دیتابیس اصلی و با امکان بازاعمال خودکار integration بعد از آپدیت‌های upstream ارائه شوند.

> نسخه فعلی: **0.1.4** — قابلیت اول: **Host Usage Ratio**

## توسعهٔ Security & Services

رفع باگ فلش و تب Firewall، کنترل فایروال، مدیریت گواهی‌ها، WARP و Telegram Proxy در شاخهٔ توسعه اضافه شده‌اند. راهنمای نصب، وضعیت تست و مرز قابلیت‌ها در [راهنمای HS Services](docs/hs-services.md) آمده است.

**Fair Use هنوز محدودیت سرعت واقعی اعمال نمی‌کند؛ تنها سیاست و پیش‌نمایش محاسبه آماده است.** این شاخه تا تکمیل adapter نود و تست روی staging، نسخهٔ نهایی همهٔ قابلیت‌های درخواستی محسوب نمی‌شود.

## قابلیت اول: Host Usage Ratio

PasarGuard به‌صورت native برای Node گزینه‌ی `Usage Ratio` دارد. HS Plugin همین مفهوم را برای Host به‌صورت **هماهنگ با Node** اضافه می‌کند:

- در modal ساخت/ویرایش Host، فیلد `Usage Ratio` با ظاهر خود PasarGuard اضافه می‌شود.
- مقدار Host در حالت عادی از `Usage Ratio` نودی که Core آن شامل Inbound همان Host است ارث می‌برد؛ اگر Node روی `2` باشد Host نیز `2` نشان می‌دهد.
- اگر Host را از `2` به `2.7` تغییر دهید، افزونه اختلاف `+0.7` را نگه می‌دارد؛ مصرف آن Host در همان Node با ضریب نهایی `2.7` حساب می‌شود.
- Node و Host هرگز در هم ضرب نمی‌شوند؛ Node `2` و Host `2.7` به `5.4` تبدیل نمی‌شود.
- چون اختلاف نگه‌داری می‌شود، اگر بعداً Node از `2` به `3` تغییر کند، همان Host از `2.7` به `3.7` می‌رود. یعنی Host دائماً با baseline نود sync می‌ماند.
- اگر Host را دوباره دقیقاً برابر Ratio نود کنید، اختلاف حذف می‌شود و Host کاملاً از Node پیروی می‌کند.
- قابلیت را می‌توان از تب HS Plugin روشن/خاموش کرد.
- عنوان `HS Plugin`، آیکن افزونه و برچسب `Usage Ratio` افکت طلایی ملایم دارند، اما sidebar، topbar، footer و shell اصلی PasarGuard دست‌نخورده می‌مانند.

فرمول حسابداری:

```text
host_offset = Host Usage Ratio - Node Usage Ratio
charged usage = raw usage × max(0, actual Node Usage Ratio + host_offset)
```

مثال:

```text
Node Ratio = 2.0
Host Ratio = 2.7
Stored HS offset = +0.7
Final charged ratio = 2.0 + 0.7 = 2.7

اگر بعداً Node Ratio = 3.0 شود:
Final charged ratio = 3.0 + 0.7 = 3.7
```

### تشخیص Node مربوط به Host

PasarGuard روی Node یک `core_config_id` دارد. HS Plugin ابتدا CoreConfig هر Node را بررسی می‌کند و نودی را پیدا می‌کند که Inbound انتخاب‌شده‌ی Host داخل Core آن وجود دارد. اگر یک Node مشخص شود، همان `Usage Ratio` به‌عنوان baseline Host استفاده می‌شود. در حالت‌های قدیمی یا خاص، تشخیص از طریق address، تک‌نودی بودن یا Ratio مشترک Nodeها انجام می‌شود.

اگر یک Inbound واقعاً روی چند Node با Ratioهای متفاوت فعال باشد و baseline یکتا قابل تشخیص نباشد، افزونه به‌جای حدس زدن و خراب‌کردن حسابداری، ذخیره‌ی Ratio جدید را با خطای واضح متوقف می‌کند.

خود accounting همیشه coefficient همان Node واقعی‌ای را که usage از آن دریافت شده استفاده می‌کند و فقط offset مربوط به Host را روی آن اضافه می‌کند.

### نکته مهم درباره Hostهای دارای Inbound مشترک

Xray/PasarGuard در آمار فعلی، traffic کاربر را به شکل `user` ثبت می‌کند و Host address/SNI را در آمار user نگه نمی‌دارد. بنابراین دو Host که دقیقاً یک `inbound_tag` دارند از نظر accounting قابل تفکیک قطعی نیستند. HS Plugin برای جلوگیری از حساب اشتباه، **همه Hostهای دارای یک inbound مشترک را با یک Ratio/offset مشترک** مدیریت می‌کند.

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

State قدیمی نسخه 1 که Ratioهای مطلق را نگه می‌داشت، در اولین فراخوانی API به مدل offset نسخه 2 مهاجرت می‌کند. Runtime تا قبل از تکمیل این مهاجرت، فرمت قدیمی را نیز می‌فهمد تا در زمان بروزرسانی rolling، accounting اشتباه نشود.

## English

HS Plugin is an update-resistant extension layer for PasarGuard. Host Usage Ratio is synchronized to the native Node Usage Ratio by storing only the Host delta. Example: Node 2.0 and Host 2.7 stores +0.7; traffic is charged at 2.7, not 5.4. If the Node later changes to 3.0, the Host becomes 3.7. The plugin resolves the Host baseline from the Node CoreConfig that owns the selected inbound, keeps state outside the core database, preserves legacy state during migration, and re-applies integration after upstream updates.

## License

MIT
