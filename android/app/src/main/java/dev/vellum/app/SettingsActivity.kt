package dev.vellum.app

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import dev.vellum.app.Prefs.clientToken
import dev.vellum.app.Prefs.isConfigured
import dev.vellum.app.Prefs.serverUrl

/** Account setup: server URL + client token (stored encrypted). */
class SettingsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 64, 48, 48)
        }
        val urlInput = EditText(this).apply {
            hint = getString(R.string.settings_server_url)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setText(serverUrl)
        }
        val tokenInput = EditText(this).apply {
            hint = getString(R.string.settings_token)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(clientToken)
        }
        val test = Button(this).apply { text = getString(R.string.settings_test) }
        val save = Button(this).apply { text = getString(R.string.settings_save) }

        layout.addView(urlInput)
        layout.addView(tokenInput)
        layout.addView(test)
        layout.addView(save)
        setContentView(layout)

        test.setOnClickListener {
            val url = urlInput.text.toString().trim().trimEnd('/')
            val ok = url.isNotBlank() && ApiClient.getHealth(url)
            Toast.makeText(this, if (ok) getString(R.string.settings_ok) else getString(R.string.settings_fail), Toast.LENGTH_SHORT).show()
        }
        save.setOnClickListener {
            serverUrl = urlInput.text.toString().trim()
            clientToken = tokenInput.text.toString().trim()
            finish()
            if (isConfigured()) {
                startActivity(packageManager.getLaunchIntentForPackage(packageName))
            }
        }
    }
}
