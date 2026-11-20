package com.best.client

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.VpnService
import android.provider.Settings
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.best.client.scan.ScanActivity
import com.best.client.web.NativeBridge
import com.best.client.web.WebAssets
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {

    private var web: WebView? = null
    private var bridge: NativeBridge? = null
    private var vpnCallback: ((Boolean) -> Unit)? = null

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = vpnCallback
        vpnCallback = null
        cb?.invoke(result.resultCode == RESULT_OK)
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // One picker at a time; a new request answers a pending one with "nothing".
    private var scanCallback: ((ScanActivity.Contract.Result) -> Unit)? = null
    private var uriCallback: ((Uri?) -> Unit)? = null

    private val scanner = registerForActivityResult(ScanActivity.Contract()) { res ->
        val cb = scanCallback
        scanCallback = null
        cb?.invoke(res)
    }

    /** Android's photo picker: Best sees only the one picture chosen, and needs no storage permission. */
    private val photoPicker = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> takeUri(uri) }

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> takeUri(uri) }

    /** Android's "save as" screen: the user picks where a file (a backup) goes. */
    private val fileSaver = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri -> takeUri(uri) }

    private fun takeUri(uri: Uri?) {
        val cb = uriCallback
        uriCallback = null
        cb?.invoke(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setBars(light = false)
        super.onCreate(savedInstanceState)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply {
                setText(R.string.webview_too_old)
                setTextColor(Color.WHITE)
                setPadding(64, 64, 64, 64)
                gravity = Gravity.CENTER
                textSize = 17f
            })
            return
        }
        val b = NativeBridge(this)
        bridge = b
        val w = createWebView(b)
        web = w
        setContentView(w)

        ViewCompat.setOnApplyWindowInsetsListener(w) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val d = resources.displayMetrics.density
            b.setInsets((bars.top / d).roundToInt(), (max(bars.bottom, ime.bottom) / d).roundToInt(), (bars.left / d).roundToInt(), (bars.right / d).roundToInt())
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = b.emit("back", null)
        })

        handleShare(intent)
        w.loadUrl(WebAssets.START_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(b: NativeBridge): WebView {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/app/", WebAssets(this))
            .build()
        val w = WebView(this)
        w.setBackgroundColor(ContextCompat.getColor(this, R.color.bg))
        w.isVerticalScrollBarEnabled = false
        w.isHorizontalScrollBarEnabled = false
        w.overScrollMode = WebView.OVER_SCROLL_NEVER
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            @Suppress("DEPRECATION") databaseEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
            setGeolocationEnabled(false)
            // Local pages only: Safe Browsing would just send their addresses to Google.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = false
        }
        w.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                // Anything that is not one of Best's own files is answered with nothing.
                return loader.shouldInterceptRequest(request.url)
                    ?: WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), null)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The page crashed: start over cleanly instead of letting the app die.
                recreate()
                return true
            }
        }
        WebViewCompat.addWebMessageListener(w, "bestNative", setOf(WebAssets.ORIGIN), b)
        return w
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    private fun handleShare(intent: Intent?) {
        when {
            intent?.action == ACTION_SCAN -> bridge?.onLink("scan:")
            // best://install-sub?url=… (and the same links made for v2rayNG): the page asks first.
            intent?.action == Intent.ACTION_VIEW && intent.data?.scheme in LINK_SCHEMES -> bridge?.onLink(intent.dataString ?: return)
            // Any app can send this; a broken extra must not bring Best down (the page asks before adding).
            intent?.action == Intent.ACTION_SEND && intent.type == "text/plain" ->
                bridge?.onShared((try { intent.getStringExtra(Intent.EXTRA_TEXT) } catch (_: Exception) { null })?.take(200_000) ?: return)
            else -> return
        }
        setIntent(Intent(this, MainActivity::class.java))
    }

    /** Transparent system bars over the page, with icons that suit the UI theme. */
    fun setBars(light: Boolean) {
        val style = if (light) SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT) else SystemBarStyle.dark(Color.TRANSPARENT)
        enableEdgeToEdge(style, style)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
    }

    /** Asks Android for the VPN permission when needed (only the first time, or after another VPN took it). */
    fun requestVpn(cb: (Boolean) -> Unit) {
        val ask = try { VpnService.prepare(this) } catch (_: Exception) { null }
        if (ask == null) return cb(true)
        vpnCallback = cb
        vpnPermission.launch(ask)
    }

    fun scanQr(texts: ScanActivity.Contract.Texts, cb: (ScanActivity.Contract.Result) -> Unit) {
        scanCallback?.invoke(ScanActivity.Contract.Result(null, null))
        scanCallback = cb
        scanner.launch(texts)
    }

    fun pickPhoto(cb: (Uri?) -> Unit) {
        uriCallback?.invoke(null)
        uriCallback = cb
        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    fun pickFile(cb: (Uri?) -> Unit) {
        uriCallback?.invoke(null)
        uriCallback = cb
        filePicker.launch(arrayOf("text/*", "application/json", "application/yaml", "application/x-yaml", "application/octet-stream"))
    }

    fun saveFile(name: String, cb: (Uri?) -> Unit) {
        uriCallback?.invoke(null)
        uriCallback = cb
        fileSaver.launch(name)
    }

    /** Android's page where the user lets Best install its own updates. */
    fun openInstallSettings() {
        if (Build.VERSION.SDK_INT < 26) return
        try {
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }

    /** Android 13+: the connection notification needs this permission; Best works without it too. */
    fun requestNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    companion object {
        const val ACTION_SCAN = "com.best.client.SCAN"
        private val LINK_SCHEMES = setOf("best", "v2rayng")
    }

    override fun onDestroy() {
        bridge?.dispose()
        bridge = null
        web?.let {
            it.stopLoading()
            it.destroy()
        }
        web = null
        super.onDestroy()
    }
}
