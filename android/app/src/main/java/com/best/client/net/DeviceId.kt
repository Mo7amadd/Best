package com.best.client.net

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Device id for subscription panels that limit how many devices a user may have (Remnawave and
 * others): "x-hwid" with the subscription request, plus "x-device-os", "x-ver-os" and
 * "x-device-model". The same scheme as Best for Windows (src/core/hwid.js):
 *  - Not the phone's hardware id: a random secret made once on this phone, kept encrypted with a
 *    key of the Android keystore in the no-backup folder (never in a backup: restored elsewhere it
 *    would make two devices one), mixed with the panel's host name. A panel always sees the same
 *    id, two panels cannot tell they talk to the same phone.
 *  - The phone's name is not sent: "Android phone" unless the user chose another name.
 * Remnawave (v3) ignores an id that does not match /^[a-zA-Z0-9=-]{10,64}$/: 32 hex characters.
 */
object DeviceId {

    const val DEFAULT_MODEL = "Android phone"
    private const val KEY_ALIAS = "best-device-id"
    private const val FILE = "device.dat"

    @Volatile private var secret: String? = null

    private val SECRET = Regex("^[0-9a-f]{64}$")

    /** Request headers for a subscription fetch of `url`. */
    fun headers(ctx: Context, url: String, name: String): Map<String, String> {
        val host = try { java.net.URL(url).host.orEmpty().lowercase() } catch (_: Exception) { "" }
        // Never in the way of the download itself: without a secret, no id is sent.
        val id = try { idFor(secret(ctx), host) } catch (_: Exception) { return emptyMap() }
        val h = linkedMapOf("x-hwid" to id, "x-device-os" to "Android")
        val ver = headerText(Build.VERSION.RELEASE.orEmpty(), 32)
        if (ver.isNotEmpty()) h["x-ver-os"] = ver
        h["x-device-model"] = headerText(name, 40).ifEmpty { DEFAULT_MODEL }
        return h
    }

    /** HMAC-SHA256(key = the secret's hex text, "best-hwid\n" + host), first 32 hex characters. */
    fun idFor(secret: String, host: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal("best-hwid\n$host".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.take(32)
    }

    /** Printable ASCII only, one line, short. */
    fun headerText(v: String, max: Int): String =
        v.replace(Regex("[^\\x20-\\x7e]"), "").replace(Regex("\\s+"), " ").trim().take(max)

    /** What a panel said: "limit" (the subscription has its maximum of devices), "required" (it wants an id), or "". */
    fun status(header: (String) -> String?): String {
        fun on(n: String) = header(n)?.trim()?.lowercase() == "true"
        return when {
            on("x-hwid-max-devices-reached") || on("x-hwid-limit") -> "limit"
            on("x-hwid-not-supported") -> "required"
            else -> ""
        }
    }

    @Synchronized
    private fun secret(ctx: Context): String {
        secret?.let { return it }
        val file = File(ctx.noBackupFilesDir, FILE)
        val stored = try { if (file.exists()) decrypt(file.readBytes()) else null } catch (_: Exception) { null }
        val s = if (stored != null && SECRET.matches(stored)) stored else {
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val fresh = bytes.joinToString("") { "%02x".format(it) }
            val tmp = File(file.path + ".tmp")
            tmp.writeBytes(encrypt(fresh))
            if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
            fresh
        }
        secret = s
        return s
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    /**
     * iv length (1 byte), iv, then AES-GCM ciphertext. Where the keystore does not work (some
     * emulators), a 0 byte and the text: the file is still private to Best and outside backups.
     */
    private fun encrypt(text: String): ByteArray = try {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val iv = c.iv
        byteArrayOf(iv.size.toByte()) + iv + c.doFinal(text.toByteArray(Charsets.UTF_8))
    } catch (_: Exception) {
        byteArrayOf(0) + text.toByteArray(Charsets.UTF_8)
    }

    private fun decrypt(data: ByteArray): String {
        if (data.isNotEmpty() && data[0].toInt() == 0) return String(data, 1, data.size - 1, Charsets.UTF_8)
        val n = data[0].toInt()
        require(n in 12..16 && data.size > 1 + n)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 1, n))
        return String(c.doFinal(data, 1 + n, data.size - 1 - n), Charsets.UTF_8)
    }
}
