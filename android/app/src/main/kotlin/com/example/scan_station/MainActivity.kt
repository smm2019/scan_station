package com.example.scan_station

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private fun uriFor(path: String): Uri {
        val file = java.io.File(path)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
            FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        else Uri.fromFile(file)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "app.installer")
            .setMethodCallHandler { call, result ->
                if (call.method == "share") { // ㉖v74 缺料反馈分享：文字/图片走系统分享面板（微信排首位）
                    val text = call.argument<String>("text") ?: ""
                    val paths = call.argument<List<String>>("paths") ?: emptyList()
                    try {
                        val intent = if (paths.isNotEmpty()) {
                            Intent(Intent.ACTION_SEND).apply {
                                type = "image/png"
                                putExtra(Intent.EXTRA_STREAM, uriFor(paths[0]))
                                if (paths.size > 1) { // 多图：ClipData 附带其余（微信支持连发）
                                    val clip = ClipData("缺料清单", arrayOf("image/png"), ClipData.Item(uriFor(paths[0])))
                                    for (i in 1 until paths.size) clip.addItem(ClipData.Item(uriFor(paths[i])))
                                    clipData = clip
                                }
                                if (text.isNotEmpty()) putExtra(Intent.EXTRA_TEXT, text)
                            }
                        } else {
                            Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_TEXT, text)
                            }
                        }
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        startActivity(Intent.createChooser(intent, "分享到").also { it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("SHARE_FAIL", e.message, null)
                    }
                } else if (call.method == "installApk") {
                    val path = call.argument<String>("path")
                    if (path.isNullOrEmpty()) {
                        result.error("BAD_ARG", "路径为空", null)
                    } else {
                        try {
                            val file = java.io.File(path)
                            val uri: Uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                                FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
                            } else {
                                Uri.fromFile(file)
                            }
                            val intent = Intent(Intent.ACTION_VIEW)
                            intent.setDataAndType(uri, "application/vnd.android.package-archive")
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            startActivity(intent)
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("INSTALL_FAIL", e.message, null)
                        }
                    }
                } else {
                    result.notImplemented()
                }
            }
    }
}
