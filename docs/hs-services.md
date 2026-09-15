# HS Services — بازیابی و ادغام با پنل

مبنای این اصلاح، نسخهٔ مشترک `7390611` است. تغییرات معیوب بعدی با commit جدید کنار گذاشته می‌شوند؛ تاریخچه پاک یا force-push نمی‌شود.

## نصب و پاک‌سازی نسخه‌های قبلی

```bash
sudo hs-pg update
sudo hs-pg restart
```

آپدیت، سرویس‌های HS Shield و timer بازگشت آن را متوقف و حذف می‌کند؛ فقط جدول‌های `inet hs_plugin` و `inet hs_fair_use` متعلق به پیاده‌سازی قبلی حذف می‌شوند. قوانین و سیاست اصلی nftables، UFW و Docker دست‌نخورده می‌مانند. فایل‌های JS و hookهای فایروال و افزونهٔ معیوب قبلی از نصب محلی و container حذف می‌شوند. فایروال HS دیگر تب، عامل یا سرویس فعال ندارد.

پس از restart پنل، خروجی‌های `hs-fair-<user>-<hash>` متعلق به روش قدیمیِ freedom/mark از Core حذف می‌شوند؛ نسخهٔ قبلی تنظیمات در `services/legacy-core-backups.json` نگه‌داری می‌شود. سایر خروجی‌ها و قوانین مسیریابی حفظ می‌شوند. تا restart، کد Python بارگذاری‌شدهٔ قبلی ممکن است هنوز در حافظهٔ پنل فعال باشد؛ هر دو دستور بالا لازم‌اند.

نگهبان نصب، oneshot با بررسی هر پنج دقیقه و واکنش به تغییر compose است؛ حلقهٔ دائمی ده‌ثانیه‌ای قبلی حذف شده است. API و داده‌های کاربران و تنظیمات Host Usage Ratio حفظ می‌شوند.

## محل قابلیت‌ها

| قابلیت | محل تنظیم |
|---|---|
| روشن و خاموش کردن قابلیت‌ها | HS Plugin → Features، با همان کارت و Switch قابلیت‌های قبلی |
| گواهی‌های Certbot | HS Plugin → Certificates |
| WARP | Nodes → Cores → Core → Outbounds → WARP / WireGuard HS |
| WireGuard معمولی | فرم اصلی WireGuard در Outbounds خود پاسارگارد |
| Telegram MTProxy | Nodes → Cores → Core → Inbounds → Telegram MTProxy HS |
| Fair Use Host | Hosts → فرم ساخت/ویرایش Host → بخش Fair Use HS؛ ذخیره با Save اصلی Host |
| Fair Use Group | Groups → فرم ساخت/ویرایش Group → بخش Fair Use HS؛ حالت Always یا After usage و ذخیره با Save اصلی Group |
| Fair limited | نشان نارنجی در جدول کاربران و فیلتر کنار وضعیت‌ها |

فرم WireGuard پاسارگارد دارای کلید، آدرس، peers، endpoint، MTU، reserved و تنظیمات مربوطه است. HS وارد کردن پروفایل WARP و مسیریابی انتخابی را به همان بخش Outbounds اضافه می‌کند. قبل از Apply باید تغییرات ذخیره‌نشدهٔ Core را ذخیره یا لغو کنید. پس از اعمال موفق، ویرایشگر بارگذاری مجدد می‌شود تا پیش‌نویس قدیمی روی تنظیمات تازه نوشته نشود. ثبت حساب WARP خودکار نیست.

MTProxy مانند قرارگیری MTProto در ثنایی در بخش Inbounds نمایش داده می‌شود؛ سرویس مستقل رسمی Telegram است، نه outbound مصنوعی Xray. برای ساخت و کنترل آن، Agent نود و باینری رسمی MTProxy لازم‌اند. این نسخه دارای آدرس، پورت، پورت آمار، advertising tag، لینک random-padding و start/stop/delete است؛ ادعای برابری تمام گزینه‌های FakeTLS ثنایی ندارد.

## Certbot

فقط lineageهای Certbot در `/etc/letsencrypt/live/*/fullchain.pem` نمایش داده می‌شوند. گواهی اعتماد داخلی نود، با عمر چندساله، در این صفحه نیست. زمان انقضا از خود فایل خوانده می‌شود. تمدید وقتی ممکن است که Certbot و فایل `renewal/<name>.conf` روی همان سرور موجود باشند.

دکمهٔ Renew now کار تمدید را به همان Agent می‌فرستد. خروج موفق فرمان به‌تنهایی کافی نیست؛ تاریخ انقضای گواهی باید واقعاً جلو رفته باشد. فعال شدن گواهی تازه در سرویس مصرف‌کننده به reload یا restart آن سرویس بستگی دارد. می‌توان reload مجاز را محلی در `/etc/hs-pg/services.json` تنظیم کرد:

```json
{"certbot_config_dir":"/etc/letsencrypt","reload_units":{"example.com":"nginx.service"}}
```

