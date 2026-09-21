MT MATRIX - TZ 原生 Android 登入包

使用方式：
1. 先把本 ZIP 根目錄的 MT Assistant Web 專案部署到 Render（和你原本方式相同）。
2. android-tz-wrapper/app/src/main/java/com/mtassistant/tz/MainActivity.java 的 APP_URL 預設：
   https://mt-assistant-web-v3.onrender.com/
   如果你的實際 Render 網址不同，只改這一行。
3. 用 Android Studio 開啟 android-tz-wrapper 資料夾，等待 Gradle Sync。
4. Build > Build APK(s)。
5. 安裝 APK 後，看到的仍是 MT Assistant 原登入頁。
6. 在 Android App 內輸入 TZ 帳密時，會走 NativeBridge -> https://www.tz6868.cc/api/v1/login。

安全範圍：
- NativeBridge 僅允許 HTTPS POST 到 www.tz6868.cc/api/v1/login。
- TZ 密碼不會送到 MT Assistant / Render 後端。
- 瀏覽器直接開網站時仍走原本 MT Assistant 帳密登入，不會嘗試跨站直打 TZ。

注意：
- 這是 Android Studio 可編譯原始專案；此環境沒有 Android SDK/Gradle toolchain，因此沒有在這裡產出 APK。
- 真實 TZ 帳號登入仍需你安裝後實測。
