package com.best.client.web

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import com.best.client.BuildConfig
import com.best.client.MainActivity
import com.best.client.data.Store
import com.best.client.net.Fetcher
import com.best.client.net.Probe
import com.best.client.scan.QrCodes
import com.best.client.scan.ScanActivity
import com.best.client.update.AppInstaller
import com.best.client.update.Downloader
import com.best.client.vpn.GeoFiles
import com.best.client.vpn.SingBox
import com.best.client.vpn.BestVpnService
import com.best.client.vpn.Session
import com.best.client.vpn.VpnState
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import libv2ray.Libv2ray
import org.json.JSONArray
import org.json.JSONObject

/**
 * The only way the web UI reaches the phone. Messages are accepted from Best's own page origin
 * in the main frame only; each method has a fixed name and checks its arguments. Requests are
 * `{id, m, a}`; replies `{id, ok, r}` / `{id, ok:false, e}`; events `{ev, d}`.
 */
class NativeBridge(private val activity: MainActivity) : WebViewCompat.WebMessageListener {

    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newFixedThreadPool(2) { r -> Thread(r, "best-io") }
    private val tests: ExecutorService = Executors.newFixedThreadPool(TEST_THREADS) { r -> Thread(r, "best-test") }
    /** Speed tests one at a time (they share the phone's bandwidth); downloads one at a time. */
    private val speedLine: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "best-speed") }
    private val downloads: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "best-download") }
    private val speedCancel = AtomicBoolean(false)
    private val downloadCancel = AtomicBoolean(false)
    private val store = Store(activity)
    private var events: JavaScriptReplyProxy? = null
    private val disposers = mutableListOf<() -> Unit>()
    private val disposed = AtomicBoolean(false)

    /** Last insets sent to the page, in CSS pixels. */
    private var insets = JSONObject().put("top", 0).put("bottom", 0).put("left", 0).put("right", 0)

    /** Text shared to Best ("Share → Best") until the page takes it. */
    private var sharedText: String? = null

    /** An install link (best://…, v2rayng://…) or "scan:" from the launcher shortcut, until the page takes it. */
    private var pendingLink: String? = null

    private fun interface Reply {
        fun send(result: Any?, error: String?)
    }

    private val methods: Map<String, (JSONObject, Reply) -> Unit> = mapOf(
        "app.info" to { _, r -> r.send(appInfo(), null) },
        "app.exit" to { _, r -> activity.moveTaskToBack(true); r.send(true, null) },
        "app.bars" to { a, r -> activity.setBars(a.optBoolean("light", false)); r.send(true, null) },
        "app.open" to ::openUrl,
        "app.openPanel" to ::openPanelUrl,
        "app.share" to ::share,
        "store.read" to { a, r -> background(r) { store.read(a.getString("name")) } },
        "store.write" to { a, r -> background(r) { store.write(a.getString("name"), a.getString("text")); true } },
        "clip.read" to { _, r -> r.send(readClipboard(), null) },
        "clip.write" to ::writeClipboard,
        "intent.take" to { _, r -> r.send(sharedText.also { sharedText = null }, null) },
        "intent.link" to { _, r -> r.send(pendingLink.also { pendingLink = null }, null) },
        "net.lanIp" to { _, r -> background(r) { lanAddress() } },
        "vpn.start" to ::startVpn,
        "vpn.stop" to { _, r -> BestVpnService.stop(activity); r.send(true, null) },
        "vpn.state" to { _, r -> r.send(stateJson(VpnState.current), null) },
        "core.delay" to ::delay,
        "net.tcping" to ::tcping,
        "net.fetch" to ::fetch,
        "apps.list" to { _, r -> background(r) { launcherApps() } },
        "pick.scan" to ::scan,
        "pick.photo" to ::photo,
        "pick.file" to ::file,
        "qr.make" to { a, r -> val text = a.getString("text"); background(r) { QrCodes.toDataUrl(text) } },
        "probe.speed" to ::speed,
        "probe.udp" to ::udp,
        "probe.cancel" to { _, r -> speedCancel.set(true); r.send(true, null) },
        "net.resolve" to ::resolve,
        "file.save" to ::saveFile,
        "dav.put" to { a, r -> val d = dav(a); val name = a.getString("name"); val text = a.getString("text"); background(r) { d.put(name, text); true } },
        "dav.list" to { a, r -> val d = dav(a); background(r) { JSONArray(d.list().map { JSONObject().put("name", it.first).put("modified", it.second) }) } },
        "dav.get" to { a, r -> val d = dav(a); val name = a.getString("name"); background(r) { d.get(name) } },
        "logs.read" to { a, r ->
            val L = com.best.client.vpn.Logs
            val file = when (a.optString("kind")) { "access" -> L.access(activity); "app" -> L.app(activity); else -> L.error(activity) }
            background(r) { L.tail(file) }
        },
        // What the page itself did (subscriptions, tests, errors shown to the user), for the Logs page.
        "logs.add" to { a, r ->
            background(r) { com.best.client.vpn.Logs.add(activity, a.optString("level", "info"), "Best", a.optString("text").take(400)); true }
        },
        "logs.clear" to { _, r -> background(r) { com.best.client.vpn.Logs.clear(activity); true } },
        "singbox.version" to { _, r -> background(r) { if (SingBox.available(activity)) SingBox.version(activity) else "" } },
        "net.metered" to { _, r -> r.send(metered(), null) },
        "update.app" to ::downloadApp,
        "update.install" to ::installApp,
        "update.geo" to ::downloadGeo,
        "update.cancel" to { _, r -> downloadCancel.set(true); r.send(true, null) },
        "geo.info" to { _, r -> background(r) { GeoFiles.info(activity).let { (dl, at) -> JSONObject().put("downloaded", dl).put("at", at).put("ext", GeoFiles.extInfo(activity)) } } },
    )

    init {
        AppInstaller.listener = { code -> emit("update.status", JSONObject().put("error", code)) }
        disposers += { AppInstaller.listener = null }
        disposers += VpnState.onState { emit("vpn.state", stateJson(it)) }
        disposers += VpnState.onTraffic {
            emit("vpn.traffic", JSONObject().put("up", it.upRate).put("down", it.downRate).put("upTotal", it.upTotal).put("downTotal", it.downTotal))
        }
    }

    override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        if (!isMainFrame || sourceOrigin.toString() != WebAssets.ORIGIN || disposed.get()) return
        val data = message.data ?: return
        if (data.length > MAX_MESSAGE) return
        val req = try { JSONObject(data) } catch (_: Exception) { return }
        val id = req.optInt("id", -1)
        val name = req.optString("m")
        val args = req.optJSONObject("a") ?: JSONObject()
        val reply = Reply { result, error -> main.post { respond(replyProxy, id, result, error) } }
        if (name == "hello") {
            events = replyProxy
            reply.send(JSONObject().put("info", appInfo()).put("insets", insets).put("vpn", stateJson(VpnState.current)), null)
            return
        }
        val method = methods[name] ?: return reply.send(null, "UNKNOWN_METHOD")
        try {
            method(args, reply)
        } catch (e: Exception) {
            reply.send(null, codeOf(e))
        }
    }

    // ---------------------------------------------------------------- events

    fun emit(event: String, data: Any?) {
        main.post {
            val p = events ?: return@post
            if (!disposed.get()) p.postMessage(JSONObject().put("ev", event).put("d", data ?: JSONObject.NULL).toString())
        }
    }

    fun setInsets(top: Int, bottom: Int, left: Int, right: Int) {
        insets = JSONObject().put("top", top).put("bottom", bottom).put("left", left).put("right", right)
        emit("insets", insets)
    }

    fun onLink(url: String) {
        pendingLink = url.take(MAX_SHARED)
        emit("link", null)
    }

    /** The phone's address in the Wi-Fi / local network (for LAN sharing), or null. */
    private fun lanAddress(): String? {
        for (nif in java.net.NetworkInterface.getNetworkInterfaces() ?: return null) {
            if (!nif.isUp || nif.isLoopback || nif.name.startsWith("tun")) continue
            for (a in nif.inetAddresses) if (a is java.net.Inet4Address && a.isSiteLocalAddress) return a.hostAddress
        }
        return null
    }

    fun onShared(text: String) {
        sharedText = text.take(MAX_SHARED)
        emit("shared", null)
    }

    fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        disposers.forEach { it() }
        speedCancel.set(true)
        downloadCancel.set(true)
        io.shutdownNow()
        tests.shutdownNow()
        speedLine.shutdownNow()
        downloads.shutdownNow()
        events = null
    }

    // ---------------------------------------------------------------- methods

    private fun appInfo() = JSONObject()
        .put("version", BuildConfig.VERSION_NAME)
        .put("versionCode", BuildConfig.VERSION_CODE)
        .put("xray", runCatching { Libv2ray.checkVersionX() }.getOrDefault(""))
        .put("xrayLib", BuildConfig.XRAY_LIB)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
        .put("abis", JSONArray(Build.SUPPORTED_ABIS.toList()))
        .put("repo", BuildConfig.UPDATE_REPO)
        .put("locale", Locale.getDefault().toLanguageTag())
        .put("debug", BuildConfig.DEBUG)

    private fun stateJson(s: VpnState.Snapshot) = JSONObject()
        .put("phase", s.phase.name.lowercase())
        .put("name", s.name)
        .put("forMs", s.connectedForMs)
        .put("error", s.error ?: JSONObject.NULL)

    private fun startVpn(a: JSONObject, r: Reply) {
        val session = Session.fromJson(a)
        activity.requestVpn { granted ->
            if (!granted) return@requestVpn r.send(null, "VPN_DENIED")
            try {
                BestVpnService.start(activity, session)
                // Asked only after the VPN permission, so two system dialogs never stack up.
                activity.requestNotifications()
                r.send(true, null)
            } catch (e: Exception) {
                r.send(null, codeOf(e))
            }
        }
    }

    private fun delay(a: JSONObject, r: Reply) {
        val config = a.getString("config")
        require(config.length <= MAX_CONFIG) { "TOO_LARGE" }
        JSONObject(config)
        val url = a.optString("url").ifBlank { DEFAULT_TEST_URL }
        require(url.startsWith("https://") || url.startsWith("http://")) { "BAD_URL" }
        val singbox = a.optString("core") == "singbox"
        // The quick in-process check drops inbounds; a config that needs its own (the local
        // forwarder of an unencrypted server) runs in a short-lived full core instead.
        val withInbounds = (JSONObject(config).optJSONArray("inbounds")?.length() ?: 0) > 0
        val timeout = a.optInt("timeout", 6000).coerceIn(1000, 15_000)
        tests.execute {
            val result = try {
                val ms = when {
                    singbox -> Probe.delay(activity, "singbox", config, url, timeout)
                    withInbounds -> Probe.delay(activity, "xray", config, url, timeout)
                    else -> Libv2ray.measureOutboundDelay(config, url)
                }
                JSONObject().put("ms", ms)
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) Log.w(TAG, "delay", e)
                JSONObject().put("ms", -1)
            }
            r.send(result, null)
        }
    }

    /** Time to open a TCP connection to the server (name lookup not counted); -1 when it fails. */
    private fun tcping(a: JSONObject, r: Reply) {
        val host = a.getString("host")
        val port = a.getInt("port")
        require(host.length in 1..253 && port in 1..65535) { "BAD_ARGUMENTS" }
        val timeout = a.optInt("timeout", 5000).coerceIn(500, 10_000)
        tests.execute {
            val ms = try {
                val addr = java.net.InetAddress.getByName(host)
                java.net.Socket().use { s ->
                    val t0 = android.os.SystemClock.elapsedRealtime()
                    s.connect(java.net.InetSocketAddress(addr, port), timeout)
                    android.os.SystemClock.elapsedRealtime() - t0
                }
            } catch (_: Exception) {
                -1L
            }
            r.send(JSONObject().put("ms", ms), null)
        }
    }

    private fun fetch(a: JSONObject, r: Reply) {
        val url = a.getString("url")
        val ua = a.optString("userAgent").ifBlank { "Best/${BuildConfig.VERSION_NAME}" }
        val direct = a.optBoolean("direct", false)
        // Subscriptions only: the device id for panels that limit devices (Settings → Send a device ID).
        val hwid = a.optBoolean("hwid", false)
        val deviceName = a.optString("deviceName").take(80)
        background(r) {
            val extra = if (hwid) com.best.client.net.DeviceId.headers(activity, url, deviceName) else emptyMap()
            val res = Fetcher.get(url, ua, direct, extra)
            JSONObject()
                .put("status", res.status)
                .put("device", res.device)
                .put("body", res.body)
                .put("userInfo", res.userInfo ?: JSONObject.NULL)
                .put("title", res.title ?: JSONObject.NULL)
                .put("updateHours", res.updateHours ?: JSONObject.NULL)
                .put("supportUrl", res.supportUrl?.take(600) ?: JSONObject.NULL)
                .put("webPageUrl", res.webPageUrl?.take(600) ?: JSONObject.NULL)
                .put("announce", res.announce?.take(2000) ?: JSONObject.NULL)
        }
    }

    // ---------------------------------------------------------------- QR codes and files

    private fun scan(a: JSONObject, r: Reply) {
        val texts = ScanActivity.Contract.Texts(a.optString("hint").take(120), a.optString("torch").take(40), a.optString("close").take(40))
        activity.scanQr(texts) { res -> r.send(res.text, res.error) }
    }

    private fun photo(@Suppress("UNUSED_PARAMETER") a: JSONObject, r: Reply) {
        activity.pickPhoto { uri ->
            if (uri == null) return@pickPhoto r.send(null, null)
            background(r) { QrCodes.fromImage(activity.contentResolver, uri) ?: throw IllegalStateException("NO_QR") }
        }
    }

    private fun dav(a: JSONObject) = com.best.client.net.WebDav(a.getString("url"), a.optString("user").take(256), a.optString("pass").take(256), a.optString("dir").take(64))

    /** Saves text (a backup) where the user chooses with Android's "save as" screen. */
    private fun saveFile(a: JSONObject, r: Reply) {
        val name = a.getString("name")
        val text = a.getString("text")
        require(Regex("^[\\w.-]{1,80}$").matches(name) && text.length <= MAX_BACKUP) { "BAD_ARGUMENTS" }
        activity.saveFile(name) { uri ->
            if (uri == null) return@saveFile r.send(false, null)
            background(r) {
                (activity.contentResolver.openOutputStream(uri, "wt") ?: throw IllegalStateException("FAILED")).use { it.write(text.toByteArray(Charsets.UTF_8)) }
                true
            }
        }
    }

    /** A text file the user picked (links, a subscription body, JSON, YAML, a backup); 8 MB, backups 50 MB. */
    private fun file(a: JSONObject, r: Reply) {
        val max = if (a.optBoolean("backup")) MAX_BACKUP else MAX_FILE
        activity.pickFile { uri ->
            if (uri == null) return@pickFile r.send(null, null)
            background(r) {
                val out = ByteArrayOutputStream()
                (activity.contentResolver.openInputStream(uri) ?: throw IllegalStateException("FAILED")).use { input ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (out.size() + n > max) throw IllegalStateException("TOO_LARGE")
                        out.write(buf, 0, n)
                    }
                }
                out.toString("UTF-8").removePrefix("\uFEFF")
            }
        }
    }

    // ---------------------------------------------------------------- speed / UDP tests

    private fun speed(a: JSONObject, r: Reply) {
        val config = checkedConfig(a)
        val url = a.optString("url").ifBlank { DEFAULT_SPEED_URL }
        require(url.startsWith("https://") || url.startsWith("http://")) { "BAD_URL" }
        val seconds = a.optInt("seconds", 8)
        val core = coreOf(a)
        speedCancel.set(false)
        speedLine.execute {
            val mbps = if (speedCancel.get()) -1.0 else try {
                Probe.speed(activity, core, config, url, seconds) { speedCancel.get() || disposed.get() }
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) Log.w(TAG, "speed", e)
                -1.0
            }
            r.send(JSONObject().put("mbps", mbps), null)
        }
    }

    private fun udp(a: JSONObject, r: Reply) {
        val config = checkedConfig(a)
        val m = UDP_TARGET.matchEntire(a.optString("target").ifBlank { "pool.ntp.org:123" }) ?: throw IllegalArgumentException("BAD_ARGUMENTS")
        val port = m.groupValues[2].toInt()
        require(port in 1..65535) { "BAD_ARGUMENTS" }
        val timeout = a.optInt("timeout", 6000).coerceIn(1000, 15_000)
        val core = coreOf(a)
        tests.execute {
            val ms = try {
                Probe.udp(activity, core, config, m.groupValues[1], port, timeout)
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) Log.w(TAG, "udp", e)
                -1L
            }
            r.send(JSONObject().put("ms", ms), null)
        }
    }

    private fun coreOf(a: JSONObject) = if (a.optString("core") == "singbox") "singbox" else "xray"

    /**
     * Addresses of server names, looked up by Android (its own DNS settings, Private DNS too) so
     * sing-box never has to find a DNS server by itself.
     */
    private fun resolve(a: JSONObject, r: Reply) {
        val arr = a.getJSONArray("names")
        val names = (0 until minOf(arr.length(), 8)).map { arr.getString(it).lowercase() }.filter { NAME.matches(it) }
        background(r) {
            val out = JSONObject()
            for (n in names) {
                val ips = try { java.net.InetAddress.getAllByName(n).mapNotNull { it.hostAddress }.distinct().take(8) } catch (_: Exception) { emptyList() }
                if (ips.isNotEmpty()) out.put(n, JSONArray(ips))
            }
            out
        }
    }

    private fun checkedConfig(a: JSONObject): String {
        val config = a.getString("config")
        require(config.length <= MAX_CONFIG) { "TOO_LARGE" }
        JSONObject(config)
        return config
    }

    // ---------------------------------------------------------------- updates

    private fun metered(): Boolean {
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        return cm.isActiveNetworkMetered
    }

    private fun updateDir() = File(activity.cacheDir, "update").apply { mkdirs() }

    private fun progress(name: String) = Downloader.Progress { done, total ->
        emit("update.progress", JSONObject().put("name", name).put("done", done).put("total", total))
    }

    /** Downloads Best's APK for this phone and checks its SHA-256, package and signature. */
    private fun downloadApp(a: JSONObject, r: Reply) {
        val url = a.getString("url")
        val sha = a.getString("sha256").lowercase()
        val name = a.getString("name")
        require(APK_NAME.matches(name)) { "BAD_ARGUMENTS" }
        downloadCancel.set(false)
        downloads.execute {
            try {
                // Earlier downloads are not kept (Best's own files in its cache folder only).
                updateDir().listFiles()?.forEach { if (it.name != name) it.delete() }
                val target = File(updateDir(), name)
                if (!(target.isFile && Downloader.sha256(target) == sha)) {
                    Downloader.fetch(url, sha, target, MAX_APK, setOf(BuildConfig.UPDATE_REPO), progress(name)) { downloadCancel.get() || disposed.get() }
                }
                AppInstaller.check(activity, target)
                r.send(true, null)
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) Log.w(TAG, "update", e)
                r.send(null, codeOf(e))
            }
        }
    }

    private fun installApp(a: JSONObject, r: Reply) {
        val name = a.getString("name")
        val sha = a.getString("sha256").lowercase()
        require(APK_NAME.matches(name)) { "BAD_ARGUMENTS" }
        if (!AppInstaller.canInstall(activity)) {
            activity.openInstallSettings()
            return r.send(null, "INSTALL_PERMISSION")
        }
        background(r) {
            val apk = File(updateDir(), name)
            if (!apk.isFile) throw IllegalStateException("UPDATE_MISSING")
            // Checked again right before Android gets it.
            if (Downloader.sha256(apk) != sha) throw IllegalStateException("CHECKSUM_MISMATCH")
            AppInstaller.check(activity, apk)
            AppInstaller.install(activity, apk)
            true
        }
    }

    /** Routing data: every file is downloaded and checked first, then all are put in place at once. */
    private fun downloadGeo(a: JSONObject, r: Reply) {
        val items = a.getJSONArray("items")
        require(items.length() in 1..4) { "BAD_ARGUMENTS" }
        val list = (0 until items.length()).map { i ->
            val o = items.getJSONObject(i)
            val name = o.getString("name")
            require(name in GeoFiles.ALL_FILES) { "BAD_ARGUMENTS" }
            Triple(o.getString("url"), o.getString("sha256").lowercase(), name)
        }
        downloadCancel.set(false)
        downloads.execute {
            val dir = GeoFiles.dir(activity)
            val got = LinkedHashMap<String, File>()
            try {
                for ((url, sha, name) in list) {
                    val target = File(dir, "$name.dl")
                    Downloader.fetch(url, sha, target, MAX_GEO, GEO_REPOS, progress(name)) { downloadCancel.get() || disposed.get() }
                    got[name] = target
                }
                GeoFiles.install(activity, got)
                r.send(true, null)
            } catch (e: Exception) {
                got.values.forEach { it.delete() }
                if (BuildConfig.DEBUG) Log.w(TAG, "geo", e)
                r.send(null, codeOf(e))
            }
        }
    }

    private fun readClipboard(): String? {
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = cm.primaryClip ?: return null
        if (clip.itemCount == 0) return null
        return clip.getItemAt(0).coerceToText(activity)?.toString()?.take(MAX_SHARED)
    }

    /** Share links hold passwords: marked sensitive so Android hides them in clipboard previews. */
    private fun writeClipboard(a: JSONObject, r: Reply) {
        val text = a.getString("text")
        require(text.length <= MAX_SHARED) { "TOO_LARGE" }
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Best", text)
        if (a.optBoolean("sensitive", true)) {
            clip.description.extras = PersistableBundle().apply {
                putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
            }
        }
        cm.setPrimaryClip(clip)
        r.send(true, null)
    }

    /** Only https links to known places are opened in the browser. */
    private fun openUrl(a: JSONObject, r: Reply) {
        val uri = Uri.parse(a.getString("url"))
        require(uri.scheme == "https" && uri.host in OPEN_HOSTS) { "BAD_URL" }
        activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        r.send(true, null)
    }

    /**
     * A subscription panel's support or web page link: opened in the browser only when the user taps
     * it; plain http(s) without a user name or password in it.
     */
    private fun openPanelUrl(a: JSONObject, r: Reply) {
        val url = a.getString("url")
        require(url.length <= 600) { "BAD_URL" }
        val uri = Uri.parse(url)
        require((uri.scheme == "https" || uri.scheme == "http") && !uri.host.isNullOrBlank() && uri.userInfo == null) { "BAD_URL" }
        activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        r.send(true, null)
    }

    private fun share(a: JSONObject, r: Reply) {
        val text = a.getString("text")
        require(text.length <= MAX_SHARED) { "TOO_LARGE" }
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        activity.startActivity(Intent.createChooser(send, null))
        r.send(true, null)
    }

    private fun launcherApps(): JSONArray {
        val pm = activity.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val seen = HashSet<String>()
        val out = ArrayList<JSONObject>()
        for (ri in pm.queryIntentActivities(intent, 0)) {
            val pkg = ri.activityInfo?.packageName ?: continue
            if (pkg == activity.packageName || !seen.add(pkg)) continue
            if (out.size >= MAX_APPS) break
            out += JSONObject()
                .put("pkg", pkg)
                .put("label", ri.loadLabel(pm).toString().take(80))
                .put("icon", iconDataUrl(ri.loadIcon(pm)))
        }
        out.sortBy { it.optString("label").lowercase() }
        return JSONArray(out)
    }

    private fun iconDataUrl(d: android.graphics.drawable.Drawable): String {
        val size = 72
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, size, size)
        d.draw(Canvas(bmp))
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    // ---------------------------------------------------------------- plumbing

    private fun background(r: Reply, work: () -> Any?) {
        io.execute {
            try {
                r.send(work(), null)
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) Log.w(TAG, "bridge", e)
                r.send(null, codeOf(e))
            }
        }
    }

    private fun respond(proxy: JavaScriptReplyProxy, id: Int, result: Any?, error: String?) {
        if (disposed.get() || id < 0) return
        val msg = JSONObject().put("id", id).put("ok", error == null)
        if (error == null) msg.put("r", result ?: JSONObject.NULL) else msg.put("e", error)
        proxy.postMessage(msg.toString())
    }

    /** Error codes only (the UI translates them); never stack traces or paths. */
    private fun codeOf(e: Exception): String {
        val m = e.message.orEmpty()
        return if (CODE.matches(m)) m else when (e) {
            is org.json.JSONException -> "BAD_ARGUMENTS"
            is java.net.SocketTimeoutException -> "TIMEOUT"
            is java.net.UnknownHostException -> "DNS_FAILED"
            is javax.net.ssl.SSLException -> "TLS_FAILED"
            is java.io.IOException -> "NETWORK"
            else -> "FAILED"
        }
    }

    companion object {
        private const val TAG = "BestBridge"
        private const val MAX_MESSAGE = 4 * 1024 * 1024
        private const val MAX_CONFIG = 2 * 1024 * 1024
        private const val MAX_SHARED = 1024 * 1024
        private const val MAX_APPS = 600
        private const val TEST_THREADS = 8
        private const val DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204"
        private const val DEFAULT_SPEED_URL = "https://speed.cloudflare.com/__down?bytes=25000000"
        private const val MAX_FILE = 8 * 1024 * 1024
        private const val MAX_BACKUP = 50 * 1024 * 1024
        private const val MAX_APK = 300L * 1024 * 1024
        private const val MAX_GEO = 160L * 1024 * 1024
        private val APK_NAME = Regex("^Best-android-v[0-9A-Za-z._+-]{1,40}\\.apk$")
        private val UDP_TARGET = Regex("^\\[?([A-Za-z0-9.:-]{1,253})]?:(\\d{1,5})$")
        private val NAME = Regex("^[a-z0-9.-]{1,253}$")
        private val GEO_REPOS = setOf("v2fly/geoip", "v2fly/domain-list-community", "Chocolate4U/Iran-v2ray-rules", "runetfreedom/russia-v2ray-rules-dat")
        private val CODE = Regex("^[A-Z][A-Z0-9_]{1,40}$")
        private val OPEN_HOSTS = setOf("github.com")
    }
}
