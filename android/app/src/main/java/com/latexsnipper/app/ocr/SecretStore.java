package com.latexsnipper.app.ocr;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Android Keystore-backed storage for API keys (rectification P0-10, "密钥安全存储").
 *
 * API keys were previously kept in the WebView's localStorage as plain text,
 * where any script running in the page — and anything with access to the app's
 * data directory on a rooted device — could read them.
 *
 * Here the AES key lives in the Android Keystore and never enters the app
 * process: it cannot be extracted, only used. Ciphertext is what lands in
 * SharedPreferences, so a stolen preferences file yields nothing without the
 * hardware-held key.
 *
 * AES/GCM is used for authenticated encryption, so a tampered ciphertext fails
 * to decrypt rather than silently returning corrupted bytes. A fresh IV is
 * generated per encryption (never reused, which would break GCM) and stored
 * alongside the ciphertext.
 */
final class SecretStore {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "latexsnipper_secret_key_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String PREFS = "ls_secrets";
    private static final String INDEX_KEY = "__ids";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    private final Context context;

    SecretStore(Context context) {
        this.context = context.getApplicationContext();
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Fetches the Keystore key, creating it on first use.
     * setUserAuthenticationRequired is deliberately NOT set: requiring a device
     * unlock for every request would make background grading impossible, and
     * the threat being addressed is at-rest disclosure.
     */
    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        KeyStore.Entry existing = keyStore.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    /** Stores a secret under an opaque id. Returns false when it cannot. */
    boolean put(String id, String plaintext) {
        if (id == null || id.isEmpty()) return false;
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(
                (plaintext == null ? "" : plaintext).getBytes(StandardCharsets.UTF_8));

            // iv || ciphertext, so decryption needs only this one blob.
            byte[] combined = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);

            Set<String> ids = new HashSet<>(prefs().getStringSet(INDEX_KEY, new HashSet<>()));
            ids.add(id);
            prefs().edit()
                .putString(id, Base64.encodeToString(combined, Base64.NO_WRAP))
                .putStringSet(INDEX_KEY, ids)
                .apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Returns the plaintext, or null when absent or undecryptable. */
    String get(String id) {
        if (id == null) return null;
        String stored = prefs().getString(id, null);
        if (stored == null) return null;
        try {
            byte[] combined = Base64.decode(stored, Base64.NO_WRAP);
            if (combined.length <= IV_BYTES) return null;
            byte[] iv = new byte[IV_BYTES];
            byte[] ciphertext = new byte[combined.length - IV_BYTES];
            System.arraycopy(combined, 0, iv, 0, IV_BYTES);
            System.arraycopy(combined, IV_BYTES, ciphertext, 0, ciphertext.length);

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // Tampered, or the Keystore key was cleared (app data wipe, restore
            // to a new device). Treated as absent so the user re-enters the key.
            return null;
        }
    }

    boolean has(String id) {
        return id != null && prefs().contains(id);
    }

    void remove(String id) {
        if (id == null) return;
        Set<String> ids = new HashSet<>(prefs().getStringSet(INDEX_KEY, new HashSet<>()));
        ids.remove(id);
        prefs().edit().remove(id).putStringSet(INDEX_KEY, ids).apply();
    }

    /** Ids that currently hold a secret. Never returns the secrets themselves. */
    Set<String> ids() {
        return new HashSet<>(prefs().getStringSet(INDEX_KEY, new HashSet<>()));
    }
}