برای اتصال نود از **HS Plugin → Node Bridge** استفاده کنید. پنل یک bootstrap یک‌بارمصرف با عمر کوتاه می‌دهد و دستور نصب را می‌سازد. نود موجود با Node ID ثبت می‌شود و نود تازه در حالت `auto` اطلاعات لازم PasarGuard Node را محلی می‌خواند و بدون نمایش API key در UI آن را مستقیم از نود به پنل می‌فرستد.

bootstrap بعد از مصرف قابل استفادهٔ مجدد نیست و در state فقط hash آن نگهداری می‌شود. توکن بلندمدت Bridge با دسترسی `0600` روی نود ذخیره می‌شود و ارتباط مدیریتی HS به‌صورت outbound HTTPS از نود به پنل است. کلید خصوصی گواهی به پنل ارسال نمی‌شود؛ فقط certificate عمومی برای inventory و ثبت Node استفاده می‌شود. هنگام نصب Bridge، قوانین Fair Use قدیمی مبتنی بر حذف بسته نیز پاک می‌شوند.

## Fair Use واقعی

نمونه: آستانهٔ ۱۰۰ GB، سرعت کامل ۱۰۰ Mbps و درصد ۲۰ یعنی پس از رسیدن **مصرف همین کاربر** به ۱۰۰ GB، سرعت او روی inbound مربوطه به ۲۰ Mbps می‌رسد. ۲٪ یعنی ۲ Mbps. حجم، مصرف محاسبه‌شدهٔ کاربر در دورهٔ جاری سهمیه است؛ با reset مصرف، سرعت کامل برمی‌گردد. مجموع upload و download و اتصال‌های هم‌زمان همان کاربر در بودجهٔ سرعت مشترک حساب می‌شوند. تیک Fair limited به‌صورت خودکار با تنظیم سیاست فعال می‌شود.

اجرای کاهش سرعت به **Xray مجهز به adapter HS** نیاز دارد. هستهٔ معمولی Xray API تعیین سرعت هر کاربر ندارد. این adapter داخل مسیر پردازش داده سرعت را کنترل می‌کند و routing، WARP و خروجی انتخاب‌شدهٔ کاربر را عوض نمی‌کند. برای جلوگیری از دور زدن محدودیت، splice در هستهٔ مخصوص HS برای ارتباط‌های کاربری غیرفعال می‌شود؛ این انتخاب می‌تواند هزینهٔ CPU را افزایش دهد.

ساخت باینری جداگانه از سورس Xray با Go متناسب با `go.mod`:

```bash
sudo /opt/hs-pg/plugin/build-fair-core.sh /path/to/Xray-core /opt/hs-pg/xray-hs-fair
```

اسکریپت باینری در حال اجرا را جایگزین نمی‌کند. روی نود، `XRAY_EXECUTABLE_PATH` را به باینری ساخته‌شده تنظیم کنید. در Docker باید هم باینری و هم پوشهٔ `/var/lib/hs-pg-agent` را به container نود mount کنید؛ پوشه برای خواندن policy و نوشتن ACK باید در دسترس فرایند Xray باشد. سپس نود را با ابزار مدیریت خودتان restart کنید. مسیر policy پیش‌فرض `/var/lib/hs-pg-agent/fair-policy.json` است؛ تغییر آن نیازمند تنظیم یکسان `HS_FAIR_POLICY_FILE` در Xray و `fair_policy_file` در تنظیمات Agent است.

Agent هر ده ثانیه سیاست را هماهنگ می‌کند و هسته هر ثانیه آن را می‌خواند. Agent طی تمدید طولانی Certbot نیز این هماهنگی را ادامه می‌دهد. آستانه با تأخیر آمارگیری خود پاسارگارد و این همگام‌سازی اعمال می‌شود. نشان Fair limited فقط وقتی فعال می‌شود که هستهٔ نود revision درست را تأیید کرده باشد. بدون ACK، ذخیرهٔ سیاست به‌عنوان کاهش سرعت موفق نمایش داده نمی‌شود.

Policy Host در سطح inbound اعمال می‌شود. اگر چند Host یک `inbound_tag` مشترک داشته باشند، تغییر یا حذف Fair Use روی یکی روی همهٔ Hostهای همان inbound همگام می‌شود. در Group، حالت `Always` از ابتدا cap را روی کاربران و inboundهای Group اعمال می‌کند و `After usage` بعد از threshold مصرف همان کاربر فعال می‌شود. در هم‌پوشانی Host و Group، محدودکننده‌ترین cap فعال برنده است. روی Coreهای replica، همهٔ Nodeها باید revision یکسان را ACK کنند تا وضعیت `Fair limited` اعمال‌شده تلقی شود. WireGuard native و هسته‌های غیر Xray مشمول این adapter نیستند. وضعیت‌های expired، limited، disabled و on_hold اولویت دارند و وضعیت دیتابیس اصلی تغییر نمی‌کند.

## اعتبارسنجی

تست‌های Python/API، سناریوهای DOM و مرورگر، حذف جدول‌های HS در network namespace مستقل، patchهای native و build/race test هسته در workflow پروژه اجرا می‌شوند. نتیجهٔ نصب واقعی، صدور ACME و throughput روی سرور شما باید جداگانه بررسی شود؛ تست خودکار جای تست بار روی سخت‌افزار نود را نمی‌گیرد.
