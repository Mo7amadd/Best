package com.best.client.web

import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves the UI from assets/web at https://appassets.androidplatform.net/app/… — the only content
 * the WebView ever loads. Every response carries a strict Content-Security-Policy: scripts only
 * from this origin, no network access from the page, no frames, no forms, no plugins.
 */
class WebAssets(private val context: Context) : WebViewAssetLoader.PathHandler {

    override fun handle(path: String): WebResourceResponse {
        if (!SAFE_PATH.matches(path) || path.contains("..")) return notFound()
        val mime = MIME[path.substringAfterLast('.', "").lowercase()] ?: return notFound()
        val stream = try { context.assets.open("web/$path") } catch (_: IOException) { return notFound() }
        val encoding = if (mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json")) "utf-8" else null
        return WebResourceResponse(mime, encoding, 200, "OK", HEADERS, stream)
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", HEADERS, ByteArrayInputStream(ByteArray(0)))

    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val START_URL = "$ORIGIN/app/index.html"

        private val SAFE_PATH = Regex("^[A-Za-z0-9_\\-]+(/[A-Za-z0-9_\\-]+)*\\.[a-z0-9]{1,5}$")

        private val MIME = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "mjs" to "text/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "woff2" to "font/woff2",
        )

        private val HEADERS = mapOf(
            "Content-Security-Policy" to listOf(
                "default-src 'none'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline'",
                "font-src 'self'",
                "img-src 'self' data:",
                "connect-src 'none'",
                "media-src 'none'",
                "object-src 'none'",
                "frame-src 'none'",
                "worker-src 'none'",
                "base-uri 'none'",
                "form-action 'none'",
            ).joinToString("; "),
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
            "Cache-Control" to "no-store",
        )
    }
}
