package com.best.client.scan

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.zxing.PlanarYUVLuminanceSource
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Full-screen camera that looks for a QR code and returns its text. The picture never leaves the
 * phone and nothing is saved; the camera stops as soon as a code is read or the screen closes.
 * Texts come from the web UI (its language), passed in the starting intent.
 */
class ScanActivity : ComponentActivity() {

    private val analysis: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "best-scan") }
    private val done = AtomicBoolean(false)
    private var camera: Camera? = null
    private var torchOn = false

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else finishWith(null, ERROR_CAMERA_DENIED)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        val hint = intent.getStringExtra(EXTRA_HINT).orEmpty().take(120)
        val torchLabel = intent.getStringExtra(EXTRA_TORCH).orEmpty().take(40)
        val closeLabel = intent.getStringExtra(EXTRA_CLOSE).orEmpty().take(40)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val preview = PreviewView(this).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        root.addView(preview, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(Frame(this), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        val hintView = TextView(this).apply {
            text = hint
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
        }
        root.addView(hintView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { topMargin = dp(200) })

        val bar = FrameLayout(this)
        val close = pill(closeLabel) { finishWith(null, null) }
        val torch = pill(torchLabel) { toggleTorch(it) }
        bar.addView(close, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(48), Gravity.START or Gravity.CENTER_VERTICAL))
        bar.addView(torch, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(48), Gravity.END or Gravity.CENTER_VERTICAL))
        val barParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(48), Gravity.BOTTOM)
        root.addView(bar, barParams)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            barParams.setMargins(dp(20) + b.left, 0, dp(20) + b.right, dp(28) + b.bottom)
            bar.layoutParams = barParams
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        previewView = preview

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    private var previewView: PreviewView? = null

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = try { future.get() } catch (_: Exception) { return@addListener finishWith(null, ERROR_NO_CAMERA) }
            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView?.surfaceProvider }
            val selector = ResolutionSelector.Builder()
                .setResolutionStrategy(ResolutionStrategy(android.util.Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                .build()
            val reader = ImageAnalysis.Builder()
                .setResolutionSelector(selector)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            reader.setAnalyzer(analysis, ::analyze)
            try {
                provider.unbindAll()
                val cam = if (provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
                camera = provider.bindToLifecycle(this, cam, preview, reader)
            } catch (_: Exception) {
                finishWith(null, ERROR_NO_CAMERA)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private var buffer = ByteArray(0)

    private fun analyze(image: ImageProxy) {
        image.use {
            if (done.get()) return
            val plane = it.planes[0] // luminance (Y)
            val data = plane.buffer
            val row = plane.rowStride
            val size = row * it.height
            if (buffer.size < size) buffer = ByteArray(size)
            data.rewind()
            data.get(buffer, 0, minOf(size, data.remaining()))
            val src = PlanarYUVLuminanceSource(buffer, row, it.height, 0, 0, it.width, it.height, false)
            val text = QrCodes.decode(src) ?: QrCodes.decode(src.invert()) ?: return
            if (text.isNotBlank() && done.compareAndSet(false, true)) {
                runOnUiThread {
                    window.decorView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                    finishWith(text, null)
                }
            }
        }
    }

    private fun toggleTorch(v: View) {
        val cam = camera ?: return
        if (!cam.cameraInfo.hasFlashUnit()) return
        torchOn = !torchOn
        cam.cameraControl.enableTorch(torchOn)
        v.alpha = if (torchOn) 1f else 0.85f
        (v.background as? GradientDrawable)?.setColor(if (torchOn) Color.WHITE else 0x66000000)
        (v as? TextView)?.setTextColor(if (torchOn) Color.BLACK else Color.WHITE)
    }

    private fun finishWith(text: String?, error: String?) {
        done.set(true)
        val data = Intent()
        if (text != null) data.putExtra(RESULT_TEXT, text)
        if (error != null) data.putExtra(RESULT_ERROR, error)
        setResult(if (text != null) RESULT_OK else RESULT_CANCELED, data)
        finish()
    }

    override fun onDestroy() {
        analysis.shutdownNow()
        super.onDestroy()
    }

    private fun pill(label: String, onClick: (View) -> Unit) = TextView(this).apply {
        text = label
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        gravity = Gravity.CENTER
        setPadding(dp(22), 0, dp(22), 0)
        background = GradientDrawable().apply { cornerRadius = dp(24).toFloat(); setColor(0x66000000) }
        isClickable = true
        isFocusable = true
        contentDescription = label
        setOnClickListener(onClick)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    /** Dims everything but a rounded square in the middle, with green corners. */
    private class Frame(context: Context) : View(context) {
        private val dim = Paint().apply { color = 0x99000000.toInt() }
        private val clear = Paint(Paint.ANTI_ALIAS_FLAG).apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR) }
        private val corner = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFF3DD68C.toInt()
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeWidth = 4 * resources.displayMetrics.density
        }

        init { setLayerType(LAYER_TYPE_HARDWARE, null) }

        override fun onDraw(canvas: Canvas) {
            val d = resources.displayMetrics.density
            val side = minOf(width, height) * 0.68f
            val l = (width - side) / 2
            val t = (height - side) / 2 - 40 * d
            val r = RectF(l, t, l + side, t + side)
            val rad = 28 * d
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), dim)
            canvas.drawRoundRect(r, rad, rad, clear)
            val len = 34 * d
            val p = Path()
            p.moveTo(r.left, r.top + len); p.lineTo(r.left, r.top + rad); p.quadTo(r.left, r.top, r.left + rad, r.top); p.lineTo(r.left + len, r.top)
            p.moveTo(r.right - len, r.top); p.lineTo(r.right - rad, r.top); p.quadTo(r.right, r.top, r.right, r.top + rad); p.lineTo(r.right, r.top + len)
            p.moveTo(r.right, r.bottom - len); p.lineTo(r.right, r.bottom - rad); p.quadTo(r.right, r.bottom, r.right - rad, r.bottom); p.lineTo(r.right - len, r.bottom)
            p.moveTo(r.left + len, r.bottom); p.lineTo(r.left + rad, r.bottom); p.quadTo(r.left, r.bottom, r.left, r.bottom - rad); p.lineTo(r.left, r.bottom - len)
            canvas.drawPath(p, corner)
        }
    }

    /** Starts the scanner with texts in the UI's language; the result is the text or an error code. */
    class Contract : ActivityResultContract<Contract.Texts, Contract.Result>() {
        data class Texts(val hint: String, val torch: String, val close: String)
        data class Result(val text: String?, val error: String?)

        override fun createIntent(context: Context, input: Texts) = Intent(context, ScanActivity::class.java)
            .putExtra(EXTRA_HINT, input.hint)
            .putExtra(EXTRA_TORCH, input.torch)
            .putExtra(EXTRA_CLOSE, input.close)

        override fun parseResult(resultCode: Int, intent: Intent?) =
            Result(intent?.getStringExtra(RESULT_TEXT), intent?.getStringExtra(RESULT_ERROR))
    }

    companion object {
        private const val EXTRA_HINT = "hint"
        private const val EXTRA_TORCH = "torch"
        private const val EXTRA_CLOSE = "close"
        private const val RESULT_TEXT = "text"
        private const val RESULT_ERROR = "error"
        const val ERROR_CAMERA_DENIED = "CAMERA_DENIED"
        const val ERROR_NO_CAMERA = "NO_CAMERA"
    }
}
